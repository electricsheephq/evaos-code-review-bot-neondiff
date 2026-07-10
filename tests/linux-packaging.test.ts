import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Linux daemon packaging", () => {
  it("ships systemd, Docker, and CI-runner operator assets", () => {
    const systemdDocs = readFileSync("docs/systemd.md", "utf8");
    const dockerDocs = readFileSync("docs/docker.md", "utf8");
    const ciDocs = readFileSync("docs/ci-runner.md", "utf8");
    const userUnit = readFileSync("systemd/neondiff.user.service.example", "utf8");
    const systemUnit = readFileSync("systemd/neondiff.service.example", "utf8");
    const dockerfile = readFileSync("Dockerfile", "utf8");
    const compose = readFileSync("docker-compose.example.yml", "utf8");
    const linuxSmokeWorkflow = readFileSync(".github/workflows/linux-daemon-smoke.yml", "utf8");

    expect(systemdDocs).toContain("systemctl --user");
    expect(systemdDocs).toContain("EnvironmentFile");
    expect(systemdDocs).toContain("journalctl --user -u neondiff");
    expect(dockerDocs).toContain("docker compose");
    expect(dockerDocs).toContain("ollama");
    expect(ciDocs).toContain("GitHub Actions");
    expect(ciDocs).toContain("ubuntu-latest");

    expect(userUnit).toContain("ExecStart=/usr/bin/env neondiff daemon");
    expect(userUnit).toContain("EnvironmentFile=%h/.config/neondiff/neondiff.env");
    expect(userUnit).toContain("Restart=on-failure");
    expect(systemUnit).toContain("User=neondiff");
    expect(systemUnit).toContain("EnvironmentFile=/etc/neondiff/neondiff.env");
    expect(systemUnit).toContain("Restart=on-failure");

    expect(dockerfile).toContain("FROM node:26");
    expect(dockerfile).toContain("HEALTHCHECK");
    expect(dockerfile).toContain("/proc/1/cmdline");
    expect(dockerfile).toContain("\\bdaemon\\b");
    expect(dockerfile).toContain("neondiff daemon");
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).toContain("\"--dry-run\", \"true\"");
    expect(compose).toContain("neondiff:");
    expect(compose).toContain("ollama:");
    expect(compose).toContain("NEONDIFF_CONFIG=/config/config.local.json");
    expect(compose).toContain("[\"daemon\", \"--config\", \"/config/config.local.json\", \"--dry-run\", \"true\"]");
    expect(dockerDocs).toContain("--dry-run true");
    expect(dockerDocs).toContain("--dry-run\", \"false");
    expect(ciDocs).toContain("actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8 # v5.0.0");
    expect(ciDocs).toContain("actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5");

    expect(linuxSmokeWorkflow).toContain("ubuntu-latest");
    expect(linuxSmokeWorkflow).toContain("NEONDIFF_TEST_PLATFORM: linux");
    expect(linuxSmokeWorkflow).toContain("tests/linux-packaging.test.ts");
    expect(linuxSmokeWorkflow).toContain("node dist/src/cli.js daemon status");
    expect(linuxSmokeWorkflow).toContain("out.command !== \"daemon status\"");
    expect(linuxSmokeWorkflow).toContain("typeof out.error !== \"string\"");
  });

  it("includes Linux operator assets in the npm package allowlist", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    const packlistGuard = readFileSync("scripts/check-packlist.mjs", "utf8");
    const requiredFiles = [
      "docs/systemd.md",
      "docs/docker.md",
      "docs/ci-runner.md",
      "systemd/neondiff.user.service.example",
      "systemd/neondiff.service.example",
      "Dockerfile",
      "docker-compose.example.yml"
    ];

    for (const file of requiredFiles) {
      expect(packageJson.files).toContain(file);
      expect(packlistGuard).toContain(file);
    }
  });

  it("keeps the normal Node and Docker build independent from Swift tooling", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    const postbuild = packageJson.scripts?.postbuild ?? "";
    const dockerfile = readFileSync("Dockerfile", "utf8");
    const scriptsCopy = dockerfile.indexOf("COPY scripts ./scripts");
    const sharedCopy = dockerfile.indexOf("COPY shared ./shared");
    const buildRun = dockerfile.indexOf("RUN npm run build");
    const corpusCleanup = dockerfile.indexOf("rm -rf scripts shared");
    const runtimeCopy = dockerfile.indexOf("COPY --from=build /app /app");

    expect(postbuild).toContain("generate-secret-rules.mjs --check-node");
    expect(postbuild).not.toMatch(/swift|differential/i);
    expect(scriptsCopy).toBeGreaterThanOrEqual(0);
    expect(sharedCopy).toBeGreaterThanOrEqual(0);
    expect(scriptsCopy).toBeLessThan(buildRun);
    expect(sharedCopy).toBeLessThan(buildRun);
    expect(corpusCleanup).toBeGreaterThan(buildRun);
    expect(corpusCleanup).toBeLessThan(runtimeCopy);

    const temporary = mkdtempSync(join(tmpdir(), "neondiff-node-build-contract-"));
    const swiftMarker = join(temporary, "swiftc-invoked");
    const fakeSwift = join(temporary, "swiftc");
    writeFileSync(fakeSwift, `#!/bin/sh\n: > ${JSON.stringify(swiftMarker)}\nexit 91\n`);
    chmodSync(fakeSwift, 0o755);
    try {
      const result = spawnSync("npm", ["run", "build"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, PATH: `${temporary}${delimiter}${process.env.PATH ?? ""}` }
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(existsSync(swiftMarker)).toBe(false);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 30_000);
});
