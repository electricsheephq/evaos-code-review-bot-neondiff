#!/usr/bin/env sh
set -eu

NEONDIFF_VERSION="${NEONDIFF_VERSION:-1.0.3}"
DRY_RUN=0
NPM_PREFIX="${NPM_PREFIX:-}"

usage() {
  cat <<'USAGE'
Install NeonDiff from npm.

Usage:
  sh install.sh [--dry-run] [--prefix /path/to/prefix]

Environment:
  NEONDIFF_VERSION  Version to install, defaults to 1.0.3.
  NPM_PREFIX        Optional npm global prefix.

Requires Node.js 26 or newer and npm.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --prefix)
      if [ "$#" -lt 2 ]; then
        echo "error: --prefix requires a path" >&2
        exit 64
      fi
      NPM_PREFIX="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 64
      ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "error: Node.js 26 or newer is required, but node was not found." >&2
  exit 69
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm is required, but npm was not found." >&2
  exit 69
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 26 ]; then
  echo "error: Node.js 26 or newer is required. Found $(node -v)." >&2
  exit 69
fi

set -- npm install -g "neondiff@${NEONDIFF_VERSION}"
if [ -n "$NPM_PREFIX" ]; then
  set -- "$@" --prefix "$NPM_PREFIX"
fi

echo "NeonDiff installer"
echo "version: ${NEONDIFF_VERSION}"
if [ -n "$NPM_PREFIX" ]; then
  echo "prefix: ${NPM_PREFIX}"
fi
echo "command: $*"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "dry-run: no changes made"
  exit 0
fi

"$@"
echo "installed: neondiff ${NEONDIFF_VERSION}"
echo "next: neondiff help"
