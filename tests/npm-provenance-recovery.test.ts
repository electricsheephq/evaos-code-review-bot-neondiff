import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
});
