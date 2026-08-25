import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function runFixture(
  root: string,
  command: string,
  args: string[],
  values: Record<string, string> = {}
) {
  const env = { ...process.env };
  delete env.SOURCE_SHA;
  delete env.SOURCE_REF;
  return spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...env, ...values }
  });
}

function sourceIdentityFixture() {
  const root = mkdtempSync(join(tmpdir(), "neondiff-source-identity-"));
  const scriptDirectory = join(root, "apps/neondiff-desktop/script");
  mkdirSync(scriptDirectory, { recursive: true });
  copyFileSync(
    "apps/neondiff-desktop/script/build_and_run.sh",
    join(scriptDirectory, "build_and_run.sh")
  );
  copyFileSync(
    "apps/neondiff-desktop/script/release-proof.sh",
    join(scriptDirectory, "release-proof.sh")
  );
  writeFileSync(join(root, ".gitignore"), "apps/neondiff-desktop/dist/\n");
  for (const args of [
    ["init", "--quiet"],
    ["config", "user.name", "NeonDiff Test"],
    ["config", "user.email", "neondiff-test@example.invalid"],
    ["add", "."],
    ["commit", "--quiet", "-m", "fixture"]
  ]) {
    const result = runFixture(root, "git", args);
    if (result.status !== 0) throw new Error(result.stderr);
  }
  const sha = runFixture(root, "git", ["rev-parse", "HEAD"]).stdout.trim();
  return {
    root,
    sha,
    buildScript: join(scriptDirectory, "build_and_run.sh"),
    proofScript: join(scriptDirectory, "release-proof.sh")
  };
}

