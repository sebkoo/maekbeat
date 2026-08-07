#!/usr/bin/env bash
# How many of the Playwright smoke's tests skipped, read off the run rather
# than predicted by its configuration.
#
#   scripts/check-e2e-skips.sh <log-file> <expected-skips>
#
# This looks like a second copy of apps/web/e2e/skip-budget.ts and is not. That
# reporter compares the run against `EXPECTED_SKIPS` in playwright.config.ts,
# which is itself computed from `process.env.E2E_EXPECTED_REVISION`:
#
#   export const EXPECTED_SKIPS = process.env.E2E_EXPECTED_REVISION === undefined ? 1 : 0;
#
# So it asserts that the number of skips matches what the environment predicts,
# and it cannot notice when the environment is wrong. If infra/compose-smoke.sh
# ever stopped exporting E2E_EXPECTED_REVISION, the budget would become 1,
# e2e/identity.spec.ts would skip, the reporter would agree, and the compose job
# would be green with the one test it exists to run never having run — which is
# the exact failure e2e/identity.spec.ts was written about, one level up.
#
# The number here comes from the caller instead, so the two CI jobs pin their
# own: the `smoke` job runs the suite against a locally built bundle and expects
# 1, the `compose` job runs the same suite against the containers and expects 0.
# The same six tests, two budgets, both checked from outside the suite.
set -uo pipefail

LOG=${1:?usage: scripts/check-e2e-skips.sh <log-file> <expected-skips>}
EXPECTED=${2:?usage: scripts/check-e2e-skips.sh <log-file> <expected-skips>}

note() { echo "e2e-skips: $*" >&2; }

if [ ! -s "$LOG" ]; then
  note "$LOG is missing or empty — there is no run to read."
  exit 1
fi

# A log with no summary line at all is a run that died before reporting, and
# reading that as "0 skipped" would turn a crash into a pass. Anchored to the
# reporter's own indented totals.
SUMMARY_RE='^[[:space:]]+[0-9]+ (passed|failed|flaky|skipped|did not run)'
if ! grep -qE "$SUMMARY_RE" "$LOG"; then
  note "no Playwright summary line in $LOG."
  note "  Either the suite never reached the end, or the reporter's output shape"
  note "  changed. Both mean this check has nothing to read; neither is a pass."
  exit 1
fi

# No "N skipped" line means none skipped. Last match wins: the compose log holds
# the whole stack smoke, and only the Playwright section prints these.
skipped=$(sed -nE 's/^[[:space:]]+([0-9]+) skipped.*/\1/p' "$LOG" | tail -1)
skipped=${skipped:-0}

if [ "$skipped" != "$EXPECTED" ]; then
  note "$skipped test(s) skipped in $LOG, $EXPECTED expected."
  grep -nE '⊘|skipped' "$LOG" | tail -5 >&2
  note "  A skip nobody declared is a test that looks present and proves nothing."
  note "  If this is the compose job, the likely cause is E2E_EXPECTED_REVISION"
  note "  no longer reaching the suite, which makes e2e/identity.spec.ts skip."
  exit 1
fi

echo "e2e-skips: $skipped skipped in $LOG, as expected."
