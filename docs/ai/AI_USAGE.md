# AI usage

This project is built with AI assistance, disclosed here at the project level. This file records the model, the effort policy, the working loop, and the attribution policy that `.githooks/commit-msg` and the CI hygiene job enforce.

## Model

One row per identifier, read from the execution environment at the time the work ran — never copied from a prompt, a release note, or a previous row:

| Commits                         | Model identifier as reported by the execution environment | Recorded   |
| ------------------------------- | --------------------------------------------------------- | ---------- |
| C0–C9                           | claude-fable-5                                            | 2026-08-04 |
| C10 — implementation            | claude-fable-5                                            | 2026-08-05 |
| C10 — adversarial review agents | claude-opus-5                                             | 2026-08-05 |
| C14 — implementation and review | claude-opus-5[1m]                                         | 2026-08-05 |

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

### Amendment, 2026-08-06: a gate that fails on noise stops being a gate

The C9 ratchet commit argued that a coverage threshold pinned to the measurement
"would fail on noise, and a gate that fails on noise gets raised in anger or
ignored, which is how ratchets die." The same thing happened one gate over,
without anyone pinning anything: a test that measured the machine instead of the
behaviour taught the author to discount red.

The evidence is this repository's own CI history, read from
`gh run list -R sebkoo/maekbeat` on 2026-08-06:

| Run | Trigger                           | Result  | Cause                                     |
| --- | --------------------------------- | ------- | ----------------------------------------- |
| #24 | push, C11                         | green   |                                           |
| #25 | push, C12a                        | **red** | `stream.test.ts:162` — 72 of 110 frames   |
| #26 | pull request, @fastify/swagger-ui | **red** | the same line — 0 of 110                  |
| #27 | pull request, @types/node         | **red** | `tsc` on that branch, a different failure |
| #28 | push, C13 + positioning + ratchet | green   |                                           |
| #29 | pull request, actions/setup-node  | green   |                                           |
| #30 | pull request, actions/checkout    | green   |                                           |
| #31 | pull request, @types/node         | **red** | `stream.test.ts:162` — 83 of 110          |
| #32 | push, C14                         | **red** | the same line — 105 of 110                |
| #33 | pull request, actions/checkout    | green   |                                           |
| #34 | push, the repair                  | green   |                                           |

Four reds, one line, four different counts — 72, 0, 83, 105. A regression does
not produce four different answers; a measurement of how loaded a runner was
does. Two details worth keeping straight rather than rounding off: run #27 was red for
something else entirely, a typecheck error on that branch's merged tree, and run
run #33 was green. Red was neither one cause nor a continuous band.

What it cost, stated no higher than the evidence supports. **Nothing real was
missed.** The claim here is about a mechanism, not a near-miss:

- Main sat red from #25 and three further commits were authored before CI ran
  again at #28, which they landed green. Work was built on a red main because
  red had stopped meaning anything.
- The steps in a job are sequential, so a flake at `pnpm -r test:coverage`
  guarantees `pnpm -r typecheck` never runs at all. On C12a's own run it did not.
  Whatever the later steps would have said about that commit went unsaid — and
  #27 is what an unrelated real failure looks like sitting in the same colour as
  the noise, indistinguishable without reading the log.

What settled it was not the green run on main. Run #34 was one pass of a test
that had been passing most of the time for three commits — for an intermittent
failure, a single green is close to no evidence at all. The signal came from the
Dependabot pull requests, each rebased onto the repair and each running the
whole suite on its own merged tree:

| Run | Branch                              | Before the repair | After |
| --- | ----------------------------------- | ----------------- | ----- |
| #35 | `@types/node` 22.20.1 → 26.1.2      | red (#31)         | green |
| #36 | `actions/checkout` 4 → 7            | —                 | green |
| #37 | `@fastify/swagger-ui` 5.2.6 → 6.1.1 | red (#26)         | green |

Four independent trees, four independent runs, no red. That is what distinguishes
"the flake is gone" from "the flake did not fire this time", and it is why the
re-runs were worth doing before calling it resolved rather than after.

Run #37 also disposed of a hypothesis that had every reason to be believed.
`@fastify/swagger-ui` 5 → 6 is a major version bump on a dependency this server
mounts at startup, and its pull request was red — which is exactly what a
genuine breaking change looks like from the outside. It was tempting to reason
about it: read the changelog, check the plugin API, argue. The re-run answered it
in eight minutes and the argument was never needed. A red that two causes explain
is not evidence for either of them until one is removed.

