#!/usr/bin/env bash
# A data-flow diagram is a claim about where the code is. This checks the claim,
# in both directions across the diagram's edge:
#
#   OUT  every element and boundary in docs/security/data-flow.md cites a path,
#        and every one of those paths must exist on disk.
#   IN   every B<n> and E<n> that docs/security/threat-model.md cites must be an
#        id the diagram declares.
#
# The name says only the first half. That is a naming choice explained at the
# bottom of this header, not a hidden capability — a reader grepping for the
# threat-model check should find it here, so it is stated in the second sentence
# rather than forty lines down.
#
# docs/security/data-flow.md names, for every element it draws and every
# boundary the data crosses, the path that implements it. A diagram is the
# artifact that rots most quietly of all: a box labelled with a module that was
# renamed six commits ago renders exactly like a box labelled with one that
# exists, and no reader can tell them apart. So the labels are machine-checked.
#
# WHAT THIS CATCHES: a renamed, moved or deleted module. If
# apps/server/src/silence.ts moves, E7 stops resolving and the build fails.
#
# WHAT IT DOES NOT CATCH, stated beside the guard rather than left to be
# assumed: a diagram describing the wrong flow through a file that still exists.
# Draw the alert engine writing to the decision log, or put a trust boundary in
# the wrong place, and every path still resolves. Whether the arrows are true
# stays human — the same division scripts/check-hazard-tests.sh makes when it
# checks that a citation resolves and leaves the adequacy of the control alone.
#
# WHY IT READS TABLES AND NOT PROSE, which is the design decision worth
# recording. The general form — assert that every backticked path-shaped token
# in docs/regulatory/ resolves — was measured before this was written: 22 of 100
# citations fail, and almost none is an error. `.swift` and `.md` are used as
# nouns, `/ship-check` is a slash command, `actions/cache` and `grafana/k6` are
# SOUP identifiers rather than paths, `webstore.iec.ch/en/publication/22794` is
# a URL, and `apps/ios/.../BLE/LinkState.swift` is deliberately elided. A guard
# that fails 22 times on its first run is one somebody switches off inside a
# week. So the assertion is made where a path is a path BY DECLARATION — inside
# a marked table whose column means that — instead of being inferred from shape.
#
# The marker pattern is the third use of the same idea in this repository, after
# scripts/check-soup-inventory.sh and the register region in
# scripts/check-hazard-tests.sh. It is a separate script rather than a fourth
# branch inside one of those because the assertion is different in kind: those
# resolve a citation to a declared test, this resolves a label to a file on
# disk. Folding it into a script whose name and header are about hazard tests
# would leave a reader of either one unsure which rules apply.
#
# SINCE C22 IT ALSO CHECKS REFERENCES INTO THE DIAGRAM, not only out of it.
# docs/security/threat-model.md cites the B<n> and E<n> each threat concerns,
# and a threat pointing at a boundary that was renamed or removed is how that
# document rots first — the diagram is the thing that moves under it.
#
# That is an extension rather than a tenth script, and the test is the one used
# to split this file off from check-hazard-tests.sh: is the assertion the same
# KIND? It is. Both halves read a marked table, take a declared label, and
# assert it resolves to something — a file on disk for the elements, a declared
# id for the threats. check-hazard-tests.sh resolves a citation to a test that
# RUNS, which is a different question and stays where it is. Adding a script to
# keep the shapes symmetrical would be symmetry, not necessity.
#
# The name understates the job and is kept anyway: renaming one commit after
# creation would churn ci.yml, ship-check.md and the mutation log to buy a
# better word, and the subject is still the diagram — what changed is that both
# directions across its boundary are checked.
#
# Run by the CI hygiene job and by /ship-check. It reads the working tree.
set -uo pipefail

cd "$(dirname "$0")/.."

DOC=docs/security/data-flow.md
THREATS=docs/security/threat-model.md
SECTIONS="elements boundaries"

failures=0
checked=0

note() { echo "dataflow-paths: $*" >&2; }
fail() {
  note "$*"
  failures=$((failures + 1))
}

if [ ! -f "$DOC" ]; then
  note "$DOC does not exist."
  exit 1
