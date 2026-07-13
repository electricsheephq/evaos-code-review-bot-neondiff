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
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(swiftBin, { recursive: true });
  mkdirSync(join(root, "apps/neondiff-desktop/scripts"), { recursive: true });
  mkdirSync(join(root, "apps/neondiff-desktop/script"), { recursive: true });
  mkdirSync(join(root, "apps/neondiff-desktop/fixtures/ui"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });

  writeFileSync(join(root, scriptPath), readFileSync(scriptPath));
  chmodSync(join(root, scriptPath), 0o755);
  writeFileSync(join(root, "apps/neondiff-desktop/fixtures/ui/tab-repos.json"), '{"id":"tab-repos"}\n');

  writeExecutable(appTemplate, `#!/bin/sh
set -eu
printf 'app %s\\n' "$*" >>"$FAKE_COMMAND_LOG"
ready=\${NEONDIFF_DESKTOP_EVALUATION_READY_PATH:?}
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
  'status --porcelain --untracked-files=all') exit 0 ;;
  'rev-parse HEAD') printf '%040d\\n' 0; exit 0 ;;
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
printf '%s\\n' '{"ok":true,"skippedImages":["cases/tab-repos/1040x680/screenshot.png"],"findings":[],"sensitiveFiles":[]}'
`);

  writeExecutable(join(fakeBin, "swift"), `#!/bin/sh
set -eu
printf 'swift %s\\n' "$*" >>"$FAKE_COMMAND_LOG"
case " $* " in
  *' --show-bin-path '*) printf '%s\\n' "$FAKE_SWIFT_BIN"; exit 0 ;;
esac
if [ "$1" = build ]; then exit 0; fi
if [ "$1" = run ]; then
  printf '%s\\n' '{"ok":false,"failure":"missing outer AXScrollArea ancestor"}'
  printf '%s\\n' "\${FAKE_CHECKER_MESSAGE:-Reachability trace has no outer scroll area.}" >&2
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
printf 'png' >"$output_dir/screenshot.png"
printf '%s\\n' '{"role":"AXWindow","children":[]}' >"$output_dir/accessibility.json"
printf '%s\\n' '{"schemaVersion":1,"fixtureId":"tab-repos"}' >"$output_dir/geometry.json"
printf '%s\\n' '{"schemaVersion":1,"fixture":"tab-repos","requestedContentSize":{"width":1040,"height":680},"outerScroll":null}' >"$output_dir/reachability.json"
printf '%s\\n' '{"ok":true,"fixtureId":"tab-repos"}'
`);

  return {
    root,
    output,
    commandLog,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      FAKE_APP_TEMPLATE: appTemplate,
      FAKE_COMMAND_LOG: commandLog,
      FAKE_SWIFT_BIN: swiftBin,
      FAKE_CHECKER_STATUS: "7",
      FAKE_CHECKER_MESSAGE: "Reachability trace has no outer scroll area."
    }
  };
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
    expect(script).toMatch(/mktemp -d [^\n]*\/tmp\/neondiff-desktop-repos-reachability/);
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
    expect(script.match(/build_and_run\.sh" build/g)).toHaveLength(1);
    expect(script.match(/--product NeonDiffDesktopCapture/g)).toHaveLength(1);
    expect(script.match(/--product NeonDiffDesktopReachabilityChecks/g)).toHaveLength(1);
    const appLaunch = script.match(/NEONDIFF_DESKTOP_EVALUATION_READY_PATH[\s\S]*?app_pid=\$!/)?.[0];
    const captureLaunch = script.match(/"\$capture_bin"[\s\S]*?capture_pid=\$!/)?.[0];
    expect(appLaunch).toMatch(/--ui-fixture "\$fixture"[\s\S]*--content-size "\$content_size"[\s\S]*--disable-animations/);
    expect(appLaunch).not.toContain("--repos-reachability");
    expect(captureLaunch).toContain("--repos-reachability");
    expect(script).not.toMatch(/for\s+size\s+in/);
    expect(script).not.toContain("1280x800");
    expect(script).not.toContain("1440x900");
  });

  it.runIf(process.platform === "darwin")(
    "preserves reachability and public-safe status evidence when the checker reports the expected pre-fix failure",
    { timeout: 30_000 },
    () => {
      const harness = createFakeHarnessRepository();
      const result = spawnSync(join(harness.root, scriptPath), ["--output", harness.output], {
        cwd: harness.root,
        encoding: "utf8",
        env: harness.env,
        timeout: 25_000
      });

      expect(result.error, `${result.stderr}\n${result.stdout}`).toBeUndefined();
      const commandTrace = existsSync(harness.commandLog) ? readFileSync(harness.commandLog, "utf8") : "";
      expect(result.status, `${result.stderr}\n${result.stdout}\n${commandTrace}`).toBe(7);
      const caseRoot = join(harness.output, "cases/tab-repos/1040x680");
      expect(JSON.parse(readFileSync(join(caseRoot, "reachability.json"), "utf8"))).toMatchObject({
        fixture: "tab-repos",
        requestedContentSize: { width: 1040, height: 680 },
        outerScroll: null
      });
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
    "does not classify an unrelated checker failure as the expected pre-fix result",
    { timeout: 30_000 },
    () => {
      const harness = createFakeHarnessRepository();
      const result = spawnSync(join(harness.root, scriptPath), ["--output", harness.output], {
        cwd: harness.root,
        encoding: "utf8",
        env: { ...harness.env, FAKE_CHECKER_MESSAGE: "Reachability trace schema is invalid." },
        timeout: 25_000
      });

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
    expect(docs).toMatch(/TCC/i);
    expect(docs).toMatch(/does not prove/i);
  });
});
