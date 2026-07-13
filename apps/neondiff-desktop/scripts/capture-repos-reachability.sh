#!/bin/sh
set -eu
umask 077

usage() {
  echo "usage: $0 --output <fresh-absolute-evidence-directory>" >&2
  exit 64
}

[ "$#" -eq 2 ] && [ "$1" = "--output" ] || usage
output=$2
case "$output" in /*) ;; *) usage ;; esac
[ ! -e "$output" ] && [ ! -L "$output" ] \
  || { echo "focused capture output must not already exist" >&2; exit 65; }

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
package_dir=$(dirname -- "$script_dir")
repo_dir=$(CDPATH='' cd -- "$package_dir/../.." && pwd)
cd "$repo_dir"

[ -z "$(git status --porcelain --untracked-files=all)" ] \
  || { echo "canonical focused capture requires a clean worktree" >&2; exit 65; }
head_sha=$(git rev-parse HEAD)
printf '%s\n' "$head_sha" | grep -Eq '^[0-9a-f]{40}$' \
  || { echo "could not bind focused capture to an exact HEAD" >&2; exit 65; }

assert_clean_head() {
  [ "$(git rev-parse HEAD)" = "$head_sha" ] \
    && [ -z "$(git status --porcelain --untracked-files=all)" ] \
    || { echo "source changed during focused capture" >&2; exit 65; }
}

mkdir -m 700 "$output" \
  || { echo "could not create fresh focused capture output" >&2; exit 65; }
mkdir -p "$output/cases/tab-repos/1040x680" "$output/validation"
case_dir="$output/cases/tab-repos/1040x680"

tmp_root=$(/usr/bin/mktemp -d "/tmp/neondiff-desktop-repos-reachability.XXXXXXXX") \
  || { echo "could not create private focused capture workspace" >&2; exit 65; }
[ -d "$tmp_root" ] && [ ! -L "$tmp_root" ] \
  || { echo "focused capture workspace is not a private directory" >&2; exit 65; }
/bin/chmod 700 "$tmp_root"
tmp_mode=$(/usr/bin/stat -f '%Lp' "$tmp_root" 2>/dev/null || /usr/bin/stat -c '%a' "$tmp_root")
[ "$tmp_mode" = 700 ] \
  || { echo "focused capture workspace permissions are not private" >&2; exit 65; }

app_pid=
capture_pid=
terminate_process() {
  target_pid=$1
  case "$target_pid" in ''|*[!0-9]*) return ;; esac
  [ "$target_pid" -ne "$$" ] || return
  kill -TERM "$target_pid" >/dev/null 2>&1 || true
  terminate_attempts=0
  while kill -0 "$target_pid" 2>/dev/null && [ "$terminate_attempts" -lt 10 ]; do
    /bin/sleep 0.1
    terminate_attempts=$((terminate_attempts + 1))
  done
  if kill -0 "$target_pid" 2>/dev/null; then
    kill -KILL "$target_pid" >/dev/null 2>&1 || true
  fi
  wait "$target_pid" >/dev/null 2>&1 || true
}
cleanup() {
  if [ -n "$capture_pid" ]; then terminate_process "$capture_pid"; fi
  if [ -n "$app_pid" ]; then terminate_process "$app_pid"; fi
  rm -rf "$tmp_root"
}
trap cleanup EXIT HUP INT TERM

fixture_id="tab-repos"
content_size="1040x680"
source_fixture="$package_dir/fixtures/ui/tab-repos.json"
[ -f "$source_fixture" ] && [ ! -L "$source_fixture" ] \
  || { echo "tab-repos fixture must be a regular non-symlink file" >&2; exit 65; }
fixture="$tmp_root/tab-repos.json"
cp "$source_fixture" "$fixture"

# Keep every DEBUG build product and launched bundle inside the private workspace.
export SWIFTPM_BUILD_DIR="$tmp_root/swift-build"
dist_dir="$tmp_root/dist"
NEONDIFF_DESKTOP_DIST_DIR="$dist_dir" \
  "$package_dir/script/build_and_run.sh" build \
  >"$output/validation/debug-app-build.log" 2>&1
swift build --package-path "$package_dir" --product NeonDiffDesktopCapture \
  >"$output/validation/capture-helper-build.log" 2>&1
swift build --package-path "$package_dir" --product NeonDiffDesktopReachabilityChecks \
  >"$output/validation/reachability-checker-build.log" 2>&1
swift_bin=$(swift build --package-path "$package_dir" --show-bin-path)
app_bin="$dist_dir/NeonDiffDesktop.app/Contents/MacOS/NeonDiffDesktop"
capture_bin="$swift_bin/NeonDiffDesktopCapture"
[ -x "$app_bin" ] && [ -x "$capture_bin" ] \
  || { echo "focused DEBUG capture products are missing" >&2; exit 65; }
assert_clean_head

npm run check:secrets >"$output/validation/repository-secret-scan.log" 2>&1

ready_dir="$tmp_root/ready"
mkdir -m 700 "$ready_dir"
ready="$ready_dir/ready.json"
NEONDIFF_DESKTOP_EVALUATION_READY_PATH="$ready" \
  "$app_bin" \
  --ui-testing \
  --ui-fixture "$fixture" \
  --content-size "$content_size" \
  --disable-animations \
  >"$case_dir/launch.log" 2>&1 &
app_pid=$!

ready_attempts=0
while [ ! -f "$ready" ] && kill -0 "$app_pid" 2>/dev/null && [ "$ready_attempts" -lt 100 ]; do
  /bin/sleep 0.1
  ready_attempts=$((ready_attempts + 1))
done
[ -f "$ready" ] && [ ! -L "$ready" ] \
  || { echo "tab-repos fixture did not become ready at 1040x680" >&2; exit 1; }
jq -e --arg fixture "$fixture_id" --argjson pid "$app_pid" \
  '.schemaVersion == 1 and .ready == true and .fixtureId == $fixture and .pid == $pid' \
  "$ready" >/dev/null \
  || { echo "tab-repos readiness did not match the launched process" >&2; exit 1; }
cp "$ready" "$case_dir/readiness.json"

"$capture_bin" \
  --pid "$app_pid" \
  --ready "$ready" \
  --output-dir "$case_dir" \
  --repos-reachability \
  >"$case_dir/capture.json.tmp" \
  2>"$tmp_root/capture.stderr" &
capture_pid=$!
capture_attempts=0
while kill -0 "$capture_pid" 2>/dev/null && [ "$capture_attempts" -lt 150 ]; do
  /bin/sleep 0.1
  capture_attempts=$((capture_attempts + 1))
done
if kill -0 "$capture_pid" 2>/dev/null; then
  terminate_process "$capture_pid"
  capture_pid=
  echo "capture helper timed out: tab-repos 1040x680" >&2
  exit 1
fi
capture_status=0
wait "$capture_pid" || capture_status=$?
capture_pid=
mv "$case_dir/capture.json.tmp" "$case_dir/capture.json"
if [ "$capture_status" -ne 0 ]; then
  echo "capture helper failed: tab-repos 1040x680" >&2
  exit "$capture_status"
fi

reachability="$case_dir/reachability.json"
[ -f "$reachability" ] && [ ! -L "$reachability" ] \
  || { echo "capture helper did not write reachability.json" >&2; exit 1; }
terminate_process "$app_pid"
app_pid=
assert_clean_head

# The pre-fix Repos tree is expected to fail this checker. Keep the capture and
# finish the public-safety scan before returning the checker's nonzero status.
checker_status=0
if swift run --skip-build --package-path "$package_dir" \
  NeonDiffDesktopReachabilityChecks "$reachability" \
  >"$output/validation/reachability-check.json" \
  2>"$tmp_root/reachability-check.stderr"; then
  checker_result="passed"
else
  checker_status=$?
  checker_result="failed"
fi
checker_failed=false
expected_pre_fix_failure=false
checker_reason_code="none"
if [ "$checker_status" -ne 0 ]; then
  checker_failed=true
  checker_reason_code="checker_nonzero"
  if jq -e \
      '.schemaVersion == 1 and .fixture == "tab-repos" and .requestedContentSize.width == 1040 and .requestedContentSize.height == 680 and has("outerScroll") and .outerScroll == null' \
      "$reachability" >/dev/null \
    && [ "$(cat "$tmp_root/reachability-check.stderr")" = "Reachability trace has no outer scroll area." ]; then
    expected_pre_fix_failure=true
    checker_reason_code="missing_outer_scroll"
  fi
fi
jq -n \
  --arg status "$checker_result" \
  --arg reasonCode "$checker_reason_code" \
  --argjson checkerFailed "$checker_failed" \
  --argjson exitCode "$checker_status" \
  --argjson expectedPreFixFailure "$expected_pre_fix_failure" \
  '{schemaVersion:1,status:$status,checkerFailed:$checkerFailed,exitCode:$exitCode,expectedPreFixFailure:$expectedPreFixFailure,reasonCode:$reasonCode}' \
  >"$output/validation/reachability-check-status.json"

reachability_sha=$(shasum -a 256 "$reachability" | awk '{print $1}')
jq -n \
  --arg headSHA "$head_sha" \
  --arg fixtureId "$fixture_id" \
  --arg contentSize "$content_size" \
  --arg reachabilitySHA256 "$reachability_sha" \
  --arg checkerStatus "$checker_result" \
  '{
    schemaVersion: 1,
    issue: 517,
    headSHA: $headSHA,
    fixtureId: $fixtureId,
    contentSize: $contentSize,
    buildConfiguration: "debug",
    reachabilitySHA256: $reachabilitySHA256,
    checkerStatus: $checkerStatus,
    proofBoundary: "Focused deterministic Repos reachability dev proof outside the canonical issue 515 packet.",
    exclusions: [
      "Not a full fixture or viewport matrix.",
      "Not full issue 517 interaction, layout-stability, or accessibility-conformance proof.",
      "Not signed, notarized, installed-app, release, runtime, or customer proof."
    ]
  }' >"$output/focused-proof.json"

node scripts/check-desktop-evaluation-packet-secrets.mjs --packet "$output" \
  >"$tmp_root/packet-safety-scan.json"
jq -e \
  '.ok == true and (.findings | length) == 0 and (.sensitiveFiles | length) == 0 and (.skippedImages | index("cases/tab-repos/1040x680/screenshot.png") != null)' \
  "$tmp_root/packet-safety-scan.json" >/dev/null
cp "$tmp_root/packet-safety-scan.json" "$output/validation/packet-safety-scan.json"
printf 'ok\n' >"$output/validation/packet-safety-scan.ok"
assert_clean_head

if [ "$checker_status" -ne 0 ]; then
  echo "reachability checker failed with exit $checker_status; reachability.json was preserved" >&2
  exit "$checker_status"
fi
printf '%s\n' "$output"
