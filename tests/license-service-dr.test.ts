import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  activateLicense,
  evaluateLicenseReviewGate,
  getLicenseStatus,
  type LicenseConfig
} from "../src/license.js";
import { createLicenseRequestListener } from "../services/license-api/src/http.js";
import { RateLimiter } from "../services/license-api/src/service.js";
import { LicenseStore } from "../services/license-api/src/store.js";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const licenseApiDir = join(repoRoot, "services/license-api");
const dbPath = "/data/license.sqlite";
const litestreamVersion = "0.5.14";
const litestreamLinuxX64Sha = "32083dd2af13840b273c538360b828368d7b82bbaa2c641106052dc7814ed956";
const litestreamLinuxArm64Sha = "b49b3d01fb0a8b4d426ee613c080fba44acae0551587dc43525dcd93eee64b4f";
const licenseApiTypescriptCompiler = join(licenseApiDir, "node_modules/typescript/bin/tsc");
const licenseApiTypescriptConfig = join(licenseApiDir, "tsconfig.json");

const legacySchema = `
  create table licenses (
    license_key_hash text primary key,
    plan text not null,
    repo_visibility_scope text not null,
    private_repo_allowed integer not null default 1,
    update_entitlement integer not null default 0,
    seats integer not null default 1,
    expires_at text,
    status text not null default 'active',
    revocation_reason text,
    created_at text not null default (datetime('now'))
  );
  create table activations (
    license_key_hash text not null,
    machine_id text not null,
    repo text,
    activated_at text not null default (datetime('now')),
    last_seen_at text not null default (datetime('now')),
    primary key (license_key_hash, machine_id)
  );
  create table license_issuance_events (
    idempotency_key text primary key,
    license_key_hash text not null,
    request_hash text not null,
    source text,
    external_ref text,
    created_at text not null default (datetime('now')),
    foreign key (license_key_hash) references licenses(license_key_hash)
  );
`;

const litestreamInternalSchema = `
  create table _litestream_lock (id integer);
  create table _litestream_seq (id integer primary key, seq integer);
`;

function readServiceFile(relativePath: string): string {
  return readFileSync(join(licenseApiDir, relativePath), "utf8");
}

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function licenseConfig(root: string, apiBaseUrl: string): LicenseConfig {
  return {
    enabled: true,
    apiBaseUrl,
    cachePath: join(root, "entitlement.json"),
    storageBackend: "file",
    keyPath: join(root, "license.key"),
    keychainService: "neondiff-dr-test",
    keychainAccount: "neondiff-dr-test",
    requestTimeoutMs: 5_000,
    offlineGraceMs: 0,
    publicReposFree: false,
    privateReposRequireEntitlement: true,
    updateEntitlementRequiresLicense: false
  };
}

function serviceFetchFor(store: LicenseStore, machineId: string): typeof fetch {
  const listener = createLicenseRequestListener({
    store,
    // This test is about client grace behavior, not service throttling.
    rateLimiter: new RateLimiter({ maxPerWindow: 1000, windowMs: 60_000 })
  });

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const path = new URL(url).pathname;
    const originalBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const body = JSON.stringify({ ...originalBody, machineId });

    return await new Promise<Response>((resolve) => {
      const req: any = {
        method: init?.method ?? "POST",
        url: path,
        on(event: string, cb: (arg?: unknown) => void) {
          if (event === "data") cb(Buffer.from(body));
          if (event === "end") cb();
          return req;
        },
        destroy() {}
      };
      let statusCode = 200;
      let headers: Record<string, string> = {};
      const responseChunks: string[] = [];
      const res: any = {
        writeHead(code: number, h: Record<string, string>) {
          statusCode = code;
          headers = h;
          return res;
        },
        end(payload?: string) {
          if (payload) responseChunks.push(payload);
          resolve(new Response(responseChunks.join(""), { status: statusCode, headers }));
        }
      };
      void listener(req, res);
    });
  }) as typeof fetch;
}

const outageFetch = (async (): Promise<Response> => {
  throw new Error("simulated license API outage");
}) as typeof fetch;

