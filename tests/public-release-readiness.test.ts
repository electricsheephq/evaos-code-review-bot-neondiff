import { createHash } from "node:crypto";
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
        previousReleasedPackageVersion?: string;
        skippedPublicPackageVersions?: string[];
        note?: string;
      };
      source?: {
        shaState?: string;
        candidateHeadBeforeReleaseMetadata?: string;
        proof?: string;
      };
      releaseStages?: {
        launchCutLine?: string;
        stages?: Array<{
          id?: string;
          requiredForV1?: boolean;
          allowedClaims?: string[];
          forbiddenClaims?: string[];
        }>;
      };
      updateChannels?: Record<string, {
        requiredForThisRelease?: boolean;
        state?: string;
        trackingIssue?: string;
      }>;
    };

    expect(pkg.name).toBe("neondiff");
    expect(pkg.version).toBe("1.0.0");
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
      "docs/ci-runner.md",
      "docs/docker.md",
      "docs/github-app-setup.md",
      "docs/providers.md",
      "docs/license-boundary.md",
      "docs/pricing.md",
      "docs/schema/neondiff-config.schema.json",
      "docs/systemd.md",
      "systemd/neondiff.service.example",
      "systemd/neondiff.user.service.example",
      "Dockerfile",
      "docker-compose.example.yml"
    ]);

    expect(lock.name).toBe("neondiff");
    expect(lock.version).toBe("1.0.0");
    expect(lock.packages?.[""]).toMatchObject({
      name: "neondiff",
      version: "1.0.0",
      license: "SEE LICENSE IN LICENSE.md",
      bin: { neondiff: "dist/src/cli.js" }
    });
    expect(manifest.packageArtifact).toMatchObject({
      name: "neondiff",
      version: "1.0.0",
      requiredForThisRelease: true,
      state: "pending_publish_after_merge",
      previousReleasedPackageVersion: "0.4.30-beta.1"
    });
    expect(manifest.packageArtifact?.skippedPublicPackageVersions).toContain("v0.4.29-beta.1");
    expect(manifest.packageArtifact?.skippedPublicPackageVersions).toContain("v0.4.36-beta.1");
    expect(manifest.packageArtifact?.skippedPublicPackageVersions).toContain("v0.4.37-beta.1");
    expect(manifest.packageArtifact?.skippedPublicPackageVersions).toContain("v0.4.38-beta.1");
    expect(manifest.packageArtifact?.skippedPublicPackageVersions).toContain("v0.4.39-beta.1");
    expect(manifest.packageArtifact?.skippedPublicPackageVersions).toContain("v0.4.40-beta.1");
    expect(manifest.packageArtifact?.skippedPublicPackageVersions).toContain("v0.4.41-beta.1");
    expect(manifest.packageArtifact?.skippedPublicPackageVersions).toContain("v0.4.42-beta.1");
    expect(manifest.packageArtifact?.skippedPublicPackageVersions).toContain("v0.4.43-beta.1");
    expect(manifest.packageArtifact?.skippedPublicPackageVersions).toContain("v0.4.44-beta.1");
    expect(manifest.packageArtifact?.skippedPublicPackageVersions).toContain("v0.4.45-beta.1");
    expect(manifest.packageArtifact?.skippedPublicPackageVersions).toContain("v0.4.46-beta.1");
    expect(manifest.packageArtifact?.note).toMatch(/first GA npm package/i);
    expect(manifest.source).toMatchObject({
      shaState: "pending_tag_stamp",
      candidateHeadBeforeReleaseMetadata: "7453349008ca8f23641fab1665ac909d0b51b10a"
    });
    expect(manifest.source?.proof).toMatch(/after merge and tag/i);
    expect(manifest.releaseStages?.launchCutLine).toBe(
      "1.0 is a usable local HTML installer/dashboard plus minimal Mac launcher, not full signed desktop maturity."
    );
    expect(manifest.releaseStages?.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "cli-dashboard-ga",
          requiredForV1: true,
          allowedClaims: expect.arrayContaining(["npm install -g neondiff", "neondiff dashboard opens a local HTML dashboard"]),
          forbiddenClaims: expect.arrayContaining(["signed desktop artifact", "Sparkle appcast or auto-update readiness"])
        }),
        expect.objectContaining({
          id: "minimal-mac-launcher-ga",
          requiredForV1: true,
          allowedClaims: expect.arrayContaining(["minimal Mac icon/app launcher opens the same local dashboard"]),
          forbiddenClaims: expect.arrayContaining(["full native Swift desktop maturity"])
        }),
        expect.objectContaining({
          id: "signed-appcast-desktop-post-launch",
          requiredForV1: false,
          allowedClaims: expect.arrayContaining(["signed/notarized desktop and appcast only after #449/#116 proof"])
        })
      ])
    );
    expect(manifest.updateChannels?.browserDashboard).toMatchObject({
      requiredForThisRelease: true,
      state: "published",
      trackingIssue: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/443"
    });
    expect(manifest.updateChannels?.desktop).toBeUndefined();
  });

  it("requires the live production license API and checkout issuance for GA", () => {
    const manifest = JSON.parse(read("docs/public-release-manifest.json")) as {
      licenseApi?: {
        requiredForThisRelease?: boolean;
        state?: string;
        trackingIssue?: string;
        healthUrl?: string;
        healthProofPath?: string;
        checkoutIssuanceRequiredForThisRelease?: boolean;
        checkoutIssuanceUrl?: string;
        checkoutIssuanceProofPath?: string;
        checkoutIssuanceAuthenticatedProofPath?: string;
        checkoutIssuanceState?: string;
        checkoutIssuanceTrackingIssue?: string;
      };
    };

    expect(manifest.licenseApi).toMatchObject({
      requiredForThisRelease: true,
      state: "healthy",
      checkoutIssuanceRequiredForThisRelease: true,
      checkoutIssuanceUrl: "https://neondiff-license.fly.dev/v1/admin/licenses/issue",
      checkoutIssuanceState: "ready",
      checkoutIssuanceProofPath: "docs/evidence/v1.0.0-license-checkout-issuance-unauthenticated.json",
      checkoutIssuanceAuthenticatedProofPath: "docs/evidence/license-checkout-issuance-authenticated.json",
      checkoutIssuanceTrackingIssue: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/421"
    });
    expect(manifest.licenseApi?.trackingIssue).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/);
    expect(manifest.licenseApi?.healthUrl).toMatch(/^https:\/\/[^/]+\/healthz$/);
    expect(manifest.licenseApi?.healthProofPath).toBe("docs/evidence/v1.0.0-license-api-healthz.json");

    const proof = JSON.parse(read(manifest.licenseApi?.healthProofPath ?? "")) as {
      evidenceKind?: string;
      releaseVersion?: string;
      url?: string;
      statusCode?: number;
      responseBody?: string;
      responseBodySha256?: string;
    };
    expect(proof).toMatchObject({
      evidenceKind: "license_api_healthz",
      releaseVersion: "v1.0.0",
      url: manifest.licenseApi?.healthUrl,
      statusCode: 200,
      responseBody: "{\"status\":\"ok\"}"
    });
    expect(createHash("sha256").update(proof.responseBody ?? "").digest("hex")).toBe(proof.responseBodySha256);

    const issuanceProof = JSON.parse(read(manifest.licenseApi?.checkoutIssuanceProofPath ?? "")) as {
      evidenceKind?: string;
      releaseVersion?: string;
      statusCode?: number;
      responseBody?: string;
      responseBodySha256?: string;
    };
    expect(issuanceProof).toMatchObject({
      evidenceKind: "license_api_checkout_issuance",
      releaseVersion: "v1.0.0",
      statusCode: 401,
      responseBody: expect.stringContaining("\"unauthorized\"")
    });
    expect(createHash("sha256").update(issuanceProof.responseBody ?? "").digest("hex")).toBe(issuanceProof.responseBodySha256);

    const authenticatedProof = JSON.parse(read(manifest.licenseApi?.checkoutIssuanceAuthenticatedProofPath ?? "")) as {
      evidenceKind?: string;
      releaseVersion?: string;
      statusCode?: number;
      redactedResponse?: { issuedLicensePrefix?: string; issuedLicenseFingerprint?: string };
    };
    expect(authenticatedProof).toMatchObject({
      evidenceKind: "license_api_checkout_issuance_authenticated",
      releaseVersion: "v1.0.0",
      statusCode: 200,
      redactedResponse: {
        issuedLicensePrefix: "nd_live_",
        issuedLicenseFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
      }
    });
    expect(JSON.stringify(authenticatedProof)).not.toMatch(/licenseKey|Bearer |LICENSE_ISSUANCE_SECRET/);
  });

  it("ships the canonical install script contract", () => {
    expect(existsSync("scripts/install.sh")).toBe(true);
    const script = read("scripts/install.sh");

    expect(script).toMatch(/NEONDIFF_VERSION="\$\{NEONDIFF_VERSION:-1\.0\.0\}"/);
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
      read("docs/releases/v1.0.0.md")
    ].join("\n\n");
    const legacyRepoReferences = docs
      .split(/\s+/)
      .filter(
        (token) =>
          token.includes("github.com/electricsheephq/evaos-code-review-bot") &&
          !token.includes("github.com/electricsheephq/evaos-code-review-bot-neondiff")
      );

    expect(docs).toContain("https://github.com/electricsheephq/evaos-code-review-bot-neondiff");
    expect(docs).toMatch(/npm install -g neondiff(?!@)/i);
    expect(docs).toMatch(/neondiff dashboard --config config\.local\.json/i);
    expect(docs).toMatch(/Verify API Key/i);
    expect(docs).toMatch(/license\s+status,\s+GitHub App status,\s+daemon status,\s+and provider readiness/i);
    expect(docs).toMatch(/curl -fsSL https:\/\/www\.neondiff\.com\/install/i);
    expect(docs).toContain("git clone https://github.com/electricsheephq/evaos-code-review-bot-neondiff.git");
    expect(legacyRepoReferences).toEqual([]);
    expect(docs).not.toMatch(/npm link installs the local source-checkout shim/i);
  });

  it("keeps the GitHub Marketplace free-listing packet bounded to discoverability", () => {
    expect(existsSync("docs/github-marketplace-free-listing.md")).toBe(true);

    const listing = read("docs/github-marketplace-free-listing.md");
    const publicClaims = read("scripts/check-public-claims.mjs");
    const pkg = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };

    expect(publicClaims).toContain("\"docs/github-marketplace-free-listing.md\"");
    expect(pkg.scripts?.["check:public-claims"]).toBe("node scripts/check-public-claims.mjs");

    expect(listing).toContain("Issue: #428");
    expect(listing).toContain("free discoverability listing");
    expect(listing).toContain("No Marketplace billing is shipped by this packet");
    expect(listing).toContain("owner clicks the final Marketplace publish button");
    expect(listing).toContain("https://docs.github.com/en/apps/github-marketplace/creating-apps-for-github-marketplace/requirements-for-listing-an-app");
    expect(listing).toContain("https://docs.github.com/en/apps/github-marketplace/selling-your-app-on-github-marketplace/pricing-plans-for-github-marketplace-apps");
    expect(listing).toContain("https://docs.github.com/en/apps/github-marketplace/listing-an-app-on-github-marketplace");
    expect(listing).toMatch(/Public open-source repositories are free/i);
    expect(listing).toMatch(/Private and commercial repository\s+review requires a paid NeonDiff support license/i);
    expect(listing).toMatch(/provider\/model costs stay external/i);
    expect(listing).toMatch(/support@electricsheephq\.com/);
    expect(listing).toMatch(/Security\.md/);
    expect(listing).toMatch(/Publish blocker: provide a valid privacy-policy URL/i);
    expect(listing).toMatch(/Publish blocker: implement or explicitly defer Marketplace purchase-event\s+webhooks/i);
    expect(listing).toMatch(/Publish blocker: create Marketplace logo and feature-card assets/i);
    expect(listing).toMatch(/Do not paste beta or public-preview wording into the Marketplace listing/i);
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
    expect(publish).toMatch(/--tag beta/);
    expect(publish).toMatch(/github\.event_name == 'release'/);
    expect(publish).not.toMatch(/github\.event\.release\.prerelease\s*==\s*true/);
    expect(publish).toMatch(/Classify npm package release/);
    expect(publish).toMatch(/Skipping npm publish for source-only prerelease/);
    expect(publish).toMatch(/Manual npm publish tag .* does not match package\.json version/);
    expect(publish).toMatch(/docs\/public-release-manifest\.json/);
    expect(publish).toMatch(/skippedPublicPackageVersions/);
    expect(publish.match(/if: steps\.package_release\.outputs\.should_publish == 'true'/g)).toHaveLength(5);
    expect(publish).toMatch(/require\('\.\/package\.json'\)\.version/);
    expect(publish).toMatch(/already exists; verifying dist-tags/);
  });
});
