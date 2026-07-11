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

test_list=$(scripts/run-swift-tests.sh list)
test_count=$(printf '%s\n' "$test_list" | awk -v prefix="${suite}." '
  index($0, prefix) == 1 { count += 1 }
  END { print count + 0 }
')
case "$test_count" in
  ''|0|*[!0-9]*)
    echo "no tests discovered for required Swift suite: $suite" >&2
    exit 1
    ;;
esac

case "$suite" in
  NeonDiffDesktopCoreTests)
    ledger_suite=CoreChecksMigrationLedgerTests
    ;;
  NeonDiffDesktopAppCoreTests)
    ledger_suite=ModelHarnessMigrationLedgerTests
    ;;
  *)
    ledger_suite=
    ;;
esac

if [ -n "$ledger_suite" ]; then
  scripts/run-swift-tests.sh \
    --filter "^${suite}\." \
    --skip "^${suite}\.${ledger_suite}"
  exec scripts/run-swift-tests.sh --filter "^${suite}\.${ledger_suite}"
fi

exec scripts/run-swift-tests.sh --filter "^${suite}\."
