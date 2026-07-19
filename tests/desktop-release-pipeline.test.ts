import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

const retiredCoreChecksTarget = ["NeonDiffDesktopCore", "Checks"].join("");

describe("NeonDiff desktop release-smoke pipeline", () => {
  it("defines an unsigned macOS release-smoke workflow with the required desktop gates", () => {
    const workflowPath = ".github/workflows/desktop-release-smoke.yml";

    expect(existsSync(workflowPath)).toBe(true);

    const workflow = read(workflowPath);
    const parsed = YAML.parse(workflow) as {
      on?: {
        workflow_dispatch?: unknown;
        push?: { tags?: string[] };
      };
      concurrency?: { group?: string; "cancel-in-progress"?: boolean };
      permissions?: { contents?: string };
      jobs?: Record<
        string,
        {
          "runs-on"?: string;
          defaults?: { run?: { "working-directory"?: string } };
          steps?: Array<{
            name?: string;
            uses?: string;
            run?: string;
            with?: Record<string, string>;
            "working-directory"?: string;
          }>;
        }
      >;
    };

    expect(Object.prototype.hasOwnProperty.call(parsed.on ?? {}, "workflow_dispatch")).toBe(true);
    expect(parsed.on?.push?.tags).toContain("v*");
    expect(parsed.concurrency?.group).toContain("desktop-release-smoke");
    expect(parsed.concurrency?.["cancel-in-progress"]).toBe(true);
    expect(parsed.permissions).toEqual({ contents: "read" });

    const job = parsed.jobs?.["unsigned-desktop-release-smoke"];
    expect(job?.["runs-on"]).toBe("macos-15");
    expect(job?.defaults?.run?.["working-directory"]).toBe("apps/neondiff-desktop");

    for (const command of [
      "scripts/run-required-swift-test-suite.sh NeonDiffDesktopCoreTests",
      "scripts/run-required-swift-test-suite.sh NeonDiffDesktopAppCoreTests",
      "scripts/run-required-swift-test-suite.sh NeonDiffDesktopEvaluationSupportTests",
      "swift build --target NeonDiffDesktopKeychainChecks",
      "swift run NeonDiffDesktopAppcastChecks",
      "script/build_and_run.sh release-build",
      "script/build_and_run.sh release-bundle-check",
      "script/release-proof.sh"
    ]) {
      expect(workflow).toContain(command);
    }

    expect(workflow).not.toContain("NeonDiffDesktopCoreSmoke");
    expect(workflow).not.toContain(retiredCoreChecksTarget);
    expect(workflow).not.toContain("swift run NeonDiffDesktopKeychainChecks");
    expect(workflow).not.toMatch(/Test run with \[1-9\]/);
    const fixtureBoundaryStep = job?.steps?.find(
      (step) => step.name === "Enforce release-only fixture boundary"
    );
    expect(fixtureBoundaryStep?.["working-directory"]).toBe(".");
    expect(fixtureBoundaryStep?.run).toBe(
      "npm run check:desktop-fixture-boundary -- apps/neondiff-desktop/dist/NeonDiffDesktop.app"
    );
    expect(workflow).toContain("unsigned");
    expect(workflow).toMatch(/macOS 15 Keychain contract compilation/);
    expect(workflow).toMatch(/persist-credentials:\s*false/);
    expect(workflow).toMatch(/SOURCE_SHA:/);
    expect(workflow).toMatch(/SOURCE_REF:/);
    expect(workflow).toMatch(/actions\/upload-artifact@[0-9a-f]{40}/);
    expect(workflow).not.toMatch(/actions\/checkout@v4/);
    expect(workflow).not.toMatch(/actions\/upload-artifact@v4/);
    expect(workflow).toMatch(/NeonDiffDesktop\.app\.zip/);
    expect(workflow).toMatch(/desktop-release-smoke-metadata\.json/);
    expect(workflow).toMatch(/NEONDIFF_DESKTOP_UI_LAUNCH/);
    expect(workflow).toMatch(/NEONDIFF_DESKTOP_ARTIFACT_CLASSIFICATION/);

    expect(workflow).not.toMatch(/\$\{\{\s*secrets\./);
    expect(workflow).not.toMatch(/\b(codesign|notarytool|stapler|spctl)\b/);
    expect(workflow).not.toMatch(/\bopen\s+-n\b/);
  });

  it("has a reusable release proof script that records artifact identity and proof boundaries", () => {
    const scriptPath = "apps/neondiff-desktop/script/release-proof.sh";

    expect(existsSync(scriptPath)).toBe(true);

    const script = read(scriptPath);
    for (const field of [
      "artifact_sha256",
      "source_sha",
      "source_ref",
      "app_bundle_path",
      "bundle_id",
      "short_version",
      "build_version",
      "signing_identity_class",
      "ui_launch",
      "visual_smoke_required",
      "release_ready",
      "customer_ready",
      "proof_boundary"
    ]) {
      expect(script).toContain(field);
    }

    expect(script).toContain("shasum -a 256");
    expect(script).toContain("PlistBuddy");
    expect(script).toContain("codesign");
    expect(script).toContain("normalize_bool");
    expect(script).toContain("ensure_clean_source_tree");
    expect(script).toContain("verify_existing_app_launch");
    expect(script).toContain("SOURCE_SHA_PROVIDED");
    expect(script).toContain('git -C "$REPO_ROOT" diff --quiet');
    expect(script).toContain("ls-files --others --exclude-standard");
    expect(script).toContain("jq -n");
    expect(script).toContain("NEONDIFF_DESKTOP_UI_LAUNCH");
    expect(script).not.toContain('build_and_run.sh" verify');
    expect(script).not.toMatch(/\$\{\{\s*secrets\./);
    expect(script).not.toMatch(/\b(notarytool|stapler|spctl)\b/);
  });

  it("keeps SwiftPM resources inside Contents so the app bundle can be Developer ID sealed", () => {
    const bundler = read("apps/neondiff-desktop/script/build_and_run.sh");

    expect(bundler).toContain(
      'ditto "$RESOURCE_DIR" "$APP_RESOURCES/$(basename "$RESOURCE_DIR")"'
    );
    expect(bundler).not.toContain(
      'ditto "$RESOURCE_DIR" "$APP_BUNDLE/$(basename "$RESOURCE_DIR")"'
    );
    expect(bundler).toContain('find "$APP_BUNDLE" -mindepth 1 -maxdepth 1 ! -name Contents');
  });

  it("documents the desktop smoke artifact as non-release proof", () => {
    const docPath = "apps/neondiff-desktop/docs/desktop-release-smoke.md";

    expect(existsSync(docPath)).toBe(true);

    const docs = read(docPath);
    expect(docs).toMatch(/desktop-release-smoke\.yml/);
    expect(docs).toMatch(/unsigned/i);
    expect(docs).toMatch(/non-release proof/i);
    expect(docs).toMatch(/customer-not-ready/i);
    expect(docs).toMatch(/NeonDiffDesktopCoreTests/);
    expect(docs).not.toContain(retiredCoreChecksTarget);
    expect(docs).toMatch(/NeonDiffDesktopKeychainChecks/);
    expect(docs).toMatch(/Keychain/i);
    expect(docs).toMatch(/artifact_sha256/i);
    expect(docs).toMatch(/bundle_id/i);
    expect(docs).toMatch(/visible smoke/i);
    expect(docs).not.toMatch(/\b(codesign|notarytool|stapler|spctl)\b/);
  });
});
