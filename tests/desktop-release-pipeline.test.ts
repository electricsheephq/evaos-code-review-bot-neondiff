import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
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

function immutableReleaseInputValidation(workflow: string): string {
  const parsed = YAML.parse(workflow) as {
    jobs?: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
  };
  const step = parsed.jobs?.["public-download-install-canary"]?.steps?.find(
    (candidate) => candidate.name === "Validate immutable release input"
  );
  if (!step?.run) throw new Error("missing immutable release validation step");
  return step.run;
}

function feedItemParser(workflow: string): string {
  const parsed = YAML.parse(workflow) as {
    jobs?: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
  };
  const step = parsed.jobs?.["public-download-install-canary"]?.steps?.find(
    (candidate) => candidate.name === "Verify version build feed and Sparkle signature agreement"
  );
  const match = step?.run?.match(/python3 - [^\n]+ <<'PY'\n([\s\S]*?)\nPY/);
  if (!match) throw new Error("missing exact feed XML parser");
  return match[1];
}

function runImmutableReleaseInputValidation(
  validationScript: string,
  input: { releaseTag: string; artifactName: string; artifactSha256: string }
) {
  const root = mkdtempSync(join(tmpdir(), "neondiff-release-input-"));
  const outputPath = join(root, "github-output");
  const bin = join(root, "bin");
  const uname = join(bin, "uname");
  mkdirSync(bin);
  writeFileSync(uname, "#!/bin/sh\nprintf '%s\\n' arm64\n");
  chmodSync(uname, 0o755);
  const result = spawnSync("bash", ["-euo", "pipefail", "-c", validationScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      RELEASE_TAG: input.releaseTag,
      ARTIFACT_NAME: input.artifactName,
      ARTIFACT_SHA256: input.artifactSha256,
      GITHUB_OUTPUT: outputPath
    }
  });
  return { result, outputPath };
}

const retiredCoreChecksTarget = ["NeonDiffDesktopCore", "Checks"].join("");

