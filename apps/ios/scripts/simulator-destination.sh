#!/usr/bin/env bash
# Prints an xcodebuild -destination for the newest available iOS simulator.
#
# Not a pinned device name: this machine and the CI runner have different
# simulator line-ups, and a hard-coded "iPhone 17 Pro" would break on whichever
# one Apple retires first. `simctl list` prints runtimes in ascending order, so
# the last iOS section is the newest, and the first iPhone in it is the target.
#
# Failure is loud. A silent fallback to some other platform would run the suite
# somewhere the app does not ship.
set -euo pipefail

line=$(xcrun simctl list devices available | awk '
  /^-- iOS /   { in_ios = 1; first = ""; next }
  /^-- /       { in_ios = 0; next }
  in_ios && /^[[:space:]]*iPhone/ { if (first == "") first = $0 }
  END { print first }
')

if [ -z "$line" ]; then
  echo "no iOS simulator available. Install one with: xcodebuild -downloadPlatform iOS" >&2
  exit 1
fi

udid=$(printf '%s\n' "$line" | sed -nE 's/.*\(([0-9A-Fa-f-]{36})\).*/\1/p')
if [ -z "$udid" ]; then
  echo "could not read a simulator id from: $line" >&2
  exit 1
fi

echo "platform=iOS Simulator,id=$udid"
