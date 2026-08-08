# Risk register

Maekbeat is not a medical device and there is no manufacturer here. Read
[README.md](README.md) in this directory first, and
[hazard-analysis.md](hazard-analysis.md) second — this register scores the rows
that document identifies and adds two it does not have.

This is the register [hazard-analysis.md](hazard-analysis.md) forwards to: the
columns that table deliberately left out, which are severity, an ordinal fault
reachability, and acceptability judged against criteria stated before the table.
**Probability of harm is not among them.** It is carried as `unestimated` in
every row, which is why no risk score appears anywhere below.

## What each file holds, and what stops them drifting

The two documents overlap on purpose and the overlap is checked, which is a
different arrangement from the one the seed file described.

[hazard-analysis.md](hazard-analysis.md) **identifies** hazards: the sequence of
events, the harm, the control, and the residual. This file **scores** them, and
adds two hazards that identification never reached. So H1 to H8 appear in both,
by the same ID and under the same label, while the sequence-of-events and
control text lives only in the hazard analysis and the severity, reachability
and acceptability columns live only here.

That shared ID-and-label pair is one fact in two tables, which is exactly the
drift `scripts/check-scope-ranges.sh` exists to prevent elsewhere. **It is kept
because a register naming only `H4` would be unreadable, and it is checked
rather than trusted.** Since C21 `scripts/check-hazard-tests.sh` asserts three
things: every hazard in the analysis has a row here, every row here is either
one of those hazards or is marked `register-only`, and for a shared ID the two
label cells are byte-identical. Editing a hazard's name in one file and not the
other fails the build.

H2 is the row the seed file was created for, identified at C12a while building
something else. Nothing about it moved at C21; it is identified in the hazard
analysis and scored here, like the other seven.

### Why two rows are `register-only`

The two documents have different admission rules, and the marker records that
rather than excusing an omission. [hazard-analysis.md](hazard-analysis.md)
states its own rule in its opening lines: every row is "populated from
something that actually happened here ... a defect this repository found,
fixed, and pinned with a test". Its scope is hazards **of implemented
behaviour, reached by a defect**. This register also holds hazards reached by
asking what could go wrong, which that rule excludes by construction — and the
hazard analysis names that exclusion as its own limitation.

So `register-only` does not mean "we did not get round to adding a row". It
means the row fails the hazard table's admission rule, and each of the two says
which way:

- **H9, battery.** The behaviour does not exist. `packages/protocol/src/vitals.ts`
  declares no battery field, so no battery state reaches the server, nothing
  can alarm on it, and there is no implemented behaviour for a hazard row to
  describe. It is not a defect that was found and fixed; it is a capability
  that was never built.
- **H10, BLE range.** The behaviour exists and is controlled — `LinkTiming`
  backoff and the C20a silence sweep — but it was never a defect here. Those
  controls were built for link loss in general, not in response to an
  out-of-range incident, so the row has no "something that actually happened"
  to cite and cannot meet the hazard table's rule even though its tests pass.

The consequence is worth stating plainly: a hazard nobody has hit yet can only
be recorded here, and this register is therefore the only document in the
repository that holds one.

## The criteria, fixed before the table below

Stated first because a criterion written after the rows it judges is not a
criterion. Whether that is what happened here is the subject of the last part of
this section, and the answer is uncomfortable.

### Severity — S1 to S3

Severity is the axis that depends least on this repository's own state, because
for eight of the ten rows the harm is already named in
[hazard-analysis.md](hazard-analysis.md) and was named there before any of this
existed. The two rows this register adds — battery and BLE range — have no such
prior statement, so their severity is assigned here for the first time and is
marked in the table as newly assigned rather than inherited.

| Value  | Meaning                                                                         |
| ------ | ------------------------------------------------------------------------------- |
| **S3** | Death or serious injury is conceivable in the use scenario the hazard describes |
| **S2** | Injury or materially delayed care, not life-threatening                         |
| **S1** | No injury. Loss of a record, or degraded information a person can still act on  |

