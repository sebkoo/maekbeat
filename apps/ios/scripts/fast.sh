#!/usr/bin/env bash
# The fast local loop: the package suite on the macOS host, in a couple of
# seconds instead of the simulator's forty.
#
# It is not the gate, and it says so every time rather than in a document
# somebody read once. `swift test` here cannot compile the UIKit render tests,
# so a green run leaves part of the package unverified — that used to be a
# footnote in apps/ios/README.md, and a state-type change slipped past it.
#
# Refuses to run under CI. The gate is scripts/test.sh plus
# scripts/integration.sh, and a fast loop wired into a pipeline would be exactly
# the green check that verifies less than it appears to.
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)

if [ -n "${CI:-}" ]; then
  echo "fast.sh is the local loop, not a gate — CI runs scripts/test.sh and" >&2
  echo "scripts/integration.sh, which between them compile every test file." >&2
  exit 1
fi

cd "$(dirname "$here")/MaekbeatKit"
swift test "$@"
status=$?

"$here/scope-notice.sh" macos
exit "$status"
