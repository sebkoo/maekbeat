#!/usr/bin/env bash
# Guardrails G1 + G2, history-wide: scan every commit message for banned
# AI-attribution trailers and every subject for Conventional Commit form
# (same rules .githooks/commit-msg enforces at commit time).
# Exits 0 on a clean history, including a repo with zero commits (unborn branch).
set -u

# Bans AI attribution, not co-authorship: an accurate `Co-authored-by:` line
# naming a real contributor (dependabot's squash-merge trailer, a human
# collaborator) is allowed and wanted. Byte-identical to the pattern in
# .githooks/commit-msg; scripts/test-githooks.sh asserts that.
trailer_pattern='co-authored-by:.*(claude|anthropic)|claude-session|noreply@anthropic|generated with claude'
subject_pattern='^(feat|fix|docs|test|chore|ci|refactor|perf|build)(\([a-z0-9-]+\))?!?: .+'

status=0

# "|| true" keeps the pipeline input usable on an unborn branch, where git log exits non-zero.
if { git log --format='%B' 2>/dev/null || true; } | grep -qiE "$trailer_pattern"; then
  echo "hygiene: banned AI-attribution trailer found in commit history." >&2
  echo "hygiene: offending commits:" >&2
  for p in 'co-authored-by:.*(claude|anthropic)' 'claude-session' 'noreply@anthropic' 'generated with claude'; do
    git log --format='%H %s' -i -E --grep="$p" >&2 || true
  done
  status=1
fi

# --no-merges: merge commits (PR merge refs, any non-squash merge) have git-generated
# subjects and are exempt from Conventional Commit form; the trailer scan above still
# covers their full messages.
while IFS= read -r line; do
  [ -z "$line" ] && continue
  hash="${line%% *}"
  subject="${line#* }"
  if [ "${#subject}" -gt 72 ]; then
    echo "hygiene: subject over 72 characters in ${hash}: ${subject}" >&2
    status=1
  elif ! printf '%s' "$subject" | grep -qE "$subject_pattern"; then
    echo "hygiene: non-Conventional-Commit subject in ${hash}: ${subject}" >&2
    status=1
  fi
done < <(git log --no-merges --format='%H %s' 2>/dev/null || true)

if [ "$status" -ne 0 ]; then
  exit "$status"
fi

echo "hygiene: commit history clean."
exit 0
