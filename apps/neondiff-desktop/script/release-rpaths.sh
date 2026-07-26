#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-}"
APP_BINARY="${2:-}"
OTOOL_BIN="${NEONDIFF_OTOOL_BIN:-otool}"
INSTALL_NAME_TOOL_BIN="${NEONDIFF_INSTALL_NAME_TOOL_BIN:-install_name_tool}"

if [ -z "$APP_BINARY" ] || [ ! -f "$APP_BINARY" ]; then
  echo "usage: $0 [sanitize|assert] <app-binary>" >&2
  exit 2
fi

list_binary_rpaths() {
  local otool_output
  if ! otool_output="$($OTOOL_BIN -l "$APP_BINARY")"; then
    echo "unable to inspect release bundle LC_RPATH entries" >&2
    return 1
  fi

  printf '%s\n' "$otool_output" | awk '
    /^[[:space:]]*cmd LC_RPATH$/ { waiting_for_path = 1; next }
    waiting_for_path && /^[[:space:]]*path / {
      print $2
      waiting_for_path = 0
    }
  '
}

is_portable_release_rpath() {
  case "$1" in
    /usr/lib/swift|@loader_path|@executable_path/../Frameworks)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

capture_rpaths() {
  local captured
  if ! captured="$(list_binary_rpaths)"; then
    return 1
  fi
  printf '%s' "$captured"
}

sanitize_release_rpaths() {
  local rpaths rpath
  rpaths="$(capture_rpaths)"
  while IFS= read -r rpath; do
    [ -n "$rpath" ] || continue
    if ! is_portable_release_rpath "$rpath"; then
      "$INSTALL_NAME_TOOL_BIN" -delete_rpath "$rpath" "$APP_BINARY"
    fi
  done <<< "$rpaths"
}

assert_portable_release_rpaths() {
  local rpaths rpath
  rpaths="$(capture_rpaths)"
  while IFS= read -r rpath; do
    [ -n "$rpath" ] || continue
    if ! is_portable_release_rpath "$rpath"; then
      echo "release bundle contains a non-portable LC_RPATH: $rpath" >&2
      return 1
    fi
  done <<< "$rpaths"
}

case "$MODE" in
  sanitize)
    sanitize_release_rpaths
    ;;
  assert)
    assert_portable_release_rpaths
    ;;
  *)
    echo "usage: $0 [sanitize|assert] <app-binary>" >&2
    exit 2
    ;;
esac
