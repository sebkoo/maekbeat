#!/usr/bin/env bash
# Every landed row is linked, and every link points at real ancestors.
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
# ONE CHIP PER ROW, NEVER ONE PER COMMIT (docs/ROADMAP.md, "What a row is").
# A row that is one commit gets a commit link. A row that holds several gets a
# compare link across its range, and then this script checks the range rather
# than trusting it: every commit the roadmap lists under that row must be inside
# it, and no other row's commit may be. A range can be wrong by being too narrow
# — quietly dropping the last commits of a row — as easily as by pointing
# somewhere else entirely, and neither shows on the rendered page.
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
# An entry's OWN link, which is the one right after the word: "— shipped [sha]".
# Not just any commit link on the line — several entries link neighbouring
# commits inline in their prose, and testing for those would call an entry
# linked because it mentions somebody else's hash.
OWN_LINK_RE='shipped \[[0-9a-f]{7,40}\]'

# ---------------------------------------------------------------------------
# 1. Every SHA either file links is a commit, and an ancestor of HEAD.
#
# Well-formed is not the same as real: a transposed hex digit still matches the
# URL shape, and a SHA from an abandoned branch still resolves locally. Only
# ancestry proves the commit is on the line of history this checkout is on.
# Both halves of a compare link are collected here, so a broken range end is
# caught by exactly the same test as a broken commit chip.
# ---------------------------------------------------------------------------
commit_links=$(grep -ohE 'maekbeat/commit/[0-9a-f]{7,40}' "$BOARD" "$PLAN" | cut -d/ -f3)
compare_links=$(grep -ohE 'maekbeat/compare/[0-9a-f]{7,40}\.\.\.[0-9a-f]{7,40}' "$BOARD" "$PLAN" | cut -d/ -f3)
compare_shas=$(printf '%s\n' "$compare_links" | sed 's/\.\.\./ /' | tr ' ' '\n' | grep -E '^[0-9a-f]{7,40}$')
linked_shas=$(printf '%s\n%s\n' "$commit_links" "$compare_shas" | grep -E '^[0-9a-f]{7,40}$' | sort -u)

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
# 2. Every compare range runs forwards and spans something.
#
# base...head with the two reversed renders a page, resolves both SHAs, and
# passes every ancestry test above while showing no commits at all. Ordering is
# the only thing that distinguishes it.
# ---------------------------------------------------------------------------
for range in $compare_links; do
  base=${range%%...*}
  head=${range##*...}
  git cat-file -e "${base}^{commit}" 2>/dev/null && git cat-file -e "${head}^{commit}" 2>/dev/null || continue
  if ! git merge-base --is-ancestor "$base" "$head" 2>/dev/null; then
    fail "compare range $base...$head runs backwards; $base is not an ancestor of $head"
  elif [ "$(git rev-parse "$base")" = "$(git rev-parse "$head")" ]; then
    fail "compare range $base...$head is empty; both ends are the same commit"
  fi
done

# ---------------------------------------------------------------------------
# 3. Every shipped roadmap entry carries a link, bar the newest.
# ---------------------------------------------------------------------------
shipped_total=$(grep -cE "$SHIPPED_RE" "$PLAN")
if [ "$shipped_total" -eq 0 ]; then
  fail "no shipped entry matched in $PLAN; the pattern has drifted from the file"
fi

# The newest entry is the last shipped line in the file: the roadmap is written
# in plan order, and new commits are appended within their row.
newest_line=$(grep -nE "$SHIPPED_RE" "$PLAN" | tail -1 | cut -d: -f1)
newest_commit=$(sed -n "${newest_line}p" "$PLAN" | grep -oE 'C[0-9]+[a-z]?' | head -1)

# The board's exemption is narrower than the roadmap's, and the difference is
# the whole reason the lag exists. A row goes linkless for exactly one commit
# because that commit cannot contain its own hash. The moment the roadmap entry
# carries a link, the hash is known and the board has no excuse left — so the
# board is exempt only while the newest roadmap entry is itself linkless.
#
# Written the obvious way, this was a hole: with C19 both the newest row and a
# row eleven linked commits deep, deleting its chip from the board passed,
# because "the newest row may be linkless" matched a row that had been landed
# for days. Caught by mutation, not by reading.
if sed -n "${newest_line}p" "$PLAN" | grep -qE "$OWN_LINK_RE"; then
  board_exempt=""
else
  board_exempt="$newest_commit"
fi

unlinked=$(grep -nE "$SHIPPED_RE" "$PLAN" | grep -vE "$OWN_LINK_RE" | cut -d: -f1)
for line in $unlinked; do
  entry=$(sed -n "${line}p" "$PLAN" | grep -oE 'C[0-9]+[a-z]?' | head -1)
  if [ "$line" = "$newest_line" ]; then
    note "$PLAN:$line ($entry) is the newest shipped entry and may be linkless; backfill it next commit"
  else
    fail "$PLAN:$line ($entry) says shipped and carries no commit link, and is not the newest entry"
  fi
done

# ---------------------------------------------------------------------------
# 4. The board names no shipped row outside a link, and every compare range it
#    uses covers exactly the row it claims to.
#
# Only the Commits column is read. The Phase and Ships columns mention commit
# numbers as prose — "application code intentionally starts at C1" — and
# demanding a link there would be demanding one for a sentence.
# ---------------------------------------------------------------------------
board_unlinked=""
board_rows=0
chip_tokens=""
COVERED=$(mktemp -d)
trap 'rm -rf "$COVERED"' EXIT
while IFS= read -r row; do
  board_rows=$((board_rows + 1))
  # Field 5, because a leading pipe makes field 1 empty: | Phase | Ships | Status | Commits |
  commits=$(printf '%s\n' "$row" | awk -F'|' '{print $5}')

  # 4a. Strip every markdown link; anything left naming a shipped row is a chip
  #     somebody wrote as plain text.
  bare=$(printf '%s\n' "$commits" | sed -E 's/\[[^]]*\]\([^)]*\)//g')
  for token in $(printf '%s\n' "$bare" | grep -oE 'C[0-9]+[a-z]?' | sort -u); do
    if grep -qE "^ *- ${token}[,: ].*shipped" "$PLAN"; then
      board_unlinked="$board_unlinked $token"
    fi
  done

  # 4b. Each compare chip must span its row exactly. The label has to name the
  #     row, because otherwise there is nothing to check the range against —
  #     an unlabelled range is the exemption this whole section exists to deny.
  while IFS= read -r chip; do
    [ -n "$chip" ] || continue
    label=$(printf '%s' "$chip" | sed -E 's/^\[([^]]*)\].*/\1/')
    range=$(printf '%s' "$chip" | sed -E 's|.*compare/([0-9a-f]+\.\.\.[0-9a-f]+)\).*|\1|')
    token=$(printf '%s' "$label" | grep -oE 'C[0-9]+[a-z]?' | head -1)
    base=${range%%...*}
    head=${range##*...}
    if [ -z "$token" ]; then
      fail "$BOARD has a compare chip labelled \"$label\" naming no roadmap row, so nothing can check what it covers"
      continue
    fi
    git cat-file -e "${base}^{commit}" 2>/dev/null && git cat-file -e "${head}^{commit}" 2>/dev/null || continue
    git merge-base --is-ancestor "$base" "$head" 2>/dev/null || continue
    inside=$(git rev-list "$base..$head")

    # Banked for the coverage check below, which is done once per row against
    # the union of its chips rather than once per chip. See the block after the
    # board loop for why a row may need more than one range.
    printf '%s\n' "$inside" >>"$COVERED/$token"
    case " $chip_tokens " in
      *" $token "*) ;;
      *) chip_tokens="$chip_tokens $token" ;;
    esac

    # Not too wide: no other row's own commit may fall inside the range. This
    # stays per-range and is the half that keeps a second chip from being a
    # licence to span anything — a row with two chips still may not reach across
    # another row's commit with either of them.
    while IFS= read -r entry; do
      other=$(printf '%s' "$entry" | grep -oE 'C[0-9]+[a-z]?' | head -1)
      [ "$other" = "$token" ] && continue
      sha=$(printf '%s' "$entry" | grep -ohE 'maekbeat/commit/[0-9a-f]{7,40}' | head -1 | cut -d/ -f3)
      [ -n "$sha" ] || continue
      full=$(git rev-parse "$sha" 2>/dev/null) || continue
      printf '%s\n' "$inside" | grep -q "^${full}$" &&
        fail "$BOARD spans $token as $range, which also swallows $other ($sha) — that row has its own chip"
    done < <(grep -E "$SHIPPED_RE" "$PLAN")
  done < <(printf '%s\n' "$commits" | grep -oE '\[[^]]*\]\([^)]*compare/[0-9a-f]{7,40}\.\.\.[0-9a-f]{7,40}\)')
