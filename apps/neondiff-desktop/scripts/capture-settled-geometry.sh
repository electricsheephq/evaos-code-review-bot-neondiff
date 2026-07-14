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
  || { echo "settled geometry output must not already exist" >&2; exit 65; }
output_parent=$(dirname -- "$output")
output_name=$(basename -- "$output")
case "$output_name" in ''|.|..) usage ;; esac
[ -d "$output_parent" ] && [ ! -L "$output_parent" ] \
  || { echo "settled geometry output parent must be a real directory" >&2; exit 65; }
physical_parent=$(CDPATH='' cd -P -- "$output_parent" && pwd -P)
[ "$output" = "$physical_parent/$output_name" ] \
  || { echo "settled geometry output must be a canonical path without symlinked parents" >&2; exit 65; }

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
package_dir=$(dirname -- "$script_dir")
repo_dir=$(CDPATH='' cd -- "$package_dir/../.." && pwd)

[ -z "$(git -C "$repo_dir" status --porcelain --untracked-files=all)" ] \
  || { echo "settled geometry capture requires a clean worktree" >&2; exit 65; }
head_sha=$(git -C "$repo_dir" rev-parse HEAD)
printf '%s\n' "$head_sha" | grep -Eq '^[0-9a-f]{40}$' \
  || { echo "could not bind capture to an exact HEAD" >&2; exit 65; }

attempt_limit=300
if [ "${NEONDIFF_DESKTOP_TEST_MODE:-}" = 1 ]; then
  attempt_limit=${NEONDIFF_DESKTOP_TEST_CAPTURE_ATTEMPTS:-300}
  case "$attempt_limit" in ''|*[!0-9]*)
    echo "test capture attempt limit must be an integer from 1 through 300" >&2
    exit 65
  esac
  [ "$attempt_limit" -ge 1 ] && [ "$attempt_limit" -le 300 ] \
    || { echo "test capture attempt limit must be an integer from 1 through 300" >&2; exit 65; }
elif [ -n "${NEONDIFF_DESKTOP_TEST_CAPTURE_ATTEMPTS:-}" ]; then
  echo "test capture attempt limit requires explicit test mode" >&2
  exit 65
fi
unset NEONDIFF_DESKTOP_TEST_MODE NEONDIFF_DESKTOP_TEST_CAPTURE_ATTEMPTS

mkdir -m 700 "$output"
output_metadata=$(/usr/bin/stat -f '%u:%Lp' "$output" 2>/dev/null || /usr/bin/stat -c '%u:%a' "$output")
[ "$output_metadata" = "$(id -u):700" ] \
  || { echo "settled geometry output must be owned by the caller with mode 700" >&2; exit 65; }
cd "$output"
[ "$(pwd -P)" = "$output" ] \
  || { echo "settled geometry output identity changed during setup" >&2; exit 65; }
mkdir -m 700 validation
status_path="validation/settled-capture-status.json"

render_status() {
  target=$1
  shift
  status=$1
  phase=$2
  reason=$3
  safety=$4
  proof=$5
  jq -n \
    --arg status "$status" \
    --arg phase "$phase" \
    --arg reasonCode "$reason" \
    --arg publicSafety "$safety" \
    --arg proof "$proof" \
    '{schemaVersion:1,status:$status,phase:$phase,reasonCode:$reasonCode,publicSafety:$publicSafety,proof:$proof}' \
    >"$target"
}

write_status() {
  render_status "$status_path.tmp" "$@"
  mv "$status_path.tmp" "$status_path"
}

write_status incomplete setup capture_in_progress incomplete not_emitted

tmp_root=$(/usr/bin/mktemp -d "/tmp/neondiff-settled-geometry.XXXXXXXX")
/bin/chmod 700 "$tmp_root"
tmp_mode=$(/usr/bin/stat -f '%Lp' "$tmp_root" 2>/dev/null || /usr/bin/stat -c '%a' "$tmp_root")
[ "$tmp_mode" = 700 ] \
  || { write_status incomplete setup private_workspace_invalid incomplete not_emitted; exit 65; }

app_pid=
capture_pid=
terminate_process() {
  target=$1
  case "$target" in ''|*[!0-9]*) return ;; esac
  [ "$target" -ne "$$" ] || return
  kill -TERM "$target" >/dev/null 2>&1 || true
  attempts=0
  while kill -0 "$target" 2>/dev/null && [ "$attempts" -lt 10 ]; do
    /bin/sleep 0.1
    attempts=$((attempts + 1))
  done
  kill -KILL "$target" >/dev/null 2>&1 || true
  wait "$target" >/dev/null 2>&1 || true
}
cleanup() {
  if [ -n "$capture_pid" ]; then terminate_process "$capture_pid"; fi
  if [ -n "$app_pid" ]; then terminate_process "$app_pid"; fi
  rm -f ".settled-geometry-proof.json.pending"
  rm -f "validation/.settled-capture-status.final.pending"
  rm -rf "$tmp_root"
}
trap cleanup EXIT HUP INT TERM

