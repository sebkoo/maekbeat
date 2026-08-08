# Lifecycle map

Maekbeat is not a medical device and there is no manufacturer here. Read
[README.md](README.md) in this directory first — it states the position this
file depends on, makes the classification argument, and lists what a real
submission would need that this has none of.

This maps what this repository already does onto the process areas a medical
device software lifecycle standard asks a manufacturer to run. It is written
from the codebase upward: start from an artifact that exists, name the process
area it belongs to, then say what the area asks for that is not here.

**The absences are the content.** A map with every row filled would be the
fiction this directory exists to avoid, and the vocabulary of process is exactly
what makes that fiction hard to spot from outside.

## Why no clause numbers appear

IEC 62304:2006+AMD1:2015 is paywalled at CHF 1,150 and I have not read it
(publisher's catalogue record re-checked 2026-08-07 at
`webstore.iec.ch/en/publication/22794`, which serves metadata and no table of
contents). The process-area names below are my own paraphrase from secondary
reading, not quotations, and no clause number appears anywhere in this
directory — the standing rule set in
[README.md](README.md#citations-i-could-not-verify).

Secondary sources converge on particular numbers for the SOUP and
classification requirements. Convergent hearsay is still hearsay, so the
requirements are described and the numbering is not. Check every description
here against the standard before relying on it.

## The map

Verdicts are deliberately coarse. **Practice** means an artifact exists and
something checks it; **partial** means an artifact exists and nothing checks it,
or it covers one part of the area; **absent** means there is nothing; **planned
— C(n)** means nothing yet, with the commit that changes it named.

| Process area                         | What exists here                                                                                   | Verdict       |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------- |
| Development planning                 | Nothing. `docs/ROADMAP.md` sequences features, which is a different artifact                       | Absent        |
| Requirements analysis                | `packages/protocol` zod schemas, `packages/vitals-sim/golden` fixtures, `docs/ble-gatt-profile.md` | Partial       |
| Architectural design                 | `docs/ARCHITECTURE.md`, `docs/adr/0001-stack-and-name.md`, `docs/DECISIONS.md`                     | Partial       |
| Detailed design                      | Nothing between architecture and source                                                            | Absent        |
| Unit implementation and verification | Per-package suites, coverage ratchets, `docs/ai/mutation-log.md`                                   | Practice      |
| Integration and integration testing  | `apps/server/src/*.integration.test.ts`, `infra/compose-smoke.sh`, the `compose` CI job            | Practice      |
| System testing                       | `apps/web/e2e/journey.spec.ts` through a real browser against a real server                        | Practice      |
| V&V planning                         | Nothing. The suites execute no plan                                                                | Absent        |
| Release                              | Container build, `infra/verify-image-identity.sh`, GHCR publish from `main` alone                  | Partial       |
| Configuration management             | git with linear history, `.githooks/`, `scripts/check-commit-hygiene.sh`, `pnpm-lock.yaml`         | Practice      |
| Problem resolution                   | Nothing. `docs/ai/mutation-log.md` records deliberate breaks, not reported problems                | Absent        |
| Risk management                      | `docs/regulatory/hazard-analysis.md` + `scripts/check-hazard-tests.sh`                             | Practice      |
| SOUP                                 | Nothing                                                                                            | Planned — C21 |
| Maintenance                          | Dependabot alone (`.github/dependabot.yml`, `docs/DECISIONS.md` #27)                               | Absent        |

Five rows read **practice**, and every one of them is a verification or control
activity. Every absent row is a planning or record-keeping activity. That
pattern is the finding, and the last section returns to it.

**Where a row reads absent, the "What exists here" cell says nothing rather
than naming the nearest adjacent artifact.** That rule is the whole
discipline of this table. There is always something to point at — a roadmap
near development planning, a mutation log near problem resolution, three green
test suites near V&V planning — and a map that reaches for it produces a page
with every row filled and no information in it.

---

## Development planning — absent

**What the area asks for.** A plan, written before the work, naming the
deliverables, the development and verification methods, the traceability
approach, the standards to be applied, and how the plan is kept current as the
work moves. Its rigour scales with the software safety class.

**What is here.** Nothing. There is no software development plan.

**What this repository has instead, which is not that.** `docs/ROADMAP.md`
sequences features at commit granularity and is enforced rather than
aspirational — the HARD SCOPE rule in `CLAUDE.md` keeps application source out
of any commit but its designated one, and `scripts/check-scope-ranges.sh` fails
CI when the README's stated scope and the roadmap disagree. `docs/ai/AI_USAGE.md`
records the loop contract the work follows, including that every guard is proven
against a mutation at writing time.

Both are real and neither is a development plan. A feature sequence says what
will be built in what order; a development plan says by what method, verified
how, traceable to what, against which standards. Nothing states a verification
method per deliverable in advance, nothing fixes acceptance criteria before an
implementation is written, and no document names which standards apply — this
directory is the first thing in the repository that names any, and it names them
to disclaim conformance.

## Requirements analysis — partial

**What the area asks for.** Software requirements derived from the system
requirements, covering function, inputs and outputs, interfaces, security, and
the risk controls the risk analysis assigns to software; each one verifiable and
traceable to the system requirement above it and the test below it.

**What is here.** The wire contract is a specification that executes.
`packages/protocol` holds zod schemas for the vitals frame, alert, silence and
acknowledgement shapes, and `apps/server` validates every inbound frame against
them, so a requirement violation is a runtime rejection rather than a review
finding. `packages/vitals-sim/golden` pins the bytes both languages must agree
on, which is what keeps `apps/ios`'s hand-written Swift `Codable` mirror from
drifting; `docs/ble-gatt-profile.md` specifies the transport contract the same
way.

**What is absent.** A schema states shape, not intent. Nothing in this
repository says what the system must do in the language of a person who needs
it — there is no requirement reading "a caregiver learns of a sustained
tachycardia episode within N seconds", and so nothing to trace a test back to.
The alert thresholds in `apps/server/src/alerts.ts` are labeled in source as
demo heuristics with no requirement behind them, and the one threshold that is
derived rather than picked — `DEVICE_SILENCE_MS`, computed from the gateway's
own reconnect deadlines and pinned across the language boundary by
`apps/server/src/silence.test.ts` — is derived in a test comment, not in a
requirement.

## Architectural design — partial

**What the area asks for.** An architecture that decomposes the software into
items, states the interfaces between them and to anything outside, identifies
which items are SOUP, and identifies the segregation the risk control relies on.

**What is here.** `docs/ARCHITECTURE.md` describes the stages a frame passes
through; `docs/adr/0001-stack-and-name.md` and the 32 entries in
`docs/DECISIONS.md` record the choices with their alternatives and trade-offs,
which is the part of design rationale that usually goes unwritten. Some entries
are risk control decisions in substance: `#23` records that thinning a slow
subscriber's stream was considered and rejected, and hazard H3 cites that
rejection as its control.

**What is absent.** No diagram or document identifies SOUP items inside the
architecture, and the inventory planned in this row will be a list beside the
architecture rather than a decomposition of it. No interface specification exists
apart from the schemas. Segregation is not identified anywhere, because nothing
here is segregated: `apps/server` is one process with one in-memory store, and
`docs/regulatory/hazard-analysis.md` rows H1, H2 and H6 all end at the same
residual risk, that a restart loses what the process was holding.

## Detailed design — absent

**What the area asks for.** Refinement of each software item into units, with
enough design detail to implement and verify them, at a rigour that scales with
safety class.

**What is here.** Nothing. The step between `docs/ARCHITECTURE.md` and the
source files does not exist as an artifact.

**Why that is defensible here and would not be there.** For a codebase this
size, read by its author, the source is the detailed design and a separate
document would be a transcription that rots. That argument does not survive a
safety class where an auditor must confirm that what was implemented is what was
designed, and it is recorded here as a deliberate omission rather than an
oversight.

## Unit implementation and verification — practice

**What the area asks for.** Acceptance criteria for units, verification that
each meets them, and records of the results.

**What is here.** The strongest area in the repository, and the only one where
the verification is itself verified. Every workspace package defines
`test:coverage` with thresholds in its own `vitest.config.ts` (95–97% across the
five packages), the thresholds are a ratchet that moves only up and only in its
own commit, and `docs/ai/mutation-log.md` records every guard proven by breaking
what it protects and watching the guard fail.

**What is absent.** Acceptance criteria are per-file coverage thresholds, which
is a proxy for adequacy and not a statement of it. Test results are CI run logs
with GitHub's retention, not retained records. The mutation log's honesty about
its own failures — the two NOT CAUGHT rows at C20a, both of which changed the
code — is the kind of record the area wants and is kept by convention, not by a
process anything enforces.

## Integration and integration testing — practice

**What the area asks for.** Integration of units per the architecture, testing
of the integrated items against their interfaces, and evaluation of the
integration test results.

**What is here.** `apps/server/src/retention.integration.test.ts` exists because
a mutation proved the whole feature could be left unwired in `buildApp` with
every unit test still green — an integration gap found by the mutation loop
rather than by a plan. `infra/compose-smoke.sh` and the `compose` CI job run the
built containers together, and the C13 Playwright suite runs against them.

**What is absent.** Nothing states which integrations must be tested; the
suites cover the ones somebody thought of. There is no integration plan to
evaluate results against.

## System testing — practice

**What the area asks for.** Verification of the software system's requirements,
including the risk controls, with the results evaluated and any deferred
anomalies documented.

**What is here.** `apps/web/e2e/journey.spec.ts` drives a real browser against a
real server process and asserts the caregiver-visible path end to end;
`scripts/check-e2e-skips.sh` fails the build when the run's own log shows more
skipped specs than the count that job declares, so a suite cannot go quiet.
Hazard rows H3 and H5 cite system-level tests as their controls, and
`scripts/check-hazard-tests.sh` fails when one of those citations stops
resolving.

**What is absent.** There are no system requirements to verify against, per the
requirements section above, so these tests verify behaviour somebody chose
rather than a specification. No anomaly list exists: nothing in this repository
records a known defect that shipped, and the honest reason is that nothing here
ships to anyone.

## V&V planning — absent

**What the area asks for.** Verification and validation planned as artifacts in
their own right: what will be verified, by what method, against what acceptance
criteria, at which stage, and who evaluates the result — written before the
verification runs, and separate from the tests that carry it out.

**What is here.** Nothing. This row exists because the three rows above it read
**practice**, and a reader who stopped at the table would reasonably conclude
that verification is covered here. The suites are real; the plan they would
execute does not exist, and no document in this repository decides what is
enough.

**Why the distinction is not pedantry.** A test suite answers "did this pass".
A V&V plan answers "was passing this the right thing to require", and it has to
be written first or the answer is circular. Every coverage threshold in this
workspace was set just under an already-measured floor
(`apps/server/vitest.config.ts` and its four siblings say so in their comments),
which is a ratchet against regression and explicitly not a criterion chosen in
advance. `README.md` lists this among the gaps a real submission would need,
and it is the gap this map is least able to soften.

## Release — partial

**What the area asks for.** Verification that activities and tasks are complete,
documented known residual anomalies, an archived and reproducible released
version, and a record of how it was created.

**What is here.** The strongest evidence in this area is that the release is
checked by the registry rather than by the job that pushed it: the `publish` job
pulls the SHA tag back out of `ghcr.io`, runs `infra/verify-image-identity.sh`
against what came back, and asserts `latest` resolves to the same digest.
Reproducibility has real support — `pnpm-lock.yaml` at lockfileVersion 9.0, base
images pinned to a patch digest-adjacent tag in `infra/*.Dockerfile`, and
`pnpm install --frozen-lockfile` in every CI job.

**What is absent.** This repository cuts no version tags, so `latest` means "the
newest commit on `main` that passed CI" and there is no released version to
archive. There is no residual anomaly list accompanying a release, no release
approval, and one step the pipeline cannot take: a GHCR package is created
private, so anonymous pullability stays deliberately unasserted (C19,
`docs/ROADMAP.md`).

## Configuration management — practice

**What the area asks for.** Identification of configuration items including
SOUP, controlled change with approval and traceability, and a record of the
configuration of each release.

**What is here.** git with linear history, commit hygiene enforced at three
layers — `.claude/settings.json`, `.githooks/commit-msg` active via
`core.hooksPath`, and `scripts/check-commit-hygiene.sh` in CI — with the banned
pattern byte-identical across the last two and asserted so by
`scripts/test-githooks.sh`. Dependency configuration is pinned by
`pnpm-lock.yaml`; action versions are held internally consistent by
`scripts/check-action-versions.sh`, which chose consistency over newness
precisely so that somebody else's release cannot turn a green build red
(`docs/DECISIONS.md` #26).

**What is absent.** Change control is one person merging their own pull
requests. No configuration item is identified as SOUP anywhere (planned — C21),
and three tools that gate every build — the prettier and markdownlint pins in
the `docs-lint` job, and the checksummed SwiftLint download in the `ios` job —
are pinned in `.github/workflows/ci.yml` rather than in any manifest, so
`pnpm install --frozen-lockfile` does not reproduce them.

## Problem resolution — absent

**What the area asks for.** Problem reports investigated, the cause found where
possible, the relevance to safety evaluated, change requests raised, and the
problem tracked to closure — with trends analysed across reports.

**What is here.** Nothing. There is no problem report as a document type, no
identifier, no state, and nothing to track to closure.

**What this repository has instead, which is not that.**
`docs/ai/mutation-log.md` records every deliberate break and its outcome,
`docs/DECISIONS.md` records the reasoning behind fixes, and where a defect
produced a hazard, the row in `docs/regulatory/hazard-analysis.md` cites the
test that now pins it — H5 exists because the shipped iOS app opened no socket
at C17 with a green suite. That is a genuinely good record and it is a record of
faults this project went looking for, which is the opposite direction from a
problem arriving unbidden from someone using the software.

`SECURITY.md` describes coordinated disclosure for a repository, a different
obligation from device complaint handling. There is no trend analysis because
there is no population of reports to trend. Nobody outside the author has ever
reported anything, which is the honest reason this row is empty rather than
thin.

## Risk management — practice

**What the area asks for.** Identification of software items that could
contribute to a hazardous situation, identification of the causes, risk control
measures, verification of those measures, and traceability from hazard through
cause and control to verification.

**What is here.** [hazard-analysis.md](hazard-analysis.md) carries eight
hazards, every one populated from a defect this project actually had, each
naming its control and citing the test that demonstrates it.
`scripts/check-hazard-tests.sh` fails the build when a citation stops resolving
— a missing file, a renamed test, a skipped one, or a row citing nothing — which
is the mechanism this whole directory rests on.

**What is absent, and it is a structural gap rather than a missing document.**
Traceability runs one direction only. Each row cites a test; no test cites a
row, so a control can be deleted and the guard still passes as long as the test
name survives. The hazards also came from defects rather than from a systematic
sweep over functions, interfaces and foreseeable misuse, and the estimation and
acceptability columns a risk register needs are not there — the table says so
itself, and [risk-register.md](risk-register.md) is a seed file until C21 builds
the register (planned — C21).

## SOUP — planned, C21

**What the area asks for.** Each SOUP item identified by title, manufacturer and
version; the functional and performance requirements it must meet stated; the
hardware and software it needs in order to meet them stated; its published
anomaly list evaluated for whether any known defect can produce a hazardous
situation; and the whole set held under configuration management.

**What is here.** Nothing. No document in this repository identifies a single
dependency as SOUP, and the workspace declares 37 third-party npm packages
across six manifests before counting actions, base images and build tools.

**Planned in this row.** A SOUP inventory and a guard that diffs it against the
manifests — the same commit that lands them updates this section. Until then
this row is empty, and `README.md` lists the missing inventory among the gaps.

## Maintenance — absent

**What the area asks for.** A maintenance plan, feedback received and evaluated
as problem reports, and modifications made under the same discipline as
development, including re-evaluation of risk.

**What is here.** Dependabot, daily on two ecosystems, and nothing else.
`docs/DECISIONS.md` #27 records that no artifact in this repository verifies
dependency currency, and that this is a load-bearing assumption rather than a
gap a guard could close.

**What is absent.** Everything else. There is no maintenance plan, no released
version to maintain, no user to receive feedback from, and no post-market
surveillance —
[README.md](README.md#gaps--what-a-real-submission-would-need-that-this-has-none-of)
lists that among the gaps. The limit on what Dependabot covers is measured in
`docs/DECISIONS.md` #27: it examines a dependency only once a full manifest scan
has read it, and the scan of 2026-08-05 had read eight of the 37.

---

## The pattern in the absences

Five areas read **practice** and five read **absent**, and the tempting summary
— verification on one side, planning on the other — does not survive being
checked against the table. Both halves need narrowing, and the narrowing is
more interesting than the slogan.

On the absent side, four of the five are planning or record-keeping:
development planning, V&V planning, problem resolution, maintenance.
**Detailed design is the exception.** It is neither, and it is absent for a
reason the other four do not share — at this size, read by its author, the
source is the detailed design, and a separate document would be a transcription
that rots. That is a defensible omission rather than an incentive failure, and
it is the one absent row that nobody deciding to care more would fill.

On the practice side, three are verification or control outright: system
testing, configuration management, risk management. The other two are not.
**Unit implementation and verification** and **integration and integration
testing** each pair a doing half with a checking half, and it is the checking
half that earns the verdict in both — the suites, the ratchets and the mutation
log, not the implementation they measure. The first draft of this paragraph
called that row "unit verification", dropping the word "implementation" and
making the claim read truer than it was, which is the same reaching-for-the-
nearest-artifact the table's own rule forbids.

What survives is narrower and still worth stating. **Everything this repository
does well is downstream of code that already exists**, and everything it lacks
would have had to be written before that code. The cause of the four planning
absences is visible in the repository's own incentives: a test, a guard and a
coverage ratchet are demonstrable to a reader in seconds, while a development
plan is a document whose value is only realised by an auditor who does not exist
here. Maintenance is absent for a plainer reason still — nothing here has ever
been released to anyone.

One consequence deserves to be stated rather than left in the table. **Nothing
here traces forward.** Requirements are schemas, tests are chosen rather than
derived, and hazard rows cite tests while no test cites a hazard row — so the
chain a lifecycle standard actually asks for, from system requirement through
software requirement and design to the test that verifies it and the risk
control it implements, is not merely incomplete. It has no direction, and adding
the missing documents would not create one.

That is the honest verdict of this map: the parts of a lifecycle this repository
has are real and checked, and they are the parts that a lifecycle standard
treats as consequences of the parts it does not have.
