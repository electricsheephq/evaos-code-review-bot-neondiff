import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

function extractBlock(name: string): string {
  const workflow = readFileSync(".github/workflows/publish-npm.yml", "utf8");
  const beginMarker = `# BEGIN ${name}`;
  const endMarker = `# END ${name}`;
  const begin = workflow.indexOf(beginMarker);
  if (begin < 0) throw new Error(`${beginMarker} is missing`);
  const contentStart = workflow.indexOf("\n", begin) + 1;
  const contentEnd = workflow.indexOf(endMarker, contentStart);
  if (contentEnd < 0) throw new Error(`${endMarker} is missing`);
  const lines = workflow.slice(contentStart, contentEnd).split("\n").filter(Boolean);
  const indent = lines[0]?.match(/^\s*/)?.[0] ?? "";
  return lines.map((line) => {
    if (!line.startsWith(indent)) throw new Error(`${name} indentation is inconsistent`);
    return line.slice(indent.length);
  }).join("\n");
}

describe("v1.0.4 npm provenance recovery workflow", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function harness() {
    const root = mkdtempSync(join(tmpdir(), "neondiff-npm-provenance-recovery-"));
    roots.push(root);
    const bin = join(root, "bin");
    const log = join(root, "npm-mutations.log");
    const npm = join(bin, "npm");
    writeFileSync(join(root, "mkdir.sh"), `mkdir -p ${JSON.stringify(bin)}\n`, { mode: 0o700 });
    spawnSync("bash", [join(root, "mkdir.sh")]);
    writeFileSync(log, "");
    writeFileSync(npm, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$NPM_MUTATION_LOG"\n`, { mode: 0o700 });
    chmodSync(npm, 0o700);
    return { root, bin, log };
  }

  function orchestrationHarness(initialLatest = "1.0.3", initialQuarantine = "1.0.4") {
    const { root, bin, log } = harness();
    const integrity = `sha512-${Buffer.from("reviewed-v1.0.4-tarball").toString("base64")}`;
    const sha512 = Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex");
    const shasum = "1".repeat(40);
    const releaseCommit = "fc66d27b6ab9f6a1eb8282d289ef63407cd96982";
    const mainSha = "a".repeat(40);
    const candidateHead = "42db7c8ff7dba6ceac813238dcebfb54dc83851f";
    const policyScript = resolve("scripts/npm-release-policy.mjs");
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, ".recovery-policy", "scripts"), { recursive: true });
    mkdirSync(join(root, "docs"), { recursive: true });
    mkdirSync(join(root, "evidence"), { recursive: true });
    mkdirSync(join(root, "neondiff-reviewed-pack"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.0.4" }));
    writeFileSync(join(root, "pack.json"), JSON.stringify([{ version: "1.0.4", integrity, shasum }]));
    const evidenceKinds = [
      "production-lifecycle",
      "no-bypass-matrix",
      "useful-work-boundaries",
      "dashboard",
      "desktop",
      "install-upgrade"
    ];
    const artifacts = evidenceKinds.map((kind) => ({ kind, ref: `evidence/${kind}.json` }));
    for (const artifact of artifacts) writeFileSync(join(root, artifact.ref), "{}\n");
    writeFileSync(join(root, "evidence", "activation-proof.json"), JSON.stringify({ artifacts }));
    writeFileSync(join(root, "docs", "public-release-manifest.json"), JSON.stringify({
      source: { candidateHeadBeforeReleaseMetadata: candidateHead },
      licenseApi: { activationProofPath: "evidence/activation-proof.json" },
      packageArtifact: { previousReleasedPackageVersion: "1.0.3" }
    }));
    writeFileSync(join(root, "neondiff-reviewed-pack", "neondiff-1.0.4.tgz"), "reviewed-v1.0.4-tarball");
    writeFileSync(join(root, "scripts", "check-public-release-ready.mjs"), `
      if (process.env.FAIL_STAGE === "readiness") process.exit(41);
    `);
    copyFileSync(policyScript, join(root, ".recovery-policy", "scripts", "npm-release-policy.mjs"));
    const provenanceVerifier = join(root, ".recovery-policy", "scripts", "verify-npm-provenance.mjs");
    writeFileSync(provenanceVerifier, `
      if (process.env.FAIL_STAGE === "provenance") process.exit(42);
      if (process.env.FAIL_STAGE === "provenance-empty") process.exit(0);
      process.stdout.write(JSON.stringify(${JSON.stringify({
        package: "neondiff",
        version: "1.0.4",
        integrity,
        sha512,
        repository: "electricsheephq/evaos-code-review-bot-neondiff",
        workflow: ".github/workflows/publish-npm.yml",
        tag: "v1.0.4",
        commit: releaseCommit
      })}));
    `);
    writeFileSync(join(root, "scripts", "npm-release-policy.mjs"), "throw new Error('tag-root recovery policy must not execute');\n");
    writeFileSync(join(root, "scripts", "verify-npm-provenance.mjs"), "throw new Error('tag-root provenance verifier must not execute');\n");
    const state = join(root, "npm-state");
    writeFileSync(state, `LATEST=${JSON.stringify(initialLatest)}\nQUARANTINE=${JSON.stringify(initialQuarantine)}\nCHANNEL_READS=0\nPACKAGE_READS=0\n`);
    const npm = join(bin, "npm");
    writeFileSync(npm, `#!/usr/bin/env bash
set -euo pipefail
source "$NPM_STATE_FILE"
write_state() {
  printf 'LATEST=%q\\nQUARANTINE=%q\\nCHANNEL_READS=%q\\nPACKAGE_READS=%q\\n' "$LATEST" "$QUARANTINE" "$CHANNEL_READS" "$PACKAGE_READS" > "$NPM_STATE_FILE.tmp"
  mv "$NPM_STATE_FILE.tmp" "$NPM_STATE_FILE"
}
case "\${1:-}" in
  publish)
    printf '%s\\n' "$*" >> "$NPM_MUTATION_LOG"
    ;;
  dist-tag)
    printf '%s\\n' "$*" >> "$NPM_MUTATION_LOG"
    if [ "\${2:-}" = "add" ]; then
      if [ "\${FAIL_STAGE:-}" = "promotion-rejected-error" ]; then exit 47; fi
      LATEST="1.0.4"
    elif [ "\${2:-}" = "rm" ]; then
      QUARANTINE=""
    fi
    write_state
    if [ "\${2:-}" = "add" ] && [ "\${FAIL_STAGE:-}" = "promotion-accepted-error" ]; then exit 47; fi
    ;;
  install)
    if [ "\${FAIL_STAGE:-}" = "signature-install" ]; then exit 43; fi
    ;;
  audit)
    if [ "\${FAIL_STAGE:-}" = "signature" ]; then exit 43; fi
    if [ "\${FAIL_STAGE:-}" = "signature-content" ]; then
      printf '%s\\n' '{"invalid":[{"name":"neondiff"}],"missing":[]}'
      exit 0
    fi
    printf '%s\\n' '{"invalid":[],"missing":[]}'
    ;;
  view)
    if [[ "$*" == *"version dist.integrity dist.shasum gitHead dist.attestations"* ]]; then
      if [ "\${FAIL_STAGE:-}" = "registry" ]; then exit 44; fi
      REMOTE_INTEGRITY=${JSON.stringify(integrity)}
      if [ "\${FAIL_STAGE:-}" = "verify-pack" ]; then REMOTE_INTEGRITY="sha512-mismatch"; fi
      ATTESTATION_URL="https://registry.npmjs.org/-/npm/v1/attestations/neondiff@1.0.4"
      if [ "\${FAIL_STAGE:-}" = "attestation-url" ]; then ATTESTATION_URL="https://example.invalid/untrusted"; fi
      printf '{"version":"1.0.4","dist.integrity":"%s","dist.shasum":"%s","dist.attestations":{"url":"%s"}}\\n' "$REMOTE_INTEGRITY" ${JSON.stringify(shasum)} "$ATTESTATION_URL"
    elif [[ "$*" == *"dist-tags"* ]]; then
      CHANNEL_READS=$((CHANNEL_READS + 1))
      write_state
      if [ "\${FAIL_STAGE:-}" = "channel-registry" ]; then exit 44; fi
      if [ "\${FAIL_STAGE:-}" = "channel-json" ]; then printf '%s\\n' '[]'; exit 0; fi
      if [ "\${FAIL_STAGE:-}" = "prepromotion-channel-registry" ] && [ "$CHANNEL_READS" = "2" ]; then exit 44; fi
      if [ "\${FAIL_STAGE:-}" = "prepromotion-channel-json" ] && [ "$CHANNEL_READS" = "2" ]; then printf '%s\\n' '[]'; exit 0; fi
      if [ -n "$QUARANTINE" ]; then
        printf '{"latest":"%s","release-candidate":"%s"}\\n' "$LATEST" "$QUARANTINE"
      else
        printf '{"latest":"%s"}\\n' "$LATEST"
      fi
    else
      PACKAGE_READS=$((PACKAGE_READS + 1))
      write_state
      if [ "\${FAIL_STAGE:-}" = "package-missing" ]; then exit 44; fi
      if [ "\${FAIL_STAGE:-}" = "package-transient" ] && [ "$PACKAGE_READS" -lt 3 ]; then exit 44; fi
      printf '%s\\n' '1.0.4'
    fi
    ;;
  *)
    echo "unexpected npm command: $*" >&2
    exit 45
    ;;
esac
`, { mode: 0o700 });
    const curl = join(bin, "curl");
    writeFileSync(curl, `#!/usr/bin/env bash
if [ "\${FAIL_STAGE:-}" = "attestation-download" ]; then exit 45; fi
printf '%s\\n' '{}'
`, { mode: 0o700 });
    const gh = join(bin, "gh");
    writeFileSync(gh, `#!/usr/bin/env bash
if [ "\${FAIL_STAGE:-}" = "attestation" ]; then exit 45; fi
exit 0
`, { mode: 0o700 });
    const git = join(bin, "git");
    writeFileSync(git, `#!/usr/bin/env bash
if [ "\${1:-}" = "rev-parse" ] && [ "\${2:-}" = "refs/remotes/origin/main" ]; then
  printf '%s\\n' "\${MAIN_SHA_OVERRIDE:-$GITHUB_SHA}"
elif [ "\${1:-}" = "rev-list" ] && [ "\${2:-}" = "-n" ] && [ "\${3:-}" = "1" ]; then
  printf '%s\\n' "\${TAG_COMMIT_OVERRIDE:-${releaseCommit}}"
else
  echo "unexpected git command: $*" >&2
  exit 46
fi
`, { mode: 0o700 });
    const sleep = join(bin, "sleep");
    writeFileSync(sleep, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });
    for (const executable of [npm, curl, gh, git, sleep]) chmodSync(executable, 0o700);
    return {
      root,
      bin,
      log,
      state,
      provenanceVerifier,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        NPM_MUTATION_LOG: log,
        NPM_STATE_FILE: state,
        FAIL_STAGE: "",
        PROVENANCE_RECOVERY: "true",
        RUNNER_TEMP: root,
        RELEASE_EVENT_NAME: "workflow_dispatch",
        GITHUB_REF: "refs/heads/main",
        WORKFLOW_REF: "electricsheephq/evaos-code-review-bot-neondiff/.github/workflows/publish-npm.yml@refs/heads/main",
        WORKFLOW_SHA: mainSha,
        GITHUB_SHA: mainSha,
        GITHUB_REPOSITORY: "electricsheephq/evaos-code-review-bot-neondiff",
        RELEASE_TAG: "v1.0.4",
        NPM_TAG: "latest",
        NPM_CONFIRM_ATTEMPTS: "2",
        NPM_CONFIRM_DELAY_MS: "0",
        NPM_CONFIRM_TIMEOUT_MS: "1000"
      }
    };
  }

  function runOrchestration(
    overrides: Record<string, string> = {},
    initialState: { latest?: string; quarantine?: string } = {}
  ) {
    const block = extractBlock("V104_PROVENANCE_RECOVERY_MUTATION_GATE");
    const { root, bin, log, state, env } = orchestrationHarness(
      initialState.latest ?? "1.0.3",
      initialState.quarantine ?? "1.0.4"
    );
    if (overrides.REMOVE_FIXTURE === "tarball") {
      rmSync(join(root, "neondiff-reviewed-pack", "neondiff-1.0.4.tgz"));
    } else if (overrides.REMOVE_FIXTURE === "evidence") {
      rmSync(join(root, "evidence", "dashboard.json"));
    } else if (overrides.REMOVE_FIXTURE === "proof-inventory") {
      writeFileSync(join(root, "evidence", "activation-proof.json"), JSON.stringify({ artifacts: [] }));
    } else if (overrides.REMOVE_FIXTURE === "recovery-policy") {
      rmSync(join(root, ".recovery-policy", "scripts", "npm-release-policy.mjs"));
    }
    const environmentOverrides = { ...overrides };
    delete environmentOverrides.REMOVE_FIXTURE;
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", block], {
      cwd: root,
      encoding: "utf8",
      env: { ...env, ...environmentOverrides, PATH: `${bin}:${process.env.PATH}` }
    });
    return {
      result,
      commands: readFileSync(log, "utf8"),
      registryState: readFileSync(state, "utf8")
    };
  }

  it("never publishes from protected-main provenance recovery", () => {
    const block = extractBlock("V104_PROVENANCE_RECOVERY_PUBLISH_GUARD");
    for (const packageAlreadyExists of ["true", "false"]) {
      const { root, bin, log } = harness();
      const result = spawnSync("bash", ["-euo", "pipefail", "-c", block], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          NPM_MUTATION_LOG: log,
          PROVENANCE_RECOVERY: "true",
          PACKAGE_ALREADY_EXISTS: packageAlreadyExists,
          PACKAGE_VERSION: "1.0.4",
          PACK_TARBALL: "/tmp/neondiff-1.0.4.tgz"
        }
      });
      const commands = readFileSync(log, "utf8");
      expect(commands).not.toMatch(/^publish\b/m);
      expect(result.status).toBe(packageAlreadyExists === "true" ? 0 : 1);
    }
  });

  it("blocks foreign predecessor or quarantine ownership before latest mutation", () => {
    const block = extractBlock("V104_PROVENANCE_RECOVERY_PREPROMOTION_GUARD");
    const policyScript = resolve("scripts/npm-release-policy.mjs");
    const rows = [
      { latest: "1.0.3", quarantine: "1.0.4", status: 0, mutation: true },
      { latest: "1.0.3", quarantine: "", status: 1, mutation: false },
      { latest: "1.0.3", quarantine: "9.9.9", status: 1, mutation: false },
      { latest: "1.0.4", quarantine: "", status: 0, mutation: false },
      { latest: "1.0.4", quarantine: "9.9.9", status: 1, mutation: false },
      { latest: "9.9.9", quarantine: "1.0.4", status: 1, mutation: false }
    ];
    for (const row of rows) {
      const { root, bin, log } = harness();
      const result = spawnSync("bash", ["-euo", "pipefail", "-c", block], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          NPM_MUTATION_LOG: log,
          PROVENANCE_RECOVERY: "true",
          POLICY_SCRIPT: policyScript,
          PREPROMOTION_TAG_VERSION: row.latest,
          PREPROMOTION_QUARANTINE_VERSION: row.quarantine,
          PACKAGE_VERSION: "1.0.4",
          EXPECTED_PREDECESSOR: "1.0.3",
          NPM_TAG: "latest"
        }
      });
      const commands = readFileSync(log, "utf8");
      expect(result.status, `${row.latest}/${row.quarantine}`).toBe(row.status);
      expect(commands.includes("dist-tag add neondiff@1.0.4 latest"), `${row.latest}/${row.quarantine}`).toBe(row.mutation);
      if (!row.mutation) expect(commands).not.toMatch(/^dist-tag\s+(?:add|rm)\b/m);
    }
  });

  it("executes the complete recovery mutation gate before promotion and owned cleanup", () => {
    const { result, commands } = runOrchestration();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(commands).toBe([
      "dist-tag add neondiff@1.0.4 latest",
      "dist-tag rm neondiff release-candidate",
      ""
    ].join("\n"));
    expect(commands).not.toMatch(/^publish\b/m);
  });

  it("leaves every npm mutation command unreachable when an upstream recovery gate fails", () => {
    const rows: Array<[string, Record<string, string>]> = [
      ["wrong event", { RELEASE_EVENT_NAME: "release" }],
      ["wrong protected ref", { GITHUB_REF: "refs/tags/v1.0.4" }],
      ["wrong workflow ref", { WORKFLOW_REF: "other" }],
      ["wrong workflow sha", { WORKFLOW_SHA: "b".repeat(40) }],
      ["stale fetched main sha", { MAIN_SHA_OVERRIDE: "b".repeat(40) }],
      ["wrong tag", { RELEASE_TAG: "v1.0.5" }],
      ["wrong tag commit", { TAG_COMMIT_OVERRIDE: "b".repeat(40) }],
      ["recovery-mode downgrade", { PROVENANCE_RECOVERY: "false" }],
      ["missing reviewed tarball", { REMOVE_FIXTURE: "tarball" }],
      ["missing protected-main recovery policy", { REMOVE_FIXTURE: "recovery-policy" }],
      ["invalid activation proof inventory", { REMOVE_FIXTURE: "proof-inventory" }],
      ["missing activation evidence", { REMOVE_FIXTURE: "evidence" }],
      ["activation attestation failure", { FAIL_STAGE: "attestation" }],
      ["package missing", { FAIL_STAGE: "package-missing" }],
      ["readiness failure", { FAIL_STAGE: "readiness" }],
      ["registry failure", { FAIL_STAGE: "registry" }],
      ["untrusted attestation URL", { FAIL_STAGE: "attestation-url" }],
      ["attestation download failure", { FAIL_STAGE: "attestation-download" }],
      ["provenance verifier failure", { FAIL_STAGE: "provenance" }],
      ["missing verified provenance result", { FAIL_STAGE: "provenance-empty" }],
      ["signature package install failure", { FAIL_STAGE: "signature-install" }],
      ["signature audit failure", { FAIL_STAGE: "signature" }],
      ["signature audit invalid result", { FAIL_STAGE: "signature-content" }],
      ["channel registry failure", { FAIL_STAGE: "channel-registry" }],
      ["channel metadata parse failure", { FAIL_STAGE: "channel-json" }],
      ["prepromotion channel registry failure", { FAIL_STAGE: "prepromotion-channel-registry" }],
      ["prepromotion channel parse failure", { FAIL_STAGE: "prepromotion-channel-json" }],
      ["fallback policy failure", { FAIL_STAGE: "verify-pack" }]
    ];
    for (const [name, overrides] of rows) {
      const { result, commands } = runOrchestration(overrides);
      expect(result.status, name).not.toBe(0);
      expect(commands, name).not.toMatch(/^(?:publish|dist-tag\s+(?:add|rm))\b/m);
    }
    for (const [name, state] of [
      ["foreign predecessor", { latest: "9.9.9", quarantine: "1.0.4" }],
      ["foreign quarantine", { latest: "1.0.3", quarantine: "9.9.9" }]
    ] as const) {
      const { result, commands } = runOrchestration({}, state);
      expect(result.status, name).not.toBe(0);
      expect(commands, name).not.toMatch(/^(?:publish|dist-tag\s+(?:add|rm))\b/m);
    }
  }, 60_000);

  it("is idempotent after promotion and owned quarantine cleanup already converged", () => {
    const { result, commands } = runOrchestration({}, { latest: "1.0.4", quarantine: "" });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(commands).toBe("");
  });

  it("converges transient package existence reads before the no-publish recovery guard", () => {
    const { result, commands, registryState } = runOrchestration({ FAIL_STAGE: "package-transient" });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(commands).toBe([
      "dist-tag add neondiff@1.0.4 latest",
      "dist-tag rm neondiff release-candidate",
      ""
    ].join("\n"));
    expect(commands).not.toMatch(/^publish\b/m);
    expect(registryState).toMatch(/^PACKAGE_READS=3$/m);
  });

  it("reconciles both accepted and rejected ambiguous promotion command failures", () => {
    const accepted = runOrchestration({ FAIL_STAGE: "promotion-accepted-error" });
    expect(accepted.result.status, `${accepted.result.stdout}\n${accepted.result.stderr}`).toBe(0);
    expect(accepted.commands).toBe([
      "dist-tag add neondiff@1.0.4 latest",
      "dist-tag rm neondiff release-candidate",
      ""
    ].join("\n"));
    expect(accepted.registryState).toMatch(/^LATEST=1\.0\.4$/m);
    expect(accepted.registryState).toMatch(/^QUARANTINE=''$/m);

    const rejected = runOrchestration({ FAIL_STAGE: "promotion-rejected-error" });
    expect(rejected.result.status).not.toBe(0);
    expect(rejected.commands).toBe("dist-tag add neondiff@1.0.4 latest\n");
    expect(rejected.registryState).toMatch(/^LATEST=1\.0\.3$/m);
    expect(rejected.registryState).toMatch(/^QUARANTINE=1\.0\.4$/m);
    expect(rejected.registryState).toMatch(/^CHANNEL_READS=4$/m);
  });
});
