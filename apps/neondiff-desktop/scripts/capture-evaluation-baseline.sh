#!/bin/sh
set -eu

usage() {
  echo "usage: $0 --output <packet-directory>" >&2
  exit 64
}

[ "$#" -eq 2 ] && [ "$1" = "--output" ] || usage
output=$2
case "$output" in /*) ;; *) usage ;; esac

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
package_dir=$(dirname -- "$script_dir")
repo_dir=$(CDPATH='' cd -- "$package_dir/../.." && pwd)
cd "$repo_dir"

[ -z "$(git status --porcelain)" ] || { echo "canonical capture requires a clean worktree" >&2; exit 65; }
[ ! -e "$output" ] || { echo "output packet already exists" >&2; exit 65; }
head_sha=$(git rev-parse HEAD)

assert_clean_head() {
  [ "$(git rev-parse HEAD)" = "$head_sha" ] \
    && [ -z "$(git status --porcelain)" ] \
    || { echo "source changed during canonical capture" >&2; exit 65; }
}

run_id="${head_sha}-$$"
tmp_root="/tmp/neondiff-desktop-evaluation/$run_id"
mkdir -p "$tmp_root/fixtures" "$output/artifacts" "$output/fixtures" "$output/tests" "$output/cases" "$output/validation"
cleanup_pid=
capture_pid=
terminate_process() {
  target_pid=$1
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
  if [ -n "$capture_pid" ]; then
    terminate_process "$capture_pid"
  fi
  if [ -n "$cleanup_pid" ]; then
    terminate_process "$cleanup_pid"
  fi
  rm -rf "$tmp_root"
}
trap cleanup EXIT HUP INT TERM

swift package --package-path "$package_dir" clean

test_log="$output/tests/swift-testing.log"
test_start=$(node -e 'process.stdout.write(String(Date.now()))')
{
  "$package_dir/scripts/run-required-swift-test-suite.sh" NeonDiffDesktopCoreTests
  "$package_dir/scripts/run-required-swift-test-suite.sh" NeonDiffDesktopAppCoreTests
  "$package_dir/scripts/run-required-swift-test-suite.sh" NeonDiffDesktopEvaluationSupportTests
  swift run --package-path "$package_dir" NeonDiffDesktopFixtureChecks
} >"$test_log" 2>&1
test_end=$(node -e 'process.stdout.write(String(Date.now()))')
test_duration=$(node -e 'process.stdout.write(String((Number(process.argv[1]) - Number(process.argv[2])) / 1000))' "$test_end" "$test_start")
test_list=$(cd "$package_dir" && scripts/run-swift-tests.sh list)
test_count=$(printf '%s\n' "$test_list" | awk '
  index($0, "NeonDiffDesktopCoreTests.") == 1 { count += 1 }
  index($0, "NeonDiffDesktopAppCoreTests.") == 1 { count += 1 }
  index($0, "NeonDiffDesktopEvaluationSupportTests.") == 1 { count += 1 }
  END { print count + 0 }
')
[ "$test_count" -gt 0 ] || { echo "required Swift tests were not discovered" >&2; exit 1; }
test_log_sha=$(shasum -a 256 "$test_log" | awk '{print $1}')
jq -n \
  --arg headSHA "$head_sha" \
  --argjson testCount "$test_count" \
  --argjson durationSeconds "$test_duration" \
  --arg logSHA256 "$test_log_sha" \
  '{schemaVersion:1,headSHA:$headSHA,status:"passed",runner:"swift-testing",suites:["NeonDiffDesktopCoreTests","NeonDiffDesktopAppCoreTests","NeonDiffDesktopEvaluationSupportTests","NeonDiffDesktopFixtureChecks"],testCount:$testCount,durationSeconds:$durationSeconds,logSHA256:$logSHA256}' \
  >"$output/tests/test-summary.json"
assert_clean_head

swift run --package-path "$package_dir" NeonDiffDesktopFixtureChecks \
  >"$output/validation/fixture-checks.log" 2>&1
cp "$package_dir/fixtures/ui/catalog.json" "$output/fixtures/catalog.json"
jq -r '.entries[] | [.id,.file] | @tsv' "$package_dir/fixtures/ui/catalog.json" >"$tmp_root/catalog.tsv"
tab=$(printf '\t')
while IFS="$tab" read -r fixture_id fixture_name; do
  printf '%s\n' "$fixture_id" | grep -Eq '^[a-z0-9][a-z0-9-]{0,63}$' || { echo "invalid catalog fixture id" >&2; exit 1; }
  printf '%s\n' "$fixture_name" | grep -Eq '^[a-z0-9][a-z0-9-]{0,63}\.json$' || { echo "invalid catalog fixture file" >&2; exit 1; }
  cp "$package_dir/fixtures/ui/$fixture_name" "$output/fixtures/$fixture_name"
  cp "$package_dir/fixtures/ui/$fixture_name" "$tmp_root/fixtures/$fixture_id.json"
done <"$tmp_root/catalog.tsv"

NEONDIFF_DESKTOP_DIST_DIR="$output/artifacts" "$package_dir/script/build_and_run.sh" build \
  >"$output/validation/debug-build.log" 2>&1
swift build --package-path "$package_dir" --product NeonDiffDesktopCapture \
  >"$output/validation/capture-helper-build.log" 2>&1
capture_bin=$(swift build --package-path "$package_dir" --show-bin-path)/NeonDiffDesktopCapture
app="$output/artifacts/NeonDiffDesktop.app"
app_bin="$app/Contents/MacOS/NeonDiffDesktop"
fixture_resolver="$app/Contents/Helpers/NeonDiffDesktopFixtureResolve"
mkdir -p "$output/fixtures/normalized"
while IFS="$tab" read -r fixture_id fixture_name; do
  "$fixture_resolver" \
    --ui-testing \
    --ui-fixture "$tmp_root/fixtures/$fixture_id.json" \
    --content-size 1040x680 \
    --disable-animations \
    >"$output/fixtures/normalized/$fixture_id.json"
done <"$tmp_root/catalog.tsv"
assert_clean_head

npm run check:secrets >"$output/validation/repository-secret-scan.log" 2>&1
swift build --package-path "$package_dir" -c release --product NeonDiffDesktop \
  >"$output/validation/release-build.log" 2>&1
release_bin=$(swift build --package-path "$package_dir" -c release --show-bin-path)
npm run check:desktop-fixture-boundary -- \
  "$release_bin/NeonDiffDesktop" \
  "$release_bin/NeonDiffDesktopAppCore.build" \
  "$release_bin/Modules/NeonDiffDesktopAppCore.swiftmodule" \
  >"$output/validation/release-boundary.log" 2>&1
release_bundle="$tmp_root/release-bundle"
NEONDIFF_DESKTOP_DIST_DIR="$release_bundle" "$package_dir/script/build_and_run.sh" release-bundle-check \
  >>"$output/validation/release-boundary.log" 2>&1
npm run check:desktop-fixture-boundary -- "$release_bundle/NeonDiffDesktop.app" \
  >>"$output/validation/release-boundary.log" 2>&1
printf 'ok\n' >"$output/validation/release-boundary.ok"
node scripts/capture-desktop-evaluation-platform.mjs \
  --output "$output/validation/platform.json" \
  >"$output/validation/platform-capture.json"

while IFS="$tab" read -r fixture_id fixture_name; do
  for size in 1040x680 1280x800; do
    case_dir="$output/cases/$fixture_id/$size"
    ready_dir="$tmp_root/$fixture_id-$size"
    mkdir -p "$case_dir" "$ready_dir"
    ready="$ready_dir/ready.json"
    NEONDIFF_DESKTOP_EVALUATION_READY_PATH="$ready" \
      "$app_bin" \
      --ui-testing \
      --ui-fixture "$tmp_root/fixtures/$fixture_id.json" \
      --content-size "$size" \
      --disable-animations \
      >"$case_dir/launch.log" 2>&1 &
    cleanup_pid=$!
    attempts=0
    while [ ! -f "$ready" ] && kill -0 "$cleanup_pid" 2>/dev/null && [ "$attempts" -lt 100 ]; do
      /bin/sleep 0.1
      attempts=$((attempts + 1))
    done
    [ -f "$ready" ] || { echo "fixture did not become ready: $fixture_id $size" >&2; exit 1; }
    [ "$(jq -r .pid "$ready")" = "$cleanup_pid" ] || { echo "fixture PID mismatch" >&2; exit 1; }
    "$capture_bin" --pid "$cleanup_pid" --ready "$ready" --output-dir "$case_dir" >"$case_dir/capture.json.tmp" &
    capture_pid=$!
    capture_attempts=0
    while kill -0 "$capture_pid" 2>/dev/null && [ "$capture_attempts" -lt 150 ]; do
      /bin/sleep 0.1
      capture_attempts=$((capture_attempts + 1))
    done
    if kill -0 "$capture_pid" 2>/dev/null; then
      terminate_process "$capture_pid"
      capture_pid=
      echo "capture helper timed out: $fixture_id $size" >&2
      exit 1
    fi
    wait "$capture_pid"
    capture_pid=
    mv "$case_dir/capture.json.tmp" "$case_dir/capture.json"
    jq -n \
      --arg fixtureId "$fixture_id" \
      --arg size "$size" \
      '{fixtureId:$fixtureId,size:$size}' \
      >"$case_dir/case.json"
    cp "$ready" "$case_dir/readiness.json"
    terminate_process "$cleanup_pid"
    cleanup_pid=
  done
done <"$tmp_root/catalog.tsv"

node scripts/check-desktop-evaluation-packet-secrets.mjs --packet "$output" >"$tmp_root/packet-safety-scan.json"
jq -e '.ok == true and (.skippedImages | length) == 24' "$tmp_root/packet-safety-scan.json" >/dev/null
cp "$tmp_root/packet-safety-scan.json" "$output/validation/packet-safety-scan.json"
printf 'ok\n' >"$output/validation/packet-safety-scan.ok"
assert_clean_head

node scripts/build-desktop-evaluation-manifest.mjs \
  --packet "$output" \
  --head-sha "$head_sha" \
  >"$output/manifest-build.json"
swift run --package-path "$package_dir" NeonDiffDesktopManifestChecks "$output/manifest.json" \
  >"$output/manifest-check.json"
jq -e '.caseCount == 24 and .fixtureCount == 12' "$output/manifest-check.json" >/dev/null
node scripts/verify-desktop-evaluation-packet.mjs --packet "$output" >"$output/packet-check.json"
assert_clean_head
printf '%s\n' "$output"
