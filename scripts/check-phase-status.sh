#!/usr/bin/env bash
# The phase status marker, in the one place that decides it and everywhere it is
# repeated.
#
# Phase 6 sat at "(in progress)" on the roadmap and unchecked on the README board
# for the whole of the row's twelfth commit and the one that closed it, while the
# row itself read "C19, closed." and every bullet under it said "shipped". Nothing
# noticed, and the reason is worth stating: the only occurrence of "Status" in any
# other scripts/check-*.sh is a comment in check-commit-links.sh naming the field
# to SKIP on the way to the Commits column. Every claim beside the status is
# verified. The status is not.
#
# What is NOT derivable, stated first so the guard is not mistaken for more than
# it is: whether a phase is finished. C19 closed because somebody decided to cut
# dashboards-as-code (docs/DECISIONS.md #32), and no arrangement of git history
# says that. "Every bullet shipped" is not the rule either — Phase 7's C20 and
# C20a both say shipped while the phase is genuinely open.
#
# So the judgement stays human and lives in exactly one place, the roadmap
# heading, and two rules hold everything else to it:
#
#   R1  The README board's Status cell agrees with that phase's roadmap heading.
#       The heading is the source; the board is propagated. Fails both ways.
#   R2  A phase whose heading says complete has no roadmap row lacking a
#       "shipped [sha]".
#
# R1 on its own would be two hand-written values agreeing with each other, which
# is the shape infra/compose-smoke.sh was fixed for in C19's tenth commit — three
# places agreed because one value was fed to all three. R2 is the half anchored
# in something nobody writing the status chose: the shas, already checked against
# real commits by scripts/check-commit-links.sh.
#
# A row is grouped by its C identifier rather than by list nesting, so a
# phase-sized row states its shas on its own sub-bullets (C19) exactly as a
# one-commit row states it on itself (C18). Both satisfy R2; neither is exempt.
#
# Reading nothing is a failure here, not a pass. scripts/check-commit-hygiene.sh
# line 18 pipes `git log ... || true` into grep, so a broken git log yields an
# empty stream and a green guard; this script exits 1 when it cannot find the
# board, the headings, a marker, or a row.
#
# Run by the CI hygiene job and by /ship-check. It reads the working tree.
set -uo pipefail

readme=README.md
roadmap=docs/ROADMAP.md
failures=0

note() {
  echo "phase-status: $*" >&2
}

for file in "$readme" "$roadmap"; do
  if [ ! -f "$file" ]; then
    note "$file is missing. This guard reads it; it cannot pass without it."
    exit 1
  fi
done

# --- The README progress board -------------------------------------------------
# Keyed on the section heading, not on the word "Status": the design-notes table
# higher up the README has a Status column too, and matching that one instead
# would check the wrong claim while looking identical.
board_start=$(grep -nE '^## Status$' "$readme" | head -1 | cut -d: -f1)
if [ -z "$board_start" ]; then
  note "no '## Status' heading in $readme."
  note "  That heading is how this guard finds the progress board. If the board"
  note "  moved or was renamed, point this script at it — do not leave the"
  note "  repository's front-page claim unread."
  exit 1
fi
board_end=$(awk -v s="$board_start" 'NR > s && /^## /{ print NR; exit }' "$readme")
if [ -z "$board_end" ]; then
  board_end=$(($(wc -l < "$readme") + 1))
fi

board_rows=$(awk -v s="$board_start" -v e="$board_end" 'NR > s && NR < e' "$readme" |
  grep -E '^\| [0-9]+ — ')
if [ -z "$board_rows" ]; then
  note "the '## Status' section holds no phase rows."
  note "  Expected lines shaped '| 6 — Infra & operations | … | ✅ | … |'."
  note "  The table changed shape; update this script rather than losing the check."
  exit 1
fi

# --- The roadmap headings, the single source -----------------------------------
headings=$(grep -nE '^## Phase [0-9]+ — ' "$roadmap")
if [ -z "$headings" ]; then
  note "no '## Phase N — …' headings in $roadmap."
  note "  Those headings are the source this guard propagates from."
  exit 1
fi

