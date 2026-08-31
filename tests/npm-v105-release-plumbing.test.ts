import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const read = (path: string): string => readFileSync(path, "utf8");

describe("neondiff@1.0.5 release plumbing", () => {
  it("derives every sealed-worker version check from package identity", () => {
    const pkg = JSON.parse(read("package.json")) as { version?: string };
    const lock = JSON.parse(read("package-lock.json")) as {
      version?: string;
      packages?: Record<string, { version?: string }>;
    };
    const builder = read("scripts/build-desktop-sealed-worker.mjs");
    const desktopBuild = read("apps/neondiff-desktop/script/build_and_run.sh");

    expect(pkg.version).toBe("1.0.5");
    expect(lock.version).toBe("1.0.5");
    expect(lock.packages?.[""]?.version).toBe("1.0.5");
    expect(builder).toContain("reportedVersion !== sealedPackageVersion");
    expect(builder).not.toContain('reportedVersion !== "1.0.4"');
    expect(desktopBuild).toContain("EXPECTED_WORKER_VERSION");
    expect(desktopBuild).not.toContain('NeonDiffWorker\" --version)\" = \"1.0.4\"');
  });

  it("makes the typed npm publication receipt a release-status gate", () => {
    const releaseStatus = read("src/release-status.ts");
    const readiness = read("scripts/check-public-release-ready.mjs");
    const releaseRunbook = read("apps/neondiff-desktop/docs/mac-release-runbook.md");
    const readme = read("README.md");
    const setup = read("docs/SETUP.md");

    expect(releaseStatus).toContain("neondiff.npm-publication-proof.v1");
    expect(releaseStatus).toContain("publicationProofPath");
    expect(releaseStatus).toContain("validateNpmPublicationProof");
    expect(releaseStatus).toContain("packageArtifact:");
    expect(readiness).toContain("status.npmPublication.packageArtifact");
    expect(readiness).toContain("candidate ledger shasum does not match npm pack");
    expect(readiness).toContain("candidate ledger integrity does not match npm pack");
    expect(readiness).toContain("validateMandatoryActivationProofPath");
    expect(readiness).toContain("expectedCandidateHead: candidateHead");
    expect(readiness).not.toContain('(prepublication === "true" && !prepublicationReady)');
    expect(releaseRunbook).toContain("Before any RC or stable declaration, signing, or notarization");
    for (const installGuide of [readme, setup]) {
      expect(installGuide).toContain("npm install -g neondiff@1.0.5");
      expect(installGuide).toContain("npm install -g neondiff@1.0.4");
    }
  });

  it("routes predecessor rollback only through an explicit serialized workflow mode", () => {
    const workflow = parse(read(".github/workflows/publish-npm.yml")) as {
      on?: { workflow_dispatch?: { inputs?: Record<string, unknown> } };
      concurrency?: { group?: string; "cancel-in-progress"?: boolean };
      jobs?: Record<string, { if?: string; steps?: Array<{ run?: string }> }>;
    };

    expect(workflow.on?.workflow_dispatch?.inputs).toHaveProperty("predecessor_rollback");
    expect(workflow.concurrency).toEqual({
      group: "publish-npm-neondiff",
      "cancel-in-progress": false
    });
    expect(workflow.jobs).toHaveProperty("rollback_predecessor");
    const rollback = workflow.jobs?.rollback_predecessor;
    const stepNames = rollback?.steps?.map((step) => (step as { name?: string }).name ?? "") ?? [];
    const script = rollback?.steps?.map((step) => step.run ?? "").join("\n") ?? "";
    expect(rollback?.if).toContain("predecessor_rollback");
    expect(script).toContain("verify-predecessor-rollback");
    expect(script).toContain('npm dist-tag add "neondiff@1.0.4" latest');
    expect(script).toContain('rollback-current.json');
    expect(script).toContain('rollback-predecessor.json');
    expect(script).not.toContain('"rollback-$VERSION.json"');
    expect(script).toContain("rollback-pre-mutation-channel.json");
    expect(script).toContain("confirmation-only");
    expect(script).toContain("mutation_required");
    expect(read(".github/workflows/publish-npm.yml")).toContain("steps.rollback_plan.outputs.mutation_required");
    expect(script).toContain("bounded");
    expect(stepNames.indexOf("Install exact script-free rollback dependencies")).toBeGreaterThan(stepNames.indexOf("Setup rollback Node.js"));
    expect(stepNames.indexOf("Install exact script-free rollback dependencies")).toBeLessThan(stepNames.indexOf("Verify immutable packages and rollback precondition"));
    const installStep = rollback?.steps?.find((step) => (step as { name?: string }).name === "Install exact script-free rollback dependencies");
    expect(installStep?.run?.trim()).toBe("npm ci --ignore-scripts");
  });

  it("routes immutable v1.0.5 existing-package continuation through protected main", () => {
    const workflow = read(".github/workflows/publish-npm.yml");
    const parsed = parse(workflow) as {
      on?: { workflow_dispatch?: { inputs?: Record<string, unknown> } };
      jobs?: Record<string, { if?: string }>;
    };

    expect(parsed.on?.workflow_dispatch?.inputs).toHaveProperty("v105_existing_package_continuation");
    expect(workflow).toContain("V105_EXISTING_PACKAGE_CONTINUATION");
    expect(workflow).toContain("verify-v105-existing-package-continuation");
    expect(workflow).toContain("Checkout protected-main recovery policy");
    expect(workflow).toContain('test "$RELEASE_TAG" = "v1.0.5"');
    expect(workflow).toContain('$V105_EXISTING_PACKAGE_CONTINUATION" != "true"');
    expect(workflow).toContain('neondiff@$PACKAGE_VERSION already exists; existing-package continuation will not publish');
    expect(workflow).not.toContain('npm publish "$PACK_TARBALL" --provenance --access public --tag "latest"');
    expect(parsed.jobs?.publish?.if).toContain("predecessor_rollback");
    expect(parsed.jobs?.rollback_predecessor?.if).toContain("predecessor_rollback");
    expect(workflow).toContain("Predecessor rollback cannot run with v1.0.5 existing-package continuation");
  });
});
