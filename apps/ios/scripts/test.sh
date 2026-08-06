#!/usr/bin/env bash
# Runs the MaekbeatKit suite on an iOS simulator with coverage, then gates on it.
#
# One script for the local loop and for CI, so "it passes on my machine" and
# "it passes in the job" mean the same commands. The destination is discovered
# rather than pinned (scripts/simulator-destination.sh).
#
# The scheme comes from the package rather than from Maekbeat.xcodeproj: the
# project's auto-generated MaekbeatKit scheme has no test action, because the
# test target belongs to the package and not to the project. Running from the
# package directory is what makes `xcodebuild test` see it.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
ios_dir=$(dirname "$here")
result="$ios_dir/.xcresult/MaekbeatKit.xcresult"

destination=$("$here/simulator-destination.sh")
echo "iOS tests: $destination"
xcodebuild -version

rm -rf "$result"
mkdir -p "$(dirname "$result")"

cd "$ios_dir/MaekbeatKit"
xcodebuild test \
  -scheme MaekbeatKit \
  -destination "$destination" \
  -enableCodeCoverage YES \
  -resultBundlePath "$result" \
  -derivedDataPath "$ios_dir/.build-xcode" \
  CODE_SIGNING_ALLOWED=NO

"$here/coverage-gate.sh" "$result"

# What the simulator cannot run, named rather than assumed.
"$here/scope-notice.sh" simulator
