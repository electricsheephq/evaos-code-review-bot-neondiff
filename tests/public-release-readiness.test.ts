import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("NeonDiff public release readiness", () => {
  it("declares the public npm package identity and a narrow publish surface", () => {
    const pkg = JSON.parse(read("package.json")) as {
      name?: string;
      version?: string;
      private?: boolean;
      description?: string;
      license?: string;
      homepage?: string;
      repository?: { type?: string; url?: string };
      bin?: Record<string, string>;
      files?: string[];
    };
    const lock = JSON.parse(read("package-lock.json")) as {
      name?: string;
      version?: string;
      packages?: Record<string, { name?: string; version?: string; license?: string; bin?: Record<string, string> }>;
    };
    const manifest = JSON.parse(read("docs/public-release-manifest.json")) as {
      packageArtifact?: {
        name?: string;
        version?: string;
        requiredForThisRelease?: boolean;
        state?: string;
        heldReason?: string;
        currentSourceVersion?: string;
        previousReleasedPackageVersion?: string;
      };
    };

    expect(pkg.name).toBe("neondiff");
    expect(pkg.version).toBe("0.4.24-beta.1");
    expect(pkg.private).toBeUndefined();
    expect(pkg.description).toMatch(/local-first AI PR reviewer/i);
    expect(pkg.license).toBe("SEE LICENSE IN LICENSE.md");
    expect(pkg.homepage).toBe("https://www.neondiff.com");
    expect(pkg.repository).toMatchObject({
      type: "git",
      url: "git+https://github.com/electricsheephq/evaos-code-review-bot-neondiff.git"
    });
    expect(pkg.bin).toEqual({ neondiff: "dist/src/cli.js" });
    expect(pkg.files).toEqual([
      "dist/src",
      "README.md",
      "LICENSE.md",
      "SECURITY.md",
      "CODE_OF_CONDUCT.md",
      "config.example.json",
      "docs/SETUP.md",
      "docs/github-app-setup.md",
      "docs/providers.md",
      "docs/license-boundary.md",
      "docs/pricing.md",
      "docs/schema/neondiff-config.schema.json"
    ]);

    expect(lock.name).toBe("neondiff");
    expect(lock.version).toBe("0.4.24-beta.1");
    expect(lock.packages?.[""]).toMatchObject({
      name: "neondiff",
      version: "0.4.24-beta.1",
      license: "SEE LICENSE IN LICENSE.md",
      bin: { neondiff: "dist/src/cli.js" }
    });
    expect(manifest.packageArtifact).toMatchObject({
      name: "neondiff",
      version: "0.4.24-beta.1",
      requiredForThisRelease: false,
      state: "held_at_previous_npm_release",
      currentSourceVersion: "v0.4.28-beta.1",
      previousReleasedPackageVersion: "0.4.24-beta.1"
    });
    expect(manifest.packageArtifact?.heldReason).toMatch(/source\/daemon-only live beta/i);
  });

  it("ships the canonical install script contract", () => {
    expect(existsSync("scripts/install.sh")).toBe(true);
    const script = read("scripts/install.sh");

    expect(script).toMatch(/NEONDIFF_VERSION="\$\{NEONDIFF_VERSION:-0\.4\.24-beta\.1\}"/);
    expect(script).toMatch(/npm[^\n]+install[^\n]+-g[^\n]+neondiff@\$\{NEONDIFF_VERSION\}/);
    expect(script).toMatch(/--dry-run/);
    expect(script).toMatch(/Node\.js 26 or newer/);
    expect(script).not.toMatch(/ghp_|github_pat_|BEGIN (RSA|OPENSSH|PRIVATE) KEY|sk-[A-Za-z0-9]/);
  });

  it("public setup docs point to npm, install script, source fallback, and the public implementation repo", () => {
    const docs = [
      read("README.md"),
      read("docs/SETUP.md"),
      read("docs/github-app-setup.md"),
      read("docs/providers.md"),
      read("docs/license-boundary.md"),
      read("docs/releases/v0.4.24-beta.1.md")
    ].join("\n\n");
    const legacyRepoReferences = docs
      .split(/\s+/)
      .filter(
        (token) =>
          token.includes("github.com/electricsheephq/evaos-code-review-bot") &&
          !token.includes("github.com/electricsheephq/evaos-code-review-bot-neondiff")
      );

    expect(docs).toContain("https://github.com/electricsheephq/evaos-code-review-bot-neondiff");
    expect(docs).toMatch(/npm install -g neondiff@0\.4\.24-beta\.1/i);
    expect(docs).toMatch(/curl -fsSL https:\/\/www\.neondiff\.com\/install/i);
    expect(docs).toContain("git clone https://github.com/electricsheephq/evaos-code-review-bot-neondiff.git");
    expect(legacyRepoReferences).toEqual([]);
    expect(docs).not.toMatch(/npm link installs the local source-checkout shim/i);
  });

  it("CI workflows gate build, tests, package, docs claims, and npm provenance publish", () => {
    for (const path of [".github/workflows/ci.yml", ".github/workflows/publish-npm.yml"]) {
      expect(existsSync(path)).toBe(true);
    }

    const ci = read(".github/workflows/ci.yml");
    const publish = read(".github/workflows/publish-npm.yml");

    expect(ci).toMatch(/node-version:\s*26/);
    expect(ci).toMatch(/npm ci/);
    expect(ci).toMatch(/npm run build/);
    expect(ci).toMatch(/tests\/public-release-readiness\.test\.ts/);
    expect(ci).toMatch(/npm pack --dry-run --json/);
    expect(ci).toMatch(/forbidden public claims/i);
    expect(ci).toMatch(/secret/i);

    expect(publish).toMatch(/id-token:\s*write/);
    expect(publish).toMatch(/NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.NPM_TOKEN\s*\}\}/);
    expect(publish).toMatch(/npm publish --provenance/);
    expect(publish).toMatch(/v0\.4\.24-beta\.1/);
  });
});
