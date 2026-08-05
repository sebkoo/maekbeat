#!/usr/bin/env bash
# SwiftLint over apps/ios, with every violation an error.
#
# `--strict` is the whole point: a warning nobody has to fix is a rule nobody
# follows. This runs as its own CI step and fails the job, which is the same
# outcome as failing the build and does not require the linter to be resolved
# as a package dependency on every compile.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
ios_dir=$(dirname "$here")

if ! command -v swiftlint >/dev/null 2>&1; then
  echo "swiftlint not found. Install it with: brew install swiftlint" >&2
  echo "CI installs a pinned release; see .github/workflows/ci.yml." >&2
  exit 1
fi

swiftlint version
swiftlint lint --strict --config "$ios_dir/.swiftlint.yml" "$ios_dir"