assert_clean_head() {
  current_head=$(git -C "$repo_dir" rev-parse HEAD 2>/dev/null || true)
  current_status=$(git -C "$repo_dir" status --porcelain --untracked-files=all 2>/dev/null || printf 'failed\n')
  if [ "$current_head" != "$head_sha" ] || [ -n "$current_status" ]; then
    write_status incomplete source source_changed incomplete not_emitted
    echo "source changed during settled geometry capture" >&2
    exit 65
  fi
}

source_fixture="$package_dir/fixtures/ui/tab-overview.json"
[ -f "$source_fixture" ] && [ ! -L "$source_fixture" ] \
  || { write_status incomplete setup fixture_invalid incomplete not_emitted; exit 65; }
fixture="$tmp_root/tab-overview.json"
cp "$source_fixture" "$fixture"

export SWIFTPM_BUILD_DIR="$tmp_root/swift-build"
dist_dir="$tmp_root/dist"
NEONDIFF_DESKTOP_DIST_DIR="$dist_dir" \
  "$package_dir/script/build_and_run.sh" build >"$tmp_root/app-build.log" 2>&1
swift build --package-path "$package_dir" --product NeonDiffDesktopSettledGeometryCapture \
  >"$tmp_root/capture-build.log" 2>&1
swift build --package-path "$package_dir" --product NeonDiffDesktopGeometryChecks \
  >"$tmp_root/checker-build.log" 2>&1
swift_bin=$(swift build --package-path "$package_dir" --show-bin-path)
app_bin="$dist_dir/NeonDiffDesktop.app/Contents/MacOS/NeonDiffDesktop"
capture_bin="$swift_bin/NeonDiffDesktopSettledGeometryCapture"
[ -x "$app_bin" ] && [ -x "$capture_bin" ] \
  || { write_status incomplete build products_missing incomplete not_emitted; exit 65; }
node "$repo_dir/scripts/hash-desktop-bundle-tree.mjs" "$dist_dir/NeonDiffDesktop.app" \
  >"$tmp_root/debug-app-tree.json"
jq -e '
  .algorithm == "sha256-tree-v1"
  and (.entryCount | type == "number" and . > 0)
  and (.sha256 | type == "string" and test("^[0-9a-f]{64}$"))
' "$tmp_root/debug-app-tree.json" >/dev/null \
  || { write_status incomplete build app_identity_invalid incomplete not_emitted; exit 65; }
assert_clean_head

npm --prefix "$repo_dir" run check:secrets >"$tmp_root/repository-secret-scan.log" 2>&1

ready_dir="$tmp_root/ready"
capture_stage="$tmp_root/capture"
mkdir -m 700 "$ready_dir" "$capture_stage"
ready="$ready_dir/ready.json"
surface_state="$ready_dir/surface-state.json"
settled="$capture_stage/settled-geometry.json"
NEONDIFF_DESKTOP_EVALUATION_READY_PATH="$ready" \
  "$app_bin" \
  --ui-testing \
  --ui-fixture "$fixture" \
  --content-size 1040x680 \
  --disable-animations \
  >"$tmp_root/launch.log" 2>&1 &
app_pid=$!

ready_attempts=0
while [ ! -f "$ready" ] && kill -0 "$app_pid" 2>/dev/null && [ "$ready_attempts" -lt 100 ]; do
  /bin/sleep 0.1
  ready_attempts=$((ready_attempts + 1))
done
if [ ! -f "$ready" ]; then
  write_status incomplete readiness readiness_unavailable incomplete not_emitted
  echo "tab-overview readiness was unavailable" >&2
  exit 1
fi
[ -f "$ready" ] && [ ! -L "$ready" ] \
  || { write_status incomplete readiness readiness_invalid incomplete not_emitted; exit 1; }
jq -e --argjson pid "$app_pid" '
  type == "object"
  and .schemaVersion == 1
  and .fixtureId == "tab-overview"
  and .pid == $pid
  and .ready == true
  and .contentFrame.width == 1040
  and .contentFrame.height == 680
' "$ready" >/dev/null \
  || { write_status incomplete readiness readiness_invalid incomplete not_emitted; exit 1; }

"$capture_bin" \
  --pid "$app_pid" \
  --ready "$ready" \
  --output "$settled" \
  >"$tmp_root/capture-status.json" \
  2>"$tmp_root/capture-error.json" &
capture_pid=$!
capture_attempts=0
while kill -0 "$capture_pid" 2>/dev/null && [ "$capture_attempts" -lt "$attempt_limit" ]; do
  /bin/sleep 0.1
  capture_attempts=$((capture_attempts + 1))
done
if kill -0 "$capture_pid" 2>/dev/null; then
  terminate_process "$capture_pid"
  capture_pid=
  write_status incomplete capture capture_timeout incomplete not_emitted
  echo "settled geometry helper timed out" >&2
  exit 124