function releasePlist(sourceSHA: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.electricsheephq.NeonDiffDesktop</string>
<key>CFBundleShortVersionString</key><string>1.1.0</string>
<key>CFBundleVersion</key><string>11091</string>
<key>NeonDiffPaidBetaContract</key><string>paid-mac-beta-byo-v1</string>
<key>NeonDiffBYOGitHubEnabled</key><true/>
<key>NeonDiffSourceSHA</key><string>${sourceSHA}</string>
</dict></plist>\n`;
}

const retiredCoreChecksTarget = ["NeonDiffDesktopCore", "Checks"].join("");

describe("NeonDiff desktop release-smoke pipeline", () => {
  it("executes exact-checkout source identity gates in isolated repositories", () => {
    const fixture = sourceIdentityFixture();
    const releaseBuildEnv = {
      NEONDIFF_DESKTOP_BUILD_CONFIGURATION: "release",
      NEONDIFF_DESKTOP_VERSION: "1.1.0",
      NEONDIFF_SPARKLE_FEED_URL: "https://ci.invalid/neondiff/appcast.xml",
      NEONDIFF_SPARKLE_PUBLIC_ED_KEY: "CI_ONLY_NOT_A_RELEASE_KEY"
    };
    try {
      const attachedBuild = runFixture(
        fixture.root,
        "/bin/bash",
        [fixture.buildScript, "release-build"],
        releaseBuildEnv
      );
      expect(attachedBuild.status).toBe(2);
      expect(attachedBuild.stderr).toContain(
        "release candidates require a detached source checkout"
      );

      const attachedProof = runFixture(
        fixture.root,
        "/bin/bash",
        [fixture.proofScript]
      );
      expect(attachedProof.status).toBe(2);
      expect(attachedProof.stderr).toContain(
        "release proof requires a detached source checkout"
      );

      expect(
        runFixture(fixture.root, "git", ["checkout", "--quiet", "--detach", "HEAD"])
          .status
      ).toBe(0);
      writeFileSync(join(fixture.root, "dirty.txt"), "dirty\n");
      const dirtyBuild = runFixture(
        fixture.root,
        "/bin/bash",
        [fixture.buildScript, "release-build"],
        releaseBuildEnv
      );
      expect(dirtyBuild.status).toBe(2);
      expect(dirtyBuild.stderr).toContain(
        "release builds require an exact clean source checkout"
      );
      const dirtyProof = runFixture(
        fixture.root,
        "/bin/bash",
        [fixture.proofScript]
      );
      expect(dirtyProof.status).toBe(2);
      expect(dirtyProof.stderr).toContain("source tree has untracked files");
      rmSync(join(fixture.root, "dirty.txt"));

      expect(runFixture(fixture.root, "git", ["tag", "v1.1.0-lightweight"]).status).toBe(0);
      const lightweightTag = runFixture(
        fixture.root,
        "/bin/bash",
        [fixture.proofScript],
        { SOURCE_SHA: fixture.sha, SOURCE_REF: "refs/tags/v1.1.0-lightweight" }
      );
      expect(lightweightTag.status).toBe(2);
      expect(lightweightTag.stderr).toContain("release source tag must be annotated");
      expect(runFixture(fixture.root, "git", ["tag", "--delete", "v1.1.0-lightweight"]).status).toBe(0);

      for (const tag of ["v1.1.0-rc.1", "v1.1.0"]) {
        expect(
          runFixture(fixture.root, "git", ["tag", "-a", tag, "-m", tag]).status
        ).toBe(0);
      }
      const loneRef = runFixture(
        fixture.root,
        "/bin/bash",
        [fixture.proofScript],
        { SOURCE_REF: "refs/tags/v1.1.0" }
      );
      expect(loneRef.status).toBe(2);
      expect(loneRef.stderr).toContain("SOURCE_SHA and SOURCE_REF must be provided together");

      const wrongSHA = runFixture(
        fixture.root,
        "/bin/bash",
        [fixture.proofScript],
        { SOURCE_SHA: "0".repeat(40), SOURCE_REF: "refs/tags/v1.1.0" }
      );
      expect(wrongSHA.status).toBe(2);
      expect(wrongSHA.stderr).toContain(
        "provided source identity does not match the exact checkout"
      );

      const ambiguousTags = runFixture(
        fixture.root,
        "/bin/bash",
        [fixture.proofScript]
      );
      expect(ambiguousTags.status).toBe(2);
      expect(ambiguousTags.stderr).toContain("source ref is ambiguous");

      const exactTriggeredTag = runFixture(
        fixture.root,
        "/bin/bash",
        [fixture.proofScript],
        { SOURCE_SHA: fixture.sha, SOURCE_REF: "refs/tags/v1.1.0" }
      );
      expect(exactTriggeredTag.status).toBe(1);
      expect(exactTriggeredTag.stderr).toContain("missing app bundle");
      expect(exactTriggeredTag.stderr).not.toContain("source ref is ambiguous");

      if (process.platform === "darwin") {
        const contents = join(
          fixture.root,
          "apps/neondiff-desktop/dist/NeonDiff.app/Contents"
        );
        mkdirSync(contents, { recursive: true });
        const infoPlist = join(contents, "Info.plist");
        writeFileSync(infoPlist, releasePlist(fixture.sha));
        const valid = runFixture(
          fixture.root,
          "/bin/bash",
          [fixture.proofScript],
          { SOURCE_SHA: fixture.sha, SOURCE_REF: "refs/tags/v1.1.0" }
        );
        expect(valid.status).toBe(0);
        expect(JSON.parse(valid.stdout)).toMatchObject({
          source_sha: fixture.sha,
          artifact_source_sha: fixture.sha,
          source_ref: "refs/tags/v1.1.0"
        });

        writeFileSync(infoPlist, releasePlist("0".repeat(40)));
        const wrongMarker = runFixture(
          fixture.root,
          "/bin/bash",
          [fixture.proofScript],
          { SOURCE_SHA: fixture.sha, SOURCE_REF: "refs/tags/v1.1.0" }
        );
        expect(wrongMarker.status).toBe(1);
        expect(wrongMarker.stderr).toContain(
          "artifact source identity does not match the exact checkout"
        );
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("defines a three-clean-Mac public download and install canary", () => {
    const workflowPath = ".github/workflows/paid-beta-public-download-canary.yml";

    expect(existsSync(workflowPath)).toBe(true);

    const workflow = read(workflowPath);
    const parsed = YAML.parse(workflow) as {
      on?: {
        workflow_dispatch?: {
          inputs?: Record<string, { required?: boolean }>;
        };
      };
      permissions?: { contents?: string };
      jobs?: Record<
        string,
        {
          strategy?: { "fail-fast"?: boolean; matrix?: { runner?: string[] } };
          "runs-on"?: string;
        }
      >;
    };

    const inputs = parsed.on?.workflow_dispatch?.inputs;
    expect(inputs?.release_tag?.required).toBe(true);
    expect(inputs?.artifact_name?.required).toBe(true);
    expect(inputs?.artifact_sha256?.required).toBe(true);
    expect(parsed.permissions).toEqual({
      contents: "read",
      issues: "read",
      "pull-requests": "read"
    });

    const job = parsed.jobs?.["public-download-install-canary"];
    expect(job?.strategy?.["fail-fast"]).toBe(false);
    expect(job?.strategy?.matrix?.runner).toEqual(["macos-14", "macos-15", "macos-26"]);
    expect(job?.["runs-on"]).toBe("${{ matrix.runner }}");

    for (const command of [
      "releases/tags",
      "curl --fail",
      "shasum -a 256",
      "com.apple.quarantine",
      "ditto -x -k",
      "codesign --verify --deep --strict",
      "TeamIdentifier=TC6MS3T6NN",
      "grep -Eq '^Authority=Developer ID Application:.+$'",
      "xcrun stapler validate",
      "spctl --assess --type execute",
      "/Applications/NeonDiff.app",
      'test "$(uname -m)" = "arm64"',
      'test "$release_channel" = "$artifact_channel"'
    ]) {
      expect(workflow).toContain(command);
    }

    expect(workflow).toMatch(/actions\/upload-artifact@[0-9a-f]{40}/);
    expect(workflow).not.toMatch(/actions\/upload-artifact@v4/);
    expect(workflow).not.toMatch(/\$\{\{\s*secrets\./);
    expect(workflow).not.toContain("spctl -a -vv");
    expect(workflow).not.toContain("open -n");
    expect(workflow).not.toContain("NeonDiffDesktop");
  });

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
            env?: Record<string, string>;
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
    const checkout = job?.steps?.find((step) => step.name === "Checkout");
    expect(checkout?.with?.ref).toBe("${{ github.sha }}");

    for (const command of [
      "node-version: 26",
      "npm ci --ignore-scripts",
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
      "npm run check:desktop-fixture-boundary -- apps/neondiff-desktop/dist/NeonDiff.app"
    );
    for (const stepName of [
      "Build unsigned Release app bundle",
      "Check unsigned Release app bundle"
    ]) {
      const step = job?.steps?.find((candidate) => candidate.name === stepName);
      expect(step?.env?.NEONDIFF_DESKTOP_PAID_BETA_CONTRACT).toBe(
        "paid-mac-beta-byo-v1"
      );
      expect(step?.env?.NEONDIFF_DESKTOP_BYO_GITHUB_ENABLED).toBe("true");
    }
    expect(workflow).toContain("unsigned");
    expect(workflow).toMatch(/macOS 15 Keychain contract compilation/);
    expect(workflow).toMatch(/persist-credentials:\s*false/);
    expect(workflow).toMatch(/SOURCE_SHA:/);
    expect(workflow).toMatch(/SOURCE_REF:/);
    const packageStep = job?.steps?.find(
      (step) => step.name === "Package unsigned app bundle and metadata"
    );
    expect(packageStep?.env?.SOURCE_SHA).toBe("${{ github.sha }}");
    expect(packageStep?.env?.SOURCE_REF).toBe(
      "${{ startsWith(github.ref, 'refs/tags/') && github.ref || github.sha }}"
    );
    expect(workflow).toMatch(/actions\/upload-artifact@[0-9a-f]{40}/);
    expect(workflow).not.toMatch(/actions\/checkout@v4/);
    expect(workflow).not.toMatch(/actions\/upload-artifact@v4/);
    expect(workflow).toMatch(/NeonDiff\.app\.zip/);
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
      "artifact_source_sha",
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
    expect(script).toContain("DERIVED_SOURCE_SHA");
    expect(script).toContain("provided source identity does not match the exact checkout");
    expect(script).toContain("artifact source identity does not match the exact checkout");
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
    expect(bundler).toContain('"$SCRIPT_DIR/release-rpaths.sh" sanitize "$APP_BINARY"');
    expect(bundler).toContain('"$SCRIPT_DIR/release-rpaths.sh" assert "$APP_BINARY"');
    expect(bundler).toContain("build-desktop-sealed-worker.mjs");
    expect(bundler).toContain("NeonDiffSourceSHA");
    expect(bundler).toContain("derive_release_source_sha");
    expect(bundler).toContain("release candidates require a detached source checkout");
    expect(bundler).toContain('"$APP_HELPERS/NeonDiffWorker" --version');
  });

  it("builds the credential-bearing worker as one pinned sealed executable", () => {
    const script = read("scripts/build-desktop-sealed-worker.mjs");
    const cli = read("src/cli.ts");
    const entitlements = read(
      "apps/neondiff-desktop/script/worker-runtime.entitlements.plist"
    );

    expect(script).toContain("https://nodejs.org/dist/");
    expect(script).toContain(
      "7ee659a7768e641bbfd5360940660b8e8fd0052f77488f365562bac522fc15d4"
    );
    expect(script).toContain("--build-sea");
    expect(script).toContain('mainFormat: "module"');
    expect(script).toContain('format: "esm"');
    expect(script).toContain(
      '"import.meta.neondiffPackageVersion"'
    );
    expect(script).toContain("portabilityDirectory");
    expect(cli).toContain(
      "typeof sealedPackageVersion === \"string\""
    );
    expect(cli).not.toContain(
      "declare const __NEONDIFF_SEA_PACKAGE_VERSION__"
    );
    expect(script).toContain("/usr/bin/codesign");
    expect(script).toContain("/usr/bin/otool");
    expect(entitlements).toContain(
      "com.apple.security.cs.allow-jit"
    );
    expect(entitlements).not.toContain("get-task-allow");
    expect(entitlements).not.toContain(
      "disable-library-validation"
    );
  });

  it("removes machine-local release rpaths and fails closed on inspection errors", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-release-rpaths-"));
    const binary = join(root, "NeonDiffDesktop");
    const state = join(root, "rpaths.txt");
    const otool = join(root, "otool");
    const installNameTool = join(root, "install_name_tool");
    const helper = "apps/neondiff-desktop/script/release-rpaths.sh";

    try {
      writeFileSync(binary, "fixture");
      writeFileSync(
        state,
        [
          "/usr/lib/swift",
          "@loader_path",
          "/Volumes/Build Disk/Xcode.app/Contents/Developer/usr/lib/swift",
          "@executable_path/../Frameworks"
        ].join("\n") + "\n"
      );
      writeFileSync(
        otool,
        `#!/bin/sh
set -eu
while IFS= read -r rpath; do
  printf '          cmd LC_RPATH\\n      cmdsize 64\\n         path %s (offset 12)\\n' "$rpath"
done < "$NEONDIFF_RPATH_STATE"
`
      );
      writeFileSync(
        installNameTool,
        `#!/bin/sh
set -eu
test "$1" = "-delete_rpath"
grep -Fvx "$2" "$NEONDIFF_RPATH_STATE" > "$NEONDIFF_RPATH_STATE.next"
mv "$NEONDIFF_RPATH_STATE.next" "$NEONDIFF_RPATH_STATE"
`
      );
      chmodSync(otool, 0o755);
      chmodSync(installNameTool, 0o755);

      const env = {
        ...process.env,
        NEONDIFF_RPATH_STATE: state,
        NEONDIFF_OTOOL_BIN: otool,
        NEONDIFF_INSTALL_NAME_TOOL_BIN: installNameTool
      };
      const sanitize = spawnSync(helper, ["sanitize", binary], { encoding: "utf8", env });
      expect(sanitize.status).toBe(0);
      expect(readFileSync(state, "utf8").trim().split("\n")).toEqual([
        "/usr/lib/swift",
        "@loader_path",
        "@executable_path/../Frameworks"
      ]);

      const assertion = spawnSync(helper, ["assert", binary], { encoding: "utf8", env });
      expect(assertion.status).toBe(0);

      writeFileSync(state, "@loader_path/../../escape\n");
      const rejected = spawnSync(helper, ["assert", binary], { encoding: "utf8", env });
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain("non-portable LC_RPATH");

      writeFileSync(otool, "#!/bin/sh\nexit 7\n");
      const unreadable = spawnSync(helper, ["assert", binary], { encoding: "utf8", env });
      expect(unreadable.status).not.toBe(0);
      expect(unreadable.stderr).toContain("unable to inspect release bundle LC_RPATH entries");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
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

  it("documents release-mode bundle commands for the Developer ID flow", () => {
    const runbook = read("apps/neondiff-desktop/docs/mac-release-runbook.md");

    expect(runbook).toContain("script/build_and_run.sh release-build");
    expect(runbook).toContain("script/build_and_run.sh release-bundle-check");
  });
});
