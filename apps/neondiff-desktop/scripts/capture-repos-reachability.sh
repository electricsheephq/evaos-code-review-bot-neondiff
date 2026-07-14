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

capture_attempt_limit=150
if [ "${NEONDIFF_DESKTOP_TEST_MODE:-}" = 1 ]; then
  capture_attempt_limit=${NEONDIFF_DESKTOP_TEST_CAPTURE_ATTEMPTS:-150}
  case "$capture_attempt_limit" in ''|*[!0-9]*)
    echo "test capture attempt limit must be an integer from 1 through 150" >&2
    exit 65
  esac
  [ "$capture_attempt_limit" -ge 1 ] && [ "$capture_attempt_limit" -le 150 ] \
    || { echo "test capture attempt limit must be an integer from 1 through 150" >&2; exit 65; }
elif [ -n "${NEONDIFF_DESKTOP_TEST_CAPTURE_ATTEMPTS:-}" ]; then
  echo "test capture attempt limit requires explicit test mode" >&2
  exit 65
fi
unset NEONDIFF_DESKTOP_TEST_MODE NEONDIFF_DESKTOP_TEST_CAPTURE_ATTEMPTS

assert_clean_head() {
  current_head=$(git rev-parse HEAD 2>/dev/null || true)
  current_status=$(git status --porcelain --untracked-files=all 2>/dev/null || printf 'git-status-failed\n')
  if [ "$current_head" != "$head_sha" ] || [ -n "$current_status" ]; then
    write_focused_status incomplete source source_changed incomplete not_emitted ""
    echo "source changed during focused capture" >&2
    exit 65
  fi
}

mkdir -m 700 "$output" \
  || { echo "could not create fresh focused capture output" >&2; exit 65; }
mkdir -p "$output/cases" "$output/validation"
case_dir="$output/cases/tab-repos/1040x680"
status_path="$output/validation/focused-capture-status.json"

render_focused_status() {
  status_target=$1
  status_value=$2
  phase_value=$3
  reason_value=$4
  public_safety_value=$5
  focused_proof_value=$6
  capture_exit_value=$7
  jq -n \
    --arg status "$status_value" \
    --arg phase "$phase_value" \
    --arg reasonCode "$reason_value" \
    --arg publicSafety "$public_safety_value" \
    --arg focusedProof "$focused_proof_value" \
    --arg captureExitCode "$capture_exit_value" \
    '{
      schemaVersion: 1,
      status: $status,
      phase: $phase,
      reasonCode: $reasonCode,
      publicSafety: $publicSafety,
      focusedProof: $focusedProof
    } + (if $captureExitCode == "" then {} else {captureExitCode: ($captureExitCode | tonumber)} end)' \
    >"$status_target.tmp"
  mv "$status_target.tmp" "$status_target"
}

write_focused_status() {
  render_focused_status "$status_path" "$@"
}

write_focused_status incomplete setup capture_in_progress incomplete not_emitted ""

tmp_root=$(/usr/bin/mktemp -d "/tmp/neondiff-desktop-evaluation.XXXXXXXX") \
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
  rm -f \
    "$output/.focused-proof.json.pending" \
    "$output/validation/.focused-capture-status.json.pending" \
    "$output/validation/.packet-safety-scan.json.pending" \
    "$output/validation/.packet-safety-scan.ok.pending"
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
capture_stage="$tmp_root/capture-output"
mkdir -m 700 "$capture_stage"
NEONDIFF_DESKTOP_EVALUATION_READY_PATH="$ready" \
  "$app_bin" \
  --ui-testing \
  --ui-fixture "$fixture" \
  --content-size "$content_size" \
  --disable-animations \
  >"$tmp_root/launch.log" 2>&1 &
app_pid=$!

ready_attempts=0
while [ ! -f "$ready" ] && kill -0 "$app_pid" 2>/dev/null && [ "$ready_attempts" -lt 100 ]; do
  /bin/sleep 0.1
  ready_attempts=$((ready_attempts + 1))
done
if [ ! -f "$ready" ]; then
  if kill -0 "$app_pid" 2>/dev/null; then
    terminate_process "$app_pid"
    app_pid=
    write_focused_status incomplete readiness readiness_timeout incomplete not_emitted ""
    echo "tab-repos readiness timed out at 1040x680" >&2
  else
    wait "$app_pid" >/dev/null 2>&1 || true
    app_pid=
    write_focused_status incomplete launch fixture_launch_failed incomplete not_emitted ""
    echo "tab-repos fixture exited before readiness at 1040x680" >&2
  fi
  exit 1
fi
[ ! -L "$ready" ] \
  || {
    write_focused_status incomplete readiness readiness_invalid incomplete not_emitted ""
    echo "tab-repos readiness was not a regular private file" >&2
    exit 1
  }
