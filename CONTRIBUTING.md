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
- A roadmap row is one capability, and one that cannot be described in a single
  reader-facing sentence is two rows (`docs/ROADMAP.md`, "What a row is"). The
  README status board carries one chip per row and never one per commit;
  `scripts/check-commit-links.sh` enforces that, and the roadmap is where
  commit-level detail belongs.

## Hooks

The `pre-commit` hook runs `prettier` and `markdownlint` on staged files.
Check formatting locally before committing (swap `--check` for `--write`
in the prettier line to fix findings):

```sh
npx --yes prettier@3.9.6 --check --ignore-unknown .
npx --yes markdownlint-cli2@0.23.2 "**/*.md" "#**/node_modules"
```

## Issues

Two forms in `.github/ISSUE_TEMPLATE/` — a bug report and an architecture
discussion — and the blank issue stays enabled for anything neither fits, which
is a GitHub setting rather than a file here. The bug form asks
which claim the behaviour disagrees with, because in this repository a bug is a
gap between a written claim and what runs.

Four labels, declared with their meanings in [.github/labels.yml](.github/labels.yml)
— nothing syncs that file, so GitHub is the authority and it is the record. Two
filters, which resolve against whatever is labelled at the time you open them:

- [good first issue](https://github.com/sebkoo/maekbeat/issues?q=is%3Aopen+label%3A%22good+first+issue%22)
- [help wanted](https://github.com/sebkoo/maekbeat/issues?q=is%3Aopen+label%3A%22help+wanted%22)

## Pull requests

PRs use `.github/pull_request_template.md`. Fill in every section,
including the evidence-map question — it is there on purpose.
