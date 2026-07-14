import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = "apps/neondiff-desktop/scripts/capture-repos-reachability.sh";
const testPath = "tests/desktop-repos-reachability-capture.test.ts";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeExecutable(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function swiftAffected(files: string[]): { affected: boolean; matched: string[] } {
  return JSON.parse(
    execFileSync("node", ["scripts/swift-affected.mjs", "--files", ...files], { encoding: "utf8" })
  );
}

function createFakeHarnessRepository(): {
  root: string;
  output: string;
  env: NodeJS.ProcessEnv;
  commandLog: string;
} {
  const root = mkdtempSync(join(tmpdir(), "neondiff-repos-capture-test-"));
  roots.push(root);
  const fakeBin = join(root, "fake-bin");
  const swiftBin = join(root, "swift-bin");
  const output = join(root, "evidence");
  const commandLog = join(root, "commands.log");
  const appTemplate = join(root, "fake-app");
  const gitState = join(root, "git-state");
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(swiftBin, { recursive: true });
  mkdirSync(join(root, "apps/neondiff-desktop/scripts"), { recursive: true });
  mkdirSync(join(root, "apps/neondiff-desktop/script"), { recursive: true });
  mkdirSync(join(root, "apps/neondiff-desktop/fixtures/ui"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(gitState, { recursive: true });

  writeFileSync(join(root, scriptPath), readFileSync(scriptPath));
  chmodSync(join(root, scriptPath), 0o755);
  writeFileSync(join(root, "apps/neondiff-desktop/fixtures/ui/tab-repos.json"), '{"id":"tab-repos"}\n');

  writeExecutable(appTemplate, `#!/bin/sh
set -eu
printf 'app %s\\n' "$*" >>"$FAKE_COMMAND_LOG"
printf 'app-pid %s\\n' "$$" >>"$FAKE_COMMAND_LOG"
ready=\${NEONDIFF_DESKTOP_EVALUATION_READY_PATH:?}
case "\${FAKE_APP_READINESS_MODE:-ready}" in
  exit)
    printf 'private launch failure detail\\n'
    exit 73
    ;;
  timeout)
    trap 'exit 0' HUP INT TERM
    while :; do /bin/sleep 0.1; done
    ;;
esac
printf '{"schemaVersion":1,"fixtureId":"tab-repos","pid":%s,"windowNumber":41,"windowFrame":{"x":0,"y":0,"width":1040,"height":702},"contentFrame":{"x":0,"y":22,"width":1040,"height":680},"backingScale":2,"ready":true}\\n' "$$" >"$ready"
trap 'exit 0' HUP INT TERM
while :; do /bin/sleep 0.1; done
`);

  writeExecutable(join(root, "apps/neondiff-desktop/script/build_and_run.sh"), `#!/bin/sh
set -eu
printf 'build-app %s\\n' "$*" >>"$FAKE_COMMAND_LOG"
app="$NEONDIFF_DESKTOP_DIST_DIR/NeonDiffDesktop.app/Contents/MacOS/NeonDiffDesktop"
mkdir -p "$(dirname "$app")"
cp "$FAKE_APP_TEMPLATE" "$app"
chmod +x "$app"
`);

  writeExecutable(join(fakeBin, "git"), `#!/bin/sh
set -eu
printf 'git %s\\n' "$*" >>"$FAKE_COMMAND_LOG"
case "$*" in
  'status --porcelain --untracked-files=all')
    count=0
    [ ! -f "$FAKE_GIT_STATE/status-count" ] || count=$(cat "$FAKE_GIT_STATE/status-count")
    count=$((count + 1))
    printf '%s\\n' "$count" >"$FAKE_GIT_STATE/status-count"
    if [ "\${FAKE_GIT_DIRTY_STATUS_CALL:-0}" -eq "$count" ]; then printf ' M drifted-file\\n'; fi
    exit 0
    ;;
  'rev-parse HEAD')
    count=0
    [ ! -f "$FAKE_GIT_STATE/head-count" ] || count=$(cat "$FAKE_GIT_STATE/head-count")
    count=$((count + 1))
    printf '%s\\n' "$count" >"$FAKE_GIT_STATE/head-count"
    if [ "\${FAKE_GIT_HEAD_DRIFT_CALL:-0}" -eq "$count" ]; then
      printf '%039d1\\n' 0
    else
      printf '%040d\\n' 0
    fi
    exit 0
    ;;
esac
exit 2
`);

  writeExecutable(join(fakeBin, "npm"), `#!/bin/sh
set -eu
printf 'npm %s\\n' "$*" >>"$FAKE_COMMAND_LOG"
printf 'repository secret scan passed\\n'
`);

  writeExecutable(join(fakeBin, "node"), `#!/bin/sh
set -eu
printf 'node %s\\n' "$*" >>"$FAKE_COMMAND_LOG"
if [ "\${FAKE_SAFETY_SCAN_OK:-true}" = true ]; then
  printf '%s\\n' '{"ok":true,"skippedImages":["cases/tab-repos/1040x680/screenshot.png"],"findings":[],"sensitiveFiles":[]}'
  exit 0
fi
printf '%s\\n' '{"ok":false,"skippedImages":["cases/tab-repos/1040x680/screenshot.png"],"findings":[{"rule":"redacted"}],"sensitiveFiles":[]}'
exit 9
`);

  writeExecutable(join(fakeBin, "swift"), `#!/bin/sh
set -eu
printf 'swift %s\\n' "$*" >>"$FAKE_COMMAND_LOG"
case " $* " in
  *' --show-bin-path '*) printf '%s\\n' "$FAKE_SWIFT_BIN"; exit 0 ;;
esac
if [ "$1" = build ]; then exit 0; fi
if [ "$1" = run ]; then
  if [ -n "\${FAKE_CHECKER_OUTPUT:-}" ]; then
    printf '%s\\n' "$FAKE_CHECKER_OUTPUT"
  elif [ "\${FAKE_CHECKER_STATUS:-0}" -eq 0 ]; then
    printf '%s\\n' '{"category":"none","ok":true,"reasonCode":"none","schemaVersion":1,"status":"reachable"}'
  else
    printf '{"category":"%s","ok":false,"reasonCode":"%s","schemaVersion":1,"status":"failed"}\\n' \\
      "\${FAKE_CHECKER_CATEGORY:-geometry}" "\${FAKE_CHECKER_REASON:-no-upward-movement}"
  fi
  if [ -n "\${FAKE_CHECKER_MESSAGE:-}" ]; then printf '%s\\n' "$FAKE_CHECKER_MESSAGE" >&2; fi
  exit "\${FAKE_CHECKER_STATUS:-0}"
fi
exit 2
`);

  writeExecutable(join(swiftBin, "NeonDiffDesktopCapture"), `#!/bin/sh
set -eu
printf 'capture %s\\n' "$*" >>"$FAKE_COMMAND_LOG"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output-dir) output_dir=$2; shift 2 ;;
    --repos-reachability) repos_reachability=true; shift ;;
    *) shift ;;
  esac
done
[ "\${repos_reachability:-false}" = true ] || exit 64
printf 'capture-pid %s\\n' "$$" >>"$FAKE_COMMAND_LOG"
if [ "\${FAKE_CAPTURE_HANG:-false}" = true ]; then
  trap 'exit 0' HUP INT TERM
  while :; do /bin/sleep 0.1; done
fi
printf 'png' >"$output_dir/screenshot.png"
printf '%s\\n' '{"role":"AXWindow","children":[]}' >"$output_dir/accessibility.json"
printf '%s\\n' '{"schemaVersion":1,"fixtureId":"tab-repos"}' >"$output_dir/geometry.json"
printf '%s\\n' '{"schemaVersion":2,"fixture":"tab-repos","ready":true,"quiescent":true,"requestedContentSize":{"width":1040,"height":680},"sampleIntervalMilliseconds":100,"preScrollAcquisitionMilliseconds":200,"postScrollAcquisitionMilliseconds":200,"tolerancePoints":1,"acquisition":{"status":"complete","failureReason":null},"preScrollSamples":[{"elapsedMilliseconds":0,"viewport":{"x":0,"y":0,"width":1040,"height":680},"regions":[{"id":"table","frame":{"x":24,"y":100,"width":900,"height":360}},{"id":"apply-allowlist","frame":{"x":24,"y":600,"width":180,"height":30}},{"id":"boundary-body","frame":{"x":24,"y":650,"width":760,"height":40}}]},{"elapsedMilliseconds":100,"viewport":{"x":0,"y":0,"width":1040,"height":680},"regions":[{"id":"table","frame":{"x":24,"y":100,"width":900,"height":360}},{"id":"apply-allowlist","frame":{"x":24,"y":600,"width":180,"height":30}},{"id":"boundary-body","frame":{"x":24,"y":650,"width":760,"height":40}}]},{"elapsedMilliseconds":200,"viewport":{"x":0,"y":0,"width":1040,"height":680},"regions":[{"id":"table","frame":{"x":24,"y":100,"width":900,"height":360}},{"id":"apply-allowlist","frame":{"x":24,"y":600,"width":180,"height":30}},{"id":"boundary-body","frame":{"x":24,"y":650,"width":760,"height":40}}]}],"scrollInteraction":{"mechanism":"increment-page-press","incrementPagePress":{"actionAdvertised":true,"attemptCount":1,"performResult":"success","outerClipBefore":{"x":20,"y":50,"width":1000,"height":580},"outerClipAfter":{"x":20,"y":50,"width":1000,"height":580}},"valueMutation":null},"postScrollSamples":[{"elapsedMilliseconds":0,"viewport":{"x":0,"y":0,"width":1040,"height":680},"regions":[{"id":"table","frame":{"x":24,"y":0,"width":900,"height":360}},{"id":"apply-allowlist","frame":{"x":24,"y":500,"width":180,"height":30}},{"id":"boundary-body","frame":{"x":24,"y":550,"width":760,"height":40}}]},{"elapsedMilliseconds":100,"viewport":{"x":0,"y":0,"width":1040,"height":680},"regions":[{"id":"table","frame":{"x":24,"y":0,"width":900,"height":360}},{"id":"apply-allowlist","frame":{"x":24,"y":500,"width":180,"height":30}},{"id":"boundary-body","frame":{"x":24,"y":550,"width":760,"height":40}}]},{"elapsedMilliseconds":200,"viewport":{"x":0,"y":0,"width":1040,"height":680},"regions":[{"id":"table","frame":{"x":24,"y":0,"width":900,"height":360}},{"id":"apply-allowlist","frame":{"x":24,"y":500,"width":180,"height":30}},{"id":"boundary-body","frame":{"x":24,"y":550,"width":760,"height":40}}]}]}' >"$output_dir/reachability.json"
jq '(.preScrollSamples[]?, .postScrollSamples[]?) |= . + {
      outerClip:{x:20,y:50,width:1000,height:580},
      boundaryScrollAncestorCount:1
    }' "$output_dir/reachability.json" >"$output_dir/reachability.tmp"
mv "$output_dir/reachability.tmp" "$output_dir/reachability.json"
if [ "\${FAKE_ACQUISITION_STATUS:-complete}" != complete ]; then
  jq --arg status "$FAKE_ACQUISITION_STATUS" --argjson reason "$FAKE_ACQUISITION_FAILURE_REASON" \
    '.acquisition = {status:$status,failureReason:$reason}
      | .ready = false
      | .quiescent = false
      | .scrollInteraction = null
      | .postScrollSamples = []' "$output_dir/reachability.json" \
    >"$output_dir/reachability.tmp"
  mv "$output_dir/reachability.tmp" "$output_dir/reachability.json"
fi
case "\${FAKE_CAPABILITIES_MODE:-valid}" in
  valid)
    printf '%s\\n' '{"schemaVersion":1,"fixture":"tab-repos","requestedContentSize":{"width":1040,"height":680},"osMajorVersion":26,"acquisition":{"status":"complete","failureReason":null},"scrollToVisibleActionAvailable":true,"boundaryAdvertisesScrollToVisible":false,"outerVerticalScrollBarResolved":true,"outerVerticalScrollBarAdvertisesIncrement":false,"outerVerticalIncrementPageResolved":true,"outerVerticalIncrementPageAdvertisesPress":true}' \\
      >"$output_dir/scroll-capabilities.json"
    ;;
  failed)
    printf '{"schemaVersion":1,"fixture":"tab-repos","requestedContentSize":{"width":1040,"height":680},"osMajorVersion":26,"acquisition":{"status":"failed","failureReason":"%s"},"scrollToVisibleActionAvailable":true,"boundaryAdvertisesScrollToVisible":null,"outerVerticalScrollBarResolved":null,"outerVerticalScrollBarAdvertisesIncrement":null,"outerVerticalIncrementPageResolved":null,"outerVerticalIncrementPageAdvertisesPress":null}\n' \
      "\${FAKE_CAPABILITY_FAILURE_REASON:-semantic-missing}" \
      >"$output_dir/scroll-capabilities.json"
    ;;
  missing-page-field)
    printf '%s\\n' '{"schemaVersion":1,"fixture":"tab-repos","requestedContentSize":{"width":1040,"height":680},"osMajorVersion":26,"acquisition":{"status":"complete","failureReason":null},"scrollToVisibleActionAvailable":true,"boundaryAdvertisesScrollToVisible":false,"outerVerticalScrollBarResolved":true,"outerVerticalScrollBarAdvertisesIncrement":false,"outerVerticalIncrementPageResolved":true}' >"$output_dir/scroll-capabilities.json"
    ;;
  unknown-page-field)
    printf '%s\\n' '{"schemaVersion":1,"fixture":"tab-repos","requestedContentSize":{"width":1040,"height":680},"osMajorVersion":26,"acquisition":{"status":"complete","failureReason":null},"scrollToVisibleActionAvailable":true,"boundaryAdvertisesScrollToVisible":false,"outerVerticalScrollBarResolved":true,"outerVerticalScrollBarAdvertisesIncrement":false,"outerVerticalIncrementPageResolved":true,"outerVerticalIncrementPageAdvertisesPress":false,"rawIncrementPage":"forbidden"}' >"$output_dir/scroll-capabilities.json"
    ;;
  invalid-page-cross-field)
    printf '%s\\n' '{"schemaVersion":1,"fixture":"tab-repos","requestedContentSize":{"width":1040,"height":680},"osMajorVersion":26,"acquisition":{"status":"complete","failureReason":null},"scrollToVisibleActionAvailable":true,"boundaryAdvertisesScrollToVisible":false,"outerVerticalScrollBarResolved":true,"outerVerticalScrollBarAdvertisesIncrement":false,"outerVerticalIncrementPageResolved":false,"outerVerticalIncrementPageAdvertisesPress":true}' >"$output_dir/scroll-capabilities.json"
    ;;
  invalid) printf '%s\\n' '{}' >"$output_dir/scroll-capabilities.json" ;;
  missing) ;;
esac
printf '%s\\n' '{"ok":true,"fixtureId":"tab-repos","scrollCapabilities":{"path":"scroll-capabilities.json","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}'
if [ "\${FAKE_CAPTURE_STATUS:-0}" -ne 0 ]; then
  if [ -n "\${FAKE_CAPTURE_MESSAGE:-}" ]; then printf '%s\\n' "$FAKE_CAPTURE_MESSAGE" >&2; fi
  exit "$FAKE_CAPTURE_STATUS"
fi
`);

  return {
    root,
    output,
    commandLog,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      FAKE_APP_TEMPLATE: appTemplate,
      FAKE_APP_READINESS_MODE: "ready",
      FAKE_COMMAND_LOG: commandLog,
      FAKE_SWIFT_BIN: swiftBin,
      FAKE_CHECKER_STATUS: "7",
      FAKE_CHECKER_MESSAGE: "Reachability behavior trace was rejected.",
      FAKE_CHECKER_OUTPUT: "",
      FAKE_CHECKER_CATEGORY: "geometry",
      FAKE_CHECKER_REASON: "no-upward-movement",
      FAKE_CAPTURE_STATUS: "0",
      FAKE_CAPTURE_MESSAGE: "",
      FAKE_CAPTURE_HANG: "false",
      NEONDIFF_DESKTOP_TEST_MODE: "1",
      NEONDIFF_DESKTOP_TEST_CAPTURE_ATTEMPTS: "30",
      FAKE_ACQUISITION_STATUS: "complete",
      FAKE_ACQUISITION_FAILURE_REASON: "null",
      FAKE_CAPABILITIES_MODE: "valid",
      FAKE_CAPABILITY_FAILURE_REASON: "semantic-missing",
      FAKE_SAFETY_SCAN_OK: "true",
      FAKE_GIT_STATE: gitState,
      FAKE_GIT_DIRTY_STATUS_CALL: "0",
      FAKE_GIT_HEAD_DRIFT_CALL: "0"
    }
  };
}

function runHarness(harness: ReturnType<typeof createFakeHarnessRepository>, overrides: NodeJS.ProcessEnv = {}) {
  return spawnSync(join(harness.root, scriptPath), ["--output", harness.output], {
    cwd: harness.root,
    encoding: "utf8",
    env: { ...harness.env, ...overrides },
    timeout: 25_000
  });
}

function focusedStatus(harness: ReturnType<typeof createFakeHarnessRepository>): Record<string, unknown> {
  return JSON.parse(readFileSync(join(harness.output, "validation/focused-capture-status.json"), "utf8"));
}

function expectNoFinalProof(harness: ReturnType<typeof createFakeHarnessRepository>): void {
  expect(existsSync(join(harness.output, "focused-proof.json"))).toBe(false);
  expect(existsSync(join(harness.output, "validation/packet-safety-scan.ok"))).toBe(false);
}

function launchedPID(harness: ReturnType<typeof createFakeHarnessRepository>): number {
  const commands = readFileSync(harness.commandLog, "utf8");
  const match = commands.match(/^app-pid (\d+)$/m);
  expect(match).not.toBeNull();
  return Number(match?.[1]);
}

function capturePID(harness: ReturnType<typeof createFakeHarnessRepository>): number {
  const commands = readFileSync(harness.commandLog, "utf8");
  const match = commands.match(/^capture-pid (\d+)$/m);
  expect(match).not.toBeNull();
  return Number(match?.[1]);
}

describe("focused Repos reachability capture", () => {
  it("rejects relative or pre-existing output before capture", () => {
    const relative = spawnSync(scriptPath, ["--output", "relative-evidence"], { encoding: "utf8" });
    expect(relative.status).toBe(64);
    expect(relative.stderr).toMatch(/usage:/);

    const existing = mkdtempSync(join(tmpdir(), "neondiff-existing-repos-capture-"));
    roots.push(existing);
    const collision = spawnSync(scriptPath, ["--output", existing], { encoding: "utf8" });
    expect(collision.status).toBe(65);
    expect(collision.stderr).toContain("focused capture output must not already exist");
  });

  it("defines a syntactically valid, exact-HEAD, private focused harness", () => {
    const syntax = spawnSync("sh", ["-n", scriptPath], { encoding: "utf8" });
    expect(syntax.status, syntax.stderr).toBe(0);

    const script = readFileSync(scriptPath, "utf8");
    expect(script).toContain("umask 077");
    expect(script).toContain('"/tmp/neondiff-desktop-evaluation.XXXXXXXX"');
    expect(script).not.toContain("neondiff-desktop-repos-reachability.XXXXXXXX");
    expect(script).toContain("canonical focused capture requires a clean worktree");
    expect(script).toContain("assert_clean_head");
    expect(script).toContain('fixture_id="tab-repos"');
    expect(script).toContain('content_size="1040x680"');
    expect(script).toContain("NEONDIFF_DESKTOP_EVALUATION_READY_PATH");
    expect(script).toContain("capture helper timed out");
    expect(script).toContain("NEONDIFF_DESKTOP_TEST_CAPTURE_ATTEMPTS");
    expect(script).toContain("unset NEONDIFF_DESKTOP_TEST_MODE NEONDIFF_DESKTOP_TEST_CAPTURE_ATTEMPTS");
    expect(script).toContain("kill -KILL");
    expect(script).toContain("npm run check:secrets");
    expect(script).toContain("check-desktop-evaluation-packet-secrets.mjs");
    expect(script).not.toMatch(/\bsecurity\s+find-|\blaunchctl\b|\bdefaults\s+(?:read|write)\b/);
  });

  it.runIf(process.platform === "darwin")(
    "rejects an unsafe test-only capture timeout override before launching",
    () => {
      const harness = createFakeHarnessRepository();
      const result = runHarness(harness, { NEONDIFF_DESKTOP_TEST_CAPTURE_ATTEMPTS: "151" });

      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(65);
      expect(result.stderr).toContain("test capture attempt limit must be an integer from 1 through 150");
      expect(readFileSync(harness.commandLog, "utf8")).not.toContain("build-app");
    }
  );

  it("builds one DEBUG app, capture helper, and checker and launches only the Repos fixture", () => {
    const script = readFileSync(scriptPath, "utf8");
    const canonical = readFileSync("apps/neondiff-desktop/scripts/capture-evaluation-baseline.sh", "utf8");
    expect(script.match(/build_and_run\.sh" build/g)).toHaveLength(1);
    expect(script.match(/--product NeonDiffDesktopCapture/g)).toHaveLength(1);
    expect(script.match(/--product NeonDiffDesktopReachabilityChecks/g)).toHaveLength(1);
    const appLaunch = script.match(/NEONDIFF_DESKTOP_EVALUATION_READY_PATH[\s\S]*?app_pid=\$!/)?.[0];
    const captureLaunch = script.match(/"\$capture_bin"[\s\S]*?capture_pid=\$!/)?.[0];
    expect(appLaunch).toMatch(/--ui-fixture "\$fixture"[\s\S]*--content-size "\$content_size"[\s\S]*--disable-animations/);
    expect(appLaunch).not.toContain("--repos-reachability");
    expect(captureLaunch).toContain("--repos-reachability");
    expect(canonical).not.toContain("--repos-reachability");
    expect(script).not.toMatch(/for\s+size\s+in/);
    expect(script).not.toContain("1280x800");
    expect(script).not.toContain("1440x900");
  });

  it("keeps the Increment Page action full-chain rebound, single-shot, and ledger-first", () => {
    const captureSource = readFileSync(
      "apps/neondiff-desktop/Sources/NeonDiffDesktopCapture/main.swift",
      "utf8"
    );
    const incrementPageProbe = captureSource.match(
      /private func incrementPageButton[\s\S]*?private func verifiedWindow/
    )?.[0];
    expect(incrementPageProbe).toBeDefined();
    expect(incrementPageProbe).toContain("kAXChildrenAttribute");
    expect(incrementPageProbe).toMatch(/for child in children[\s\S]*try requireTargetPID\(child\)/);
    expect(incrementPageProbe).toContain("kAXRoleAttribute");
    expect(incrementPageProbe).toContain("kAXSubroleAttribute");
    expect(incrementPageProbe).not.toContain("visit(");
    expect(captureSource).toContain("NSAccessibility.Action.press.rawValue");
    expect(captureSource).toContain("AXUIElementCopyActionNames");
    const capabilityProbe = captureSource.match(
      /func captureScrollCapabilities[\s\S]*?private func acquireStableSamples/
    )?.[0];
    expect(capabilityProbe).not.toContain("AXUIElementPerformAction");
    const behaviorPress = captureSource.match(
      /private func performIncrementPagePress[\s\S]*?private func revalidatedIncrementPagePressBinding/
    )?.[0];
    expect(behaviorPress?.match(/AXUIElementPerformAction/g)).toHaveLength(1);
    expect(behaviorPress).toContain("NSAccessibility.Action.press.rawValue");
    expect(behaviorPress).not.toMatch(/for |while |repeat /);
    expect(behaviorPress).not.toMatch(/verifiedWindow\(|semanticElements\(|outermostScrollArea\(/);
    const revalidation = captureSource.match(
      /private func revalidatedIncrementPagePressBinding[\s\S]*?private func interactionWithSettledOuterClipAfter/
    )?.[0];
    expect(revalidation).toContain("let current = try incrementPagePressBinding()");
    expect(revalidation?.match(/CFEqual\(/g)).toHaveLength(7);
    expect(revalidation).toContain("boundaryScrollAncestorCount == current.semantic.boundaryScrollAncestorCount");
    expect(revalidation).toContain("original.actionAdvertised == current.actionAdvertised");
    expect(revalidation).toContain("throw Failure.semanticChanged");
    const captureFlow = captureSource.match(
      /func capture\(\)[\s\S]*?func captureScrollCapabilities/
    )?.[0];
    expect(captureFlow).toMatch(
      /scrollInteraction = try performIncrementPagePress[\s\S]*?post = acquireStableSamples\(\)[\s\S]*?interactionWithSettledOuterClipAfter/
    );
    expect(captureSource).toMatch(
      /outerClip: outerClip,[\s\S]*?boundaryScrollAncestorCount: binding\.boundaryScrollAncestorCount/
    );
    const checkerSection = readFileSync(scriptPath, "utf8").match(
      /checker_status=0[\s\S]*?reachability_sha=/
    )?.[0];
    expect(checkerSection).not.toMatch(/jq[\s\S]*?"\$reachability"/);
  });

  it.runIf(process.platform === "darwin")(
    "preserves reachability and public-safe status evidence when the checker rejects the behavior trace",
    { timeout: 30_000 },
    () => {
      const harness = createFakeHarnessRepository();
      const result = runHarness(harness);

      expect(result.error, `${result.stderr}\n${result.stdout}`).toBeUndefined();
      const commandTrace = existsSync(harness.commandLog) ? readFileSync(harness.commandLog, "utf8") : "";
      expect(result.status, `${result.stderr}\n${result.stdout}\n${commandTrace}`).toBe(7);
      const caseRoot = join(harness.output, "cases/tab-repos/1040x680");
      expect(JSON.parse(readFileSync(join(caseRoot, "reachability.json"), "utf8"))).toMatchObject({
        fixture: "tab-repos",
        requestedContentSize: { width: 1040, height: 680 },
        scrollInteraction: { mechanism: "increment-page-press", valueMutation: null }
      });
      expect(JSON.parse(readFileSync(join(caseRoot, "scroll-capabilities.json"), "utf8"))).toEqual({
        schemaVersion: 1,
        fixture: "tab-repos",
        requestedContentSize: { width: 1040, height: 680 },
        osMajorVersion: 26,
        acquisition: { status: "complete", failureReason: null },
        scrollToVisibleActionAvailable: true,
        boundaryAdvertisesScrollToVisible: false,
        outerVerticalScrollBarResolved: true,
        outerVerticalScrollBarAdvertisesIncrement: false,
        outerVerticalIncrementPageResolved: true,
        outerVerticalIncrementPageAdvertisesPress: true
      });
      expect(JSON.parse(readFileSync(join(caseRoot, "capture.json"), "utf8")))
        .toMatchObject({ scrollCapabilities: { path: "scroll-capabilities.json", sha256: expect.any(String) } });
      expect(JSON.parse(readFileSync(join(harness.output, "validation/reachability-check-status.json"), "utf8")))
        .toEqual({
          schemaVersion: 2,
          status: "failed",
          checkerFailed: true,
          exitCode: 7,
          category: "geometry",
          reasonCode: "no-upward-movement"
        });
      expect(JSON.parse(readFileSync(join(harness.output, "validation/packet-safety-scan.json"), "utf8")))
        .toMatchObject({ ok: true, findings: [], sensitiveFiles: [] });
      expect(JSON.parse(readFileSync(join(harness.output, "focused-proof.json"), "utf8"))
        .scrollCapabilitiesSHA256).toMatch(/^[a-f0-9]{64}$/);
      expect(existsSync(join(harness.output, "validation/reachability-check.stderr"))).toBe(false);

      const ready = JSON.parse(readFileSync(join(caseRoot, "readiness.json"), "utf8"));
      expect(() => process.kill(ready.pid, 0)).toThrow();

      const commands = commandTrace;
      expect(commands.match(/build-app build/g)).toHaveLength(1);
      expect(commands.match(/swift build .*--product NeonDiffDesktopCapture/g)).toHaveLength(1);
      expect(commands.match(/swift build .*--product NeonDiffDesktopReachabilityChecks/g)).toHaveLength(1);
      expect(commands).toMatch(/app --ui-testing --ui-fixture .*tab-repos\.json --content-size 1040x680 --disable-animations/);
      expect(commands).not.toMatch(/app .*--repos-reachability/);
      expect(commands).toMatch(/capture .*--output-dir .* --repos-reachability/);
      expect(commands).toMatch(/swift run --skip-build --package-path .* NeonDiffDesktopReachabilityChecks .*reachability\.json/);
    }
  );

  it.runIf(process.platform === "darwin")(
    "rejects a capture that omits the sanitized scroll capability artifact",
    { timeout: 30_000 },
    () => {
      const harness = createFakeHarnessRepository();
      const result = runHarness(harness, { FAKE_CAPABILITIES_MODE: "missing" });

      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(1);
      expect(focusedStatus(harness)).toMatchObject({
        status: "incomplete",
        phase: "capture",
        reasonCode: "capture_output_incomplete",
        focusedProof: "not_emitted"
      });
      expect(existsSync(join(harness.output, "cases/tab-repos/1040x680"))).toBe(false);
      expectNoFinalProof(harness);
    }
  );

  it.runIf(process.platform === "darwin")(
    "rejects a malformed sanitized scroll capability artifact",
    { timeout: 30_000 },
    () => {
      for (const mode of [
        "invalid",
        "missing-page-field",
        "unknown-page-field",
        "invalid-page-cross-field"
      ]) {
        const harness = createFakeHarnessRepository();
        const result = runHarness(harness, { FAKE_CAPABILITIES_MODE: mode });

        expect(result.status, `${mode}: ${result.stderr}\n${result.stdout}`).toBe(1);
        expect(focusedStatus(harness)).toMatchObject({
          status: "incomplete",
          phase: "capture",
          reasonCode: "capture_output_incomplete",
          focusedProof: "not_emitted"
        });
        expect(existsSync(join(harness.output, "cases/tab-repos/1040x680"))).toBe(false);
        expectNoFinalProof(harness);
      }
    }
  );

  it.runIf(process.platform === "darwin")(
    "accepts an exact typed capability acquisition failure",
    { timeout: 30_000 },
    () => {
      const harness = createFakeHarnessRepository();
      const result = runHarness(harness, { FAKE_CAPABILITIES_MODE: "failed" });

      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(7);
      expect(JSON.parse(readFileSync(
        join(harness.output, "cases/tab-repos/1040x680/scroll-capabilities.json"),
        "utf8"
      ))).toMatchObject({
        acquisition: { status: "failed", failureReason: "semantic-missing" },
        boundaryAdvertisesScrollToVisible: null,
        outerVerticalScrollBarResolved: null,
        outerVerticalScrollBarAdvertisesIncrement: null,
        outerVerticalIncrementPageResolved: null,
        outerVerticalIncrementPageAdvertisesPress: null
      });
    }
  );

  it.runIf(process.platform === "darwin")(
    "rejects an unknown capability acquisition failure reason",
    { timeout: 30_000 },
    () => {
      const harness = createFakeHarnessRepository();
      const result = runHarness(harness, {
        FAKE_CAPABILITIES_MODE: "failed",
        FAKE_CAPABILITY_FAILURE_REASON: "unknown-reason"
      });

      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(1);
      expect(focusedStatus(harness)).toMatchObject({
        status: "incomplete",
        phase: "capture",
        reasonCode: "capture_output_incomplete",
        focusedProof: "not_emitted"
      });
      expect(existsSync(join(harness.output, "cases/tab-repos/1040x680"))).toBe(false);
      expectNoFinalProof(harness);
    }
  );

  it.runIf(process.platform === "darwin")(
    "classifies every checker rejection as an ordinary checker failure",
    { timeout: 30_000 },
    () => {
      const harness = createFakeHarnessRepository();
      const result = runHarness(harness, {
        FAKE_CHECKER_MESSAGE: "Reachability trace action was unavailable.",
        FAKE_CHECKER_CATEGORY: "action",
        FAKE_CHECKER_REASON: "action-not-advertised"
      });

      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(7);
      expect(JSON.parse(readFileSync(join(harness.output, "validation/reachability-check-status.json"), "utf8")))
        .toMatchObject({
          status: "failed",
          checkerFailed: true,
          exitCode: 7,
          category: "action",
          reasonCode: "action-not-advertised"
        });
    }
  );

  it.runIf(process.platform === "darwin")(
    "fails closed on malformed checker output without inferring from the raw trace",
    { timeout: 30_000 },
    () => {
      const harness = createFakeHarnessRepository();
      const result = runHarness(harness, { FAKE_CHECKER_OUTPUT: "{}" });

      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(7);
      expect(JSON.parse(readFileSync(join(harness.output, "validation/reachability-check-status.json"), "utf8")))
        .toEqual({
          schemaVersion: 2,
          status: "failed",
          checkerFailed: true,
          exitCode: 7,
          category: "checker",
          reasonCode: "checker-result-invalid"
        });
    }
  );

  it.runIf(process.platform === "darwin")(
    "preserves a typed failed acquisition without a behavior interaction",
    { timeout: 30_000 },
    () => {
      const harness = createFakeHarnessRepository();
      const result = runHarness(harness, {
        FAKE_ACQUISITION_STATUS: "failed",
        FAKE_ACQUISITION_FAILURE_REASON: '"semantic-missing"',
        FAKE_CHECKER_CATEGORY: "acquisition",
        FAKE_CHECKER_REASON: "acquisition-semantic-missing"
      });

      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(7);
      expect(JSON.parse(readFileSync(
        join(harness.output, "cases/tab-repos/1040x680/reachability.json"),
        "utf8"
      ))).toMatchObject({
        ready: false,
        quiescent: false,
        acquisition: { status: "failed", failureReason: "semantic-missing" },
        scrollInteraction: null,
        postScrollSamples: []
      });
      expect(JSON.parse(readFileSync(join(harness.output, "validation/reachability-check-status.json"), "utf8")))
        .toMatchObject({
          checkerFailed: true,
          exitCode: 7,
          category: "acquisition",
          reasonCode: "acquisition-semantic-missing"
        });
    }
  );

  it.runIf(process.platform === "darwin")(
    "normalizes an app exit before readiness without exposing the private launch log",
    { timeout: 30_000 },
    () => {
      const harness = createFakeHarnessRepository();
      const result = runHarness(harness, { FAKE_APP_READINESS_MODE: "exit" });

      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(1);
      expect(focusedStatus(harness)).toMatchObject({
        status: "incomplete",
        phase: "launch",
        reasonCode: "fixture_launch_failed",
        publicSafety: "incomplete",
        focusedProof: "not_emitted"
      });
      expectNoFinalProof(harness);
      expect(existsSync(join(harness.output, "cases/tab-repos/1040x680"))).toBe(false);
      expect(existsSync(join(harness.output, "validation/launch.log"))).toBe(false);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("private launch failure detail");
      expect(() => process.kill(launchedPID(harness), 0)).toThrow();
    }
  );

  it.runIf(process.platform === "darwin")(
    "terminates an app that times out before readiness and records a public-safe status",
    { timeout: 30_000 },
    () => {
      const harness = createFakeHarnessRepository();
      const result = runHarness(harness, { FAKE_APP_READINESS_MODE: "timeout" });

      expect(result.error, `${result.stderr}\n${result.stdout}`).toBeUndefined();
      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(1);
      expect(focusedStatus(harness)).toMatchObject({
        status: "incomplete",
        phase: "readiness",
        reasonCode: "readiness_timeout",
        publicSafety: "incomplete",
        focusedProof: "not_emitted"
      });
      expectNoFinalProof(harness);
      expect(existsSync(join(harness.output, "cases/tab-repos/1040x680"))).toBe(false);
      expect(existsSync(join(harness.output, "validation/launch.log"))).toBe(false);
      expect(() => process.kill(launchedPID(harness), 0)).toThrow();
    }
  );

  it.runIf(process.platform === "darwin")(
    "rejects capture partials and normalizes a Screen Recording failure without raw stderr",
    { timeout: 30_000 },
    () => {
      const harness = createFakeHarnessRepository();
      const result = runHarness(harness, {
        FAKE_CAPTURE_STATUS: "13",
        FAKE_CAPTURE_MESSAGE: "Capture permission is unavailable: Screen Recording"
      });

      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(13);
      expect(focusedStatus(harness)).toMatchObject({
        status: "incomplete",
        phase: "capture",
        reasonCode: "screen_recording_unavailable",
        captureExitCode: 13,
        publicSafety: "incomplete",
        focusedProof: "not_emitted"
      });
      expectNoFinalProof(harness);
      expect(existsSync(join(harness.output, "cases/tab-repos/1040x680"))).toBe(false);
      expect(existsSync(join(harness.output, "validation/capture.stderr"))).toBe(false);
      expect(() => process.kill(launchedPID(harness), 0)).toThrow();
    }
  );

  it.runIf(process.platform === "darwin")(
    "normalizes an Accessibility failure without raw stderr",
    { timeout: 30_000 },
    () => {
      const harness = createFakeHarnessRepository();
      const result = runHarness(harness, {
        FAKE_CAPTURE_STATUS: "13",
        FAKE_CAPTURE_MESSAGE: "Capture permission is unavailable: Accessibility"
      });

      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(13);
      expect(focusedStatus(harness)).toMatchObject({
        status: "incomplete",
        phase: "capture",
        reasonCode: "accessibility_unavailable",
        captureExitCode: 13,
        publicSafety: "incomplete",
        focusedProof: "not_emitted"
      });
      expectNoFinalProof(harness);
      expect(existsSync(join(harness.output, "cases/tab-repos/1040x680"))).toBe(false);
      expect(existsSync(join(harness.output, "validation/capture.stderr"))).toBe(false);
      expect(() => process.kill(launchedPID(harness), 0)).toThrow();
    }
  );

  it.runIf(process.platform === "darwin")(
    "terminates timed-out capture and app processes without publishing partials",
    { timeout: 30_000 },
    () => {
      const harness = createFakeHarnessRepository();
      const result = runHarness(harness, { FAKE_CAPTURE_HANG: "true" });

      expect(result.error, `${result.stderr}\n${result.stdout}`).toBeUndefined();
      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(124);
      expect(focusedStatus(harness)).toMatchObject({
        status: "incomplete",
        phase: "capture",
        reasonCode: "capture_timeout",
        captureExitCode: 124,
        publicSafety: "incomplete",
        focusedProof: "not_emitted"
      });
      expectNoFinalProof(harness);
      expect(existsSync(join(harness.output, "cases/tab-repos/1040x680"))).toBe(false);
      expect(() => process.kill(capturePID(harness), 0)).toThrow();
      expect(() => process.kill(launchedPID(harness), 0)).toThrow();
    }
  );

  it.runIf(process.platform === "darwin")(
    "keeps proof incomplete when the public-safety scan fails",
    { timeout: 30_000 },
    () => {
      const harness = createFakeHarnessRepository();
      const result = runHarness(harness, {
        FAKE_CHECKER_STATUS: "0",
        FAKE_CHECKER_MESSAGE: "",
        FAKE_SAFETY_SCAN_OK: "false"
      });

      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(9);
      expect(focusedStatus(harness)).toMatchObject({
        status: "incomplete",
        phase: "public_safety",
        reasonCode: "public_safety_failed",
        publicSafety: "failed",
        focusedProof: "not_emitted"
      });
      expectNoFinalProof(harness);
      expect(existsSync(join(harness.output, "validation/packet-safety-scan.json"))).toBe(false);
      expect(() => process.kill(launchedPID(harness), 0)).toThrow();
    }
  );

  it.runIf(process.platform === "darwin")(
    "records source drift as incomplete before launching the fixture",
    { timeout: 30_000 },
    () => {
      const harness = createFakeHarnessRepository();
      const result = runHarness(harness, { FAKE_GIT_DIRTY_STATUS_CALL: "2" });

      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(65);
      expect(focusedStatus(harness)).toMatchObject({
        status: "incomplete",
        phase: "source",
        reasonCode: "source_changed",
        publicSafety: "incomplete",
        focusedProof: "not_emitted"
      });
      expectNoFinalProof(harness);
      expect(readFileSync(harness.commandLog, "utf8")).not.toMatch(/^app /m);
    }
  );

  it.runIf(process.platform === "darwin")(
    "records exact-HEAD drift as incomplete before launching the fixture",
    { timeout: 30_000 },
    () => {
      const harness = createFakeHarnessRepository();
      const result = runHarness(harness, { FAKE_GIT_HEAD_DRIFT_CALL: "2" });

      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(65);
      expect(focusedStatus(harness)).toMatchObject({
        status: "incomplete",
        phase: "source",
        reasonCode: "source_changed",
        publicSafety: "incomplete",
        focusedProof: "not_emitted"
      });
      expectNoFinalProof(harness);
      expect(readFileSync(harness.commandLog, "utf8")).not.toMatch(/^app /m);
    }
  );

  it.runIf(process.platform === "darwin")(
    "does not publish proof when source drift is detected after the safety gate",
    { timeout: 30_000 },
    () => {
      const harness = createFakeHarnessRepository();
      const result = runHarness(harness, {
        FAKE_CHECKER_STATUS: "0",
        FAKE_CHECKER_MESSAGE: "",
        FAKE_GIT_DIRTY_STATUS_CALL: "4"
      });

      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(65);
      expect(focusedStatus(harness)).toMatchObject({
        status: "incomplete",
        phase: "source",
        reasonCode: "source_changed",
        publicSafety: "incomplete",
        focusedProof: "not_emitted"
      });
      expectNoFinalProof(harness);
      expect(existsSync(join(harness.output, "validation/packet-safety-scan.json"))).toBe(false);
    }
  );

  it.runIf(process.platform === "darwin")(
    "emits final proof only after a green checker and passing safety scan",
    { timeout: 30_000 },
    () => {
      const harness = createFakeHarnessRepository();
      const result = runHarness(harness, { FAKE_CHECKER_STATUS: "0", FAKE_CHECKER_MESSAGE: "" });

      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(focusedStatus(harness)).toMatchObject({
        status: "complete",
        phase: "complete",
        reasonCode: "none",
        publicSafety: "passed",
        focusedProof: "emitted"
      });
      expect(JSON.parse(readFileSync(join(harness.output, "validation/reachability-check-status.json"), "utf8")))
        .toMatchObject({
          schemaVersion: 2,
          checkerFailed: false,
          exitCode: 0,
          category: "none",
          reasonCode: "none"
        });
      expect(existsSync(join(harness.output, "focused-proof.json"))).toBe(true);
      expect(existsSync(join(harness.output, "validation/packet-safety-scan.ok"))).toBe(true);
      expect(() => process.kill(launchedPID(harness), 0)).toThrow();
    }
  );

  it("routes the focused harness contract through the Swift desktop gate", () => {
    expect(swiftAffected([testPath])).toMatchObject({ affected: true, matched: [testPath] });
  });

  it("documents a partial #517 dev proof outside the canonical #515 packet", () => {
    const docs = readFileSync("apps/neondiff-desktop/docs/ui-evaluation.md", "utf8");
    expect(docs).toMatch(/focused partial #517 proof/i);
    expect(docs).toMatch(/outside the canonical #515 packet/i);
    expect(docs).toMatch(/performs that public\s+action exactly once/i);
    expect(docs).toMatch(/re-resolves the full Boundary -> outer scroll -> vertical\s+scrollbar -> direct Increment Page chain/i);
    expect(docs).toMatch(/successful action\s+ledger is persisted before any post-action read/i);
    expect(docs).toMatch(/every settled post-action outer clip/i);
    expect(docs).toMatch(/rigid\s+upward translation/i);
    expect(docs).toMatch(/nested Table/i);
    expect(docs).toMatch(/checker failure preserves\s+`reachability\.json`/i);
    expect(docs).toMatch(/runner does not infer a result from the raw\s+trace/i);
    expect(docs).toMatch(/`scroll-capabilities\.json`/i);
    expect(docs).toMatch(/does not perform accessibility actions/i);
    expect(docs).toMatch(/TCC/i);
    expect(docs).toMatch(/does not prove/i);
  });
});