fi
capture_exit=0
wait "$capture_pid" || capture_exit=$?
capture_pid=
if [ "$capture_exit" -ne 0 ]; then
  write_status incomplete capture capture_failed incomplete not_emitted
  echo "settled geometry helper failed" >&2
  exit "$capture_exit"
fi
jq -e '
  type == "object"
  and keys == ["ok","reasonCode","schemaVersion","status"]
  and .schemaVersion == 1
  and .ok == true
  and .status == "complete"
  and .reasonCode == "none"
' "$tmp_root/capture-status.json" >/dev/null \
  || { write_status incomplete capture capture_status_invalid incomplete not_emitted; exit 1; }
[ -f "$settled" ] && [ ! -L "$settled" ] \
  || { write_status incomplete capture capture_output_missing incomplete not_emitted; exit 1; }
[ -f "$surface_state" ] && [ ! -L "$surface_state" ] \
  || { write_status incomplete capture surface_state_missing incomplete not_emitted; exit 1; }
jq -e --argjson pid "$app_pid" '
  type == "object"
  and .schemaVersion == 1
  and .fixtureId == "tab-overview"
  and .pid == $pid
  and .section == "overview"
  and .surfaceGeneration == 2
  and .quiescent == true
  and .contentFrame.width == 1040
  and .contentFrame.height == 680
' "$surface_state" >/dev/null \
  || { write_status incomplete capture surface_state_invalid incomplete not_emitted; exit 1; }

terminate_process "$app_pid"
app_pid=
assert_clean_head

case_parent="cases/overview-repos-overview"
pending="$case_parent/.1040x680.pending"
case_dir="$case_parent/1040x680"
mkdir -p "$case_parent"
mkdir -m 700 "$pending"
cp "$ready" "$pending/readiness.json"
cp "$surface_state" "$pending/final-surface-state.json"
cp "$settled" "$pending/settled-geometry.json"
cp "$tmp_root/capture-status.json" "$pending/capture-status.json"
cp "$tmp_root/debug-app-tree.json" "$pending/debug-app-tree.json"
mv "$pending" "$case_dir"

checker_exit=0
if swift run --skip-build --package-path "$package_dir" \
  NeonDiffDesktopGeometryChecks "$case_dir/settled-geometry.json" \
  >"validation/settled-geometry-check.json" \
  2>"$tmp_root/checker.stderr"; then
  :
else
  checker_exit=$?
fi
jq -e '
  type == "object"
  and keys == ["category","ok","reasonCode","schemaVersion","status"]
  and .schemaVersion == 1
  and .ok == true
  and .status == "stable"
  and .category == "none"
  and .reasonCode == "none"
' "validation/settled-geometry-check.json" >/dev/null \
  || { write_status incomplete checker checker_rejected incomplete not_emitted; exit 1; }
[ "$checker_exit" -eq 0 ] \
  || { write_status incomplete checker checker_rejected incomplete not_emitted; exit "$checker_exit"; }

trace_sha=$(shasum -a 256 "$case_dir/settled-geometry.json" | awk '{print $1}')
app_tree_sha=$(jq -r '.sha256' "$case_dir/debug-app-tree.json")
jq -n \
  --arg head "$head_sha" \
  --arg traceSha256 "$trace_sha" \
  --arg appTreeSha256 "$app_tree_sha" \
  '{schemaVersion:1,head:$head,scenario:"overview-repos-overview",contentSize:"1040x680",traceSha256:$traceSha256,appTreeAlgorithm:"sha256-tree-v1",appTreeSha256:$appTreeSha256,checker:"stable",proofBoundary:"settled-geometry-only"}' \
  >".settled-geometry-proof.json.pending"

if node "$repo_dir/scripts/check-desktop-evaluation-packet-secrets.mjs" --packet . \
  >"$tmp_root/packet-safety.json"; then
  :
else
  write_status incomplete safety public_safety_failed failed not_emitted
  echo "settled geometry public-safety scan failed" >&2
  exit 1
fi
jq -e '
  .ok == true
  and .findings == []
  and .sensitiveFiles == []
  and .invalidImages == []
  and .unsupportedEntries == []
' "$tmp_root/packet-safety.json" >/dev/null \
  || { write_status incomplete safety public_safety_failed failed not_emitted; exit 1; }
cp "$tmp_root/packet-safety.json" "validation/packet-safety-scan.json"
printf 'ok\n' >"validation/packet-safety-scan.ok"
assert_clean_head
# The proof rename below is the packet's sole publication commit marker. Keep
# the status truthful even if the process is interrupted between the two
# renames: the completed capture is ready for publication, but only proof-file
# presence means it was emitted.
render_status "validation/.settled-capture-status.final.pending" complete complete none passed publication_ready
assert_clean_head
mv "validation/.settled-capture-status.final.pending" "$status_path"
mv ".settled-geometry-proof.json.pending" "settled-geometry-proof.json"
