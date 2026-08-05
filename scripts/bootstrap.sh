#!/usr/bin/env bash
# One-command setup after clone: verify toolchain, wire git hooks, print next steps.
# Failure contract: exits 0 when the required toolchain (git, Node 22+) is present;
# fails fast with an actionable per-tool message otherwise — that failure is correct behavior.
set -u

if ! command -v git >/dev/null 2>&1; then
  echo "bootstrap: git not found — install Xcode Command Line Tools (xcode-select --install) or brew install git" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "bootstrap: node not found — install Node 22+ (e.g. nvm install 22, or brew install node@22)" >&2
  exit 1
fi

node_version="$(node --version)"
node_major="${node_version#v}"
node_major="${node_major%%.*}"
case "$node_major" in
  '' | *[!0-9]*)
    echo "bootstrap: could not parse a major version from 'node --version' output '$node_version' — install Node 22+ (e.g. nvm install 22, or brew install node@22)" >&2
    exit 1
    ;;
esac
if [ "$node_major" -lt 22 ]; then
  echo "bootstrap: found node $node_version but Node 22+ is required — install Node 22+ (e.g. nvm install 22, or brew install node@22)" >&2
  exit 1
fi

# pnpm is optional for now: the first workspace package lands at C1.
if ! command -v pnpm >/dev/null 2>&1; then
  echo "bootstrap: warning — pnpm not found. Optional today; the first workspace package lands at C1. Hint: corepack enable pnpm"
fi

if ! git config core.hooksPath .githooks; then
  echo "bootstrap: failed to set core.hooksPath — run this from inside a git clone (git clone, not a ZIP download)" >&2
  exit 1
fi
echo "bootstrap: core.hooksPath set to .githooks — commit-msg and pre-commit hooks are active."

echo "bootstrap: done. Next steps:"
echo "  - hooks are active: they run on every commit in this clone"
echo "  - run: npm run format:check   # try the docs formatting gate"
echo "  - see docs/ROADMAP.md for what lands next"
exit 0
