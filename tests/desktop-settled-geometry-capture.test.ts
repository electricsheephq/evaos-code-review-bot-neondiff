import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = "apps/neondiff-desktop/scripts/capture-settled-geometry.sh";
const testPath = "tests/desktop-settled-geometry-capture.test.ts";
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

function traceFixture(): object {
  const frame = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
  const sample = (section: "overview" | "repos", elapsedMilliseconds: number) => ({
    elapsedMilliseconds,
    windowFrame: frame(0, 0, 1040, 710),
    contentFrame: frame(0, 30, 1040, 680),
    regions: [
      { id: "chrome", frame: frame(0, 30, 1040, 82) },
      { id: "sidebar", frame: frame(0, 112, 230, 598) },
      { id: "detail", frame: frame(231, 112, 809, 598) },
      ...(section === "overview"
        ? [{ id: "overview-sentinel", frame: frame(255, 150, 180, 30) }]
        : [
            { id: "repos-outer-scroll", frame: frame(255, 150, 761, 520) },
            { id: "repos-bottom-sentinel", frame: frame(279, 650, 713, 16) }
          ])
    ]
  });
  return {
    schemaVersion: 1,
    scenario: "overview-repos-overview",
    fixtureId: "tab-overview",
    pid: 1,
    windowNumber: 41,
    coordinateSpace: "global-top-left",
    requestedContentSize: { width: 1040, height: 680 },
    tolerancePoints: 1,
    sampleIntervalMilliseconds: 100,
    navigationActions: [
      {
        index: 0,
        fromSection: "overview",
        toSection: "repos",
        controlIdentifier: "neondiff-sidebar-section-repos",
        actionAdvertised: true,
        attemptCount: 1,
        performResult: "success"
      },
      {
        index: 1,
        fromSection: "repos",
        toSection: "overview",
        controlIdentifier: "neondiff-sidebar-section-overview",
        actionAdvertised: true,
        attemptCount: 1,
        performResult: "success"
      }
    ],
    checkpoints: ["overview", "repos", "overview"].map((section, index) => ({
      index,
      section,
      ready: true,
      quiescent: true,
      acquisitionMilliseconds: 250,
      samples: [0, 100, 205].map((elapsed) => sample(section as "overview" | "repos", elapsed))
    }))
  };
}

