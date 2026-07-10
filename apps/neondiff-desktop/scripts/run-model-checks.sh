#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
package_root="$(cd "$script_dir/.." && pwd)"
model_source="$package_root/Sources/NeonDiffDesktop/Models/NeonDiffDesktopModel.swift"
check_source="$package_root/Checks/NeonDiffDesktopModelChecks/main.swift"

swift build --package-path "$package_root" --target NeonDiffDesktopCore >/dev/null
bin_path="$(swift build --package-path "$package_root" --show-bin-path)"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/neondiff-model-checks.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

core_objects=("$bin_path"/NeonDiffDesktopCore.build/*.o)
if [[ ! -e "${core_objects[0]}" ]]; then
  echo "NeonDiffDesktopCore objects were not produced" >&2
  exit 1
fi

swiftc \
  -parse-as-library \
  -I "$bin_path/Modules" \
  "$model_source" \
  "$check_source" \
  "${core_objects[@]}" \
  -framework AppKit \
  -framework Security \
  -o "$scratch/NeonDiffDesktopModelChecks"

"$scratch/NeonDiffDesktopModelChecks"
