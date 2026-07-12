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
      publicationProofPath?: string;
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
    expect(pkg.version).toBe("1.0.4");
    expect(pkg.private).toBeUndefined();
    expect(pkg.description).toMatch(/local-first AI PR reviewer/i);
    expect(pkg.license).toBe("SEE LICENSE IN LICENSE.md");
    expect(pkg.homepage).toBe("https://www.neondiff.com");
    expect(pkg.repository).toMatchObject({
      type: "git",
      url: "git+https://github.com/electricsheephq/evaos-code-review-bot-neondiff.git"
    });
    expect(pkg.bin).toEqual({ neondiff: "dist/src/cli.js" });
    expect(pkg.exports).toEqual({});
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
    expect(lock.version).toBe("1.0.4");
    expect(lock.packages?.[""]).toMatchObject({
      name: "neondiff",
      version: "1.0.4",
      license: "SEE LICENSE IN LICENSE.md",
      bin: { neondiff: "dist/src/cli.js" }
    });
    expect(manifest.packageArtifact).toMatchObject({
      name: "neondiff",
      version: "1.0.4",
      requiredForThisRelease: true,
      state: "release_candidate",
      previousReleasedPackageVersion: "1.0.3"
    });
    expect(existsSync("docs/release-candidates/v1.0.4.json")).toBe(true);
    if (!existsSync("docs/release-candidates/v1.0.4.json")) return;
    const candidateLedger = JSON.parse(read("docs/release-candidates/v1.0.4.json")) as {
      state?: string;
      candidateSourceSha?: string;
      proofRunUrl?: string;
      activationProofPath?: string;
      recoveryIssue?: string;
      releaseCommit?: string;
      githubReleaseUrl?: string;
      publishRunUrl?: string;
      packageArtifact?: { shasum?: string; integrity?: string };
      registry?: { state?: string; gitHeadState?: string; latest?: string; releaseCandidate?: string };
      proofBoundary?: { allowed?: string[]; forbidden?: string[] };
    };
    expect(candidateLedger).toMatchObject({
      version: "v1.0.4",
      packageVersion: "1.0.4",
      publishedVersionAtCandidateCut: "v1.0.3",
      state: "immutable_package_published_quarantined_pending_provenance_recovery",
      trackingIssue: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/532",
      recoveryIssue: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/542",
      candidateSourceSha: "42db7c8ff7dba6ceac813238dcebfb54dc83851f",
      releaseCommit: "fc66d27b6ab9f6a1eb8282d289ef63407cd96982",
      githubReleaseUrl: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/releases/tag/v1.0.4",
      publishRunUrl: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/actions/runs/29185873762",
      proofRunUrl: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/actions/runs/29185155054",
      activationProofPath:
        "docs/evidence/v1.0.4/mandatory-activation-42db7c8ff7dba6ceac813238dcebfb54dc83851f.json",
      packageArtifact: {
        shasum: "526c04bd24673351b9cc7136d8747df00ffaa2be",
        integrity:
          "sha512-ng6g4Ivn+eFzZWkxhDAOsvaimYQi8HWktnK9xTptNLg37EK/LRh2Xr5Y+sAYnX6Sqa1YBVd3iUZBMtQLQbYvcw=="
      },
      registry: {
        state: "published_quarantined",
        gitHeadState: "absent_reviewed_tarball_publish",
        latest: "1.0.3",
        releaseCandidate: "1.0.4"
      }
    });
    expect(candidateLedger.proofBoundary?.allowed).toContain(
      "registry exposes npm attestation metadata pending successful recovery verification"
    );
    expect(candidateLedger.proofBoundary?.allowed?.join("\n")).not.toMatch(/npm signatures.*bind/i);
    expect(candidateLedger.proofBoundary?.forbidden).toEqual([
      "npm latest points to 1.0.4",
      "release-candidate cleanup completed",
      "public-registry install and activation smoke completed",
      "predecessor releases or artifacts are safe to remove"
    ]);
    expect(candidateLedger.proofBoundary?.forbidden).not.toContain("v1.0.4 activation proof exists");
    expect(read("scripts/install.sh")).toMatch(/NEONDIFF_VERSION="\$\{NEONDIFF_VERSION:-1\.0\.3\}"/);
    for (const path of ["README.md", "docs/SETUP.md"]) {
      const releaseNotice = read(path);
      const normalizedReleaseNotice = releaseNotice.replace(/^>\s?/gm, "").replace(/\s+/g, " ");
      expect(normalizedReleaseNotice).toContain("v1.0.4 verification notice:");
      expect(normalizedReleaseNotice).not.toContain("v1.0.4 release notice:");
      expect(normalizedReleaseNotice).toContain(
        "v1.0.4 is the first package intended to enforce mandatory API-backed activation."
      );
      expect(normalizedReleaseNotice).toContain(
        "Verify `npm view neondiff version` and the matching non-prerelease GitHub Release before relying on it"
      );
      expect(normalizedReleaseNotice).toContain("v1.0.3 and earlier do not enforce this boundary.");
      expect(releaseNotice).not.toContain("this source branch");
    }
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
      candidateHeadBeforeReleaseMetadata: "42db7c8ff7dba6ceac813238dcebfb54dc83851f"
    });
    expect(manifest.source?.proof).toMatch(/29185155054/);
    expect(manifest.source?.proof).toMatch(/tag, GitHub Release, and npm publication remain pending/i);
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
      version: "v1.0.4",
      rollback: "git reset --hard refs/tags/v1.0.3",
      rollbackRepository: "electricsheephq/evaos-code-review-bot-neondiff",
      trackingIssue: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/443"
    });
    expect(manifest.updateChannels?.cli).toMatchObject({
      requiredForThisRelease: true,
      state: "source_checkout",
      version: "v1.0.4",
      rollback: "git reset --hard refs/tags/v1.0.3"
    });
    expect(manifest.updateChannels?.daemon).toMatchObject({
      requiredForThisRelease: true,
      state: "source_checkout",
      version: "v1.0.4",
      rollback: "git reset --hard refs/tags/v1.0.3"
    });
    expect(manifest.updateChannels?.website).toBeUndefined();
    expect(manifest.updateChannels?.desktop).toBeUndefined();

    expect(manifest.publicationProofPath).toBeUndefined();
    const aggregatePath =
      "docs/evidence/v1.0.4/mandatory-activation-42db7c8ff7dba6ceac813238dcebfb54dc83851f.json";
    const aggregateRaw = read(aggregatePath);
    const aggregate = JSON.parse(aggregateRaw) as {
      evidenceKind?: string;
      releaseVersion?: string;
      harness?: { sourceHead?: string };
      installedCandidate?: {
        packageVersion?: string;
        binaryVersion?: string;
        packShasum?: string;
        packIntegrity?: string;
      };
      matrix?: { bypassAllowedCases?: number; scenarios?: unknown[] };
      usefulWorkBoundaries?: { reportPassed?: boolean; totalTests?: number };
      installUpgrade?: { freshInstallPassed?: boolean; upgradedFromVersion?: string; upgradePassed?: boolean };
      dashboard?: { setupBlockedBeforeActivation?: boolean; providerBlockedBeforeActivation?: boolean; activatedStatusVisible?: boolean };
      desktop?: { brokerUnavailable?: boolean; usefulWorkBlocked?: boolean };
      redaction?: { rawLicenseKeyAbsent?: boolean; bearerTokenAbsent?: boolean; privatePathsAbsent?: boolean };
      artifacts?: Array<{ ref?: string; sha256?: string }>;
    };
    expect(createHash("sha256").update(aggregateRaw).digest("hex")).toBe(
      "82372b6dad9992741392017116de3b423c134b8b26ad605a3a6cfcafd59c721c"
    );
    expect(aggregate).toMatchObject({
      evidenceKind: "mandatory_activation_no_bypass",
      releaseVersion: "v1.0.4",
      harness: { sourceHead: "42db7c8ff7dba6ceac813238dcebfb54dc83851f" },
      installedCandidate: {
        packageVersion: "1.0.4",
        binaryVersion: "1.0.4",
        packShasum: "526c04bd24673351b9cc7136d8747df00ffaa2be",
        packIntegrity:
          "sha512-ng6g4Ivn+eFzZWkxhDAOsvaimYQi8HWktnK9xTptNLg37EK/LRh2Xr5Y+sAYnX6Sqa1YBVd3iUZBMtQLQbYvcw=="
      },
      matrix: { bypassAllowedCases: 0 },
      usefulWorkBoundaries: { reportPassed: true, totalTests: 197 },
      installUpgrade: { freshInstallPassed: true, upgradedFromVersion: "1.0.3", upgradePassed: true },
      dashboard: {
        setupBlockedBeforeActivation: true,
        providerBlockedBeforeActivation: true,
        activatedStatusVisible: true
      },
      desktop: { brokerUnavailable: true, usefulWorkBlocked: true },
      redaction: { rawLicenseKeyAbsent: true, bearerTokenAbsent: true, privatePathsAbsent: true }
    });
    expect(aggregate.matrix?.scenarios).toHaveLength(19);
    expect(aggregate.artifacts).toHaveLength(6);
    for (const artifact of aggregate.artifacts ?? []) {
      expect(artifact.ref).toMatch(/^docs\/evidence\/v1\.0\.4\/[a-z-]+-42db7c8ff7dba6ceac813238dcebfb54dc83851f\.json$/);
      expect(existsSync(artifact.ref ?? "")).toBe(true);
      expect(createHash("sha256").update(read(artifact.ref ?? "")).digest("hex")).toBe(artifact.sha256);
    }
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
        activationProofPath?: string;
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
      checkoutIssuanceProofPath: "docs/evidence/v1.0.4-license-checkout-issuance-unauthenticated.json",
      checkoutIssuanceAuthenticatedProofPath: "docs/evidence/v1.0.4-license-checkout-issuance-authenticated.json",
      activationProofPath:
        "docs/evidence/v1.0.4/mandatory-activation-42db7c8ff7dba6ceac813238dcebfb54dc83851f.json",
      checkoutIssuanceTrackingIssue: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/421"
    });
    expect(manifest.licenseApi?.trackingIssue).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/);
    expect(manifest.licenseApi?.healthUrl).toMatch(/^https:\/\/[^/]+\/healthz$/);
    expect(manifest.licenseApi?.healthProofPath).toBe("docs/evidence/v1.0.4-license-api-healthz.json");

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
      releaseVersion: "v1.0.4",
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
      releaseVersion: "v1.0.4",
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
      releaseVersion: "v1.0.4",
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

    for (const channel of ["cli", "daemon", "browserDashboard"]) {
      expect(manifest.updateChannels?.[channel]?.rollback).toBe("git reset --hard refs/tags/v1.0.3");
    }

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
      read("docs/releases/v1.0.4.md")
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
    expect(docs).toMatch(/API-backed activation is required for supported (?:public, private, internal, and unknown repository review|review work)/i);
    expect(docs).toMatch(/active NeonDiff entitlement before\s+>\s*worktree prep, provider calls, or GitHub review posting/i);
    expect(docs).toMatch(/curl -fsSL https:\/\/www\.neondiff\.com\/install/i);
    expect(docs).toContain("git clone https://github.com/electricsheephq/evaos-code-review-bot-neondiff.git");
    expect(legacyRepoReferences).toEqual([]);
    expect(docs).not.toMatch(/npm link installs the local source-checkout shim/i);
    expect(read("docs/releases/v1.0.4.md")).not.toMatch(/\/Volumes\/LEXAR|\/Users\/lume/);
  });

  it("keeps the retired GitHub Marketplace free-listing packet explicitly non-publishable", () => {
    expect(existsSync("docs/github-marketplace-free-listing.md")).toBe(true);

    const listing = read("docs/github-marketplace-free-listing.md");
    const publicClaims = read("scripts/check-public-claims.mjs");
    const pkg = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };

    expect(publicClaims).toContain("\"docs/github-marketplace-free-listing.md\"");
    expect(pkg.scripts?.["check:public-claims"]).toBe("node scripts/check-public-claims.mjs");

    expect(listing).toContain("Issue: #428");
    expect(listing).toMatch(/free-use\s+listing strategy is retired/i);
    expect(listing).toContain("No Marketplace billing or listing is shipped by this packet");
    expect(listing).toMatch(/owner must approve and click the final Marketplace\s+publish button/i);
    expect(listing).toContain("https://docs.github.com/en/apps/github-marketplace/creating-apps-for-github-marketplace/requirements-for-listing-an-app");
    expect(listing).toContain("https://docs.github.com/en/apps/github-marketplace/selling-your-app-on-github-marketplace/pricing-plans-for-github-marketplace-apps");
    expect(listing).toContain("https://docs.github.com/en/apps/github-marketplace/listing-an-app-on-github-marketplace");
    expect(listing).toMatch(/requires\s+API-backed activation for public, private, internal, and unknown repository\s+work/i);
    expect(listing).toMatch(/provider\/model costs stay external/i);
    expect(listing).toMatch(/support@electricsheephq\.com/);
    expect(listing).toMatch(/SECURITY\.md/);
    expect(listing).toMatch(/provide a valid privacy-policy URL/i);
    expect(listing).toMatch(/implement the required purchase and\s+cancellation webhooks/i);
    expect(listing).toMatch(/Do not paste\s+beta, public-preview, or retired free-use wording/i);
  });

  it("CI workflows gate build, tests, package, docs claims, and npm provenance publish", () => {
    for (const path of [".github/workflows/ci.yml", ".github/workflows/publish-npm.yml", ".github/workflows/license-lifecycle-proof.yml"]) {
      expect(existsSync(path)).toBe(true);
    }

    const ci = read(".github/workflows/ci.yml");
    const publish = read(".github/workflows/publish-npm.yml");
    const lifecycle = read(".github/workflows/license-lifecycle-proof.yml");
    const releasePolicy = read("scripts/npm-release-policy.mjs");

    expect(ci).toMatch(/node-version:\s*26/);
    expect(ci).toContain("actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8 # v5.0.0");
    expect(ci).toContain("actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5");
    expect(ci).not.toMatch(/uses:\s*actions\/(?:checkout|setup-node)@v\d+/);
    expect(ci).toMatch(/npm ci/);
    expect(ci).toMatch(/npm run build/);
    expect(ci).toMatch(/npm ci --prefix services\/license-api/);
    expect(ci).toMatch(/npm test --prefix services\/license-api/);
    expect(ci).toMatch(/npm run build --prefix services\/license-api/);
    expect(ci).toMatch(/tests\/public-release-readiness\.test\.ts/);
    expect(ci).toMatch(/npm pack --dry-run --json/);
    expect(ci).toMatch(/forbidden public claims/i);
    expect(ci).toMatch(/secret/i);

    expect(publish).toMatch(/id-token:\s*write/);
    expect(publish).toMatch(/attestations:\s*read/);
    expect(publish).toMatch(/concurrency:\s*\n\s*group:\s*publish-npm-neondiff/);
    expect(publish).toMatch(/cancel-in-progress:\s*false/);
    expect(publish).toContain("actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8 # v5.0.0");
    expect(publish).toContain("actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5");
    expect(publish).toMatch(/persist-credentials:\s*false/);
    expect(publish).not.toMatch(/uses:\s*actions\/(?:checkout|setup-node)@v\d+/);
    expect(publish).toMatch(/NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.NPM_TOKEN\s*\}\}/);
    expect(publish).toMatch(/Verify npm publish token is configured/);
    expect(publish).toMatch(/NPM_TOKEN Actions secret is not configured; publish cannot continue/);
    expect(publish).toMatch(/npm publish "\$PACK_TARBALL" --provenance/);
    expect(releasePolicy).toMatch(/npmTag = packageVersion\.includes\("-"\) \? "beta" : "latest"/);
    expect(publish).toMatch(/github\.event_name == 'release'/);
    expect(publish).toMatch(/environment:\s*npm-publish/);
    expect(publish).toMatch(/fetch-depth:\s*0/);
    expect(publish).toMatch(/npm-release-policy\.mjs classify/);
    expect(publish).toMatch(/npm-release-policy\.mjs verify-git/);
    expect(publish).toMatch(/node "\$POLICY_SCRIPT" verify-pack/);
    expect(publish).toMatch(/node "\$POLICY_SCRIPT" verify-pack[\s\S]*--expected-git-head "\$EXPECTED_GIT_HEAD"/);
    expect(publish).toMatch(/verify-npm-provenance\.mjs/);
    expect(publish).toMatch(/npm audit signatures --prefix "\$SIGNATURE_VERIFY_ROOT" --json/);
    expect(publish).toMatch(/REQUIRED_EVIDENCE_KINDS/);
    expect(publish).toMatch(/EVIDENCE_ARTIFACTS/);
    expect(publish).toMatch(/gh attestation verify "\$EVIDENCE_ARTIFACT"/);
    expect(publish).toMatch(/gh attestation verify "\$ACTIVATION_PROOF_PATH"/);
    expect(publish).toMatch(/--signer-workflow electricsheephq\/evaos-code-review-bot-neondiff\/\.github\/workflows\/license-lifecycle-proof\.yml/);
    expect(publish).toMatch(/--signer-digest "\$CANDIDATE_HEAD"/);
    expect(publish).toMatch(/--source-ref refs\/heads\/main/);
    expect(publish).toMatch(/node "\$POLICY_SCRIPT" verify-channel/);
    expect(publish).toMatch(/prepromotion-channel\.json/);
    expect(publish.indexOf("prepromotion-channel.json")).toBeLessThan(
      publish.indexOf('npm dist-tag add "neondiff@$PACKAGE_VERSION" "$NPM_TAG"')
    );
    expect(publish).toMatch(/gh api "repos\/\$GITHUB_REPOSITORY\/releases\/tags\/\$RELEASE_TAG"/);
    expect(publish).toMatch(/GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/);
    expect(releasePolicy).toMatch(/stable npm packages require a non-prerelease GitHub Release/);
    expect(publish).toMatch(/release tag commit must be an ancestor of protected main/i);
    expect(publish).toContain('test "$GITHUB_REF" = "refs/tags/$RELEASE_TAG"');
    expect(publish.indexOf('test "$GITHUB_REF" = "refs/tags/$RELEASE_TAG"')).toBeLessThan(
      publish.indexOf('npm publish "$PACK_TARBALL" --provenance')
    );
    expect(publish).toContain('test "$RELEASE_TAG" = "v1.0.4"');
    expect(publish).toContain('test "$TAG_COMMIT" = "fc66d27b6ab9f6a1eb8282d289ef63407cd96982"');
    expect(publish.indexOf('test "$RELEASE_TAG" = "v1.0.4"')).toBeLessThan(
      publish.indexOf("node scripts/npm-release-policy.mjs verify-git")
    );
    expect(publish.indexOf('test "$TAG_COMMIT" = "fc66d27b6ab9f6a1eb8282d289ef63407cd96982"')).toBeLessThan(
      publish.indexOf("Classify npm package release")
    );
    expect(releasePolicy).toMatch(/npm tarball integrity does not match the reviewed pack/);
    expect(publish.indexOf("verify-npm-provenance.mjs")).toBeLessThan(
      publish.indexOf('npm dist-tag add "neondiff@$PACKAGE_VERSION" "$NPM_TAG"')
    );
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
    expect(publish).toMatch(/npm view neondiff dist-tags --json/);
    expect(publish).toMatch(/BEGIN POST_PROMOTION_CONFIRMATION/);
    expect(publish).toMatch(/END POST_PROMOTION_CONFIRMATION/);
    expect(publish).toMatch(/post-promotion-channel\.json/);
    expect(publish).toMatch(/NPM_CONFIRM_ATTEMPTS="\$\{NPM_CONFIRM_ATTEMPTS:-12\}"/);
    expect(publish).toMatch(/NPM_CONFIRM_DELAY_MS="\$\{NPM_CONFIRM_DELAY_MS:-5000\}"/);
    expect(publish).toMatch(/NPM_CONFIRM_TIMEOUT_MS="\$\{NPM_CONFIRM_TIMEOUT_MS:-15000\}"/);
    expect(publish).not.toContain('test "$(npm view neondiff "dist-tags.$NPM_TAG")" = "$PACKAGE_VERSION"');
    expect(publish).toMatch(/tags\[npmTag\].*expectedVersion/);
    expect(publish).toMatch(/npm dist-tag did not converge to the promoted package after/);
    expect(publish).toMatch(/previousReleasedPackageVersion/);
    expect(publish).toMatch(/npm publish "\$PACK_TARBALL" --provenance --access public --tag "release-candidate"/);
    expect(publish.indexOf('npm publish "$PACK_TARBALL" --provenance --access public --tag "release-candidate"')).toBeLessThan(
      publish.indexOf('node "$POLICY_SCRIPT" verify-pack')
    );
    expect(publish.indexOf('node "$POLICY_SCRIPT" verify-pack')).toBeLessThan(
      publish.indexOf('npm dist-tag add "neondiff@$PACKAGE_VERSION" "$NPM_TAG"')
    );
    expect(publish).toMatch(/default:\s*v1\.0\.4/);
    expect(publish).not.toMatch(/default:\s*v0\.4\.30-beta\.1/);
    expect(publish).toMatch(/npm install --global npm@11\.17\.0/);
    expect(publish).toContain('test "$(npm --version)" = "11.17.0"');
    expect(publish.indexOf("npm install --global npm@11.17.0")).toBeLessThan(
      publish.indexOf('npm publish "$PACK_TARBALL" --provenance')
    );
    expect(publish).toMatch(/curl[\s\S]*--connect-timeout 10[\s\S]*--max-time 30[\s\S]*--retry 3[\s\S]*--retry-all-errors/);
    expect(publish).toMatch(/provenance_recovery:\s*\n\s*description:[^\n]*\n\s*required:\s*true\n\s*type:\s*boolean\n\s*default:\s*false/);
    expect(publish).toMatch(/WORKFLOW_REF:\s*\$\{\{\s*github\.workflow_ref\s*\}\}/);
    expect(publish).toMatch(/WORKFLOW_SHA:\s*\$\{\{\s*github\.workflow_sha\s*\}\}/);
    const publishStepHeader = publish.split("- name: Publish or verify existing package")[1]?.split("run: |")[0] ?? "";
    expect(publishStepHeader).toMatch(/PROVENANCE_RECOVERY:\s*\$\{\{\s*inputs\.provenance_recovery \|\| false\s*\}\}/);
    expect(publishStepHeader).toMatch(/RELEASE_TAG:\s*\$\{\{\s*github\.event\.inputs\.tag \|\| github\.event\.release\.tag_name\s*\}\}/);
    expect(publishStepHeader).toMatch(/WORKFLOW_REF:\s*\$\{\{\s*github\.workflow_ref\s*\}\}/);
    expect(publishStepHeader).toMatch(/WORKFLOW_SHA:\s*\$\{\{\s*github\.workflow_sha\s*\}\}/);
    expect(publish).toMatch(/verify-recovery-dispatch/);
    expect(publish).toMatch(/--github-ref "\$GITHUB_REF"/);
    expect(publish).toMatch(/--workflow-ref "\$WORKFLOW_REF"/);
    expect(publish).toMatch(/--workflow-sha "\$WORKFLOW_SHA"/);
    expect(publish).toMatch(/--package-exists "\$PACKAGE_ALREADY_EXISTS"/);
    expect(publish).toMatch(/Checkout protected-main recovery policy/);
    expect(publish).toMatch(/- name: Checkout protected-main recovery policy\n\s+if: \$\{\{[^\n]*steps\.package_release\.outputs\.should_publish == 'true'[^\n]*\}\}/);
    expect(publish).toMatch(/- name: Verify protected-main recovery policy checkout\n\s+if: \$\{\{[^\n]*steps\.package_release\.outputs\.should_publish == 'true'[^\n]*\}\}/);
    expect(publish).toMatch(/path:\s*\.recovery-policy/);
    expect(publish).toMatch(/ref:\s*\$\{\{\s*github\.workflow_sha\s*\}\}/);
    expect(publish.indexOf('npm pack --json --pack-destination "$PACK_DIR" > pack.json')).toBeLessThan(
      publish.indexOf("Checkout protected-main recovery policy")
    );
    expect(publish).toMatch(/git -C \.recovery-policy rev-parse HEAD/);
    expect(publish).toMatch(/BEGIN V104_PROVENANCE_RECOVERY_PUBLISH_GUARD/);
    expect(publish).toMatch(/END V104_PROVENANCE_RECOVERY_PUBLISH_GUARD/);
    expect(publish).toMatch(/provenance recovery requires neondiff@\$PACKAGE_VERSION to already exist/i);
    expect(publish).toMatch(/VERIFIED_PROVENANCE_PATH="\$RUNNER_TEMP\/verified-npm-provenance\.json"/);
    expect(publish).toMatch(/rm -f "\$VERIFIED_PROVENANCE_PATH"/);
    expect(publish).toMatch(/verify-npm-provenance\.mjs[\s\S]*> "\$VERIFIED_PROVENANCE_PATH"/);
    expect(publish).toMatch(/--verified-provenance "\$VERIFIED_PROVENANCE_PATH"/);
    expect(publish.indexOf('> "$VERIFIED_PROVENANCE_PATH"')).toBeLessThan(
      publish.indexOf('--verified-provenance "$VERIFIED_PROVENANCE_PATH"')
    );
    expect(publish.indexOf('npm audit signatures --prefix "$SIGNATURE_VERIFY_ROOT" --json')).toBeLessThan(
      publish.indexOf('node "$POLICY_SCRIPT" verify-pack')
    );
    expect(publish.indexOf('npm audit signatures --prefix "$SIGNATURE_VERIFY_ROOT" --json')).toBeLessThan(
      publish.indexOf("BEGIN V104_PROVENANCE_RECOVERY_PREPROMOTION_GUARD")
    );
    expect(publish).toMatch(/verify-recovery-channels/);
    expect(publish).toMatch(/BEGIN V104_PROVENANCE_RECOVERY_PREPROMOTION_GUARD/);
    expect(publish).toMatch(/END V104_PROVENANCE_RECOVERY_PREPROMOTION_GUARD/);
    expect(publish.indexOf("verify-recovery-channels")).toBeLessThan(
      publish.indexOf('npm dist-tag add "neondiff@$PACKAGE_VERSION" "$NPM_TAG"')
    );

    expect(lifecycle).toMatch(/workflow_dispatch:/);
    expect(lifecycle).toMatch(/concurrency:\s*\n\s*group:\s*neondiff-license-lifecycle-production/);
    expect(lifecycle).toMatch(/cancel-in-progress:\s*false/);
    expect(lifecycle).toMatch(/environment:\s*license-lifecycle-production/);
    expect(lifecycle).toMatch(/contents:\s*read/);
    expect(lifecycle).toMatch(/id-token:\s*write/);
    expect(lifecycle).toMatch(/attestations:\s*write/);
    expect(lifecycle).toMatch(/github\.ref == 'refs\/heads\/main'/);
    expect(lifecycle).toMatch(/persist-credentials:\s*false/);
    expect(lifecycle).toMatch(/run-license-lifecycle-smoke\.mjs/);
    expect(lifecycle).toMatch(/desktop-quarantine-proof:/);
    expect(lifecycle).toMatch(/runs-on:\s*macos-15/);
    expect(lifecycle).toMatch(/run-required-swift-test-suite\.sh NeonDiffDesktopAppCoreTests/);
    expect(lifecycle).toMatch(/swift build -c release --product NeonDiffDesktop/);
    expect(lifecycle).toMatch(/needs:\s*desktop-quarantine-proof/);
    expect(lifecycle).toMatch(/tests\/license\.test\.ts/);
    expect(lifecycle).toMatch(/run-mandatory-activation-matrix\.mjs/);
    expect(lifecycle).toMatch(/assemble-mandatory-activation-proof\.mjs/);
    expect(lifecycle).toMatch(/subject-path:\s*docs\/evidence\/\$\{\{ inputs\.release_version \}\}\/\*-\$\{\{ inputs\.candidate_head \}\}\.json/);
    expect(lifecycle).toMatch(/npm install --ignore-scripts --prefix "\$INSTALL_PREFIX" "\$PACK_TARBALL"/);
    expect(lifecycle).toMatch(/config inspect[\s\S]*v1\.0\.3-legacy-license\.json/);
    expect(lifecycle).toMatch(/candidate_cli=\$UPGRADE_PREFIX\/node_modules\/\.bin\/neondiff/);
    expect(lifecycle).toContain("actions/attest-build-provenance@977bb373ede98d70efdf65b84cb5f73e068dcc2a # v3");
    expect(lifecycle).toContain("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4");
    expect(lifecycle).not.toMatch(/LICENSE_ISSUANCE_SECRET|NPM_TOKEN|secrets\./);

    const governance = read("docs/release-governance.md");
    expect(governance).toMatch(/Mandatory Activation Proof Sequence/);
    expect(governance).toMatch(/Download the exact seven attested JSON artifacts without editing them/);
    expect(governance).toMatch(/may change only files outside the npm\s+package allowlist/i);
    expect(governance).toMatch(/package bytes must remain identical/);
    expect(governance).toMatch(/partial quarantine promotion/i);
    const recovery = governance.split("### Partial Quarantine Promotion Recovery")[1]?.split("## Tag And Release")[0] ?? "";
    expect(recovery).toMatch(/gh workflow run publish-npm\.yml/);
    expect(recovery).toMatch(/--ref v<version>/);
    expect(recovery).toMatch(/-f tag=v<version>/);
    expect(recovery).toMatch(/--ref main/);
    expect(recovery).toMatch(/-f tag=v1\.0\.4/);
    expect(recovery).toMatch(/-f provenance_recovery=true/);
    expect(recovery).toMatch(/v1\.0\.4-only/i);
    expect(recovery).toMatch(/cannot publish|does not publish/i);
    expect(recovery).toMatch(/direct dist-tag mutation is not supported/i);
    expect(recovery).toMatch(/waives only the normal 24-hour activation-proof/);
    expect(recovery).toMatch(/30-day maximum-age ceiling/);
    expect(recovery).not.toMatch(/npm dist-tag add/);
    expect(recovery).not.toMatch(/npm dist-tag rm/);

    const changelog = read("CHANGELOG.md").split("## [1.0.4]")[0] ?? "";
    expect(changelog).toMatch(/#542/);
    expect(changelog).toMatch(/reviewed\s+tarball/i);
    expect(changelog).toMatch(/Sigstore\/SLSA provenance/i);
    expect(changelog).not.toMatch(/latest=1\.0\.4|public install succeeded/i);
  });
});
