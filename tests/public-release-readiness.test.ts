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
        version?: string;
        rollback?: string;
        rollbackRepository?: string;
        trackingIssue?: string;
        note?: string;
      }>;
    };

    expect(pkg.name).toBe("neondiff");
    expect(pkg.version).toBe("1.0.3");
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
    expect(lock.version).toBe("1.0.3");
    expect(lock.packages?.[""]).toMatchObject({
      name: "neondiff",
      version: "1.0.3",
      license: "SEE LICENSE IN LICENSE.md",
      bin: { neondiff: "dist/src/cli.js" }
    });
    expect(manifest.packageArtifact).toMatchObject({
      name: "neondiff",
      version: "1.0.3",
      requiredForThisRelease: true,
      state: "release_candidate",
      previousReleasedPackageVersion: "1.0.2"
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
    expect(manifest.packageArtifact?.note).toMatch(/CLI\/dashboard npm package/i);
    expect(manifest.packageArtifact?.note).toMatch(/desktop app artifacts are not part of the npm package/i);
    expect(manifest.source).toMatchObject({
      shaState: "pending_tag_stamp",
      candidateHeadBeforeReleaseMetadata: "bcd2f7ace5b190dc86b5f86983aa62aae5e40652"
    });
    expect(manifest.source?.proof).toMatch(/before publish/i);
    expect(manifest.source?.proof).toMatch(/stamp release_candidate.*to published/i);
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
      state: "source_checkout",
      rollback: "git reset --hard refs/tags/v1.0.2",
      rollbackRepository: "electricsheephq/evaos-code-review-bot-neondiff",
      trackingIssue: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/443"
    });
    expect(manifest.updateChannels?.cli).toMatchObject({
      requiredForThisRelease: true,
      state: "source_checkout",
      rollback: "git reset --hard refs/tags/v1.0.2"
    });
    expect(manifest.updateChannels?.daemon).toMatchObject({
      requiredForThisRelease: true,
      state: "source_checkout",
      rollback: "git reset --hard refs/tags/v1.0.2"
    });
    expect(manifest.updateChannels?.website).toBeUndefined();
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
      updateChannels?: Record<string, {
        rollback?: string;
      }>;
    };

    expect(manifest.licenseApi).toMatchObject({
      requiredForThisRelease: true,
      state: "healthy",
      checkoutIssuanceRequiredForThisRelease: true,
      checkoutIssuanceUrl: "https://neondiff-license.fly.dev/v1/admin/licenses/issue",
      checkoutIssuanceState: "ready",
      checkoutIssuanceProofPath: "docs/evidence/v1.0.3-license-checkout-issuance-unauthenticated.json",
      checkoutIssuanceAuthenticatedProofPath: "docs/evidence/v1.0.3-license-checkout-issuance-authenticated.json",
      checkoutIssuanceTrackingIssue: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/421"
    });
    expect(manifest.licenseApi?.trackingIssue).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/);
    expect(manifest.licenseApi?.healthUrl).toMatch(/^https:\/\/[^/]+\/healthz$/);
    expect(manifest.licenseApi?.healthProofPath).toBe("docs/evidence/v1.0.3-license-api-healthz.json");

    const proof = JSON.parse(read(manifest.licenseApi?.healthProofPath ?? "")) as {
      evidenceKind?: string;
      releaseVersion?: string;
      observedAt?: string;
      url?: string;
      statusCode?: number;
      responseBody?: string;
      responseBodySha256?: string;
    };
    expect(proof).toMatchObject({
      evidenceKind: "license_api_healthz",
      releaseVersion: "v1.0.3",
      url: manifest.licenseApi?.healthUrl,
      statusCode: 200,
      responseBody: "{\"status\":\"ok\"}"
    });
    expect(createHash("sha256").update(proof.responseBody ?? "").digest("hex")).toBe(proof.responseBodySha256);

    const issuanceProof = JSON.parse(read(manifest.licenseApi?.checkoutIssuanceProofPath ?? "")) as {
      evidenceKind?: string;
      releaseVersion?: string;
      observedAt?: string;
      statusCode?: number;
      responseBody?: string;
      responseBodySha256?: string;
    };
    expect(issuanceProof).toMatchObject({
      evidenceKind: "license_api_checkout_issuance",
      releaseVersion: "v1.0.3",
      statusCode: 401,
      responseBody: expect.stringContaining("\"unauthorized\"")
    });
    expect(createHash("sha256").update(issuanceProof.responseBody ?? "").digest("hex")).toBe(issuanceProof.responseBodySha256);
    expect(issuanceProof.observedAt).not.toBe(proof.observedAt);

    const authenticatedProof = JSON.parse(read(manifest.licenseApi?.checkoutIssuanceAuthenticatedProofPath ?? "")) as {
      evidenceKind?: string;
      releaseVersion?: string;
      statusCode?: number;
      redactedResponse?: { issuedLicensePrefix?: string; issuedLicenseFingerprint?: string };
    };
    expect(authenticatedProof).toMatchObject({
      evidenceKind: "license_api_checkout_issuance_authenticated",
      releaseVersion: "v1.0.3",
      statusCode: 200,
      redactedResponse: {
        issuedLicensePrefix: "nd_live_",
        issuedLicenseFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
      }
    });
    expect(JSON.stringify(authenticatedProof)).not.toMatch(/licenseKey|Bearer |LICENSE_ISSUANCE_SECRET/);

    const liveCheckoutProof = JSON.parse(read("docs/evidence/v1.0.0-live-checkout-success-redacted.json")) as {
      evidenceKind?: string;
      releaseVersion?: string;
      checkout?: { rawCheckoutSessionRedacted?: boolean };
      webhook?: {
        deliveryProof?: string;
        originalLiveDeliveryProof?: string;
        statusCode?: number;
        responseBody?: string;
        responseBodySha256?: string;
      };
      successPage?: { hasLicenseActive?: boolean; hasCopyButton?: boolean; hasError?: boolean; url?: string };
      proofBoundary?: string;
    };
    expect(liveCheckoutProof).toMatchObject({
      evidenceKind: "live_checkout_success_redacted",
      releaseVersion: "v1.0.0",
      checkout: { rawCheckoutSessionRedacted: true },
      webhook: {
        deliveryProof: "stripe_style_signed_replay_after_schema_fix_not_original_live_delivery",
        originalLiveDeliveryProof: "not_claimed",
        statusCode: 200,
        responseBody: "{\"received\":true}"
      },
      successPage: {
        hasLicenseActive: true,
        hasCopyButton: true,
        hasError: false,
        url: "REDACTED_SUCCESS_URL_WITH_ONE_SHOT_TOKEN"
      }
    });
    expect(createHash("sha256").update(liveCheckoutProof.webhook?.responseBody ?? "").digest("hex")).toBe(
      liveCheckoutProof.webhook?.responseBodySha256
    );
    expect(liveCheckoutProof.proofBoundary).toContain("does not claim the original in-flight Stripe delivery");
    expect(JSON.stringify(liveCheckoutProof)).not.toMatch(/cs_live_|evt_|whsec_|nd_live_[A-Za-z0-9]|session_id=|fulfillment_token=|121 South/i);

    const rollbackProof = JSON.parse(read("docs/evidence/v1.0.3-rollback-refs.json")) as {
      evidenceKind?: string;
      releaseVersion?: string;
      channels?: Record<string, {
        rollbackRepository?: string;
        rollbackCommand?: string;
        operatorRollbackCommand?: string;
        rollbackTarget?: string;
        targetVerifiedBy?: string;
        targetVerifiedSha?: string;
        targetVerifiedShasum?: string;
        targetUrl?: string;
      }>;
    };
    expect(rollbackProof).toMatchObject({
      evidenceKind: "release_rollback_refs",
      releaseVersion: "v1.0.3",
      channels: {
        cli: {
          rollbackRepository: "electricsheephq/evaos-code-review-bot-neondiff",
          rollbackCommand: manifest.updateChannels?.cli?.rollback,
          operatorRollbackCommand: "npm dist-tag add neondiff@1.0.2 latest",
          rollbackTarget: "v1.0.2",
          targetVerifiedBy: "npm view neondiff@1.0.2 version dist.integrity dist.shasum --json",
          targetVerifiedShasum: "d62619b1ee2c539e3230572135a29a299be3a6ed"
        },
        browserDashboard: {
          rollbackRepository: "electricsheephq/evaos-code-review-bot-neondiff",
          rollbackCommand: manifest.updateChannels?.browserDashboard?.rollback,
          operatorRollbackCommand: "npm install -g neondiff@1.0.2",
          rollbackTarget: "v1.0.2",
          targetVerifiedBy: "npm view neondiff@1.0.2 version dist.integrity dist.shasum --json",
          targetVerifiedShasum: "d62619b1ee2c539e3230572135a29a299be3a6ed"
        },
        daemon: {
          rollbackRepository: "electricsheephq/evaos-code-review-bot-neondiff",
          rollbackCommand: manifest.updateChannels?.daemon?.rollback,
          operatorRollbackCommand: "npm install -g neondiff@1.0.2",
          rollbackTarget: "v1.0.2",
          targetVerifiedBy: "npm view neondiff@1.0.2 version dist.integrity dist.shasum --json",
          targetVerifiedShasum: "d62619b1ee2c539e3230572135a29a299be3a6ed"
        },
        website: {
          rollbackRepository: "electricsheephq/neon-diff-agent-website",
          releaseAction: "no_code_deploy_for_v1.0.3",
          currentChannelVersion: "v1.0.1",
          rollbackTarget: "no_action_for_v1.0.3",
          targetVerifiedBy: "docs/public-release-manifest.json omits updateChannels.website for v1.0.3",
          targetVerifiedSha: null
        }
      }
    });
    expect(JSON.stringify(rollbackProof)).not.toContain("<sha>");

    const desktopProof = JSON.parse(read("docs/evidence/v1.0.3-desktop-startup-smoke.json")) as {
      evidenceKind?: string;
      releaseVersion?: string;
      sourceCommitUrl?: string;
      proofBoundary?: string;
      bundleId?: string;
      binarySha256?: string;
      signingIdentityClass?: string;
      nativeUi?: {
        welcomeVisible?: boolean;
        providerStepVisibleAfterContinue?: boolean;
        appRemainedAlive?: boolean;
        securityAgentPresent?: boolean;
        webViewEmbedded?: boolean;
      };
      macos15ReleaseSmoke?: {
        workflowHead?: string;
        appArtifactId?: number;
        appArtifactName?: string;
        appArchiveSha256?: string;
        metadataArtifactId?: number;
        coreChecksCompiled?: boolean;
        keychainChecksCompiled?: boolean;
        unsignedBundlePackaged?: boolean;
      };
      redaction?: {
        localPathsRemoved?: boolean;
        tokensRemoved?: boolean;
      };
      artifactRelationship?: {
        visibleLocalBundleSourceIsCandidateAncestor?: boolean;
        hostedWorkflowSourceIsCandidateAncestor?: boolean;
        visibleLocalSourcesMatchMergedCandidate?: boolean;
        hostedReleaseSurfaceMatchesMergedCandidate?: boolean;
        verification?: string;
      };
    };
    expect(desktopProof).toMatchObject({
      evidenceKind: "desktop_startup_smoke_redacted",
      releaseVersion: "v1.0.3",
      sourceCommitUrl: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/commit/b22b81ca85a41abe888f3054eea25bb397d08d68",
      bundleId: "com.electricsheephq.NeonDiffDesktop",
      binarySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      signingIdentityClass: "unsigned-dev",
      nativeUi: {
        welcomeVisible: true,
        providerStepVisibleAfterContinue: true,
        appRemainedAlive: true,
        securityAgentPresent: false,
        webViewEmbedded: false
      },
      macos15ReleaseSmoke: {
        workflowHead: "9eba343c8e69e832978e51c0fb63527b61939760",
        appArtifactId: 8211347648,
        appArtifactName: "neondiff-desktop-unsigned-app",
        appArchiveSha256: "f546568f0e10ebc7abd4adcf99cc40af8a96ad635bf3fbb6333195d0a8d1a7e7",
        metadataArtifactId: 8211347876,
        coreChecksCompiled: true,
        keychainChecksCompiled: true,
        unsignedBundlePackaged: true
      },
      redaction: {
        localPathsRemoved: true,
        tokensRemoved: true
      },
      artifactRelationship: {
        visibleLocalBundleSourceIsCandidateAncestor: false,
        hostedWorkflowSourceIsCandidateAncestor: false,
        visibleLocalSourcesMatchMergedCandidate: true,
        hostedReleaseSurfaceMatchesMergedCandidate: true,
        verification: expect.stringContaining(".github/workflows/swift-desktop-gate.yml")
      }
    });
    expect(desktopProof.artifactRelationship?.verification).not.toContain(".github/workflows/swift-desktop.yml");
    expect(JSON.stringify(desktopProof)).not.toContain("appcastChecksPassed");
    expect(desktopProof.proofBoundary).toMatch(/signing/i);
    expect(JSON.stringify(desktopProof)).not.toMatch(/\/Volumes\/LEXAR|\/Users\/lume|ghp_|github_pat_|nd_live_|session_id=/);
  });

  it("ships the canonical install script contract", () => {
    expect(existsSync("scripts/install.sh")).toBe(true);
    const script = read("scripts/install.sh");

    expect(script).toMatch(/NEONDIFF_VERSION="\$\{NEONDIFF_VERSION:-1\.0\.3\}"/);
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
      read("docs/releases/v1.0.3.md")
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
    expect(docs).toMatch(/Public repo review may run without a license when `license\.publicReposFree`\s+is true/i);
    expect(docs).toMatch(/private repo review fails closed before worktree prep,\s+model\/provider calls,\s+or\s+GitHub review posting/i);
    expect(docs).toMatch(/curl -fsSL https:\/\/www\.neondiff\.com\/install/i);
    expect(docs).toContain("git clone https://github.com/electricsheephq/evaos-code-review-bot-neondiff.git");
    expect(legacyRepoReferences).toEqual([]);
    expect(docs).not.toMatch(/npm link installs the local source-checkout shim/i);
    expect(read("docs/releases/v1.0.3.md")).not.toMatch(/\/Volumes\/LEXAR|\/Users\/lume/);
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
    const releasePolicy = read("scripts/npm-release-policy.mjs");

    expect(ci).toMatch(/node-version:\s*26/);
    expect(ci).toContain("actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8 # v5.0.0");
    expect(ci).toContain("actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5");
    expect(ci).not.toMatch(/uses:\s*actions\/(?:checkout|setup-node)@v\d+/);
    expect(ci).toMatch(/npm ci/);
    expect(ci).toMatch(/npm run build/);
    expect(ci).toMatch(/tests\/public-release-readiness\.test\.ts/);
    expect(ci).toMatch(/npm pack --dry-run --json/);
    expect(ci).toMatch(/forbidden public claims/i);
    expect(ci).toMatch(/secret/i);

    expect(publish).toMatch(/id-token:\s*write/);
    expect(publish).toMatch(/concurrency:\s*\n\s*group:\s*publish-npm-neondiff/);
    expect(publish).toMatch(/cancel-in-progress:\s*false/);
    expect(publish).toContain("actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8 # v5.0.0");
    expect(publish).toContain("actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5");
    expect(publish).toMatch(/persist-credentials:\s*false/);
    expect(publish).not.toMatch(/uses:\s*actions\/(?:checkout|setup-node)@v\d+/);
    expect(publish).toMatch(/NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.NPM_TOKEN\s*\}\}/);
    expect(publish).toMatch(/Verify npm publish token is configured/);
    expect(publish).toMatch(/NPM_TOKEN Actions secret is not configured; publish cannot continue/);
    expect(publish).toMatch(/npm publish --provenance/);
    expect(releasePolicy).toMatch(/npmTag = packageVersion\.includes\("-"\) \? "beta" : "latest"/);
    expect(publish).toMatch(/github\.event_name == 'release'/);
    expect(publish).toMatch(/environment:\s*npm-publish/);
    expect(publish).toMatch(/fetch-depth:\s*0/);
    expect(publish).toMatch(/npm-release-policy\.mjs classify/);
    expect(publish).toMatch(/npm-release-policy\.mjs verify-git/);
    expect(publish).toMatch(/npm-release-policy\.mjs verify-pack/);
    expect(publish).toMatch(/npm-release-policy\.mjs verify-channel/);
    expect(publish).toMatch(/gh api "repos\/\$GITHUB_REPOSITORY\/releases\/tags\/\$RELEASE_TAG"/);
    expect(publish).toMatch(/GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/);
    expect(releasePolicy).toMatch(/stable npm packages require a non-prerelease GitHub Release/);
    expect(publish).toMatch(/release tag commit must be an ancestor of protected main/i);
    expect(releasePolicy).toMatch(/npm tarball integrity does not match the reviewed pack/);
    expect(publish).not.toMatch(/github\.event\.release\.prerelease\s*==\s*true/);
    expect(publish).toMatch(/Classify npm package release/);
    expect(releasePolicy).toMatch(/manual npm publish tag .* does not match package\.json version/i);
    expect(publish).toMatch(/docs\/public-release-manifest\.json/);
    expect(publish).toMatch(/skippedPublicPackageVersions/);
    expect(publish.match(/if: steps\.package_release\.outputs\.should_publish == 'true'/g)).toHaveLength(6);
    expect(publish).toMatch(/require\('\.\/package\.json'\)\.version/);
    expect(publish).toMatch(/already exists; verifying reviewed tarball identity/);
    expect(publish).toMatch(/registry-metadata\.tmp\.json/);
    expect(publish).toMatch(/JSON\.parse/);
    expect(publish).toMatch(/npm registry metadata remained unavailable or invalid after retries/);
    expect(publish).toMatch(/dist-tags\.\$NPM_TAG/);
    expect(publish).toMatch(/previousReleasedPackageVersion/);
    expect(publish).toMatch(/npm publish --provenance --access public --tag "release-candidate"/);
    expect(publish.indexOf('npm publish --provenance --access public --tag "release-candidate"')).toBeLessThan(
      publish.indexOf("npm-release-policy.mjs verify-pack")
    );
    expect(publish.indexOf("npm-release-policy.mjs verify-pack")).toBeLessThan(
      publish.indexOf('npm dist-tag add "neondiff@$PACKAGE_VERSION" "$NPM_TAG"')
    );
    expect(publish).toMatch(/default:\s*v1\.0\.3/);
    expect(publish).not.toMatch(/default:\s*v0\.4\.30-beta\.1/);

    const governance = read("docs/release-governance.md");
    expect(governance).toMatch(/partial quarantine promotion/i);
    expect(governance).toMatch(/npm dist-tag add neondiff@<version> latest/);
    expect(governance).toMatch(/npm dist-tag rm neondiff release-candidate/);
    expect(governance).toMatch(/npm-release-policy\.mjs verify-channel/);
    expect(governance).toMatch(/npm view neondiff dist-tags\.release-candidate/);
    expect(governance.indexOf("npm-release-policy.mjs verify-channel")).toBeLessThan(
      governance.indexOf("npm dist-tag add neondiff@<version> latest")
    );
    expect(governance.indexOf("npm view neondiff dist-tags.release-candidate")).toBeLessThan(
      governance.indexOf("npm dist-tag add neondiff@<version> latest")
    );
  });
});
