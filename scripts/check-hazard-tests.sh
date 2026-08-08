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

# Two documents now, and the second one is why this file changed at C21.
#
# docs/regulatory/risk-register.md marks a row `demonstrated` partly on the
# grounds that a test demonstrates the control AND that this script checks the
# citation. That was false for the register's own rows while this script read
# only the hazard analysis: the two hazards the register adds cited tests that
# nothing verified. A criterion that asserts its own enforcement has to be
# enforced, so the guard reads both files rather than the claim being softened.
#
# The two are read differently, because they are shaped differently. The hazard
# analysis is one table and every table line in the file must be a row — a
# second table there would be hazards nothing checks. The register also carries
# legend tables for its severity and reachability scales, which are not rows and
# must not be read as drift, so its checked region is delimited explicitly and
# everything outside it is ignored.
DOC_HAZARDS=docs/regulatory/hazard-analysis.md
DOC_REGISTER=docs/regulatory/risk-register.md
REGISTER_OPEN='<!-- register:rows -->'
REGISTER_CLOSE='<!-- /register:rows -->'

failures=0
rows=0
citations=0
uncontrolled=0
DOC=""

note() {
  echo "hazard-tests: $*" >&2
}

fail() {
  note "$*"
  failures=$((failures + 1))
}

for f in "$DOC_HAZARDS" "$DOC_REGISTER"; do
  if [ ! -f "$f" ]; then
    note "$f does not exist."
    exit 1
  fi
done

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

check_lines() {
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
    # This branch used to fail unconditionally, while the message below offered
    # "or say in the row that none exists" — an option the code did not
    # implement. The gap had a consequence worth more than the inconsistency: a
    # hazard with no control at all COULD NOT BE RECORDED in a checked table,
    # so the only hazards these documents could hold were ones already fixed.
    # That is a table biased toward good news by its own guard.
    #
    # The sentinel makes an absent control sayable and still machine-read. It is
    # deliberately not a free pass: it must state what is missing, it is counted
    # and reported separately, and a row carrying it can never read
    # `demonstrated` in the register, because C1 and C2 are exactly what it
    # declares it does not have. Found writing the battery row at C21.
    if printf '%s\n' "$line" | grep -qE '`no-control:[^`]+`'; then
      uncontrolled=$((uncontrolled + 1))
      continue
    fi
    fail "$id names no recognised citation form."
    note "  Exactly two forms are accepted: \`path::test title\`, or"
    note "  \`no-control: <what is missing>\`. This row has neither."
    # The backtick spans that ARE present, because the usual cause is a typo in
    # one of the two forms and naming what was found is the difference between
    # a five-second fix and a hunt.
    stray=$(printf '%s\n' "$line" | grep -oE '`[^`]+`' | tr -d '`' | head -3)
    if [ -n "$stray" ]; then
      note "  Backtick spans found in this row, none of them a citation:"
      while IFS= read -r s; do
        [ -n "$s" ] && note "    $s"
      done <<EOF
$stray
EOF
    fi
    continue
  fi

  # Both forms in one row. `cites` is tested first, so before this branch
  # existed a row could carry a resolvable citation AND declare no control, and
  # the contradiction passed as controlled — the sentinel was simply never
  # reached. A row must claim one thing about itself.
  if printf '%s\n' "$line" | grep -qE '`no-control:[^`]+`'; then
    fail "$id both cites a test and declares no control."
    note "  These are mutually exclusive claims and this row makes both. Drop"
    note "  whichever is untrue; if a partial control exists, cite it and put"
    note "  what it does not reach in the row's own residual text."
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
  done
}

# The hazard analysis, whole: every table line in the file is subject to the
# rules above.
DOC=$DOC_HAZARDS
before=$rows
check_lines <"$DOC_HAZARDS"
if [ "$rows" -eq "$before" ]; then
  fail "no hazard rows found in $DOC_HAZARDS."
  note "  Either the table is gone, or $ROW_RE no longer matches it. A check that"
  note "  reads nothing reports success, which is the worst thing this could do."
fi

# The register, delimited: only what sits between the markers. Their absence is
# a failure rather than an empty read, for the same reason — a checked region
# that cannot be found is a check that silently stops happening.
DOC=$DOC_REGISTER
if ! grep -qF "$REGISTER_OPEN" "$DOC_REGISTER" || ! grep -qF "$REGISTER_CLOSE" "$DOC_REGISTER"; then
  fail "$DOC_REGISTER is missing its $REGISTER_OPEN / $REGISTER_CLOSE markers."
  note "  The register's row table is delimited so its severity and reachability"
  note "  legends are not read as rows. Without the markers nothing is checked."
