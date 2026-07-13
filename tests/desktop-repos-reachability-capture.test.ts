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
  if [ "\${FAKE_CHECKER_STATUS:-0}" -eq 0 ]; then
    printf '%s\\n' '{"ok":true}'
  else
    printf '%s\\n' '{"ok":false,"failure":"missing outer AXScrollArea ancestor"}'
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
printf '{"schemaVersion":1,"fixture":"tab-repos","requestedContentSize":{"width":1040,"height":680},"acquisition":{"status":"%s","failureReason":%s},"outerScroll":null}\\n' \\
  "\${FAKE_ACQUISITION_STATUS:-complete}" "\${FAKE_ACQUISITION_FAILURE_REASON:-null}" \\
  >"$output_dir/reachability.json"
case "\${FAKE_CAPABILITIES_MODE:-valid}" in
  valid)
    printf '%s\\n' '{"schemaVersion":1,"fixture":"tab-repos","requestedContentSize":{"width":1040,"height":680},"osMajorVersion":26,"acquisition":{"status":"complete","failureReason":null},"scrollToVisibleActionAvailable":true,"boundaryAdvertisesScrollToVisible":false,"outerVerticalScrollBarResolved":true,"outerVerticalScrollBarAdvertisesIncrement":false}' \\
      >"$output_dir/scroll-capabilities.json"
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
      FAKE_CHECKER_MESSAGE: "Reachability trace has no outer scroll area.",
      FAKE_CAPTURE_STATUS: "0",
      FAKE_CAPTURE_MESSAGE: "",
      FAKE_CAPTURE_HANG: "false",
      FAKE_ACQUISITION_STATUS: "complete",
      FAKE_ACQUISITION_FAILURE_REASON: "null",
      FAKE_CAPABILITIES_MODE: "valid",
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
    expect(script).toContain("kill -KILL");
    expect(script).toContain("npm run check:secrets");
    expect(script).toContain("check-desktop-evaluation-packet-secrets.mjs");
    expect(script).not.toMatch(/\bsecurity\s+find-|\blaunchctl\b|\bdefaults\s+(?:read|write)\b/);
  });

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

  it.runIf(process.platform === "darwin")(
    "preserves reachability and public-safe status evidence when the checker reports the expected pre-fix failure",
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
        outerScroll: null
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
        outerVerticalScrollBarAdvertisesIncrement: false
      });
      expect(JSON.parse(readFileSync(join(caseRoot, "capture.json"), "utf8")))
        .toMatchObject({ scrollCapabilities: { path: "scroll-capabilities.json", sha256: expect.any(String) } });
      expect(JSON.parse(readFileSync(join(harness.output, "validation/reachability-check-status.json"), "utf8")))
        .toMatchObject({
          status: "failed",
          checkerFailed: true,
          exitCode: 7,
          expectedPreFixFailure: true,
          reasonCode: "missing_outer_scroll"
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
      const harness = createFakeHarnessRepository();
      const result = runHarness(harness, { FAKE_CAPABILITIES_MODE: "invalid" });

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
    "does not classify an unrelated checker failure as the expected pre-fix result",
    { timeout: 30_000 },
    () => {
      const harness = createFakeHarnessRepository();
      const result = runHarness(harness, { FAKE_CHECKER_MESSAGE: "Reachability trace schema is invalid." });

      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(7);
      expect(JSON.parse(readFileSync(join(harness.output, "validation/reachability-check-status.json"), "utf8")))
        .toMatchObject({
          status: "failed",
          checkerFailed: true,
          exitCode: 7,
          expectedPreFixFailure: false,
          reasonCode: "checker_nonzero"
        });
    }
  );

  it.runIf(process.platform === "darwin")(
    "does not classify failed acquisition as the expected missing-scroll result",
    { timeout: 30_000 },
    () => {
      const harness = createFakeHarnessRepository();
      const result = runHarness(harness, {
        FAKE_ACQUISITION_STATUS: "failed",
        FAKE_ACQUISITION_FAILURE_REASON: '"semantic-missing"'
      });

      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(7);
      expect(JSON.parse(readFileSync(
        join(harness.output, "cases/tab-repos/1040x680/reachability.json"),
        "utf8"
      ))).toMatchObject({ acquisition: { status: "failed", failureReason: "semantic-missing" }, outerScroll: null });
      expect(JSON.parse(readFileSync(join(harness.output, "validation/reachability-check-status.json"), "utf8")))
        .toMatchObject({
          checkerFailed: true,
          exitCode: 7,
          expectedPreFixFailure: false,
          reasonCode: "checker_nonzero"
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
    "terminates timed-out capture and app processes without publishing partials",
    { timeout: 25_000 },
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
        .toMatchObject({ checkerFailed: false, exitCode: 0, expectedPreFixFailure: false, reasonCode: "none" });
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
    expect(docs).toMatch(/missing outer `AXScrollArea` ancestor/i);
    expect(docs).toMatch(/Table scroll/i);
    expect(docs).toMatch(/checker failure preserves `reachability\.json`/i);
    expect(docs).toMatch(/`scroll-capabilities\.json`/i);
    expect(docs).toMatch(/does not perform accessibility actions/i);
    expect(docs).toMatch(/TCC/i);
    expect(docs).toMatch(/does not prove/i);
  });
});
