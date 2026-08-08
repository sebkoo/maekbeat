#!/usr/bin/env bash
# A SOUP inventory is a claim about what is in the build. This checks the claim.
#
# docs/regulatory/soup-inventory.md names every dependency this project did not
# write. An inventory rots the day after it is written, and it rots silently:
# a package added in a feature commit is absent from the document and the
# document reads exactly as it did when it was complete.
#
# So the inventory is diffed against the manifests, in both directions. This
# fails when the document names something no manifest carries, and when a
# manifest carries something the document does not name.
#
# WHAT THIS DELIBERATELY DOES NOT CHECK: versions. The document records identity
# and role and cites pnpm-lock.yaml as the version record, because an inventory
# carrying version numbers goes red on every Dependabot merge and a guard that
# fails a bot's pull request is a guard somebody switches off. That is measured
# rather than assumed — replaying all 12 Dependabot commits in this repository's
# history and diffing the dependency NAME set on each side gives no change on 12
# of 12, including react-router 7 to 8 and vite 7 to 8. The cost is the blind
# spot: a version regression is invisible here. The failure this catches is an
# item entering or leaving the build with nobody analysing it.
#
# It is the same rule as scripts/check-action-versions.sh — internal
# consistency, not newness — and for the same reason: no network, and the same
# verdict on Tuesday as on Monday.
#
# Five sources, each parsed from the working tree:
#
#   npm      every package.json outside node_modules; dependencies and
#            devDependencies, minus the @maekbeat/* workspace links, which are
#            written here and are therefore not SOUP
#   actions  `uses: owner/repo@version` in .github/workflows
#   images   FROM and ARG *_IMAGE in infra/*.Dockerfile, plus image: in
#            infra/compose.yaml for services that do not build their own
#   tools    `npx --yes name@version` in .github/workflows, and any
#            github.com/owner/repo/releases/download URL
#
# WHAT IT CANNOT SEE, stated next to the guard the way check-hazard-tests.sh
# names its own blind spots:
#
#   - VERSIONS, per the paragraph above. A pin moving backwards is invisible
#     here, and no other guard in this repository would see it either.
#   - THE SWIFT TRANSITIVE CLOSURE. A dependency DECLARED in a Package.swift is
#     caught, by the assertion at the bottom of this file. What resolves beneath
#     it is not: Package.resolved is where a Swift transitive set would be
#     written, this script does not read it, and none exists today because
#     apps/ios declares nothing. So the Swift side has the same direct-only
#     limit as npm, arrived at differently.
#
#     That assertion exists because the mutation found its absence. The first
#     draft read no Swift manifest at all, and adding one .package(...) line
#     left it reporting "document and manifests agree" — NOT CAUGHT, recorded in
#     docs/ai/mutation-log.md. A source that is never read cannot disagree with
#     anything, which is the one failure mode a guard must not have.
#   - the transitive set. pnpm-lock.yaml resolves 340 package versions; this
#     reads the 37 that are declared. Everything below the direct line is
#     outside both the document and this check.
#   - the platform and toolchain. Node, pnpm, the Swift tools version and the
#     iOS SDK are pinned in engines/packageManager/Package.swift rather than in
#     a dependency manifest; the document inventories them in a table this
#     script does not read, and says so.
#   - whether a named item is described correctly. This checks that the name
#     sets agree. Whether the Role column is true stays human, exactly as
#     check-hazard-tests.sh leaves the adequacy of a control human.
#
# The npm parser assumes prettier-formatted JSON — one key per line. That is not
# a hope: `npx --yes prettier@3.9.6 --check --ignore-unknown .` gates every
# package.json in the docs-lint job, so the format is enforced by the same CI
# run this script executes in.
#
# Run by the CI hygiene job and by /ship-check. It reads the working tree.
set -uo pipefail

cd "$(dirname "$0")/.."

DOC=docs/regulatory/soup-inventory.md

failures=0

note() {
  echo "soup-inventory: $*" >&2
}

fail() {
  note "$*"
  failures=$((failures + 1))
}