The rule is therefore checkable rather than a matter of judgement: where a
hazard row exists, severity is taken from its Harm cell and nowhere else, and
where none exists the register says so in the row.

### Fault reachability — R1 to R3, and it is not a probability

This column is the **probability that the software fault occurs** — the first
half of the decomposition, and only the first half. It is **ordinal and anchored
to evidence in this repository**, and every value names a fact a reader can go
and check:

| Value  | Meaning                                             | What the row must cite                       |
| ------ | --------------------------------------------------- | -------------------------------------------- |
| **R1** | The sequence cannot complete in the code as written | The test that demonstrates the impossibility |
| **R2** | It can complete. Not observed                       | Why nothing prevents it                      |
| **R3** | It can complete, and was observed at least once     | The commit or run where it happened          |

**Every value is assessed against the code as it stands now, and history goes
in the evidence column rather than in the value.** A fault that occurred at C17
and has since been prevented is **R1**, with C17 as its evidence — the register
is a statement about the current system, not a list of scars. Whether a control
prevents the sequence or merely softens what follows is not an input to the
value; it falls out of it, because a control that only softens leaves the
sequence able to complete.

**No number appears in this column, and that is the whole point.** A defect that
occurred once during development is a statement about reachability — the code
could do this, and did — not a rate. Turning "it happened at C17" into "0.02 per
device-year" would be exactly the fabrication
[hazard-analysis.md](hazard-analysis.md) refuses in its own missing-columns
section, and it would be worse than leaving the column out, because a number
carries an authority a word does not.

R1 is deliberately hard to earn. "A test covers it" is not R1; R1 means the
sequence of events in the hazard row cannot complete in the code as written, and
the row has to say what makes that true rather than what makes it unlikely.

### Probability of harm — unestimated, and not filled in

