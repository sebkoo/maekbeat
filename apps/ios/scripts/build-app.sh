#!/usr/bin/env bash
# Builds the app target for the simulator.
#
# Separate from the test run and not optional. The C12a lesson was that a
# feature can be fully unit-tested and left unwired; here the equivalent is a
# library that compiles perfectly inside a shell that does not. Nothing in the
# package build links App/MaekbeatApp.swift, so this is the only step that
# proves the thing a person can actually launch still compiles.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
ios_dir=$(dirname "$here")

destination=$("$here/simulator-destination.sh")
echo "iOS app build: $destination"

xcodebuild build \
  -project "$ios_dir/Maekbeat.xcodeproj" \
  -scheme Maekbeat \
  -destination "$destination" \
  -derivedDataPath "$ios_dir/.build-xcode" \
  CODE_SIGNING_ALLOWED=NO
