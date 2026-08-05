# AI usage

This project is built with AI assistance, disclosed here at the project level. This file records the model, the effort policy, the working loop, and the attribution policy that `.githooks/commit-msg` and the CI hygiene job enforce.

## Model

One row per identifier, read from the execution environment at the time the work ran — never copied from a prompt, a release note, or a previous row:

| Commits                         | Model identifier as reported by the execution environment | Recorded   |
| ------------------------------- | --------------------------------------------------------- | ---------- |
| C0–C9                           | claude-fable-5                                            | 2026-08-04 |
| C10 — implementation            | claude-fable-5                                            | 2026-08-05 |
| C10 — adversarial review agents | claude-opus-5                                             | 2026-08-05 |

Model identifiers may be preview names not yet listed in Anthropic's public model documentation as of the recording date.

## Model and effort tiers

Policy, not record: tiering is per task, not per project — an Opus-class model for design-heavy commits and for every adversarial reviewer, a Sonnet-class model where the work is mechanical or scaffolding. What actually ran is the table above, which grows a row whenever the reported identifier changes.

- xhigh: architecture and review passes.
- high: features and docs writing.
- medium: boilerplate and scaffolding.

Downshifting is safe here because the gates are model-independent. `.githooks/commit-msg` and the CI hygiene job reject the same commit messages either way; the per-package coverage ratchet (each `vitest.config.ts`), the seeded property suites in apps/server, and the byte-pinned golden fixtures in packages/vitals-sim fail on the same diffs regardless of which model wrote them.

## Loop contract

- Plan → act → verify, in that order, for every commit.
- Tests should expose intended behavior before implementation where practical.
- Tests evolve with product requirements and are never weakened to make a failing implementation pass.
- Every scope-changing commit updates the README progress board in the same commit.
- A silent review pass precedes every commit.
- An adversarial review pass closes every phase.

## No-trailer policy

AI use is disclosed here, at the project level, so git history stays free of tool-injected attribution trailers. Enforcement is layered: .claude/settings.json is the best-effort layer, and .githooks/commit-msg plus the CI hygiene job are the tool-agnostic real enforcement.

Blocked patterns, matched case-insensitively: co-authored-by, claude-session, noreply@anthropic, generated with claude.

## Human review

Every diff is read, run, and revised by the author before it lands.