done < <(grep -E '^\| [0-9] — ' "$BOARD")

# Not too narrow, checked once per row against the union of that row's compare
# chips rather than once per chip.
#
# It was written per-chip, on the assumption that a row occupies one contiguous
# stretch of history. C19 broke the assumption rather than the rule: the row was
# left open, C20 and C20a shipped, and then the row's CI work landed after them
# — so its commits sit on both sides of two other rows and no single range can
# hold them all without swallowing both. Splitting the chip is the honest
# description of what happened; widening one range would be a claim that C20 and
# C20a belong to C19.
#
# What is NOT relaxed is the anti-swallowing check above, which still binds each
# range on its own. So two chips buy a row exactly one thing: the right to skip
# over another row's commits, and nothing else. The board rule in README.md is
# unchanged in substance — one chip per row, never one per commit — and now
# reads "one chip per contiguous span".
for token in $chip_tokens; do
  for sha in $(grep -E "^ *- ${token}[,: ]" "$PLAN" | grep -ohE 'maekbeat/commit/[0-9a-f]{7,40}' | cut -d/ -f3 | sort -u); do
    full=$(git rev-parse "$sha" 2>/dev/null) || continue
    grep -q "^${full}$" "$COVERED/$token" 2>/dev/null ||
      fail "$BOARD's compare chip(s) for $token do not cover $sha — the roadmap lists it under $token"
  done
done

for token in $board_unlinked; do
  if [ -n "$board_exempt" ] && [ "$token" = "$board_exempt" ]; then
    note "$BOARD names $token unlinked; its roadmap entry is linkless too, so this is the one allowed lag"
  else
    fail "$BOARD names $token in its Commits column with no link, and $token has shipped"
  fi
done

# Guard against the guard reading nothing: the board must have rows to read.
if [ "$board_rows" -lt 8 ]; then
  fail "read only $board_rows status rows from $BOARD; the table shape has changed"
fi

if [ "$failures" -gt 0 ]; then
  note "$failures problem(s)."
  exit 1
fi
note "$shipped_total shipped entries, $board_rows board rows, $(printf '%s\n' "$linked_shas" | wc -l | tr -d ' ') linked commits, $(printf '%s\n' "$compare_links" | grep -c .) compare range(s) — all resolve to ancestors of HEAD."