jq -e --arg fixture "$fixture_id" --argjson pid "$app_pid" \
  '.schemaVersion == 1 and .ready == true and .fixtureId == $fixture and .pid == $pid' \
  "$ready" >/dev/null \
  || {
    write_focused_status incomplete readiness readiness_invalid incomplete not_emitted ""
    echo "tab-repos readiness did not match the launched process" >&2
    exit 1
  }
cp "$ready" "$capture_stage/readiness.json"

"$capture_bin" \
  --pid "$app_pid" \
  --ready "$ready" \
  --output-dir "$capture_stage" \
  --repos-reachability \
  >"$tmp_root/capture.json" \
  2>"$tmp_root/capture.stderr" &
capture_pid=$!
capture_attempts=0
while kill -0 "$capture_pid" 2>/dev/null && [ "$capture_attempts" -lt "$capture_attempt_limit" ]; do
  /bin/sleep 0.1
  capture_attempts=$((capture_attempts + 1))
done
if kill -0 "$capture_pid" 2>/dev/null; then
  terminate_process "$capture_pid"
  capture_pid=
  write_focused_status incomplete capture capture_timeout incomplete not_emitted 124
  echo "capture helper timed out: tab-repos 1040x680" >&2
  exit 124
fi
capture_status=0
wait "$capture_pid" || capture_status=$?
capture_pid=
if [ "$capture_status" -ne 0 ]; then
  capture_reason="capture_failed"
  capture_error=$(cat "$tmp_root/capture.stderr")
  case "$capture_error" in
    "Capture permission is unavailable: Screen Recording") capture_reason="screen_recording_unavailable" ;;
    "Capture permission is unavailable: Accessibility") capture_reason="accessibility_unavailable" ;;
  esac
  write_focused_status incomplete capture "$capture_reason" incomplete not_emitted "$capture_status"
  echo "capture helper failed: tab-repos 1040x680" >&2
  exit "$capture_status"
fi

for capture_file in screenshot.png accessibility.json geometry.json reachability.json scroll-capabilities.json readiness.json; do
  [ -f "$capture_stage/$capture_file" ] && [ ! -L "$capture_stage/$capture_file" ] \
    || {
      write_focused_status incomplete capture capture_output_incomplete incomplete not_emitted 1
      echo "capture helper did not write complete focused evidence" >&2
      exit 1
    }
done
[ "$(wc -c <"$capture_stage/scroll-capabilities.json")" -le 4096 ] \
  && jq -e '
    keys == [
      "acquisition",
      "boundaryAdvertisesScrollToVisible",
      "fixture",
      "osMajorVersion",
      "outerVerticalIncrementPageAdvertisesPress",
      "outerVerticalIncrementPageResolved",
      "outerVerticalScrollBarAdvertisesIncrement",
      "outerVerticalScrollBarResolved",
      "requestedContentSize",
      "schemaVersion",
      "scrollToVisibleActionAvailable"
    ]
    and .schemaVersion == 1
    and .fixture == "tab-repos"
    and .requestedContentSize == {"width":1040,"height":680}
    and (.osMajorVersion | type == "number" and . >= 1 and . <= 100 and floor == .)
    and .scrollToVisibleActionAvailable == (.osMajorVersion >= 26)
    and (.acquisition | type == "object" and keys == ["failureReason", "status"])
    and (.reasonCode as $reason |
      if .acquisition.status == "complete" then
        .acquisition.failureReason == null
        and (.boundaryAdvertisesScrollToVisible | type == "boolean")
        and (.outerVerticalIncrementPageAdvertisesPress | type == "boolean")
        and (.outerVerticalIncrementPageResolved | type == "boolean")
        and (.outerVerticalScrollBarResolved | type == "boolean")
        and (.outerVerticalScrollBarAdvertisesIncrement | type == "boolean")
        and (.scrollToVisibleActionAvailable or (.boundaryAdvertisesScrollToVisible | not))
        and (.outerVerticalScrollBarResolved or (.outerVerticalScrollBarAdvertisesIncrement | not))
        and (.outerVerticalScrollBarResolved or (.outerVerticalIncrementPageResolved | not))
        and (.outerVerticalIncrementPageResolved or (.outerVerticalIncrementPageAdvertisesPress | not))
      elif .acquisition.status == "failed" then
        (.acquisition.failureReason as $reason | [
          "cannot-complete",
          "invalid-element",
          "permission-denied",
          "invalid-type",
          "attribute-unavailable",
          "pid-mismatch",
          "window-mismatch",
          "semantic-missing",
          "semantic-duplicate",
          "timeout",
          "ancestry-unavailable",
          "ancestry-cycle",
          "ancestry-limit",
          "messaging-timeout-unavailable"
        ] | index($reason) != null)
        and .boundaryAdvertisesScrollToVisible == null
        and .outerVerticalIncrementPageAdvertisesPress == null
        and .outerVerticalIncrementPageResolved == null
        and .outerVerticalScrollBarResolved == null
        and .outerVerticalScrollBarAdvertisesIncrement == null
      else false end
    )
  ' "$capture_stage/scroll-capabilities.json" >/dev/null \
  || {
    write_focused_status incomplete capture capture_output_incomplete incomplete not_emitted 1
    echo "capture helper wrote invalid sanitized scroll capabilities" >&2
    exit 1
  }
