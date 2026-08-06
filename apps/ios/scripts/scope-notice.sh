#!/usr/bin/env bash
# Prints what a given run does NOT compile, derived from the platform guards in
# the test sources rather than from a list somebody has to remember to update.
#
# Neither command in this package runs everything, and the gaps point opposite
# ways: the macOS fast loop cannot compile the UIKit render tests, and the
# simulator gate cannot spawn the process the integration suite needs. A green
# check that verifies less than it appears to gets trusted eventually, so each
# run says which one it is.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
tests="$(dirname "$here")/MaekbeatKit/Tests/MaekbeatKitTests"
platform=${1:-}

case "$platform" in
  macos)
    guard='#if canImport(UIKit)'
    instead='apps/ios/scripts/test.sh (the simulator gate)'
    ;;
  simulator)
    guard='#if os(macOS)'
    instead='apps/ios/scripts/integration.sh (the macOS host)'
    ;;
  *)
    echo "usage: scope-notice.sh <macos|simulator>" >&2
    exit 1
    ;;
esac

skipped=$(grep -l -- "$guard" "$tests"/*.swift 2>/dev/null | xargs -n1 basename 2>/dev/null || true)

if [ -z "$skipped" ]; then
  echo "scope: this run compiles every test file in the package."
  exit 0
fi

echo
echo "  ┌─ scope of this run ─────────────────────────────────────────────"
echo "  │ NOT compiled on $platform, so NOT verified by what you just ran:"
printf '  │   %s\n' $skipped
echo "  │ Those run in: $instead"
echo "  └─────────────────────────────────────────────────────────────────"
echo
