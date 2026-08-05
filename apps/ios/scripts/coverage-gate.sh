#!/usr/bin/env bash
# The iOS half of the CLAUDE.md coverage ratchet.
#
# apps/ios is not a pnpm workspace package, so `pnpm -r test:coverage` and the
# C9 guard that fails when a package lacks that script cannot see it at all.
# This script is what stands in its place: xccov over the xcresult that
# scripts/test.sh produced, measured against a threshold set just under the
# floor, and moved only upward.
#
# The metric is line coverage, and only line coverage. xccov reports lines
# covered out of lines executable; it has no branch or function percentage of
# the kind vitest's v8 provider gives, so the iOS gate is one number where the
# TypeScript packages have four. That difference is stated in apps/ios/README.md
# rather than papered over.
#
# The denominator is the MaekbeatKit target: every line the library ships,
# excluding the test target — the same "src/ minus tests" rule each
# vitest.config.ts uses. The app shell in App/ lives in another target and
# cannot be measured here; a source scan keeps it a shell.
#
# A measured target is not the same as a measured package. Adding a second
# SwiftPM target and moving code into it would leave that code out of this
# number with the gate still green — CLAUDE.md's "the denominator is never
# shrunk", by relocation rather than by exclusion. So the report's target list
# is asserted, not just the one row read from it.
set -euo pipefail

# Ratchet, not aspiration (CLAUDE.md). Raised only in its own deliberate commit,
# never lowered, never widened by excluding a file. Set at C14 just under a
# measured 91.37% (Xcode 26.6, iOS 26.5 simulator, 2026-08-05 — the measurement
# and its method are in apps/ios/README.md), the same headroom convention the
# vitest packages use.
#
# Hard-coded, with no environment override, because CLAUDE.md forbids lowering a
# threshold by a flag and an override that exists is an override CI can be given.
# Proving the gate bites means editing this line and reverting it, exactly as the
# vitest packages are proved by editing their configs.
THRESHOLD=89
TARGET=MaekbeatKit

result=${1:-}
if [ -z "$result" ] || [ ! -d "$result" ]; then
  echo "usage: coverage-gate.sh <path to .xcresult>" >&2
  exit 1
fi

report=$(xcrun xccov view --report "$result")

# Target rows start at column 0; file and function rows are indented. Requiring
# the (covered/executable) token keeps the table header out of the match.
targets=$(printf '%s\n' "$report" | awk '
  /^[^[:space:]]/ && $3 ~ /^\([0-9]+\/[0-9]+\)$/ { print $1 }
')

# Nothing may appear in the report except the measured library and its test
# bundle. A third target is code that ships and is not counted, which is the
# ratchet being widened by relocation rather than by an exclude entry.
unexpected=$(printf '%s\n' "$targets" | grep -vxE "$TARGET|${TARGET}Tests" || true)
if [ -n "$unexpected" ]; then
  echo "coverage gate: the build has targets this gate does not measure:" >&2
  printf '  %s\n' $unexpected >&2
  echo "Every target that ships code must be in the denominator (CLAUDE.md)." >&2
  echo "Fold it into $TARGET, or measure it here — do not leave it uncounted." >&2
  exit 1
fi

read -r covered executable <<EOF
$(printf '%s\n' "$report" | awk -v target="$TARGET" '
  /^[^[:space:]]/ && $1 == target && $3 ~ /^\([0-9]+\/[0-9]+\)$/ {
    gsub(/[()]/, "", $3)
    split($3, parts, "/")
    print parts[1], parts[2]
    exit
  }
')
EOF

if [ -z "${covered:-}" ] || [ -z "${executable:-}" ]; then
  echo "coverage gate: no '$TARGET' row in the xccov report." >&2
  echo "The suite may have run without -enableCodeCoverage, or the target was renamed." >&2
  # awk rather than head: head closes the pipe early and the SIGPIPE would
  # end this script before the explicit exit below.
  printf '%s\n' "$report" | awk 'NR <= 20' >&2
  exit 1
fi

if [ "$executable" -eq 0 ]; then
  echo "coverage gate: '$TARGET' reports zero executable lines — nothing was measured." >&2
  exit 1
fi

percent=$(awk -v c="$covered" -v e="$executable" 'BEGIN { printf "%.2f", (c / e) * 100 }')
echo "coverage gate: $TARGET line coverage $percent% ($covered/$executable), threshold $THRESHOLD%"

if awk -v p="$percent" -v t="$THRESHOLD" 'BEGIN { exit !(p < t) }'; then
  echo "coverage gate: FAILED — $percent% is below the $THRESHOLD% threshold." >&2
  echo "Thresholds are a ratchet: raise coverage, do not lower this number." >&2
  exit 1
fi
