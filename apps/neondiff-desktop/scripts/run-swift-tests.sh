#!/bin/sh
set -eu

if swift -e 'import Testing' >/dev/null 2>&1; then
  exec swift test "$@"
fi

framework_path=/Library/Developer/CommandLineTools/Library/Developer/Frameworks
if [ ! -d "$framework_path/Testing.framework" ]; then
  echo "Testing.framework is unavailable at $framework_path" >&2
  exit 1
fi

exec swift test \
  -Xswiftc -F -Xswiftc "$framework_path" \
  -Xlinker -F -Xlinker "$framework_path" \
  -Xlinker -rpath -Xlinker "$framework_path" \
  "$@"
