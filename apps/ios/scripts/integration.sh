#!/usr/bin/env bash
# The app against a real apps/server: launches the server, drives the real
# clients over real WebSockets, and reads the server's own replies.
#
# Two suites, matched by the shared `Integration` in their names rather than by
# a list this script would have to be remembered for: GatewayIntegrationTests
# (C15 — the resume contract and the decision circuit) and
# ServerFailureIntegrationTests (C17 — what the interface says when the server
# dies, the decision is refused, or the socket drops mid-episode).
#
# macOS host rather than the iOS Simulator, because the suites spawn a process
# and a simulator test cannot. That puts them outside the coverage gate, which
# is stated in apps/ios/README.md rather than left to be found.
#
# It needs the workspace installed. When it is not, the suites skip rather than
# fail — and this script then fails, because a skip in CI is a green tick for
# a check nobody ran.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
kit=$(dirname "$here")/MaekbeatKit
log=$(mktemp)

cd "$kit"
set +e
swift test --filter Integration 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
set -e

if grep -q "' skipped" "$log"; then
  echo "integration: the suite skipped — apps/server dependencies are missing." >&2
  echo "Run pnpm install before this script; a skipped gate reports nothing." >&2
  exit 1
fi

if ! grep -qE 'Executed [1-9][0-9]* tests' "$log"; then
  echo "integration: no tests ran at all." >&2
  exit 1
fi

exit "$status"