board_numbers=$(printf '%s\n' "$board_rows" | sed -E 's/^\| ([0-9]+) —.*/\1/' | sort -n)
roadmap_numbers=$(printf '%s\n' "$headings" | sed -E 's/^[0-9]+:## Phase ([0-9]+) —.*/\1/' | sort -n)

if [ "$board_numbers" != "$roadmap_numbers" ]; then
  note "the board and the roadmap do not list the same phases."
  note "  board:   $(printf '%s' "$board_numbers" | tr '\n' ' ')"
  note "  roadmap: $(printf '%s' "$roadmap_numbers" | tr '\n' ' ')"
  exit 1
fi

total=$(printf '%s\n' "$roadmap_numbers" | wc -l | tr -d ' ')

while IFS= read -r heading; do
  line_no=${heading%%:*}
  text=${heading#*:}
  number=$(printf '%s' "$text" | sed -E 's/^## Phase ([0-9]+) —.*/\1/')

  # "(complete)" / "(in progress)" / "(planned)" — anything else is unreadable
  # rather than assumed complete.
  marker=''
  case "$text" in
    *'(complete)') marker=complete ;;
    *'(in progress)') marker=open ;;
    *'(planned)') marker=open ;;
  esac
  if [ -z "$marker" ]; then
    note "phase $number's heading carries no status marker."
    note "  $text"
    note "  Expected a trailing (complete), (in progress) or (planned). The"
    note "  heading is the single source; an unmarked one decides nothing."
    failures=$((failures + 1))
    continue
  fi

  # --- R1: the board agrees with the heading ----------------------------------
  row=$(printf '%s\n' "$board_rows" | grep -E "^\| $number — " | head -1)
  mark=$(printf '%s' "$row" | cut -d'|' -f4 | tr -d ' ')
  case "$mark" in
    '✅') board_says=complete ;;
    '⬜') board_says=open ;;
    *)
      note "phase $number's board cell reads '$mark', which is neither ✅ nor ⬜."
      failures=$((failures + 1))
      continue
      ;;
  esac

  if [ "$marker" != "$board_says" ]; then
    note "phase $number disagrees with itself."
    note "  $roadmap heading: $marker"
    note "  $readme board:    $board_says ($mark)"
    note "  The heading decides. Propagate it to the board, or change the heading"
    note "  if the judgement itself changed."
    failures=$((failures + 1))
    continue
  fi

  # --- R2: a complete phase has shipped every row it lists --------------------
  if [ "$marker" != complete ]; then
    echo "phase-status: phase $number open, stated the same in both places."
    continue
  fi

  next=$(awk -v s="$line_no" 'NR > s && /^## /{ print NR; exit }' "$roadmap")
  if [ -z "$next" ]; then
    next=$(($(wc -l < "$roadmap") + 1))
  fi
  body=$(awk -v s="$line_no" -v e="$next" 'NR > s && NR < e' "$roadmap")

  ids=$(printf '%s\n' "$body" | grep -oE '^[[:space:]]*- C[0-9]+[a-z]?' |
    grep -oE 'C[0-9]+[a-z]?' | sort -u)
  if [ -z "$ids" ]; then
    note "phase $number says complete but lists no C-numbered rows at all."
    note "  A complete phase with nothing under it is a heading this guard"
    note "  cannot check, which is a failure and not a pass."
    failures=$((failures + 1))
    continue
  fi

  unshipped=''
  for id in $ids; do
    if ! printf '%s\n' "$body" | grep -E "^[[:space:]]*- $id\b" | grep -q 'shipped \['; then
      unshipped="$unshipped $id"
    fi
  done

  if [ -n "$unshipped" ]; then
    note "phase $number says complete, but these rows carry no shipped sha:$unshipped"
    note "  A row is satisfied by a 'shipped [sha]' on its own bullet or on any"
    note "  sub-bullet sharing its C number, which is how a phase-sized row like"
    note "  C19 states its commits. None of these has one anywhere."
    failures=$((failures + 1))
    continue
  fi

  echo "phase-status: phase $number complete, every row shipped, board agrees."
done <<EOF
$headings
EOF

if [ "$failures" -gt 0 ]; then
  note "$failures of $total phase status claim(s) disagree or could not be read."
  exit 1
fi
