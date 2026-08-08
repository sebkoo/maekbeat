# Threat model — STRIDE

Maekbeat is not a medical device and there is no manufacturer here. Read
[../regulatory/README.md](../regulatory/README.md) first — it governs this
directory too: no device, no user, every vital synthetic.

This applies STRIDE to the boundaries and elements
[data-flow.md](data-flow.md) draws. Every row cites the `B<n>` and `E<n>` it
concerns, and `scripts/check-dataflow-paths.sh` fails the build when a cited ID
is not declared over there.

## There is no grid here, and that is deliberate

Six categories across five boundaries is thirty cells, and this system would
fill most of them with the same sentence. **The shared cause is stated once,
here, and the table below carries only what differs.**

**Nothing authenticates across any boundary in this system.** Not the BLE link,
not the ingest socket, not the fan-out socket, not the REST surface. Every
identity is a string the caller chose: `deviceId` on a frame and `actor` on a
decision are both validated for length and nothing else
([data-flow.md](data-flow.md) records this against B1 to B5, and
`apps/server/src/config.ts` says it in the code).

So "an attacker can act unauthenticated at Bn" is true five times and is one
finding, not five. Rows below are separated by **consequence** — what actually
happens differently — and where two boundaries produce the same consequence by
the same mechanism they share a row and the row says so.

## The scale is not the risk register's, and here is why