function createHarness(): {
  root: string;
  output: string;
  env: NodeJS.ProcessEnv;
  commandLog: string;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "neondiff-settled-capture-test-")));
  roots.push(root);
  const fakeBin = join(root, "fake-bin");
  const swiftBin = join(root, "swift-bin");
  const output = join(root, "evidence");
  const commandLog = join(root, "commands.log");
  const appTemplate = join(root, "fake-app");
  const trace = join(root, "trace.json");
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(swiftBin, { recursive: true });
  mkdirSync(join(root, "apps/neondiff-desktop/scripts"), { recursive: true });
  mkdirSync(join(root, "apps/neondiff-desktop/script"), { recursive: true });
  mkdirSync(join(root, "apps/neondiff-desktop/fixtures/ui"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, scriptPath), readFileSync(scriptPath));
  chmodSync(join(root, scriptPath), 0o755);
  writeFileSync(join(root, "apps/neondiff-desktop/fixtures/ui/tab-overview.json"), "{}\n");
  writeFileSync(trace, JSON.stringify(traceFixture()));

  writeExecutable(appTemplate, `#!/bin/sh
set -eu
printf 'app %s\\n' "$*" >>"$FAKE_COMMAND_LOG"
ready=\${NEONDIFF_DESKTOP_EVALUATION_READY_PATH:?}
printf '{"schemaVersion":1,"fixtureId":"tab-overview","pid":%s,"windowNumber":41,"windowFrame":{"x":0,"y":0,"width":1040,"height":710},"contentFrame":{"x":0,"y":0,"width":1040,"height":680},"backingScale":2,"ready":true}\\n' "$$" >"$ready"
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
if [ "\${1:-}" = -C ]; then shift 2; fi
printf 'git %s\\n' "$*" >>"$FAKE_COMMAND_LOG"
case "$*" in
  'status --porcelain --untracked-files=all')
    [ "\${FAKE_GIT_DIRTY:-false}" = false ] || printf ' M drifted-file\\n'
    ;;
  'rev-parse HEAD') printf '%040d\\n' 0 ;;
  *) exit 2 ;;
esac
`);

  writeExecutable(join(fakeBin, "npm"), `#!/bin/sh
printf 'npm %s\\n' "$*" >>"$FAKE_COMMAND_LOG"
exit 0
`);

  writeExecutable(join(fakeBin, "node"), `#!/bin/sh
printf 'node %s\\n' "$*" >>"$FAKE_COMMAND_LOG"
if [ "\${FAKE_SAFETY_OK:-true}" = true ]; then
  printf '%s\\n' '{"ok":true,"findings":[],"sensitiveFiles":[],"invalidImages":[],"unsupportedEntries":[]}'
  exit 0
fi
printf '%s\\n' '{"ok":false,"findings":[{"rule":"redacted"}],"sensitiveFiles":[],"invalidImages":[],"unsupportedEntries":[]}'
exit 9
`);

  writeExecutable(join(fakeBin, "swift"), `#!/bin/sh
set -eu
printf 'swift %s\\n' "$*" >>"$FAKE_COMMAND_LOG"
case " $* " in
  *' --show-bin-path '*) printf '%s\\n' "$FAKE_SWIFT_BIN" ;;
  *' run --skip-build '*' NeonDiffDesktopGeometryChecks '*)
    if [ "\${FAKE_CHECKER_OK:-true}" = true ]; then
      printf '%s\\n' '{"category":"none","ok":true,"reasonCode":"none","schemaVersion":1,"status":"stable"}'
      exit 0
    fi
    printf '%s\\n' '{"category":"sequence","ok":false,"reasonCode":"invalid-navigation-action","schemaVersion":1,"status":"failed"}'
    exit 65
    ;;
  *) exit 0 ;;
esac
`);

  writeExecutable(join(swiftBin, "NeonDiffDesktopSettledGeometryCapture"), `#!/bin/sh
set -eu
printf 'capture %s\\n' "$*" >>"$FAKE_COMMAND_LOG"
pid=
output=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --pid) pid=$2; shift 2 ;;
    --ready) shift 2 ;;
    --output) output=$2; shift 2 ;;
    *) exit 64 ;;
  esac
done
if [ "\${FAKE_CAPTURE_OK:-true}" != true ]; then
  printf '%s\\n' '{"ok":false,"reasonCode":"action-failed","schemaVersion":1,"status":"failed"}' >&2
  exit 65
fi
jq --argjson pid "$pid" '.pid = $pid' "$FAKE_TRACE" >"$output.tmp"
mv "$output.tmp" "$output"
printf '%s\\n' '{"ok":true,"reasonCode":"none","schemaVersion":1,"status":"complete"}'
`);

  return {
    root,
    output,
    commandLog,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      FAKE_APP_TEMPLATE: appTemplate,
      FAKE_COMMAND_LOG: commandLog,
      FAKE_SWIFT_BIN: swiftBin,
      FAKE_TRACE: trace,
      FAKE_CAPTURE_OK: "true",
      FAKE_CHECKER_OK: "true",
      FAKE_SAFETY_OK: "true",
      FAKE_GIT_DIRTY: "false",
      NEONDIFF_DESKTOP_TEST_MODE: "1",
      NEONDIFF_DESKTOP_TEST_CAPTURE_ATTEMPTS: "20"
    }
  };
}

function runHarness(
  harness: ReturnType<typeof createHarness>,
  overrides: NodeJS.ProcessEnv = {},
  output = harness.output
) {
  return spawnSync(join(harness.root, scriptPath), ["--output", output], {
    cwd: harness.root,
    env: { ...harness.env, ...overrides },
    encoding: "utf8",
    timeout: 15_000
  });
}

