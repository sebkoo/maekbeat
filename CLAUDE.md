# CLAUDE.md — Maekbeat project rulebook

Rules for every AI session in this repo. They are not suggestions.

## G1 — No AI attribution in commit metadata, ever

- No `Co-Authored-By`, no "Generated with Claude", no session trailers, in
  any commit message, ever. AI disclosure lives in `docs/ai/AI_USAGE.md`.
- Triple defense: `.claude/settings.json`, `.githooks/commit-msg` (active
  via `core.hooksPath`), and the CI hygiene job.
- Banned regex (case-insensitive):
  `co-authored-by:|claude-session|noreply@anthropic|generated with claude`
- After committing, run `git log --format='%B'` and confirm zero matches.
  If a trailer appears, amend or rebase BEFORE pushing.

## G2 — Atomic commits

- One feature per commit. Conventional Commits 1.0.0. Imperative subject,
  ≤72 characters.

## G3 — Honesty of claims

- No invented benchmarks. No badges for things that do not exist.
- Unbuilt = "planned", "lands at `C<n>`", or "target architecture" — never
  present tense, never "supports X" / "handles X" about future capability.
- Measured numbers only after k6 runs at C19, labeled with the method.
- Time-brittle external claims are recorded as dated procedures ("checked
  2026-08-04 via ..."), never as standing verdicts.
- Regulatory language: "FDA-literate process" only — never "FDA ready" or
  "FDA compliant". Cite no guidance or standard without a demonstrating
  artifact in the repo.

## G4 — Anti-slop writing rules

- Banned words: seamlessly, effortlessly, blazingly, revolutionize,
  empower, delve, leverage, cutting-edge, game-changing.
- "robust" / "comprehensive" only with adjacent concrete evidence.
- Every paragraph ≤3 sentences and ≥1 concrete noun (path, tool, number,
  or protocol). Every README section references a repo path.
- One emoji zone in the entire repo: the Status columns of the two README
  boards (progress board, design notes). No emoji anywhere else.

## G5 — NEVER COMMIT THE FIRST DRAFT

- Before every commit: one silent review pass over the full diff —
  consistency, G3/G4 greps, links, tone. Fix first, then commit.
- `/ship-check` (`.claude/commands/ship-check.md`) is the checklist.

## G6 — Secrets hygiene

- Nothing sensitive committed. `.gitignore` covers Node, Swift/Xcode,
  macOS, and `.env` files.

## G7 — Repo conduct

- All repo content in English; Korean glosses for names and etymology
  (README, ADR-0001) are the exception. Conventional Commits. No
  destructive git operations outside this repository.
- All session communication and reports in English, including final
  session reports.

## HARD SCOPE

- Application source files (`.swift` `.ts` `.tsx` `.js` `.jsx` `.kt`)
  land only in their designated roadmap commit (`docs/ROADMAP.md`), never
  as side effects of another task.

## FAILURE RECOVERY

- If a session is interrupted or resumed: read the working tree, run
  `git status` and `git log`, identify the last completed step, and resume
  from the next one.
- Never regenerate files that already exist and pass review.

## PROCESS

- README progress board is updated in the same commit as every scope
  change — and so is every other place stating the same scope: the
  repository tour, the Stack table, the Design notes rows, each app's
  README headline range, and the "shipped — C(n)" asides in DISCLAIMER.md,
  SECURITY.md, docs/ARCHITECTURE.md and `packages/*/README.md`.
  `scripts/check-scope-ranges.sh` enforces the three mechanical ones and
  runs in the CI hygiene job; the rest are a `/ship-check` read.
  `docs/ROADMAP.md` is the plan of record.
- Coverage thresholds (each package's `vitest.config.ts`) are a ratchet:
  they move only up, each raise its own deliberate commit, and they are
  never overridden downward by CLI flags in package scripts or CI. The
  denominator is never shrunk — no new exclude entries, no narrowed
  include globs, no relocating runtime code out of `src/`. Every
  workspace package defines `test:coverage` (CI enforces the presence);
  a new package joins the gate in its scaffold commit.
- An adversarial review pass closes each phase.
- Tests are never weakened to make an implementation pass.
