#!/usr/bin/env bash
# One fact, stated in three places, must not drift.
#
# Each app's shipped commit range appears in the README repository tour, in the
# README Stack table, and in the app's own README headline. They are prose, so
# nothing but this script makes them agree — and they did not: at C14 the Stack
# table still said the server ended at C11 and the web at C11, two sections below
# a tour that said C12 and C13. The board rule ("updated in the same commit as
# every scope change") covered the progress board and nothing else, which is
# exactly how one sentence goes stale while the sentence above it does not.
#
# The check is deliberately shape-sensitive. Each range is read by an anchored
# pattern, and a rewording that escapes the pattern fails the script rather than
# passing unread — a guard that silently matches nothing is the failure mode
# this whole file exists to prevent.
#
# Run by the CI hygiene job and by /ship-check. It reads the working tree.
set -uo pipefail

failures=0

note() {
  echo "scope-ranges: $*" >&2
}

# The last commit number in a "C5–C12a" or "C14" claim; empty if there is none.
last_commit() {
  printf '%s\n' "$1" | grep -oE 'C[0-9]+[a-z]?' | tail -1
}

# $1 app directory name, $2 name at the head of its tour line, $3 Stack row label
check_app() {
  app=$1
  tour_name=$2
  stack_label=$3

  # The repository tour: "<name> (… — C5–C12a)" on its own line in the code block.
  tour_line=$(grep -E "^[[:alnum:]/ ]*\<$tour_name \(.*\)$" README.md | head -1)
  tour=$(last_commit "$(printf '%s\n' "$tour_line" | grep -oE '— C[0-9]+[a-z]?(–C[0-9]+[a-z]?)?\)$')")

  # The Stack table: the range immediately after the app's own link, so a
  # "planned, C15" later in the same cell is not mistaken for a shipped range.
  stack_line=$(grep -E "^\| $stack_label +\|" README.md | head -1)
  stack=$(last_commit "$(printf '%s\n' "$stack_line" |
    grep -oE "\(apps/$app\), C[0-9]+[a-z]?(–C[0-9]+[a-z]?)?")")

  # The app's own headline: "…, C5–C12a of [docs/ROADMAP.md]…".
  headline=$(head -5 "apps/$app/README.md" |
    grep -oE 'C[0-9]+[a-z]?(–C[0-9]+[a-z]?)? of \[docs/ROADMAP')
  package=$(last_commit "$headline")

  for pair in "tour:$tour" "stack table:$stack" "apps/$app/README.md headline:$package"; do
    where=${pair%%:*}
    value=${pair#*:}
    if [ -z "$value" ]; then
      note "$app: no range found in the $where."
      note "  The wording moved out of the shape this check reads. Restore it or"
      note "  update scripts/check-scope-ranges.sh — do not leave it unchecked."
      failures=$((failures + 1))
    fi
  done

  if [ -n "$tour" ] && [ -n "$stack" ] && [ -n "$package" ]; then
    if [ "$tour" != "$stack" ] || [ "$tour" != "$package" ]; then
      note "$app: the shipped range disagrees across the README."
      note "  repository tour:               $tour"
      note "  Stack table:                   $stack"
      note "  apps/$app/README.md headline:  $package"
      failures=$((failures + 1))
    else
      echo "scope-ranges: $app ships through $tour, stated the same in all three places."
    fi
  fi
}

check_app server "server" "Server "
check_app web "web" "Web    "
check_app ios "ios" "iOS    "

if [ "$failures" -gt 0 ]; then
  note "$failures range statement(s) disagree or could not be read."
  exit 1
fi