describe("desktop settled geometry capture runner", () => {
  it("publishes a bounded proof only after helper, checker, and safety success", { timeout: 15_000 }, () => {
    const harness = createHarness();
    const result = runHarness(harness);

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(JSON.parse(readFileSync(
      join(harness.output, "validation/settled-capture-status.json"),
      "utf8"
    ))).toMatchObject({
      status: "complete",
      phase: "complete",
      reasonCode: "none",
      publicSafety: "passed",
      proof: "emitted"
    });
    expect(existsSync(join(
      harness.output,
      "cases/overview-repos-overview/1040x680/settled-geometry.json"
    ))).toBe(true);
    expect(existsSync(join(harness.output, "settled-geometry-proof.json"))).toBe(true);
    expect(statSync(harness.output).mode & 0o777).toBe(0o700);
    const commandLog = readFileSync(harness.commandLog, "utf8");
    expect(commandLog).toMatch(/capture --pid [0-9]+ --ready \/tmp\/[^ ]+\/ready\/ready\.json --output \/tmp\/[^ ]+\/capture\/settled-geometry\.json/);
  });

  it("fails closed without publishing proof when the two-action helper fails", { timeout: 15_000 }, () => {
    const harness = createHarness();
    const result = runHarness(harness, { FAKE_CAPTURE_OK: "false" });

    expect(result.status).toBe(65);
    expect(result.stderr).toContain("settled geometry helper failed");
    expect(result.stderr).not.toContain("action-failed");
    expect(JSON.parse(readFileSync(
      join(harness.output, "validation/settled-capture-status.json"),
      "utf8"
    ))).toMatchObject({ status: "incomplete", phase: "capture", reasonCode: "capture_failed" });
    expect(existsSync(join(harness.output, "settled-geometry-proof.json"))).toBe(false);
  });

  it("preserves the sanitized trace but withholds proof when the checker rejects it", { timeout: 15_000 }, () => {
    const harness = createHarness();
    const result = runHarness(harness, { FAKE_CHECKER_OK: "false" });

    expect(result.status).not.toBe(0);
    expect(JSON.parse(readFileSync(
      join(harness.output, "validation/settled-capture-status.json"),
      "utf8"
    ))).toMatchObject({ status: "incomplete", phase: "checker", reasonCode: "checker_rejected" });
    expect(existsSync(join(
      harness.output,
      "cases/overview-repos-overview/1040x680/settled-geometry.json"
    ))).toBe(true);
    expect(existsSync(join(harness.output, "settled-geometry-proof.json"))).toBe(false);
  });

  it("withholds completion when packet safety fails", { timeout: 15_000 }, () => {
    const harness = createHarness();
    const result = runHarness(harness, { FAKE_SAFETY_OK: "false" });

    expect(result.status).toBe(1);
    expect(JSON.parse(readFileSync(
      join(harness.output, "validation/settled-capture-status.json"),
      "utf8"
    ))).toMatchObject({
      status: "incomplete",
      phase: "safety",
      reasonCode: "public_safety_failed",
      publicSafety: "failed"
    });
    expect(existsSync(join(harness.output, "settled-geometry-proof.json"))).toBe(false);
    expect(existsSync(join(harness.output, ".settled-geometry-proof.json.pending"))).toBe(false);
  });

  it("rejects noncanonical output paths before creating evidence", () => {
    const harness = createHarness();
    mkdirSync(join(harness.root, "nested"));
    const noncanonical = `${harness.root}/nested/../evidence`;
    const result = runHarness(harness, {}, noncanonical);

    expect(result.status).toBe(65);
    expect(result.stderr).toContain("canonical path");
    expect(existsSync(harness.output)).toBe(false);
  });

  it("rejects a symlinked output parent before creating evidence", () => {
    const harness = createHarness();
    const realParent = join(harness.root, "real-parent");
    const linkedParent = join(harness.root, "linked-parent");
    mkdirSync(realParent);
    symlinkSync(realParent, linkedParent);
    const result = runHarness(harness, {}, join(linkedParent, "evidence"));

    expect(result.status).toBe(65);
    expect(result.stderr).toContain("real directory");
    expect(existsSync(join(realParent, "evidence"))).toBe(false);
  });

  it("routes the fake runner contract through the Swift desktop gate", () => {
    expect(swiftAffected([testPath])).toMatchObject({ affected: true, matched: [testPath] });
  });
});
