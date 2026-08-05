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
- Every new test is proven against a mutation of the thing it guards, at the time it is written (amended 2026-08-05 — see below).
- Tests evolve with product requirements and are never weakened to make a failing implementation pass.
- Every scope-changing commit updates the README progress board in the same commit.
- A silent review pass precedes every commit.
- An adversarial review pass closes every phase.

### Amendment, 2026-08-05: prove the test, not just the code

Three tests that asserted nothing reached the C10 and C11 adversarial passes before anything caught them: a chart test whose trough assertion read a y-axis computed from undecimated data the code under test never touched, a gap test whose inner loop ran zero iterations because both fixtures were flat, and an abort test whose post-unmount assertion held whether or not the guard existed. All three were repaired inside their own commits, so `main` never carried them — but each survived writing, self-review, and a full gate run, which is three chances too many.

From C12 the proof moves to writing time: break the thing the test guards, watch that test fail, restore, keep. The record of what was broken and what happened lives in [docs/ai/mutation-log.md](mutation-log.md), one row per proof.

That discipline is not sufficient on its own, and C12 is the evidence. Its own adversarial pass then broke four C12 tests that these writing-time proofs had passed — a live-region test that waited on an already-true condition, a keyboard test that supplied the click it was meant to be checking for, a dedupe test whose two assertions were byte-identical, and a 400-path test that never reached the validator it named. A mutation only proves what it mutates; the pass that follows exists to think of the mutations the author did not.

## No-trailer policy

AI use is disclosed here, at the project level, so git history stays free of tool-injected attribution trailers. Enforcement is layered: .claude/settings.json is the best-effort layer, and .githooks/commit-msg plus the CI hygiene job are the tool-agnostic real enforcement.

Blocked patterns, matched case-insensitively: co-authored-by, claude-session, noreply@anthropic, generated with claude.

## Human review

Every diff is read, run, and revised by the author before it lands.
