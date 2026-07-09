import { readFileSync } from "node:fs";
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
});