[../regulatory/risk-register.md](../regulatory/risk-register.md) scores fault
reachability R1 to R3, where the question is whether the code can produce a
fault. **Reusing that scale here would quietly change what it measures.** A
threat needs an attacker in a position — radio range, a network path, a browser
— and R has no room for that, so an R2 in the register ("it can complete, not
observed") and an R2 here would be claims about different things under one name.
That is the failure where a scale is made to cover new ground by renaming what
it was about.

So this defines its own, and keeps position in a separate column rather than
folding it into the score:

| Value  | Meaning                                                                      |
| ------ | ---------------------------------------------------------------------------- |
| **A1** | The attack cannot complete against the code as written. Cite what forbids it |
| **A2** | It can complete from the stated position. Not observed here                  |
| **A3** | It can complete, and is the standing condition or has been observed          |

**Position** is a fact about deployment, not a score: what an attacker must
already have. It is stated per row because "unauthenticated" says nothing about
whether reaching the socket is easy.

**What the column came out as, checked before it became prose.** Four rows read
A2 and one reads A3. On a sample of five that is weak discrimination, and a
scale that separates one row from four is closer to a description than a
judgement — the same doubt the risk register recorded about its own criteria.

**The zero is the finding, not the spread.** No row earns A1. Nothing in this
system forbids any of these attacks in the code as written: every one of them
completes, and the only distinction the column actually draws is between attacks
that need somebody to try them and one that is already true of every decision
ever recorded. A column with no A1 in it is not a risk profile; it is a
statement that there are no structural controls to profile.

## Harm is cited, not re-invented

Where a threat's harm is one the hazard analysis already names, the row cites
the hazard ID rather than describing the same outcome in new words. A third harm
vocabulary beside `hazard-analysis.md` and `risk-register.md` would be unguarded
and would drift, which is the failure those two documents cross-check each other
to prevent.

Where there is no hazard counterpart the row says so, and says which of two
things it means — **a gap in the hazard analysis**, or **a harm that is not
patient-facing** and therefore correctly outside it. Those are different answers
and the difference is where this document earns its place.

<!-- dfd:threats -->

| ID  | Threat                                                                | STRIDE              | Cites               | Position                                          | T   | Consequence, and the harm it reaches                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | --------------------------------------------------------------------- | ------------------- | ------------------- | ------------------------------------------------- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TH1 | The server acts on frames that did not come from the patient's sensor | Spoofing, Tampering | `B1` `B2` `E4` `E5` | A network path to the ingest port, or radio range | A2  | Two mechanisms, one consequence, so one row: fabricate frames for any `deviceId`, or alter them in flight, since neither end authenticates and the compose stack speaks plain HTTP. False excursions raise alerts nobody should act on — **H7**. The sharper half: injected frames also reset the last-seen stamp, so a device that has genuinely stopped reads as alive and the silence sweep never fires — **H4**, by suppression rather than by failure                                                                                                                                                                                                                                                                    |
| TH2 | A decision is recorded against an actor nobody authenticated          | Spoofing            | `B4` `E10` `E8`     | Any client that can reach the REST port           | A2  | `actor` is a caller-asserted string, so an alert can be marked acknowledged or dismissed by a name that triaged nothing. The alert then leaves the undecided set that eviction protects, and a caregiver reading the board sees it handled. **No hazard counterpart: this is a gap in the hazard analysis.** H2 covers an untriaged alert being discarded; nothing covers one being falsely marked triaged, and the harm is the same missed alert                                                                                                                                                                                                                                                                             |
| TH3 | A decision cannot be attributed to anyone                             | Repudiation         | `E8` `E10`          | None — it is the standing state                   | A3  | The append-only structure is a real control against **modification**, not against deletion: events are frozen on append and a change of mind is another event, but `DecisionLog` splices its oldest events away past a per-device bound of 200. Corrected at C22, having been published here from the class docstring rather than from the method. Neither property touches **false attribution**, which is what this row is about — the actor recorded was never authenticated. A review of a missed alert can read what was decided and when, and cannot establish by whom. **No hazard counterpart, and correctly so** — the harm falls on an investigation, not a patient, which is outside what a hazard analysis is for |
| TH4 | Unauthenticated ingest exhausts the bounded stores                    | Denial of service   | `B2` `E5` `E8` `E9` | A network path to the ingest port                 | A2  | Nothing rate-limits ingest; the per-message size bound closes an oversized frame (1009) and says nothing about how many arrive. A flood pushes the per-device alert history past its limit, which forces the eviction H2's control exists to ration, and fills per-subscriber send buffers until healthy dashboards are dropped — **H2** and **H3**, reached deliberately rather than by accident                                                                                                                                                                                                                                                                                                                             |
| TH5 | Unbounded subscriber count exhausts the process                       | Denial of service   | `B3` `E9`           | Any client that can reach the stream port         | A2  | `STREAM_MAX_BUFFERED_BYTES` bounds what each subscriber may buffer; nothing bounds how many subscribers exist. Enough concurrent subscriptions exhaust the one process, which ends monitoring for every device at once. **No hazard counterpart: a gap in the hazard analysis.** It arrives at H4's harm — monitoring stops — by a route H4 never considered, since H4 is about one quiet device and this is about the server itself                                                                                                                                                                                                                                                                                          |

<!-- /dfd:threats -->

## The two categories that yield nothing, and their different reasons

**Information disclosure yields no threat, because there is nothing here to
disclose.** Every value in the system is synthetic, generated by
`packages/vitals-sim/src`, and the left column of
[data-flow.md](data-flow.md)'s classification table says so. The reason is the
data's value and **not** a control: access is not restricted at all, and anyone
who can reach the ports can read every device's history. The day the right
column of that table becomes true — a real sensor, a real person — this category
yields several rows immediately, and nothing about the code would have changed.

**Elevation of privilege yields no threat, because there is no privilege to
elevate to.** The server has no roles, no sessions, no administrative surface
and no operation available to one caller and not another. Every client already
holds everything any client holds. This is a different reason from the one
above: that one says the prize is worthless, this one says there is no ladder.
It is also the category most likely to acquire content first, since the earliest
authentication anyone adds creates the first distinction between callers.

## What the guard checks, and what it does not

`scripts/check-dataflow-paths.sh` asserts that every `B<n>` and `E<n>` this
document cites is declared in [data-flow.md](data-flow.md)'s marked tables, and
that the threat table is not empty.

**It catches a threat pointing at a boundary that was renamed or removed** — the
way this document would rot first, since the diagram is the thing that moves.

**It does not check that a threat is real, that the category is right, or that
the consequence follows.** TH4 could name the wrong element and still resolve.
That judgement stays human, the same division
`scripts/check-hazard-tests.sh` makes between a citation that resolves and a
control that is adequate.

**It does not check the hazard IDs.** `H2`, `H3`, `H4` and `H7` appear above as
prose rather than as declared references, and nothing asserts they exist — the
same measured reason the path guard reads tables and not prose. Making them
checkable needs the declaration mechanism this repository already uses in
`soup-inventory.md`, `risk-register.md`, `data-flow.md` and this file — a marked
region whose column means something. Those are named rather than counted: a
count in prose is a fact in two places, and this sequence has corrected five
prose claims about other files already.
