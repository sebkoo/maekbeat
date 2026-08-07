#!/usr/bin/env bash
# A hazard row is a claim that something is under control. This checks the claim.
#
# docs/regulatory/hazard-analysis.md names, for each hazard, the test that
# demonstrates its control. Every regulatory document ever written rots for the
# same reason: nothing connects it to the system it describes, so the system
# moves and the document keeps saying what used to be true. A row citing a test
# that was renamed, deleted or parked reads exactly like a row citing one that
# runs on every push.
#
# So the citation is machine-checked. This script fails when a row cites nothing,
# when a cited file does not exist, when the cited test is not in it, or when the
# cited file contains a skip. It is the reason C20 is engineering rather than
# paperwork, and it is the only thing standing between the hazard table and the
# usual fate of hazard tables.
#
# Citation format, one per backtick span inside a row:
#
#     `apps/server/src/stream.heartbeat.test.ts::pings an idle subscriber, ...`
#
# path, then `::`, then the test title exactly as the suite declares it. One
# format for both languages; the file extension decides how the title is read.
#
# Run by the CI hygiene job and by /ship-check. It reads the working tree.
set -uo pipefail

DOC=docs/regulatory/hazard-analysis.md

failures=0
rows=0
citations=0

note() {
  echo "hazard-tests: $*" >&2
}

fail() {
  note "$*"
  failures=$((failures + 1))
}

if [ ! -f "$DOC" ]; then
  note "$DOC does not exist."
  exit 1
fi

# A row is `| H<n> |`. Everything else that looks like a table line is either the
# header, the separator, or drift — and drift is the failure this file exists to
# catch, so it is named rather than skipped. That also means the document holds
# exactly one table: a second one would be a set of rows nothing checks, which is
# the same rot arriving by a different door.
# Whitespace-tolerant because the cell padding is Prettier's to decide, and a
# guard that a formatter can turn red is a guard people delete.
ROW_RE='^\|[[:space:]]*H[0-9]+[[:space:]]*\|'
HEADER_RE='^\|[[:space:]]*ID[[:space:]]*\|'
SEPARATOR_RE='^\|[[:space:]-]+\|'

# What "skipped" looks like, per language. Anchored at the start of a statement
# so that `stopAndAwaitExit(` and `process.exit(0)` are not read as `xit(` — an
# unanchored pattern matched both, and a guard that fires on a passing test gets
# switched off.
#
# `.only` is here despite not being a skip: it makes every OTHER test in the run
# skip, so a cited test sitting beside one is not running either.
TS_SKIP_RE='^[[:space:]]*(it|test|describe|suite|context)(\.[A-Za-z]+)*\.(skip|only|todo|fixme|failing)\(|^[[:space:]]*(xit|xdescribe|xtest)\('
SWIFT_SKIP_RE='XCTSkip|\.disabled\('

while IFS= read -r line; do
  case $line in
  '|'*) ;;
  *) continue ;;
  esac

  if printf '%s\n' "$line" | grep -qE "$HEADER_RE"; then continue; fi
  if printf '%s\n' "$line" | grep -qE "$SEPARATOR_RE"; then continue; fi

  if ! printf '%s\n' "$line" | grep -qE "$ROW_RE"; then
    fail "a table line in $DOC is not a hazard row and is not the header:"
    note "  ${line:0:72}..."
    note "  Either it is a second table — every hazard belongs in the one this"
    note "  script reads — or the row shape moved out from under $ROW_RE."
    continue
  fi

  rows=$((rows + 1))
  id=$(printf '%s\n' "$line" | grep -oE 'H[0-9]+' | head -1)

  # Backtick spans containing `::`. A row's prose may hold other backtick spans
  # (a path, an env var); only the ones with the separator are citations.
  # shellcheck disable=SC2016  # the backticks are markdown, not substitution
  cites=$(printf '%s\n' "$line" | grep -oE '`[^`]+::[^`]+`' | tr -d '`')

  if [ -z "$cites" ]; then
    fail "$id cites no test."
    note "  A control nothing demonstrates is an intention. Cite the test that"
    note "  proves it, as \`path::test title\`, or say in the row that none exists."
    continue
  fi

  while IFS= read -r cite; do
    [ -z "$cite" ] && continue
    citations=$((citations + 1))
    path=${cite%%::*}
    title=${cite#*::}

    if [ ! -f "$path" ]; then
      fail "$id cites $path, which does not exist."
      continue
    fi

    case $path in
    *.swift)
      needle="func $title("
      decl_re='^[[:space:]]*([A-Za-z@][A-Za-z0-9_@.()]*[[:space:]]+)*func[[:space:]]'
      skip_re=$SWIFT_SKIP_RE
      shape="func $title(...)"
      ;;
    *)
      needle="\"$title\""
      decl_re='^[[:space:]]*(it|test)(\.[A-Za-z]+)*\('
      skip_re=$TS_SKIP_RE
      shape="it(\"$title\", ...)"
      ;;
    esac

    # Two greps rather than one. -F finds the title as the literal text it is,
    # parentheses and em dashes and apostrophes included, without asking anyone
    # to escape a sentence into a regex. Then the lines it found must include a
    # declaration — otherwise the title quoted in a comment, or named in the
    # prose of a different test, would satisfy the citation.
    if ! grep -F -- "$needle" "$path" | grep -qE "$decl_re"; then
      fail "$id cites a test $path does not declare:"
      note "  looked for: $shape"
      note "  The test was renamed, moved or deleted, and the row still claims it."
      continue
    fi

    # Deliberately whole-file: any skip in the cited file fails the citation,
    # rather than only a skip provably enclosing the cited test. Tracking which
    # describe block encloses which test needs a parser, and the conservative
    # rule costs nothing real — the fix is to cite a file whose tests all run.
    # It errs toward false alarm, never toward a silent pass.
    if grep -qE "$skip_re" "$path"; then
      offender=$(grep -nE "$skip_re" "$path" | head -1)
      fail "$id cites $path, which contains a skipped or exclusive test:"
      note "  $offender"
      note "  A skipped test proves nothing, and this check does not try to work"
      note "  out whether the skip covers the cited test. Cite a file with none."
      continue
    fi
  done <<EOF
$cites
EOF
done <"$DOC"

if [ "$rows" -eq 0 ]; then
  fail "no hazard rows found in $DOC."
  note "  Either the table is gone, or $ROW_RE no longer matches it. A check that"
  note "  reads nothing reports success, which is the worst thing this could do."
fi

if [ "$failures" -gt 0 ]; then
  note "$failures problem(s) across $rows row(s)."
  exit 1
fi

echo "hazard-tests: $rows hazard rows, $citations cited tests, all present and running."