[ -s "$tmp_root/capture.json" ] \
  || {
    write_focused_status incomplete capture capture_output_incomplete incomplete not_emitted 1
    echo "capture helper did not write complete focused evidence" >&2
    exit 1
  }
terminate_process "$app_pid"
app_pid=
assert_clean_head

case_parent="$output/cases/tab-repos"
pending_case="$case_parent/.1040x680.pending"
mkdir -p "$case_parent"
mkdir -m 700 "$pending_case"
if cp "$tmp_root/launch.log" "$pending_case/launch.log" \
  && cp "$tmp_root/capture.json" "$pending_case/capture.json" \
  && cp "$capture_stage/readiness.json" "$pending_case/readiness.json" \
  && cp "$capture_stage/screenshot.png" "$pending_case/screenshot.png" \
  && cp "$capture_stage/accessibility.json" "$pending_case/accessibility.json" \
  && cp "$capture_stage/geometry.json" "$pending_case/geometry.json" \
  && cp "$capture_stage/reachability.json" "$pending_case/reachability.json" \
  && cp "$capture_stage/scroll-capabilities.json" "$pending_case/scroll-capabilities.json" \
  && mv "$pending_case" "$case_dir"; then
  :
else
  rm -rf "$pending_case"
  write_focused_status incomplete evidence evidence_publish_failed incomplete not_emitted ""
  echo "could not publish complete focused evidence" >&2
  exit 1
fi
reachability="$case_dir/reachability.json"
scroll_capabilities="$case_dir/scroll-capabilities.json"

# Preserve the behavior trace for diagnosis and finish the public-safety scan
# before returning any ordinary checker failure.
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
checker_output_valid=false
if jq -e '
    type == "object"
    and keys == ["category", "ok", "reasonCode", "schemaVersion", "status"]
    and .schemaVersion == 1
    and (.reasonCode as $reason |
      if .ok == true then
        .status == "reachable" and .category == "none" and .reasonCode == "none"
      elif .ok == false and .status == "failed" then
        (
          (.category == "input" and (["usage", "unsafe-input", "input-read-failed"] | index($reason)) != null)
          or (.category == "contract" and ([
            "invalid-contract", "nonfinite-frame", "duplicate-region", "missing-region",
            "missing-scroll-interaction", "checker-encoding-failed"
          ] | index($reason)) != null)
          or (.category == "acquisition" and (.reasonCode | test("^acquisition-(cannot-complete|invalid-element|permission-denied|invalid-type|attribute-unavailable|pid-mismatch|window-mismatch|semantic-missing|semantic-duplicate|semantic-changed|timeout|ancestry-unavailable|ancestry-cycle|ancestry-limit|messaging-timeout-unavailable)$")))
          or (.category == "action" and (.reasonCode | test("^action-(not-advertised|perform-(cannot-complete|action-unsupported|invalid-element|permission-denied|other-error))$")))
          or (.category == "geometry" and ([
            "insufficient-pre-scroll-samples", "insufficient-post-scroll-samples", "excessive-drift",
            "unstable-window", "unstable-outer-clip", "unstable-scroll-ancestry",
            "outer-clip-outside-window", "boundary-initially-inside-outer-clip",
            "no-upward-movement", "non-rigid-movement", "press-insufficient-apply-allowlist",
            "press-insufficient-boundary-body", "region-outside-viewport"
          ] | index($reason)) != null)
        )
      else false end
    )' "$output/validation/reachability-check.json" >/dev/null 2>&1; then
  if { [ "$checker_status" -eq 0 ] && jq -e '.ok == true' "$output/validation/reachability-check.json" >/dev/null; } \
    || { [ "$checker_status" -ne 0 ] && jq -e '.ok == false' "$output/validation/reachability-check.json" >/dev/null; }; then
    checker_output_valid=true
  fi
fi
checker_failed=true
checker_category="checker"
checker_reason_code="checker-result-invalid"
if [ "$checker_output_valid" = true ]; then
  checker_category=$(jq -r '.category' "$output/validation/reachability-check.json")
  checker_reason_code=$(jq -r '.reasonCode' "$output/validation/reachability-check.json")
  if [ "$checker_status" -eq 0 ]; then
    checker_failed=false
    checker_result="passed"
  fi
