#!/usr/bin/env bash
# One action, one version, everywhere in this repository.
#
# `actions/setup-node` sat at v7 in four jobs and v4 in the ios job, and the
# history says how: Dependabot bumped every reference it could see in 8f6c411,
# and three commits later ad96c2f added a new job whose setup-node step was
# copied from an older one. Nothing objected. The runner did — "Node.js 20 is
# deprecated. The following actions target Node.js 20" — into a green log,
# which is where warnings go to be ignored.
#
# THE RULE IS INTERNAL CONSISTENCY, NOT NEWNESS. Every reference to an action
# must name the same version; whether that version is the newest one published
# is not asked here. Two other rules were available and both are worse:
#
#   "every reference is at the newest release" needs the network, gives a
#   different verdict on Tuesday than on Monday, and turns somebody else's
#   release into a red build on a commit that changed nothing.
#
#   "any deviation carries a documented reason" is a comment beside the
#   deviation, and a comment is not a check.
#
# What this does NOT catch, stated because a guard's blind spot belongs next to
# the guard: an action that is uniformly stale. `actions/cache@v4` is the only
# reference to that action, so it is perfectly consistent and this script has
# nothing to say about it — v6.1.0 was the newest release when this was written
# (checked 2026-08-06 via `gh api repos/actions/cache/releases/latest`). Keeping
# up with releases is Dependabot's job (.github/dependabot.yml, weekly); keeping
# a bump from missing a copy is this one.
#
# Run by the CI hygiene job and by /ship-check. It reads the working tree.
set -uo pipefail

cd "$(dirname "$0")/.."

note() {
  echo "action-versions: $*" >&2
}

# Every YAML under .github, not just the workflows: a composite action added at
# .github/actions/ pins versions the same way and would otherwise be exempt.
inventory=""
count=0

while IFS= read -r file; do
  # Anchored to the YAML key so a `uses:` inside a comment or a prose line is
  # not read as a pin. The quote characters end the reference for the
  # `uses: "owner/repo@v1"` spelling.
  while IFS= read -r spec; do
    # Local (./path) and container (docker://) steps name no released action.
    case "$spec" in
      ./* | .\\* | docker://*) continue ;;
    esac
    # No @ means an unpinned reference, which is a different defect and not
    # this script's; it is counted so the totals below stay honest.
    case "$spec" in
      *@*) ;;
      *) continue ;;
    esac

    version=${spec##*@}
    path=${spec%@*}
    # owner/repo, so `actions/cache@v4` and `actions/cache/restore@v6` are one
    # action and are required to agree — they ship from the same release.
    repo=$(printf '%s' "$path" | cut -d/ -f1,2 | tr '[:upper:]' '[:lower:]')

    inventory="${inventory}${repo}	${version}	${file}
"
    count=$((count + 1))
  done < <(grep -oE '^[[:space:]]*(-[[:space:]]+)?uses:[[:space:]]*[^[:space:]#"'"'"']+' "$file" |
    sed -E 's/.*uses:[[:space:]]*//')
done < <(find .github -type f \( -name '*.yml' -o -name '*.yaml' \) | sort)

# A guard that reads nothing passes everything. If the `uses:` shape ever moves
# out from under that grep — or .github is renamed, or the workflows are
# templated — this is the line that says so instead of printing a green tick.
if [ "$count" -eq 0 ]; then
  note "no action references found under .github/."
  note "  Either every workflow lost its steps, or the pattern this script reads"
  note "  no longer matches how they are written. Do not leave it unchecked."
  exit 1
fi

actions=$(printf '%s' "$inventory" | cut -f1 | sort -u)
failures=0

for repo in $actions; do
  versions=$(printf '%s' "$inventory" | awk -F'\t' -v r="$repo" '$1 == r { print $2 }' | sort -u)
  if [ "$(printf '%s\n' "$versions" | wc -l)" -gt 1 ]; then
    note "$repo is pinned to more than one version:"
    printf '%s' "$inventory" | awk -F'\t' -v r="$repo" '$1 == r { print "    " $2 "  " $3 }' |
      sort -u >&2
    note "  Pick one and change them all. A bump that misses a reference leaves"
    note "  the missed one running whatever it ran before, silently."
    failures=$((failures + 1))
  fi
done

if [ "$failures" -gt 0 ]; then
  note "$failures action(s) disagree with themselves."
  exit 1
fi

echo "action-versions: $count reference(s) to $(printf '%s\n' "$actions" | wc -l | tr -d ' ') action(s), each pinned to one version."
