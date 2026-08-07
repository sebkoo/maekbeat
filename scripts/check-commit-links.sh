#!/usr/bin/env bash
# Every landed commit is linked, and every link points at a real ancestor.
#
# Two facts made the board rot. A commit cannot contain its own hash, so a link
# is always added by a later commit; and the C18 and C19 briefs said to leave
# links empty until the push without saying who would fill them in afterwards.
# Nobody did, and the board went eleven commits without a single chip while
# every one of them was on main.
#
# THE ONE-ROW EXEMPTION, because the next person will hit it and assume this
# script is broken. Exactly one shipped entry may carry no commit link: the
# newest, which is the row describing the commit currently being written. That
# row gets its link from the next commit that touches the board. Any older
# linkless row is the rot this exists to catch, so the allowance is one and the
# script names the offender rather than counting them silently. If you are
# staring at "the newest entry may be linkless, this one is not the newest",
# the fix is to backfill the older row, not to add a second exemption.
#
# docs/ROADMAP.md is the plan of record, so the set of landed commits is read
# from it rather than from the README — that way the board cannot claim
# something shipped that the roadmap does not, or quietly drop a chip for
# something it does.
#
# Run by the CI hygiene job beside check-scope-ranges.sh, and by /ship-check.
# It reads the working tree and resolves SHAs against HEAD, so it works before
# a push as well as after one.
set -uo pipefail

cd "$(dirname "$0")/.."

failures=0
note() {
  echo "commit-links: $*" >&2
}
fail() {
  note "$*"
  failures=$((failures + 1))
}

BOARD=README.md
PLAN=docs/ROADMAP.md

# A shipped entry: a roadmap list item that opens with a commit number and says
# it shipped. Anchored to the list marker so that prose mentioning the word —
# "Nothing shipped was affected" in the C18/C19 ordering note — is not read as
# an entry.
SHIPPED_RE='^ *- C[0-9]+[a-z]?[,: ].*shipped'

# ---------------------------------------------------------------------------
# 1. Every SHA either file links is a commit, and an ancestor of HEAD.
#
# Well-formed is not the same as real: a transposed hex digit still matches the
# URL shape, and a SHA from an abandoned branch still resolves locally. Only
# ancestry proves the commit is on the line of history this checkout is on.
# ---------------------------------------------------------------------------
linked_shas=$(grep -ohE 'maekbeat/commit/[0-9a-f]{7,40}' "$BOARD" "$PLAN" | cut -d/ -f3 | sort -u)
if [ -z "$linked_shas" ]; then
  fail "neither $BOARD nor $PLAN links a single commit; this check would pass vacuously"
fi
for sha in $linked_shas; do
  if ! git cat-file -e "${sha}^{commit}" 2>/dev/null; then
    fail "$sha is linked but is not a commit in this repository"
  elif ! git merge-base --is-ancestor "$sha" HEAD 2>/dev/null; then
    fail "$sha is linked but is not an ancestor of HEAD"
  fi
done

# ---------------------------------------------------------------------------
# 2. Every shipped roadmap entry carries a link, bar the newest.
# ---------------------------------------------------------------------------
shipped_total=$(grep -cE "$SHIPPED_RE" "$PLAN")
if [ "$shipped_total" -eq 0 ]; then
  fail "no shipped entry matched in $PLAN; the pattern has drifted from the file"
fi

# The newest entry is the last shipped line in the file: the roadmap is written
# in plan order, and new commits are appended within their row.
newest_line=$(grep -nE "$SHIPPED_RE" "$PLAN" | tail -1 | cut -d: -f1)
newest_commit=$(sed -n "${newest_line}p" "$PLAN" | grep -oE 'C[0-9]+[a-z]?' | head -1)

unlinked=$(grep -nE "$SHIPPED_RE" "$PLAN" | grep -v 'maekbeat/commit/' | cut -d: -f1)
for line in $unlinked; do
  entry=$(sed -n "${line}p" "$PLAN" | grep -oE 'C[0-9]+[a-z]?' | head -1)
  if [ "$line" = "$newest_line" ]; then
    note "$PLAN:$line ($entry) is the newest shipped entry and may be linkless; backfill it next commit"
  else
    fail "$PLAN:$line ($entry) says shipped and carries no commit link, and is not the newest entry"
  fi
done

# ---------------------------------------------------------------------------
# 3. The board links every commit the plan calls shipped.
#
# Only the Commits column is read. The Phase and Ships columns mention commit
# numbers as prose — "application code intentionally starts at C1" — and
# demanding a link there would be demanding one for a sentence.
# ---------------------------------------------------------------------------
board_unlinked=""
while IFS= read -r row; do
  # Field 5, because a leading pipe makes field 1 empty: | Phase | Ships | Status | Commits |
  commits=$(printf '%s\n' "$row" | awk -F'|' '{print $5}')
  # Strip every markdown link, then anything left naming a commit is bare text.
  bare=$(printf '%s\n' "$commits" | sed -E 's/\[[^]]*\]\([^)]*\)//g')
  for token in $(printf '%s\n' "$bare" | grep -oE 'C[0-9]+[a-z]?' | sort -u); do
    if grep -qE "^ *- ${token}[,: ].*shipped" "$PLAN"; then
      board_unlinked="$board_unlinked $token"
    fi
  done
done < <(grep -E '^\| [0-9] — ' "$BOARD")

for token in $board_unlinked; do
  if [ "$token" = "$newest_commit" ]; then
    note "$BOARD names $token unlinked; it is the newest entry, so this is allowed once"
  else
    fail "$BOARD names $token in its Commits column with no link, and $token has shipped"
  fi
done

# Guard against the guard reading nothing: the board must have rows to read.
board_rows=$(grep -cE '^\| [0-9] — ' "$BOARD")
if [ "$board_rows" -lt 8 ]; then
  fail "read only $board_rows status rows from $BOARD; the table shape has changed"
fi

if [ "$failures" -gt 0 ]; then
  note "$failures problem(s)."
  exit 1
fi
note "$shipped_total shipped entries, $board_rows board rows, $(printf '%s\n' "$linked_shas" | wc -l | tr -d ' ') linked commits — all resolve to ancestors of HEAD."