elif [ "$checker_status" -eq 0 ]; then
  checker_status=65
  checker_result="failed"
fi
jq -n \
  --arg status "$checker_result" \
  --arg category "$checker_category" \
  --arg reasonCode "$checker_reason_code" \
  --argjson checkerFailed "$checker_failed" \
  --argjson exitCode "$checker_status" \
  '{schemaVersion:2,status:$status,checkerFailed:$checkerFailed,exitCode:$exitCode,category:$category,reasonCode:$reasonCode}' \
  >"$output/validation/reachability-check-status.json"

reachability_sha=$(shasum -a 256 "$reachability" | awk '{print $1}')
scroll_capabilities_sha=$(shasum -a 256 "$scroll_capabilities" | awk '{print $1}')
jq -n \
  --arg headSHA "$head_sha" \
  --arg fixtureId "$fixture_id" \
  --arg contentSize "$content_size" \
  --arg reachabilitySHA256 "$reachability_sha" \
  --arg scrollCapabilitiesSHA256 "$scroll_capabilities_sha" \
  --arg checkerStatus "$checker_result" \
  '{
    schemaVersion: 1,
    issue: 517,
    headSHA: $headSHA,
    fixtureId: $fixtureId,
    contentSize: $contentSize,
    buildConfiguration: "debug",
    reachabilitySHA256: $reachabilitySHA256,
    scrollCapabilitiesSHA256: $scrollCapabilitiesSHA256,
    checkerStatus: $checkerStatus,
    proofBoundary: "Focused deterministic Repos reachability dev proof outside the canonical issue 515 packet.",
    exclusions: [
      "Not a full fixture or viewport matrix.",
      "Not full issue 517 interaction, layout-stability, or accessibility-conformance proof.",
      "Not signed, notarized, installed-app, release, runtime, or customer proof."
    ]
  }' >"$tmp_root/focused-proof.json"
render_focused_status \
  "$tmp_root/final-focused-capture-status.json" \
  complete complete none passed emitted ""

safety_packet="$tmp_root/safety-packet"
mkdir -m 700 "$safety_packet"
cp -R "$output/." "$safety_packet/"
cp "$tmp_root/focused-proof.json" "$safety_packet/focused-proof.json"
cp "$tmp_root/final-focused-capture-status.json" \
  "$safety_packet/validation/focused-capture-status.json"
safety_status=0
if node scripts/check-desktop-evaluation-packet-secrets.mjs --packet "$safety_packet" \
  >"$tmp_root/packet-safety-scan.json"; then
  :
else
  safety_status=$?
fi
if [ "$safety_status" -ne 0 ] \
  || ! jq -e \
    '.ok == true and (.findings | length) == 0 and (.sensitiveFiles | length) == 0 and (.skippedImages | index("cases/tab-repos/1040x680/screenshot.png") != null)' \
    "$tmp_root/packet-safety-scan.json" >/dev/null; then
  write_focused_status incomplete public_safety public_safety_failed failed not_emitted ""
  echo "focused evidence failed the public-safety scan" >&2
  if [ "$safety_status" -ne 0 ]; then exit "$safety_status"; else exit 1; fi
fi

assert_clean_head
if cp "$tmp_root/focused-proof.json" "$output/.focused-proof.json.pending" \
  && cp "$tmp_root/final-focused-capture-status.json" \
    "$output/validation/.focused-capture-status.json.pending" \
  && cp "$tmp_root/packet-safety-scan.json" \
    "$output/validation/.packet-safety-scan.json.pending" \
  && printf 'ok\n' >"$output/validation/.packet-safety-scan.ok.pending" \
  && mv "$output/.focused-proof.json.pending" "$output/focused-proof.json" \
  && mv "$output/validation/.packet-safety-scan.json.pending" \
    "$output/validation/packet-safety-scan.json" \
  && mv "$output/validation/.packet-safety-scan.ok.pending" \
    "$output/validation/packet-safety-scan.ok" \
  && mv "$output/validation/.focused-capture-status.json.pending" "$status_path"; then
  :
else
  rm -f \
    "$output/focused-proof.json" \
    "$output/validation/packet-safety-scan.json" \
    "$output/validation/packet-safety-scan.ok"
  write_focused_status incomplete evidence evidence_publish_failed passed not_emitted ""
  echo "could not publish focused proof atomically" >&2
  exit 1
fi

if [ "$checker_status" -ne 0 ]; then
  echo "reachability checker failed with exit $checker_status; reachability.json was preserved" >&2
  exit "$checker_status"
fi
printf '%s\n' "$output"
