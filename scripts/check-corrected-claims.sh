#!/usr/bin/env bash
# Two sentences this repository has already written down as true and then had to
# correct. This refuses to let either come back.
#
#   1. that dismissed / (acknowledged + dismissed) is a FALSE-ALARM rate. It is
#      a dismissal rate — docs/product-loop.md, and H7 in
#      docs/regulatory/hazard-analysis.md, which is where the difference bites.
#   2. that the decision log is APPEND-ONLY with no update and no delete. It has
#      no update, and it evicts its oldest entries at 200 per device —
#      apps/server/src/acks.ts.
#
# WHY A FIXED-STRING CHECK AND NOT A GUARD OVER PROSE. Both claims were
# corrected once and came back verbatim. The second came back in
# docs/security/data-flow.md two commits after the correction, written by the
# session that made it. That is literal reintroduction of a known-wrong
# sentence, and a list of two strings catches exactly it. This needs no
# declaration mechanism, which is what the general prose-claims candidate in
# docs/ai/mutation-log.md needs and does not have.
#
# WHAT IT DOES NOT CATCH, stated here rather than left to be assumed:
# paraphrase. "the ratio of dismissals gives us our false positives" says the
# same wrong thing and passes. A rewording of the append-only claim that avoids
# these substrings passes. This is a backstop against repetition, not a check
# that the documents are true.
#
# SCOPE IS THE DESIGN. The phrases are banned under apps/ and packages/, where a
# statement reads as a description of what the code does now. They are permitted
# everywhere else, because docs/ai/mutation-log.md, docs/ROADMAP.md and this
# script's own header have to QUOTE them to record that they were wrong — a
# guard that forbade the words everywhere would forbid describing the error.
# That is a boundary drawn on how a reader takes the sentence, not a list of
# files granted an exemption, which is the shape argued against for the SOUP
# guard at C21. It is also why scripts/ is not a root: this file would fail it.
set -euo pipefail

cd "$(dirname "$0")/.."

# Each entry: <what it should say instead>|<extended regex>, matched case-insensitively.
patterns=(
  "a dismissal rate, not a false-alarm rate|false[- ]alarm (rate|signal)"
  "no update, and bounded eviction at 200 per device|no update and no delete"
)

roots=(apps packages)
fail=0
scanned=0

for root in "${roots[@]}"; do
  [ -d "$root" ] || continue
  while IFS= read -r file; do
    scanned=$((scanned + 1))
    for entry in "${patterns[@]}"; do
      correction="${entry%%|*}"
      regex="${entry#*|}"
      while IFS= read -r hit; do
        [ -n "$hit" ] || continue
        echo "corrected-claims: $file:${hit%%:*}" >&2
        echo "    ${hit#*:}" >&2
        echo "    should say: $correction" >&2
        fail=1
      done < <(grep -inE "$regex" "$file" || true)
    done
  done < <(git ls-files "$root")
done

if [ "$fail" -ne 0 ]; then
  cat >&2 <<'EOF'

Each phrasing above was corrected once and has come back. Discussing either
claim belongs outside apps/ and packages/, where this guard does not look —
see the header of scripts/check-corrected-claims.sh.
EOF
  exit 1
fi

echo "corrected-claims: $scanned files under ${roots[*]}, neither corrected claim restated."