if [ ! -f "$DOC" ]; then
  note "$DOC does not exist."
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# ---------------------------------------------------------------------------
# Declared — what the document says.
#
# A machine-read table is introduced by `<!-- soup:<class> -->`. After the
# marker, the first line starting with `|` opens the table and the first line
# that does not closes it, so a class may be split across several tables and
# several sections: the runtime packages are grouped by what they ship inside,
# which is the grouping a reader needs and not one flat list of 37.
#
# An item is the backtick span in a row's first cell. The header and separator
# rows carry no backticks and fall out on their own — but a row that simply
# forgot its backticks would fall out the same silent way, so that is failed
# explicitly rather than skipped.
# ---------------------------------------------------------------------------
declared() {
  awk -v want="$1" '
    /^<!-- soup:[a-z]+ -->$/ {
      cls = $0
      sub(/^<!-- soup:/, "", cls)
      sub(/ -->$/, "", cls)
      looking = (cls == want)
      intable = 0
      next
    }
    looking && /^\|/ { intable = 1 }
    looking && intable && !/^\|/ { looking = 0; intable = 0; next }
    looking && intable {
      cell = $0
      sub(/^\|[[:space:]]*/, "", cell)
      sub(/[[:space:]]*\|.*$/, "", cell)
      if (cell ~ /^`[^`]+`$/) {
        gsub(/`/, "", cell)
        print cell
      } else if (cell !~ /^-*$/ && cell != "Item") {
        print "!BADROW!" cell
      }
    }
  ' "$DOC"
}

for class in npm actions images tools; do
  declared "$class" | sort -u >"$work/doc.$class"
  if grep -q '^!BADROW!' "$work/doc.$class"; then
    while IFS= read -r bad; do
      fail "a row in a soup:$class table has no backticked item in its first cell:"
      note "  ${bad#!BADROW!}"
      note "  Every inventory row names its item as \`name\`, so this script can"
      note "  read it. A row it cannot read is an item nothing checks."
    done < <(grep '^!BADROW!' "$work/doc.$class")
    grep -v '^!BADROW!' "$work/doc.$class" >"$work/tmp" && mv "$work/tmp" "$work/doc.$class"
  fi

  # The document side has to assert its own input, the way check-hazard-tests.sh
  # refuses a table it read zero rows from. The two-way diff below does already
  # fail on an emptied document — every manifest item comes back unnamed — but it
  # fails as 50 separate reports of a dependency entering the build, which sends
  # the reader looking for 50 new dependencies instead of one deleted table. A
  # guard is also a thing people read while it is red.
  markers=$(grep -c "^<!-- soup:$class -->$" "$DOC")
  items=$(grep -cve '^$' "$work/doc.$class")

  # A class whose input is unusable is not then diffed. Diffing it would report
  # every manifest item as newly arrived — 50 reports of a dependency entering
  # the build, when what happened is that one table left the document — and the
  # cause would be the least prominent line in its own output.
  if [ "$markers" -eq 0 ]; then
    fail "$DOC has no <!-- soup:$class --> marker."
    note "  Every class this script checks is introduced by its marker. A class"
    note "  with none is a set of items compared against nothing."
    : >"$work/skip.$class"
  elif [ "$items" -eq 0 ]; then
    fail "$DOC has $markers soup:$class marker(s) and not one row under them."
    note "  The tables were emptied, or the row shape moved out from under the"
    note "  parser. Either way this class now claims nothing, and a claim of"
    note "  nothing is satisfied by anything."
    : >"$work/skip.$class"
  fi
done

# ---------------------------------------------------------------------------
# Actual — what the manifests carry.
# ---------------------------------------------------------------------------