Risk is not severity times fault frequency. A fault has to occur **and then
reach a person as harm**, and those are two different probabilities: the first
is whether the software misbehaves, the second is whether that misbehaviour
becomes injury given the patient, the caregiver, the setting and the time to
respond. Splitting them this way is the structure the risk management standard
itself uses rather than a device invented here — described from secondary
reading, since ISO 14971's text is unread and
[README.md](README.md#citations-i-could-not-verify) records why.

**The second probability is not estimated in this register, and appears in every
row as `unestimated` rather than as a value.** Estimating it needs an intended
population, an exposure duration, a caregiver response model and clinical data.
This project has a simulator it wrote itself, no user, and no device.

It is not set to "high" to be conservative. A conservative-looking guess is
still a guess; it would push every row to the top of any matrix it were fed
into, which reads as diligence and is actually the same fabrication with a safer
face. It is not omitted either — a missing column looks like an oversight, while
a column reading `unestimated` in every row is a finding.

**So no risk score is computed anywhere in this register, and no row carries
one.** Risk needs both probabilities; this has one. Any cell multiplying
severity by reachability would be arithmetic on incommensurable things dressed
as a result.

### What "acceptable" can and cannot mean here

Because there is no risk score, the acceptability column **cannot** be the
judgement a real register makes. That judgement is "is this residual risk
acceptable in view of the benefit the device delivers", and it needs a device, a
population, a benefit and criteria agreed by a manufacturer's quality system.
Maekbeat has none of the four.

What can be evaluated is narrower and worth stating, so the column asks a
question this project can actually answer. **A row is marked `demonstrated`
when all three hold:**

- **C1 — the control exists in code**, at a path the row cites.
- **C2 — a test demonstrates it and runs**, cited as `path::test title`, and
  therefore checked by `scripts/check-hazard-tests.sh` in the CI hygiene job,
  which runs on pushes to `main` and pull requests against it — not on a push
  to a feature branch.
- **C3 — the residual is stated** as what the control does not reach, in the
  row, in terms specific enough to be wrong.

Anything else is `not demonstrated`, and the row names which of the three is
missing.

**This is an engineering-completeness criterion and not a risk-acceptability
criterion.** The distinction is not pedantry: `demonstrated` says this project
did what it could verify, and says nothing whatever about whether the remaining
risk would be acceptable to a patient, a caregiver or a regulator. A register
that let the first quietly stand in for the second would be the most misleading
document in this repository, because it would be wrong in the vocabulary that
sounds most correct.

### The defect in this method, named because it cannot be hidden

**These criteria were fixed after the hazards were already known, and a risk
management process is supposed to fix them before.** The reason for the ordering
rule is precisely the failure it prevents: criteria written with the findings in
view can be shaped, consciously or not, until the findings pass them.

That is what happened here and there was no alternative. The eight hazards
landed at C20, populated from defects this repository had already had, and this
register is written afterwards against those rows. The criteria could not have
been fixed in advance of an analysis that already existed, so calling them
"fixed in advance" — the phrase `docs/ROADMAP.md` uses for this row — would be
false in the one place it most matters.

The concrete risk is that C1 to C3 were chosen because the existing rows already
satisfy them. **They do: all eight inherited rows come out `demonstrated`.** A
criterion nothing fails is a description wearing a judgement's clothes, and that
result is what the bias would produce.

The two rows added here — battery and BLE range — were meant to be the test,
since their criteria genuinely preceded their analysis. **Only one of them
tests anything, and it fails for a reason no criterion can take credit for.**
BLE range comes out `demonstrated`: its controls, tests and residual are all
real, and the guard extension in this commit is what made C2 true of it.
Battery comes out `not demonstrated` because the feature does not exist —
`packages/protocol/src/vitals.ts` has no battery field — and a row with nothing
in it fails any criteria whatever.

**So the discriminating power of C1 to C3 is untested, on a sample of one.**
The observation that would count is a row where a criterion shaped to fit would
have passed and these caught it. Nothing here is that. Nine of ten rows pass,
and the one failure is a missing capability rather than a judgement about a
control, so the criteria have never yet had to discriminate between a
well-controlled hazard and a poorly controlled one.

The suspicion about the eight inherited rows therefore stands undischarged.
This section is not entitled to retire it, and the count moving from eight to
nine makes it slightly worse rather than better.

A real process would also have someone other than the author apply the
criteria. Here the person who wrote them, wrote the rows, and wrote the code
they judge are the same person, which no amount of structure in this document
fixes.

## The register

Ten rows. H1 to H8 are the hazards in [hazard-analysis.md](hazard-analysis.md),
scored here for the first time; H9 and H10 are added by this register and exist
in no other table.

`S` is severity, `R` is fault reachability, and `P(harm)` is the probability
that the fault, having occurred, reaches a person as harm — the column this
project cannot estimate. Every citation below is checked by
`scripts/check-hazard-tests.sh`, which reads this table as of C21.

<!-- register:rows -->

| ID  | Hazard                                                                          | S   | R   | P(harm)       | Acceptability    | Basis, and what is missing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------- | --- | --- | ------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | An alert raised while the caregiver's client is disconnected is never delivered | S3  | R3  | `unestimated` | demonstrated     | Control in `apps/server/src/alerts.ts`; history outlives the socket and replays on reconnect. Observed at C17. **R3 not R1**: a server restart during the gap still loses the alert, so the sequence completes — `apps/server/src/failures.test.ts::resumes the same session epoch and an alert lifecycle spans the gap`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| H2  | An alert is evicted before anyone triages it                                    | S3  | R3  | `unestimated` | demonstrated     | Control in `apps/server/src/alerts.ts` (`evictOne`), decided before undecided. Identified at C12a. **R3 not R1**: a backlog that is entirely undecided still forces a drop, counted rather than prevented — `apps/server/src/eviction.test.ts::drops a decided alert before any undecided one`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| H3  | A stalled dashboard is fed a thinned stream and reads it as a continuous one    | S3  | R1  | `unestimated` | demonstrated     | Thinning was considered and rejected (`docs/DECISIONS.md` #23), so the buffer drops the subscriber instead. Never observed. The sequence cannot complete: no code path produces a thinned stream — `apps/server/src/fanout-bound.test.ts::receives a contiguous prefix and a close, never a stream with holes in it`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| H4  | Monitoring stops silently on a quiet device                                     | S3  | R2  | `unestimated` | demonstrated     | Control in `apps/server/src/silence.ts` since C20a. **R2 not R1**: `apps/ios` cannot decode a `silence` message and shows a contract failure instead, so a caregiver holding the phone still learns nothing (`docs/DECISIONS.md` #30) — `apps/server/src/silence.integration.test.ts::raises an alarm on the dashboard socket, and clears it when frames resume`                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| H5  | The shipped client monitors nothing while every unit test passes                | S3  | R1  | `unestimated` | demonstrated     | Control is composition tested against the real root screen. Observed at C17, when the shipped iOS app opened no socket. The sequence cannot complete in the code as written; the residual is that this is a test host, not a device — `apps/ios/MaekbeatKit/Tests/MaekbeatKitTests/CompositionTests.swift::testTheRootScreenStartsTheGatewayItWasGiven`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| H6  | A shutdown discards buffered telemetry, or does not finish                      | S2  | R1  | `unestimated` | demonstrated     | Control in `apps/server/src/lifecycle.ts`, ordered close then flush. Observed at C18. Sequence cannot complete for a requested stop; a crash is a different sequence and flushes nothing — `apps/server/src/lifecycle.test.ts::closes the server before flushing tracing`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| H7  | A real alert is dismissed because false ones came before it                     | S3  | R2  | `unestimated` | demonstrated     | Control is structural hysteresis plus cooldown in `apps/server/src/alerts.ts`. Never observed, because no caregiver has used this. **R2 not R1**: the false-alarm baseline is measured against a simulator this project also wrote — `apps/server/src/alerts.test.ts::a 30-tick anomaly yields ONE raised and ONE resolved event, not 30 alerts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| H8  | A notification says more than the data supports                                 | S3  | R2  | `unestimated` | demonstrated     | Control is a banned-word list enforced over the copy itself. Never observed. **R2 not R1**: a word list cannot catch a true sentence a frightened reader over-reads — `apps/ios/MaekbeatKit/Tests/MaekbeatKitTests/NotificationCopyTests.swift::testNoNotificationClaimsAClinicalMeaning`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| H9  | The wearable's battery dies and monitoring ends                                 | S3  | R2  | `unestimated` | **not** — C1, C2 | Severity newly assigned here; `register-only` because the behaviour does not exist, not because a row is missing. There is no control of any kind: `packages/protocol/src/vitals.ts` carries no battery field, so no battery state ever reaches the server and nothing can alarm on it. Detection is incidental, via H4's silence sweep, and only after the device has already stopped — `no-control: no battery telemetry in packages/protocol, nothing to alarm on` `register-only`                                                                                                                                                                                                                                                                                                                                                 |
| H10 | The wearable is carried out of BLE range                                        | S3  | R2  | `unestimated` | demonstrated     | Severity newly assigned here; `register-only` because this was never a defect here, so it fails the hazard table's admission rule. Controls: `LinkTiming` backoff in `apps/ios/.../BLE/LinkState.swift` and the C20a sweep in `apps/server/src/silence.ts`. **Residual**: detection is server-side only, so a caregiver holding the phone learns nothing — `apps/ios` cannot decode a `silence` message — and the 45 s threshold is one number for a whole fleet. C2 and C3 were both met by this commit: the guard did not read this file until now, and this residual was unstated until now — `apps/ios/MaekbeatKit/Tests/MaekbeatKitTests/BLELinkScenarioTests.swift::testRepeatedFailuresBackOffToTheCapAndStayThere` · `apps/server/src/silence.test.ts::does not fire on a routine BLE reconnect at its worst` `register-only` |

<!-- /register:rows -->