describe("NeonDiff desktop release-smoke pipeline", () => {
  it("accepts exact beta and annotated-style RC identities while rejecting drift", () => {
    const workflow = read(".github/workflows/paid-beta-public-download-canary.yml");
    const validationScript = immutableReleaseInputValidation(workflow);
    const digest = "a".repeat(64);

    for (const input of [
      {
        releaseTag: "v1.1.0-beta.7",
        artifactName: "NeonDiff-1.1.0-beta.7-build42-macOS.zip"
      },
      {
        releaseTag: "v1.1.0-rc.1",
        artifactName: "NeonDiff-1.1.0-rc.1-build42-macOS.zip"
      }
    ]) {
      const { result, outputPath } = runImmutableReleaseInputValidation(validationScript, {
        ...input,
        artifactSha256: digest
      });
      expect(result.status, `${input.releaseTag} ${input.artifactName}: ${result.stderr}`).toBe(0);
      expect(readFileSync(outputPath, "utf8")).toMatch(
        /(?:release_channel|version|artifact_build)=/
      );
    }

    for (const input of [
      {
        releaseTag: "v1.1.0-rc",
        artifactName: "NeonDiff-1.1.0-rc-build42-macOS.zip"
      },
      {
        releaseTag: "v1.1.0-rc.1",
        artifactName: "NeonDiff-1.1.0-beta.1-build42-macOS.zip"
      },
      {
        releaseTag: "v1.1.0-rc.1",
        artifactName: "NeonDiff-1.1.0-rc.2-build42-macOS.zip"
      },
      {
        releaseTag: "v1.1.0-rc.1",
        artifactName: "NeonDiff-1.1.0-rc.1-macOS.zip"
      },
      {
        releaseTag: "v1.1.0-rc.1",
        artifactName: "NeonDiff-1.1.0-rc.1-build42-macOS.zip",
        artifactSha256: "A".repeat(64)
      }
    ]) {
      const { result } = runImmutableReleaseInputValidation(validationScript, {
        ...input,
        artifactSha256: input.artifactSha256 ?? digest
      });
      expect(result.status, `${input.releaseTag} ${input.artifactName}`).not.toBe(0);
    }
  });

  it("binds feed metadata to one exact enclosure and rejects sibling or URL drift", () => {
    const workflow = read(".github/workflows/paid-beta-public-download-canary.yml");
    const parser = feedItemParser(workflow);
    const root = mkdtempSync(join(tmpdir(), "neondiff-feed-fixture-"));
    const feedPath = join(root, "appcast.xml");
    const feedUrl = "https://www.neondiff.com/updates/beta/appcast.xml";
    const artifactUrl = "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/releases/download/v1.1.0-rc.1/NeonDiff-1.1.0-rc.1-build42-macOS.zip";
    const signature = Buffer.alloc(64, 7).toString("base64");
    const publicKey = Buffer.alloc(32, 9).toString("base64");
    const runParser = (xml: string) => {
      writeFileSync(feedPath, xml);
      return spawnSync(
        "python3",
        ["-", feedPath, artifactUrl, "42", "1.1.0-rc.1", feedUrl, publicKey],
        { encoding: "utf8", input: parser }
      );
    };
    try {
      const valid = runParser(`<?xml version="1.0"?><rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><link>${feedUrl}</link><item><description>${artifactUrl} sparkle:version="42"</description><enclosure url="https://stale.invalid/old.zip"/></item><item><enclosure url="${artifactUrl}" sparkle:version="42" sparkle:shortVersionString="1.1.0-rc.1" sparkle:edSignature="${signature}"/></item></channel></rss>`);
      expect(valid.status, valid.stderr).toBe(0);
      expect(valid.stdout.trim()).toBe(signature);

      const wrongEnclosure = runParser(`<?xml version="1.0"?><rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><link>${feedUrl}</link><item><description>${artifactUrl} sparkle:version="42" sparkle:edSignature="${signature}"</description><enclosure url="https://wrong.invalid/NeonDiff.zip" sparkle:version="42" sparkle:shortVersionString="1.1.0-rc.1" sparkle:edSignature="${signature}"/></item></channel></rss>`);
      expect(wrongEnclosure.status).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
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
      "releases/download",
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
      'test "$release_channel" = "$artifact_channel"',
      'test "$release_number" = "$artifact_number"',
      "git/ref/tags",
      "'.object.type'",
      "sha256:$ARTIFACT_SHA256",
      "CFBundleShortVersionString",
      "CFBundleVersion",
      "SUPublicEDKey",
      "edSignature",
      "xml.etree.ElementTree",
      "len(matches) != 1",
      "Curve25519.Signing.PublicKey",
      "isValidSignature"
    ]) {
      expect(workflow).toContain(command);
    }

    expect(workflow).toMatch(/actions\/upload-artifact@[0-9a-f]{40}/);
    expect(workflow).not.toMatch(/actions\/upload-artifact@v4/);
    expect(workflow).not.toMatch(/\$\{\{\s*secrets\./);
    expect(workflow).not.toContain("spctl -a -vv");
    expect(workflow).not.toContain("open -n");
    expect(workflow).not.toContain("NeonDiffDesktop");
    expect(workflow).toContain("https://www.neondiff.com/updates/beta/appcast.xml");
    expect(workflow).not.toContain("grep -Fq \"<link>$PUBLIC_FEED_URL</link>\"");
    expect(workflow).not.toMatch(/\[\[\s*"\$sparkle_key"\s*=~/);
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
    expect(bundler).toContain('"$SCRIPT_DIR/release-rpaths.sh" sanitize "$APP_BINARY"');
    expect(bundler).toContain('"$SCRIPT_DIR/release-rpaths.sh" assert "$APP_BINARY"');
    expect(bundler).toContain("build-desktop-sealed-worker.mjs");
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