else
  before=$rows
  # Process substitution, not a pipe: `awk ... | check_lines` would run the
  # function in a subshell and every failure and count it recorded would be
  # discarded on exit, so the register would appear to pass by not being read.
  # `close` is an awk builtin and cannot be a variable name; awk says so by
  # refusing to parse, which is how this was found rather than by it silently
  # reading nothing.
  check_lines < <(awk -v mopen="$REGISTER_OPEN" -v mclose="$REGISTER_CLOSE" '
    index($0, mclose) { inside = 0; next }
    index($0, mopen)  { inside = 1; next }
    inside            { print }
  ' "$DOC_REGISTER")
  if [ "$rows" -eq "$before" ]; then
    fail "no register rows found between the markers in $DOC_REGISTER."
    note "  The markers are present and the region between them holds no row."
  fi
fi

# ---------------------------------------------------------------------------
# The cross-check: the two documents name the same hazards, by the same names.
#
# Both files carry an ID column and a hazard-label column for H1 to H8. That is
# one fact in two tables, which is the drift risk scripts/check-scope-ranges.sh
# exists for, and the register's own header used to warn about it while doing
# it. The duplication is kept — a register that named only IDs would be
# unreadable — so it is checked instead.
#
# Three assertions, and the direction of each matters:
#   - every hazard in the analysis has a row in the register. A hazard nobody
#     scored is the gap this register was written to close.
#   - every register row is either a hazard from the analysis or is explicitly
#     marked `register-only`. Otherwise a row invented here would look scored
#     while sitting in no hazard table.
#   - for a shared ID, the two label cells are byte-identical. A label edited on
#     one side and not the other is exactly the drift-with-a-delay that
#     motivated this.
# ---------------------------------------------------------------------------
labels_of() { # file, then optionally the marker-delimited region
  if [ "$1" = "$DOC_REGISTER" ]; then
    awk -v mopen="$REGISTER_OPEN" -v mclose="$REGISTER_CLOSE" '
      index($0, mclose) { inside = 0; next }
      index($0, mopen)  { inside = 1; next }
      inside            { print }
    ' "$1"
  else
    cat "$1"
  fi | grep -E '^\|[[:space:]]*H[0-9]+[[:space:]]*\|' |
    awk -F'|' '{ id = $2; lab = $3
                 gsub(/^[ \t]+|[ \t]+$/, "", id); gsub(/^[ \t]+|[ \t]+$/, "", lab)
                 print id "\t" lab }'
}

hz_labels=$(labels_of "$DOC_HAZARDS")
rg_labels=$(labels_of "$DOC_REGISTER")

while IFS=$'\t' read -r id lab; do
  [ -z "$id" ] && continue
  rg_lab=$(printf '%s\n' "$rg_labels" | awk -F'\t' -v want="$id" '$1 == want { print $2; exit }')
  if [ -z "$rg_lab" ]; then
    fail "$id is in $DOC_HAZARDS and has no row in $DOC_REGISTER."
    note "  Every hazard is scored by the register; this one is not."
    continue
  fi
  if [ "$lab" != "$rg_lab" ]; then
    fail "$id is labelled differently in the two documents:"
    note "  hazards:  $lab"
    note "  register: $rg_lab"
    note "  One was edited and the other was not. They are the same hazard."
  fi
done <<EOF
$hz_labels
EOF

while IFS=$'\t' read -r id lab; do
  [ -z "$id" ] && continue
  if ! printf '%s\n' "$hz_labels" | awk -F'\t' -v want="$id" '$1 == want { found = 1 } END { exit !found }'; then
    if ! awk -v mopen="$REGISTER_OPEN" -v mclose="$REGISTER_CLOSE" '
           index($0, mclose) { inside = 0; next }
           index($0, mopen)  { inside = 1; next }
           inside            { print }
         ' "$DOC_REGISTER" | grep -E "^\|[[:space:]]*$id[[:space:]]*\|" | grep -q 'register-only'; then
      fail "$id is in $DOC_REGISTER, is in no hazard table, and is not marked register-only."
      note "  A row scored here but identified nowhere. Either add it to"
      note "  $DOC_HAZARDS, or say \`register-only\` in the row."
    fi
  fi
done <<EOF
$rg_labels
EOF

if [ "$failures" -gt 0 ]; then
  note "$failures problem(s) across $rows row(s)."
  exit 1
fi

summary="hazard-tests: $rows rows across two documents, $citations cited tests, all present and running"
if [ "$uncontrolled" -gt 0 ]; then
  summary="$summary; $uncontrolled row(s) declare no control"
fi
echo "$summary."
