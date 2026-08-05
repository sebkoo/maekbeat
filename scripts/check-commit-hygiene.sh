#!/usr/bin/env bash
# Guardrail G1, history-wide: scan every commit message for banned AI-attribution trailers.
# Exits 0 on a clean history, including a repo with zero commits (unborn branch).
set -u

pattern='co-authored-by:|claude-session|noreply@anthropic|generated with claude'

# "|| true" keeps the pipeline input usable on an unborn branch, where git log exits non-zero.
if { git log --format='%B' 2>/dev/null || true; } | grep -qiE "$pattern"; then
  echo "hygiene: banned AI-attribution trailer found in commit history." >&2
  echo "hygiene: offending commits:" >&2
  for p in 'co-authored-by:' 'claude-session' 'noreply@anthropic' 'generated with claude'; do
    git log --format='%H %s' -i --grep="$p" >&2 || true
  done
  exit 1
fi

echo "hygiene: commit history clean."
exit 0
