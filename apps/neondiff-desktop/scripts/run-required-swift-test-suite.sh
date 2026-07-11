#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <Swift test target>" >&2
  exit 64
fi

suite=$1
case "$suite" in
  ''|*[!A-Za-z0-9_]*)
    echo "invalid Swift test target: $suite" >&2
    exit 64
    ;;
esac
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
package_dir=$(dirname -- "$script_dir")
cd "$package_dir"

result_file=$(mktemp "${TMPDIR:-/tmp}/neondiff-swift-tests.XXXXXX")
trap 'rm -f "$result_file"' EXIT HUP INT TERM

scripts/run-swift-tests.sh --filter "^${suite}\." --xunit-output "$result_file"
test_count=$(/usr/bin/xmllint --xpath 'string(sum(/testsuites/testsuite/@tests))' "$result_file")
case "$test_count" in
  ''|0|*[!0-9]*)
  echo "no tests discovered for required Swift suite: $suite" >&2
  exit 1
  ;;
esac