# npm. The dependency blocks only: a key inside "scripts" or "engines" is not a
# dependency, so the state machine tracks which block it is in rather than
# matching every quoted key in the file.
find . -name package.json -not -path '*/node_modules/*' -print0 |
  xargs -0 awk '
    /^  "(dependencies|devDependencies)": \{/ { inblock = 1; next }
    inblock && /^  \}/ { inblock = 0; next }
    inblock && /^    "/ {
      name = $0
      sub(/^    "/, "", name)
      sub(/".*$/, "", name)
      if (name !~ /^@maekbeat\//) print name
    }
  ' | sort -u >"$work/real.npm"

# GitHub Actions. Local composite actions (`uses: ./...`) are this repository's
# own and are not SOUP; there are none today and the rule is stated anyway.
grep -rhoE '^[[:space:]]*(- )?uses:[[:space:]]*[^ ]+' .github/workflows/ |
  sed -E 's/.*uses:[[:space:]]*//' |
  grep -v '^\./' |
  sed -E 's/@.*$//' |
  sort -u >"$work/real.actions"

# Container base images. A FROM naming a build variable is resolved by the ARG
# default above it, so the ARG is the pin and the ${...} form is skipped.
{
  grep -hoE '^ARG [A-Z_]*IMAGE=[^ ]+' infra/*.Dockerfile | sed -E 's/^ARG [A-Z_]*IMAGE=//'
  grep -hoE '^FROM [^$ ]+' infra/*.Dockerfile | sed -E 's/^FROM //'
  # compose: an `image:` on a service that also declares `build:` names the
  # image this repository produces, not one it consumes.
  awk '
    /^[a-z]/ { flush(); svc = "" }
    /^  [a-z0-9_-]+:[[:space:]]*$/ { flush(); svc = $1; img = ""; built = 0; next }
    svc != "" && /^    build:/ { built = 1 }
    svc != "" && /^    image:[[:space:]]/ { img = $2 }
    END { flush() }
    function flush() { if (svc != "" && img != "" && !built) print img }
  ' infra/compose.yaml
} | sed -E 's/:[^:/]*$//' | sort -u >"$work/real.images"

# Build tools pinned outside every manifest.
{
  grep -rhoE 'npx --yes [@]?[a-z0-9/._-]+@[0-9][^ ]*' .github/workflows/ |
    sed -E 's/^npx --yes //; s/@[0-9][^ ]*$//'
  grep -rhoE 'https://github\.com/[^/]+/[^/]+/releases/download/' .github/workflows/ |
    sed -E 's|https://github\.com/||; s|/releases/download/||'
} | sort -u >"$work/real.tools"

# ---------------------------------------------------------------------------
# The diff, both directions, per class.
# ---------------------------------------------------------------------------
LABEL_npm="npm dependency"
LABEL_actions="GitHub Action"
LABEL_images="container base image"
LABEL_tools="pinned build tool"

WHERE_npm="a package.json outside node_modules"
WHERE_actions=".github/workflows"
WHERE_images="infra/*.Dockerfile or infra/compose.yaml"
WHERE_tools=".github/workflows"

total=0

for class in npm actions images tools; do
  label_var="LABEL_$class"
  where_var="WHERE_$class"
  label=${!label_var}
  where=${!where_var}

  count=$(wc -l <"$work/real.$class" | tr -d ' ')
  total=$((total + count))

  if [ "$count" -eq 0 ]; then
    fail "found no $label in $where."
    note "  A source that reads nothing agrees with any document, which is the"
    note "  worst thing this script could do. The parser or the layout moved."
    continue
  fi

  # Reported unusable above; the diff would only bury its own cause.
  [ -e "$work/skip.$class" ] && continue

  while IFS= read -r item; do
    [ -z "$item" ] && continue
    fail "$DOC names the $label \`$item\`, which $where does not carry."
    note "  It was removed from the build and the inventory still claims it."
  done < <(comm -23 "$work/doc.$class" "$work/real.$class")

  while IFS= read -r item; do
    [ -z "$item" ] && continue
    fail "$where carries the $label \`$item\`, which $DOC does not name."
    note "  A dependency entered the build without entering the analysis. Add a"
    note "  row under a <!-- soup:$class --> marker saying what it does here."
  done < <(comm -13 "$work/doc.$class" "$work/real.$class")
done

# ---------------------------------------------------------------------------
# The fifth source, asserted rather than diffed.
#
# apps/ios/MaekbeatKit/Package.swift declares no dependencies, and the inventory
# states that as a fact about the iOS app rather than as an omission. A claim of
# zero is checkable, so it is checked: the alternative was a class with an empty
# manifest side, which the `found no ...` rule above would have failed on every
# run, and a guard that is red by design gets switched off.
#
# This was written because the mutation found it. Adding one .package(...) line
# to Package.swift left this script reporting "document and manifests agree" —
# NOT CAUGHT, recorded in docs/ai/mutation-log.md — because a source it never
# read could not disagree with anything.
# ---------------------------------------------------------------------------
swift_manifests=$(find . -name Package.swift -not -path '*/node_modules/*' -not -path '*/.build/*')
swift_deps=$(printf '%s\n' "$swift_manifests" | tr '\n' '\0' | xargs -0 grep -h '^[[:space:]]*\.package(' 2>/dev/null | sed 's/^[[:space:]]*//')

if [ -n "$swift_deps" ]; then
  fail "a Package.swift now declares a dependency, and this inventory has no table for it."
  while IFS= read -r dep; do
    [ -n "$dep" ] && note "  $dep"
  done <<EOF
$swift_deps
EOF
  note "  $DOC states that apps/ios declares zero external Swift packages, which"
  note "  is why there is no soup:swift class. That statement is now false. Add"
  note "  the class here and its table there, in the same commit as the package."
fi

if [ "$failures" -gt 0 ]; then
  note "$failures problem(s) across $total inventoried items."
  exit 1
fi

echo "soup-inventory: $total items, document and manifests agree."
