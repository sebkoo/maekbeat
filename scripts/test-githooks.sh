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

# G1 leg of the matrix. The rule bans AI attribution, not co-authorship, so this
# leg has to prove both halves — a Claude trailer rejected, and an accurate
# co-author line for a real contributor accepted.
#
# The dependabot row is here because it fired for real: GitHub's squash merge
# writes that exact line, and the guard's original bare `co-authored-by:` term
# rejected two correct commits on main. The near-miss it points at is worse — the
# first outside contributor's squash merge at C23 would have failed CI for
# having accurate authorship.
run_body() {
  local expected="$1"
  local label="$2"
  local body="$3"
  printf 'feat(server): fine subject\n\n%s\n' "$body" > "$tmp"
  if bash "$hook" "$tmp" > /dev/null 2>&1; then
    actual="pass"
  else
    actual="fail"
  fi
  if [ "$actual" != "$expected" ]; then
    echo "test-githooks: expected ${expected}, got ${actual}: ${label}" >&2
    failures=$((failures + 1))
  fi
}

run_body fail "Claude co-author trailer" \
  'Co-Authored-By: Claude <noreply@anthropic.com>'
run_body fail "Claude trailer without the anthropic address" \
  'Co-authored-by: Claude Code <bot@example.com>'
run_body fail "anthropic named in a co-author line" \
  'Co-authored-by: Anthropic Assistant <assistant@example.com>'
run_body fail "session marker" 'claude-session: 0e0d3c1a'
run_body fail "generated-with line" 'Generated with Claude Code'
run_body fail "bare anthropic address anywhere" 'Reported-by: someone <noreply@anthropic.com>'

run_body pass "dependabot squash-merge trailer" \
  'Co-authored-by: dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>'
run_body pass "human co-author" \
  'Co-authored-by: Jane Doe <jane@example.com>'
run_body pass "a body that merely discusses the rule" \
  'The hook rejects a co-authored-by line only when it names an AI.'

# The pattern is duplicated in two enforcement points on purpose — the hook runs
# at commit time and the script runs over history in CI — and a drift between
# them is a hole in whichever one is laxer. Assert they are byte-identical.
# Anchored to the executable lines, not to any mention: both files also discuss
# the rule in prose, and matching that would compare comments.
hook_pattern="$(sed -nE "s/^if grep -qiE '(.*)' \"\\\$msg_file\"; then\$/\\1/p" .githooks/commit-msg)"
script_pattern="$(sed -nE "s/^trailer_pattern='(.*)'\$/\\1/p" scripts/check-commit-hygiene.sh)"
if [ "$hook_pattern" != "$script_pattern" ]; then
  echo "test-githooks: the banned-trailer pattern differs between the two copies." >&2
  echo "  .githooks/commit-msg:            ${hook_pattern}" >&2
  echo "  scripts/check-commit-hygiene.sh: ${script_pattern}" >&2
  failures=$((failures + 1))
fi
if [ -z "$hook_pattern" ]; then
  echo "test-githooks: could not read the pattern out of .githooks/commit-msg." >&2
  failures=$((failures + 1))
fi

if [ "$failures" -ne 0 ]; then
  echo "test-githooks: ${failures} case(s) failed." >&2
  exit 1
fi

echo "test-githooks: all commit-msg matrix cases passed."
exit 0
