# AI usage

This project is built with AI assistance, disclosed here at the project level. This file records the model, the effort policy, the working loop, and the attribution policy that `.githooks/commit-msg` and the CI hygiene job enforce.

## Model

Model identifier as reported by the execution environment: claude-fable-5. Recorded: 2026-08-04.

Model identifiers may be preview names not yet listed in Anthropic's public model documentation as of the recording date.

## Effort tiers

- xhigh: architecture and review passes.
- high: features and docs writing.
- medium: boilerplate and scaffolding.

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