The rule this generalises to:

> A gate that fails on noise stops being a gate, whether the noise comes from a
> threshold pinned too tight or from a test that measures the machine instead of
> the behaviour. Both erode the same discipline — verify green before building
> on it — and the erosion is invisible until something real is missed.

The practice that follows, because a lesson with no changed behaviour is
decoration: **push, confirm green, then start the next commit.** When a gate
goes red the next action is diagnosis, never another feature commit — and a red
that is "probably the flaky one" is a diagnosis nobody performed. The repair and
its proofs are in [mutation-log.md](mutation-log.md) under "Fan-out delivery:
waiting for a condition, not for the clock", which also records that this test
had given a false green locally since C11.

### Amendment, 2026-08-05: an uncatchable mutation is a question about the code

The writing-time proof above assumes the test suite is what can be wrong. Often
it is. But when a mutation cannot be caught, the first question is not "which
test is missing" — it is **whether the mutated thing should exist at all.**

Ask it in this order, and do not skip the first step.

**Step 1 — a NOT CAUGHT result is a claim about the harness before it is a claim
about the code.** Verify the mutation actually took effect: every build
configuration, every copy of the pattern, the file the process really reads, the
platform that really compiles it. Then re-run. A mutation that did not land
looks exactly like dead state, and the two want opposite responses.

**Step 2 — only once the mutation is confirmed real** does the question about
the code apply. Work the branches in order and take the first that can be
answered:

- **(a) Does it change anything observable?** A request payload, a log line, a
  displayed value, a returned case — anything a test could see. If yes, write
  the test that pins that contribution, and the mutation is caught.
- **(b) If not, name the specific failure mode it defends against**, and write
  the test for that scenario. A defence with a named threat is engineering. A
  defence with no named threat is decoration.
- **(c) If neither can be answered, delete it.** An uncatchable mutation is the
  discipline reporting dead state, not a gap in the suite. State that no
  observation distinguishes will drift from the mechanism it shadows, and
  mislead whoever reads it next into thinking it is load-bearing.

Reaching for (a) when the answer is (c) is how a codebase accumulates assertions
about its own internals. Reaching for (c) when the answer is (b) deletes a guard
whose scenario nobody had staged yet. The order matters, and so does writing
down which branch was taken — C15 took all three for one field and the reasoning
is in that commit and in [mutation-log.md](mutation-log.md).

Step 1 is here because this rule shipped without it and the hole showed up the
same day. Two mutations against the app target's Info.plist keys reported NOT
CAUGHT, and the guard was fine: `project.pbxproj` declares each key once per
build configuration, and the harness replaced only the first occurrence, so the
Debug copy went away while the Release copy kept the assertion green. Applied to
that false NOT CAUGHT, step 2 alone deletes a working guard — the branches would
have asked whether a key nothing seemed to observe should exist, and the answer
would have been wrong. Both were caught once the mutation removed both copies.

The failure mode generalises past `.pbxproj`: a pattern duplicated across two
files, a constant read from an environment the test does not set, a file behind
a platform guard the fast loop does not compile. In each case the harness is
reporting on something it never changed.

## No-trailer policy

AI use is disclosed here, at the project level, so git history stays free of tool-injected attribution trailers. Enforcement is layered: .claude/settings.json is the best-effort layer, and .githooks/commit-msg plus the CI hygiene job are the tool-agnostic real enforcement.

Blocked patterns, matched case-insensitively: a `co-authored-by:` line that also names claude or anthropic, claude-session, noreply@anthropic, generated with claude.

The rule bans AI attribution, not co-authorship, and the distinction is load-bearing rather than pedantic. An accurate `Co-authored-by:` line — a human collaborator, or Dependabot's squash-merge trailer — is a true statement about who wrote the change, and a guard that rejects it is asking for authorship to be falsified. The pattern used to open with a bare `co-authored-by:` term and did exactly that; see the landmine entry in [mutation-log.md](mutation-log.md).

Adding another AI tool means adding its trailer form to the pattern. It does not mean widening the co-author term back.

## Human review

Every diff is read, run, and revised by the author before it lands.
