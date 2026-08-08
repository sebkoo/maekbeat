#!/usr/bin/env bash
# A data-flow diagram is a claim about where the code is. This checks the claim.
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
# Run by the CI hygiene job and by /ship-check. It reads the working tree.
set -uo pipefail

cd "$(dirname "$0")/.."

DOC=docs/security/data-flow.md
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

if [ "$failures" -gt 0 ]; then
  note "$failures problem(s) across $checked path(s)."
  exit 1
fi

echo "dataflow-paths: $checked paths across ${SECTIONS// /, }, all present."
