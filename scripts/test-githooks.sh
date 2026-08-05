#!/usr/bin/env bash
# Hook matrix: run .githooks/commit-msg against known subjects and assert the
# exit codes. Guards the hook itself — a regression here would silently stop
# gating commits. Run from the repo root: bash scripts/test-githooks.sh
set -u

hook=".githooks/commit-msg"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

failures=0

# matrix rows: expected exit ("pass" = 0, "fail" = nonzero) | subject
run_case() {
  local expected="$1"
  local subject="$2"
  printf '%s\n' "$subject" > "$tmp"
  if bash "$hook" "$tmp" > /dev/null 2>&1; then
    actual="pass"
  else
    actual="fail"
  fi
  if [ "$actual" != "$expected" ]; then
    echo "test-githooks: expected ${expected}, got ${actual}: ${subject}" >&2
    failures=$((failures + 1))
  fi
}

run_case pass "feat(server): add WebSocket vitals ingest"
run_case pass "feat(protocol)!: drop v1 frames"
run_case fail "Added the ingest endpoint"
run_case fail "feat(server): $(printf 'x%.0s' $(seq 1 70))"

# G1 leg of the matrix: a well-formed subject with a banned trailer must fail.
printf 'feat(server): fine subject\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n' > "$tmp"
if bash "$hook" "$tmp" > /dev/null 2>&1; then
  echo "test-githooks: expected fail, got pass: trailer message" >&2
  failures=$((failures + 1))
fi

if [ "$failures" -ne 0 ]; then
  echo "test-githooks: ${failures} case(s) failed." >&2
  exit 1
fi

echo "test-githooks: all commit-msg matrix cases passed."
exit 0