fi

# Every backticked span inside a marked region, in row order. A row's cells may
# hold more than one path — an element implemented at one path and served by
# another — so all of them are read rather than only the first.
paths_in() {
  awk -v want="$1" '
    $0 ~ ("^<!-- /dfd:" want " -->$") { inside = 0; next }
    $0 ~ ("^<!-- dfd:" want " -->$")  { inside = 1; next }
    inside && /^\|/ { print }
  ' "$DOC" | grep -ohE '`[^`]+`' | tr -d '`' | sort -u
}

for section in $SECTIONS; do
  if ! grep -qF "<!-- dfd:$section -->" "$DOC" || ! grep -qF "<!-- /dfd:$section -->" "$DOC"; then
    fail "$DOC is missing its <!-- dfd:$section --> / <!-- /dfd:$section --> markers."
    note "  The checked region cannot be found, so nothing in it is checked."
    continue
  fi

  found=0
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    found=$((found + 1))
    checked=$((checked + 1))
    if [ ! -e "$p" ]; then
      fail "$DOC ($section) names \`$p\`, which does not exist."
      note "  The diagram labels a module that moved, was renamed, or was"
      note "  deleted. A stale box renders exactly like a correct one."
    fi
  done <<EOF
$(paths_in "$section")
EOF

  # A region that reads zero paths agrees with any diagram ever drawn. The
  # header of every other guard here says the same thing; it is repeated per
  # section because the two regions fail independently.
  if [ "$found" -eq 0 ]; then
    fail "$DOC ($section) has its markers and not one path between them."
    note "  Either the table was emptied or the row shape moved out from under"
    note "  the parser. A check that reads nothing reports success."
  fi
done

# ---------------------------------------------------------------------------
# References INTO the diagram: every B<n> and E<n> a threat cites must be an id
# the diagram declares.
# ---------------------------------------------------------------------------
declared_ids=$(
  for section in $SECTIONS; do
    awk -v want="$section" '
      $0 ~ ("^<!-- /dfd:" want " -->$") { inside = 0; next }
      $0 ~ ("^<!-- dfd:" want " -->$")  { inside = 1; next }
      inside && /^\|/ { print }
    ' "$DOC"
  done | sed -E 's/^\|[[:space:]]*//; s/[[:space:]]*\|.*$//' | grep -E '^[BE][0-9]+$' | sort -u
)

if [ -z "$declared_ids" ]; then
  fail "$DOC declares no B<n> or E<n> ids, so nothing can be checked against it."
  note "  The id column moved out from under the parser. A check with nothing"
  note "  to resolve against accepts every reference ever written."
fi

refs=0
if [ ! -f "$THREATS" ]; then
  fail "$THREATS does not exist; its references into the diagram are unchecked."
elif ! grep -qF '<!-- dfd:threats -->' "$THREATS" || ! grep -qF '<!-- /dfd:threats -->' "$THREATS"; then
  fail "$THREATS is missing its <!-- dfd:threats --> markers."
  note "  The checked region cannot be found, so no threat reference is read."
else
  cited=$(awk '
    /^<!-- \/dfd:threats -->$/ { inside = 0; next }
    /^<!-- dfd:threats -->$/   { inside = 1; next }
    inside && /^\|/ { print }
  ' "$THREATS" | grep -ohE '`[BE][0-9]+`' | tr -d '`' | sort -u)

  if [ -z "$cited" ]; then
    fail "$THREATS has its markers and cites no diagram id between them."
    note "  A threat naming no boundary or element is a threat about nothing in"
    note "  particular, and this check would read zero of them."
  fi

  while IFS= read -r id; do
    [ -z "$id" ] && continue
    refs=$((refs + 1))
    printf '%s\n' "$declared_ids" | grep -qxF "$id" ||
      fail "$THREATS cites \`$id\`, which $DOC does not declare."
  done <<EOF
$cited
EOF
fi

if [ "$failures" -gt 0 ]; then
  note "$failures problem(s) across $checked path(s) and $refs reference(s)."
  exit 1
fi

echo "dataflow-paths: $checked paths, $refs threat reference(s), all resolve."
