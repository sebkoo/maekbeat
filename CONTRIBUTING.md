# Contributing

Thanks for your interest. Maekbeat is an educational project; contributions
are welcome once good-first-issues open at C23 (see `docs/ROADMAP.md`).

## Setup

```sh
git clone https://github.com/sebkoo/maekbeat.git
cd maekbeat
./scripts/bootstrap.sh
```

`scripts/bootstrap.sh` activates the repo hooks (`git config core.hooksPath
.githooks`) and checks that Node.js is version 22 or newer.

## Commits

- Follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/).
- Imperative subject line, 72 characters or fewer.
- One feature per commit — split unrelated changes.
- The `commit-msg` hook rejects AI attribution trailers. Disclosure of AI
  assistance lives in `docs/ai/AI_USAGE.md`, not in commit metadata.

## Hooks

The `pre-commit` hook runs `prettier` and `markdownlint` on staged files.
Check formatting locally before committing (swap `--check` for `--write`
in the prettier line to fix findings):

```sh
npx --yes prettier@3.9.6 --check --ignore-unknown .
npx --yes markdownlint-cli2@0.23.2 "**/*.md" "#**/node_modules"
```

## Pull requests

PRs use `.github/pull_request_template.md`. Fill in every section,
including the evidence-map question — it is there on purpose.