describe("license service disaster recovery wiring", () => {
  it("pins Litestream install, config, and entrypoint to the mounted license database without secrets", () => {
    const dockerfile = readServiceFile("Dockerfile");
    const litestreamConfig = readServiceFile("litestream.yml");
    const brokerLitestreamConfig = readServiceFile("litestream-broker.yml");
    const entrypoint = readServiceFile("docker-entrypoint.sh");
    const flyConfig = readServiceFile("fly.toml");

    expect(dockerfile).toContain(`LITESTREAM_VERSION=${litestreamVersion}`);
    expect(dockerfile).toContain(litestreamLinuxX64Sha);
    expect(dockerfile).toContain(litestreamLinuxArm64Sha);
    expect(dockerfile).toContain("COPY services/license-api/litestream.yml /etc/litestream.yml");
    expect(dockerfile).toContain(
      "COPY services/license-api/litestream-broker.yml /etc/litestream-broker.yml"
    );
    expect(dockerfile).toContain("COPY services/license-api/docker-entrypoint.sh /usr/local/bin/license-api-entrypoint");
    expect(dockerfile).toContain("chown node:node /data");
    expect(dockerfile).toContain('ENTRYPOINT ["license-api-entrypoint"]');

    expect(litestreamConfig).toContain(`path: \${LICENSE_DB_PATH}`);
    expect(litestreamConfig).toContain("url: ${LICENSE_REPLICA_URL}");
    expect(litestreamConfig).not.toContain("replicas:");
    expect(litestreamConfig).not.toMatch(/^\s*url:\s+(?!\$\{LICENSE_REPLICA_URL\}\s*$).+/m);
    expect(litestreamConfig).not.toMatch(/AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|secret-access-key:\s+\S|account-key:\s+\S/i);

    expect(brokerLitestreamConfig).toContain(`path: \${LICENSE_DB_PATH}`);
    expect(brokerLitestreamConfig).toContain("url: ${LICENSE_REPLICA_URL}");
    expect(brokerLitestreamConfig).toContain(`path: \${GITHUB_BROKER_DB_PATH}`);
    expect(brokerLitestreamConfig).toContain("url: ${GITHUB_BROKER_REPLICA_URL}");
    expect(brokerLitestreamConfig).not.toMatch(
      /^\s*url:\s+(?!\$\{(?:LICENSE|GITHUB_BROKER)_REPLICA_URL\}\s*$).+/m
    );
    expect(brokerLitestreamConfig).not.toMatch(
      /AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|secret-access-key:\s+\S|account-key:\s+\S/i
    );

    expect(entrypoint).toContain(`LICENSE_DB_PATH:=/data/license.sqlite`);
    expect(entrypoint).toContain(`GITHUB_BROKER_DB_PATH:=/data/github-broker.sqlite`);
    expect(entrypoint).toContain(
      `GITHUB_BROKER_LITESTREAM_CONFIG:=/etc/litestream-broker.yml`
    );
    expect(entrypoint).toContain('if [ ! -f "$LICENSE_DB_PATH" ]');
    expect(entrypoint).toContain('litestream restore -if-replica-exists -config "$LITESTREAM_CONFIG" "$LICENSE_DB_PATH"');
    expect(entrypoint).toContain(
      'litestream restore -if-replica-exists -config "$LITESTREAM_CONFIG" "$GITHUB_BROKER_DB_PATH"'
    );
    expect(entrypoint).toContain('exec litestream replicate -config "$LITESTREAM_CONFIG" -exec "node dist/server.js"');
    expect(entrypoint).toContain("LICENSE_LITESTREAM_REQUIRED");
    expect(entrypoint).not.toMatch(/AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|secret-access-key:\s+\S|account-key:\s+\S|password\s*=/i);

    expect(flyConfig).toContain(`LICENSE_DB_PATH = "${dbPath}"`);
    expect(flyConfig).toContain(`GITHUB_BROKER_DB_PATH = "/data/github-broker.sqlite"`);
    expect(flyConfig).toContain(
      `GITHUB_BROKER_LITESTREAM_CONFIG = "/etc/litestream-broker.yml"`
    );
    expect(flyConfig).toContain('LICENSE_REPLICA_URL');
    expect(flyConfig).toContain('GITHUB_BROKER_REPLICA_URL');
    expect(flyConfig).not.toMatch(/^\s*LICENSE_REPLICA_URL\s*=/m);
    expect(flyConfig).not.toMatch(/^\s*GITHUB_BROKER_REPLICA_URL\s*=/m);
    expect(flyConfig).toContain('LICENSE_LITESTREAM_REQUIRED = "true"');
    expect(flyConfig).toContain('source = "license_data"');
    expect(flyConfig).toContain('destination = "/data"');
    expect(flyConfig).not.toMatch(/AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|secret-access-key|account-key|password\s*=/i);
  });

  it("preserves two-database DR under the broker kill switch and refuses enablement without it", () => {
    const root = mkdtempSync(join(tmpdir(), "nd-broker-dr-entrypoint-"));
    try {
      const binDir = join(root, "bin");
      const tracePath = join(root, "trace.log");
      const licensePath = join(root, "data", "license.sqlite");
      const brokerPath = join(root, "data", "github-broker.sqlite");
      mkdirSync(binDir, { recursive: true });
      writeExecutable(
        join(binDir, "litestream"),
        `#!/bin/sh
printf 'litestream' >> "$TRACE_LOG"
for arg in "$@"; do printf ' <%s>' "$arg" >> "$TRACE_LOG"; done
printf '\\n' >> "$TRACE_LOG"
if [ "$1" = "restore" ]; then
  for target in "$@"; do :; done
  mkdir -p "$(dirname "$target")"
  : > "$target"
fi
`
      );

      const baseEnv = {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        TRACE_LOG: tracePath,
        LICENSE_DB_PATH: licensePath,
        LICENSE_REPLICA_URL: "s3://fixture/license",
        LICENSE_LITESTREAM_REQUIRED: "true",
        LITESTREAM_CONFIG: join(licenseApiDir, "litestream.yml"),
        GITHUB_BROKER_ENABLED: "true",
        GITHUB_BROKER_DB_PATH: brokerPath,
        GITHUB_BROKER_REPLICA_URL: "s3://fixture/broker",
        GITHUB_BROKER_LITESTREAM_CONFIG: join(
          licenseApiDir,
          "litestream-broker.yml"
        )
      };

      execFileSync("sh", [join(licenseApiDir, "docker-entrypoint.sh")], {
        env: baseEnv,
        stdio: "pipe"
      });
      const trace = readFileSync(tracePath, "utf8");
      expect(trace).toContain(`<${licensePath}>`);
      expect(trace).toContain(`<${brokerPath}>`);
      expect(trace.match(/litestream <restore>/g)).toHaveLength(2);
      expect(trace).toContain(
        `<${join(licenseApiDir, "litestream-broker.yml")}>`
      );
      expect(trace).toContain("litestream <replicate>");

      rmSync(licensePath, { force: true });
      rmSync(brokerPath, { force: true });
      rmSync(tracePath, { force: true });
      execFileSync("sh", [join(licenseApiDir, "docker-entrypoint.sh")], {
        env: { ...baseEnv, GITHUB_BROKER_ENABLED: "false" },
        stdio: "pipe"
      });
      const killedTrace = readFileSync(tracePath, "utf8");
      expect(killedTrace.match(/litestream <restore>/g)).toHaveLength(2);
      expect(killedTrace).toContain(`<${brokerPath}>`);
      expect(killedTrace).toContain(
        `<${join(licenseApiDir, "litestream-broker.yml")}>`
      );

      rmSync(licensePath, { force: true });
      rmSync(brokerPath, { force: true });
      rmSync(tracePath, { force: true });
      execFileSync("sh", [join(licenseApiDir, "docker-entrypoint.sh")], {
        env: {
          ...baseEnv,
          GITHUB_BROKER_ENABLED: "false",
          GITHUB_BROKER_REPLICA_URL: ""
        },
        stdio: "pipe"
      });
      const licenseOnlyTrace = readFileSync(tracePath, "utf8");
      expect(licenseOnlyTrace.match(/litestream <restore>/g)).toHaveLength(1);
      expect(licenseOnlyTrace).toContain(`<${licensePath}>`);
      expect(licenseOnlyTrace).not.toContain(`<${brokerPath}>`);
      expect(licenseOnlyTrace).toContain(`<${join(licenseApiDir, "litestream.yml")}>`);

      rmSync(tracePath, { force: true });
      expect(() =>
        execFileSync("sh", [join(licenseApiDir, "docker-entrypoint.sh")], {
          env: { ...baseEnv, GITHUB_BROKER_REPLICA_URL: "" },
          stdio: "pipe"
        })
      ).toThrow();
      expect(existsSync(tracePath)).toBe(false);

      expect(() =>
        execFileSync("sh", [join(licenseApiDir, "docker-entrypoint.sh")], {
          env: {
            ...baseEnv,
            GITHUB_BROKER_REPLICA_URL: baseEnv.LICENSE_REPLICA_URL
          },
          stdio: "pipe"
        })
      ).toThrow();
      expect(existsSync(tracePath)).toBe(false);

      const missingLicenseReplica = spawnSync(
        "sh",
        [join(licenseApiDir, "docker-entrypoint.sh")],
        {
          env: {
            ...baseEnv,
            GITHUB_BROKER_ENABLED: "false",
            LICENSE_LITESTREAM_REQUIRED: "false",
            LICENSE_REPLICA_URL: ""
          },
          encoding: "utf8",
          stdio: "pipe"
        }
      );
      expect(missingLicenseReplica.status).not.toBe(0);
      expect(missingLicenseReplica.stderr).toContain(
        "LICENSE_REPLICA_URL is unset; refusing to start production"
      );
      expect(existsSync(tracePath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("documents owner-gated DR proof without claiming live replication from this source-only slice", () => {
    const deployRunbook = readServiceFile("docs/deploy.md");
    const adminRunbook = readServiceFile("docs/admin-runbook.md");
    const drRunbook = readServiceFile("docs/disaster-recovery.md");
    const lifecycleRunbook = readServiceFile("docs/subscription-lifecycle.md");
    const serviceReadme = readServiceFile("README.md");

    expect(deployRunbook).toContain("disaster-recovery.md");
    expect(adminRunbook).toContain("disaster-recovery.md");
    expect(drRunbook).toContain("RPO target: <= 5 minutes");
    expect(drRunbook).toContain("RTO target: <= 30 minutes");
    expect(drRunbook).toContain("Owner-gated");
    expect(drRunbook).toContain("flyctl secrets set");
    expect(drRunbook).toContain("timed staging restore drill");
    expect(drRunbook).toContain("This source-only PR does not prove live replication");
    expect(drRunbook).toContain("offlineGraceMs=0");
    expect(drRunbook).toContain("diagnostic only");
    expect(drRunbook).toContain("pre-v2");
    expect(drRunbook).toContain("fresh path or volume");
    expect(drRunbook).toContain("Image rollback does not reverse the SQLite schema migration");
    expect(drRunbook).toContain("Migration failure prevents the service from starting");
    expect(drRunbook).toContain("Never copy an open SQLite database");
    expect(drRunbook).toContain('PRE_V2_RECOVERY_TIMESTAMP="<recorded-rfc3339-timestamp>"');
    expect(drRunbook).toContain('FRESH_RESTORE_PATH="<fresh-nonexistent-license-db-path>"');
    expect(drRunbook).toContain(
      'litestream restore -timestamp "$PRE_V2_RECOVERY_TIMESTAMP" -config "$LITESTREAM_CONFIG" -o "$FRESH_RESTORE_PATH" "$LICENSE_DB_PATH"'
    );
    expect(drRunbook).toContain('node /app/dist/verify-legacy-restore.js "$FRESH_RESTORE_PATH"');
    expect(drRunbook).not.toContain('sqlite3 "$FRESH_RESTORE_PATH"');
    expect(drRunbook).toContain("exact legacy schema signature");
    expect(drRunbook).toContain("non-writing replica destination");
    expect(deployRunbook).toContain("point-in-time restore command");
    expect(lifecycleRunbook).toContain("point-in-time restore command");
    expect(drRunbook).not.toMatch(/rollback[\s\S]{0,500}restore -if-replica-exists/i);
    expect(adminRunbook).toContain("bind-checkout-subscription");
    expect(adminRunbook).toContain("--dry-run");
    expect(adminRunbook).toContain("No raw-key recovery or replacement-key minting");
    expect(deployRunbook).toContain("Checkout remains held");
    expect(deployRunbook).toContain("#559");
    expect(lifecycleRunbook).toContain("POST /v1/admin/licenses/lifecycle");
    expect(lifecycleRunbook).toContain("renew_paid");
    expect(lifecycleRunbook).toContain("reconcile");
    expect(lifecycleRunbook).toContain("cancel_at_period_end");
    expect(lifecycleRunbook).toContain("payment_attention");
    expect(lifecycleRunbook).toContain("revoke");
    expect(lifecycleRunbook).toContain("Checkout remains held");
    expect(lifecycleRunbook).toContain("#559");
    expect(adminRunbook).not.toContain("copy of the volume");
    expect(adminRunbook).not.toContain("revoke and re-issue");
    expect(deployRunbook).not.toContain("flip license.enabled");
    expect(deployRunbook).not.toContain("There is no in-app migration system");
    expect(drRunbook).not.toContain("inside the configured offline grace window");
    expect(drRunbook).not.toContain("-force");
    expect(serviceReadme).toContain(
      "Activation, validation, and deactivation use per-license-key rate limiting."
    );
    expect(serviceReadme).toContain(
      "Subscription lifecycle and release-lifecycle issuance use separate client-address rate-limit budgets."
    );
    expect(serviceReadme).not.toContain("Cross-cutting: 429");
    expect(drRunbook).not.toContain("/Volumes/LEXAR/Codex");
    expect(drRunbook).not.toMatch(/AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|secret-access-key:\s+\S|account-key:\s+\S/i);
  });

  it("executes the shipped Node verifier against a real legacy restore and rejects non-legacy schema", () => {
    const root = mkdtempSync(join(tmpdir(), "nd-license-restore-verifier-"));
    try {
      const alternateCwd = join(root, "alternate-cwd");
      const compiledRoot = join(root, "compiled-license-api");
      mkdirSync(alternateCwd);
      execFileSync(process.execPath, [
        licenseApiTypescriptCompiler,
        "-p",
        licenseApiTypescriptConfig,
        "--outDir",
        compiledRoot
      ], { cwd: alternateCwd, stdio: "pipe" });
      const legacyRestoreVerifier = join(compiledRoot, "verify-legacy-restore.js");
      const legacyPath = join(root, "legacy.sqlite");
      const legacyDb = new DatabaseSync(legacyPath);
      legacyDb.exec(legacySchema);
      legacyDb.exec(litestreamInternalSchema);
      legacyDb.prepare("insert into _litestream_lock (id) values (?)").run(1);
      legacyDb.prepare("insert into _litestream_seq (id, seq) values (?, ?)").run(1, 3170);
      legacyDb.close();

      const verified = execFileSync(
        process.execPath,
        [legacyRestoreVerifier, legacyPath],
        { cwd: alternateCwd, encoding: "utf8" }
      );
      expect(verified.trim()).toBe("legacy restore verification ok");

      const lookalikePath = join(root, "litestream-lookalike.sqlite");
      const lookalikeDb = new DatabaseSync(lookalikePath);
      lookalikeDb.exec(legacySchema);
      lookalikeDb.exec(`
        create table _litestream_lock (id text);
        create table _litestream_seq (id integer primary key, seq integer);
      `);
      lookalikeDb.close();
      expect(() => execFileSync(
        process.execPath,
        [legacyRestoreVerifier, lookalikePath],
        { cwd: alternateCwd, encoding: "utf8", stdio: "pipe" }
      )).toThrow();

      const v2Path = join(root, "v2.sqlite");
      const v2Store = new LicenseStore(v2Path);
      v2Store.close();
      expect(() => execFileSync(
        process.execPath,
        [legacyRestoreVerifier, v2Path],
        { cwd: alternateCwd, encoding: "utf8", stdio: "pipe" }
      )).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("license service mandatory-online outage behavior", () => {
  const roots: string[] = [];
  const stores: LicenseStore[] = [];

  afterEach(async () => {
    for (const store of stores.splice(0)) store.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("creates a diagnostic cache from real activation but never authorizes review during an outage", async () => {
    const root = mkdtempSync(join(tmpdir(), "nd-license-dr-"));
    roots.push(root);
    const store = new LicenseStore(join(root, "license.sqlite"));
    stores.push(store);
    const issued = store.issueLicense({ plan: "yearly", repoVisibilityScope: "private", seats: 1 });
    const base = new Date("2026-07-08T00:00:00.000Z");
    const config = licenseConfig(root, "http://127.0.0.1:8080");

    const activated = await activateLicense({
      config,
      licenseKey: issued.rawKey,
      repo: "owner/private",
      now: base,
      fetchImpl: serviceFetchFor(store, "machine-a")
    });
    expect(activated).toMatchObject({ ok: true, status: "active", source: "api" });
    expect(existsSync(join(root, "entitlement.json"))).toBe(true);

    const outageStatus = await getLicenseStatus({
      config,
      repo: "owner/private",
      refresh: true,
      now: new Date(base.getTime() + 1),
      fetchImpl: outageFetch
    });
    expect(outageStatus).toMatchObject({
      ok: false,
      status: "network",
      source: "none",
      classification: "network"
    });

    const outageGate = await evaluateLicenseReviewGate({
      config,
      repo: "owner/private",
      visibility: "private",
      refresh: true,
      now: new Date(base.getTime() + 1),
      fetchImpl: outageFetch
    });
    expect(outageGate).toMatchObject({ ok: false, status: "network" });
    expect(outageGate.reason).toContain("license API network failure");
    expect(outageGate.reason).toContain("requires active entitlement");
  });
});
