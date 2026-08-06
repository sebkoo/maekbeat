# Decisions

This file is the interview-speed summary layer on top of the ADRs in docs/adr/. It grows one entry per phase, and entries link to a full ADR where one exists — today that is only ADR-0001 (docs/adr/0001-stack-and-name.md). Each entry states the decision, the alternatives, the trade-offs, and why it was made now.

**1. Fastify (see ADR-0001)**  
Decision: Fastify on Node 22 for the ingest and REST server in apps/server.  
Alternatives: Express, NestJS.  
Trade-offs: Smaller middleware ecosystem than Express and fewer batteries than Nest, in exchange for first-class JSON-schema validation, @fastify/swagger OpenAPI generation, and lower per-request overhead.  
Why now: C5–C7 need schema-validated WebSocket and REST routes, and choosing the framework at C0 keeps the path to a runnable C5 unblocked.

**2. WebSocket ingest**  
Decision: WebSocket for phone-to-server frame ingest and server-to-dashboard push.  
Alternatives: MQTT, server-sent events, HTTP polling.  
Trade-offs: MQTT suits constrained devices but adds a broker to operate; SSE is one-way; polling burns phone battery and works against the 2 s frame-to-dashboard target.  
Why now: The C6 ingest path and the C11 live chart both need bidirectional streaming, and one protocol serves both ends.

**3. BLE simulator before hardware**  
Decision: A simulator transport driven by packages/vitals-sim lands (C2, C14) before any CoreBluetooth code (C15).  
Alternatives: Buying a development wearable first; mocking only at the server boundary.  
Trade-offs: A simulator hides real radio behavior — pairing, RSSI drops, mid-stream disconnects — which the C15 state machine must still handle explicitly.  
Why now: It keeps the server path runnable without hardware from C5 on, and CI can drive the simulator deterministically.

**4. Synthetic data only**  
Decision: Every vital sign in this repo comes from packages/vitals-sim; no human data enters the project.  
Alternatives: Public physiological datasets such as PhysioNet; recorded personal data from a consumer wearable.  
Trade-offs: Synthetic traces lack real-world noise and sensor artifacts, so alert-engine results do not generalize to clinical signals.  
Why now: An educational demo has no IRB, no consent pipeline, and no HIPAA posture, and synthetic data keeps the not-a-medical-device positioning honest.

**5. AWS CDK (see ADR-0001)**  
Decision: AWS CDK in TypeScript for the infra/ stacks.  
Alternatives: Terraform, AWS SAM, raw CloudFormation.  
Trade-offs: CDK ties the repo to AWS and CloudFormation semantics, where Terraform would stay portable across clouds.  
Why now: The target stack (S3, Lambda, ECR, ECS) is AWS-specific already, CDK stays inside the monorepo's TypeScript toolchain, and `cdk synth` is checkable in CI at C19.

**6. ECS over EKS**  
Decision: ECS on EC2 as the container runtime for apps/server.  
Alternatives: EKS (Kubernetes), plain EC2 with systemd units.  
Trade-offs: Less portability and a thinner ecosystem than Kubernetes, in exchange for less operational overhead and fewer moving parts.  
Why now: This system prioritizes reliability and iteration speed, and a single service with one task definition does not need a Kubernetes control plane.

**7. pnpm monorepo (see ADR-0001)**  
Decision: One pnpm workspace holding apps/, packages/, and infra/.  
Alternatives: A polyrepo per app; npm or yarn workspaces.  
Trade-offs: One repo couples CI time and release cadence across apps, while pnpm's strict node_modules layout surfaces phantom dependencies early.  
Why now: The packages/protocol schemas must stay in lockstep with server and web from C1 on, and a single lockfile makes that change atomic.

**8. Swift native (see ADR-0001)**  
Decision: Native Swift + SwiftUI for the iOS app in apps/ios.  
Alternatives: React Native, Flutter.  
Trade-offs: No UI code shared with apps/web, and a second language in the repo.  
Why now: BLE background work is platform-specific — CoreBluetooth state restoration and background modes — and native is my strongest lane.

**9. Single harness commit C0**  
Decision: Single harness commit C0.  
Alternatives: Splitting config, docs, and CI into separate commits.  
Trade-offs: One heavier first diff to review, instead of small reviewable steps.  
Why now: Hooks, CI, and settings implement one rule together; they only work as a whole, and packing them into C0 keeps every later commit pure feature evidence.

**10. Irwin–Hall noise over Box–Muller**  
Decision: vitals-sim approximates gaussian noise as a rescaled sum of three uniforms (packages/vitals-sim/src/prng.ts).  
Alternatives: Box–Muller or ziggurat transforms; a seeded normal-distribution library.  
Trade-offs: A coarser normal — hard ±3 bound, blunter tails — in exchange for arithmetic that is bit-exact under IEEE 754, where Box–Muller's Math.log/Math.cos may round differently per engine.  
Why now: C3 pins byte-identical golden fixtures (packages/vitals-sim/golden/), and that only holds cross-engine if generation never touches engine-dependent math.

**11. Seq regression starts a new device session**  
Decision: Ingest dedupe is scoped to (deviceId, sessionEpoch, seq): a `seq` more than SEQ_REORDER_WINDOW (64, apps/server/src/store.ts) below the session's high-water mark starts a new server-side session; regressions inside the window dedupe as retransmits or late arrivals.  
Alternatives: A wire-level boot/session id (a protocol `v` bump); connection-scoped sessions; treating any regression as a new session.  
Trade-offs: A reboot before `seq` exceeds the window is absorbed as duplicates, and any pre-reboot frame arriving after the new session starts is mislabeled into it — possibly re-storing an old frame and forking a further session (limits recorded in packages/protocol/README.md) — in exchange the wire stays v1 and out-of-order arrivals inside the window survive, where connection-scoped sessions would break C15 reconnect-replay idempotency and any-regression would misread every late packet as a reboot.  
Why now: C6 ingest must handle replays and reboots today, the caveat has been on the record in packages/protocol/README.md since C1, and C15's reconnect design needs the rule fixed before the gateway exists.

**12. Alert state is encoded three ways, hue last**  
Decision: raised, ongoing, and resolved each carry a word, a mark glyph, and a border style alongside their colours (apps/web/src/styles/tokens.css), asserted pairwise distinct by apps/web/src/styles/tokens.test.ts.  
Alternatives: a red/amber/green triad; colour plus an icon font; patterned fills.  
Trade-offs: three cues per state cost badge width and one extra token pair per state, where a hue triad would be smaller and instantly familiar — but red/amber/green is the exact palette deuteranopia and protanopia collapse, and a greyscale screenshot flattens it entirely.  
Why now: the C12 timeline renders these same three states and its WCAG 2.2 AA pass grades them, so fixing the encoding at the scaffold commit keeps C12 a verification step rather than a redesign.

**13. Min/max envelope decimation, and gaps before buckets**  
Decision: the live chart thins its series by keeping each bucket's lowest and highest sample (apps/web/src/chart/geometry.ts), and splits the series at coverage gaps before any thinning happens.  
Alternatives: stride sampling every n-th frame; largest-triangle-three-buckets; drawing every frame and letting the browser cope.  
Trade-offs: an envelope emits up to two points per bucket instead of one and draws a band rather than a smooth line where the signal is noisy, and splitting first costs a second pass — in exchange no local extreme can be sampled away, where stride sampling drops whatever falls between its steps and would silently delete a one-sample SpO2 trough, and no bucket can span a hole and quietly reconnect the line across it.  
Why now: C11 is the first commit that draws vitals at all, the ring holds more frames (1024) than the plot has pixels, and the desaturation trough is the exact signal this project exists to surface — pinning both rules with tests at the first chart keeps C12's timeline and C23's demo honest by construction.

**14. Acknowledgement is an appended event, and the chart is not a live region**  
Decision: a decision on an alert is appended to a server-side log (apps/server/src/acks.ts) and never written onto the alert; and the only aria-live region on the dashboard announces alert transitions and decisions, never streaming vitals (apps/web/src/components/AlertAnnouncer.tsx).  
Alternatives: an `acknowledged` boolean on the alert record; client-side-only acknowledgement; making the chart region polite so screen-reader users hear the numbers too.  
Trade-offs: the log costs a derivation on every read and grows until its retention bound, where a boolean would be one field — but a boolean cannot answer who judged what and when, cannot distinguish acknowledged from dismissed over time, and dies on reload if it lives in the client, taking the C23 false-alarm metric with it. Announcing the numbers would suit a user checking a single reading and would punish everyone else, since a 1 Hz chart inside a live region interrupts roughly once a second; the summary stays available on demand through the chart's own label.  
Why now: C12 is the first commit where a person acts on an alert, C22 needs the audit shape to already exist rather than to be retrofitted, and the WCAG 2.2 AA pass grades the live-region choice here rather than at C23.

**15. Evict decided alerts before undecided ones**  
Decision: the per-device alert history stays bounded at ALERT_HISTORY_LIMIT, but eviction sorts by decision state first and age second — a triaged alert is dropped before any alert nobody has judged (apps/server/src/alerts.ts).  
Alternatives: raise the cap; drop the bound and keep every alert; keep arrival-order eviction and accept the loss.  
Trade-offs: eviction now asks the decision log a question per drop, and a device whose backlog is entirely undecided still forces a drop — now counted as `forcedEvictions`, served on GET /devices and logged at warn, where before it was silent; an unbounded history would remove the hazard entirely at the cost of memory growing with uptime, which is the property the bound exists to hold.  
Why now: the C12 acknowledgement route exposed an alert that could become permanently un-decidable once evicted, and discarding an untriaged alert is the system throwing away exactly what a caregiver has not yet seen — the same law as the protocol's transport bounds and the chart's min/max decimation.

**16. A macOS CI job for apps/ios, and goldens as the cross-language contract** \
Decision: apps/ios is gated by its own `ios` job on a GitHub-hosted macOS runner — SwiftLint `--strict`, an app-target build, and `xcodebuild test` with an `xccov` line-coverage ratchet (apps/ios/scripts/) — and its hand-written Swift Codable types are kept honest by decoding the same packages/vitals-sim/golden NDJSON fixtures the TypeScript suites pin, with no code generation and no copied fixture. \
Alternatives: a written, deliberate exemption from the coverage ratchet with a compensating control; generating the Swift types from the zod schemas; committing a second copy of the goldens under apps/ios; running the suite on a self-hosted Mac. \
Trade-offs: the job adds two to four minutes to every pull request and a floating Xcode from the runner image, and the gate measures one metric where each vitest.config.ts ratchets four, since xccov reports no branch or function percentage — against which an exemption would have left the first non-JavaScript app in the repository ungated, which is the hole C9 closed for the web reopening in a new language. Generation would make the Swift types a projection of the schema and prove nothing about the bytes; a copied fixture would be a second truth that drifts silently. The fixture route costs a real gap instead: the goldens are vitals frames only, so the alert, decision, and REST envelope shapes have no cross-language pin, and Swift's Codable ignores unknown keys where `z.strictObject` rejects them — closed at test time by round-tripping each frame's key set, not at runtime on the wire (apps/ios/README.md tabulates the rest). \
Why now: C14 is the first Swift in the repository and the first directory `pnpm -r` cannot see, so both the gate and the contract mechanism had to be decided before any code depended on them — and the cost objection turned out not to exist: standard GitHub-hosted runners, macOS included, are free and unmetered for public repositories, and this repository is public (checked 2026-08-05 against GitHub's Actions billing documentation).

**17. A pure link state machine behind a stupid CoreBluetooth adapter** \
Decision: every decision about the BLE link lives in `BLELinkMachine`, a value type with no radio, no clock and no framework import, whose whole 9 × 11 transition matrix is asserted — ninety-nine cells, each for the landing state and the exact effect list; `CoreBluetoothCentral` only translates delegate callbacks into events and effects into calls, and is the single file in apps/ios permitted to import the framework. \
Alternatives: put the logic in the `CBCentralManager` delegate where the framework already is; wrap CoreBluetooth in a protocol and mock the framework types; buy hardware and test the real path; ship the radio path untested and say so. \
Trade-offs: the split costs an events-and-effects vocabulary that would be unnecessary in a single delegate class, and a reader has to follow one more indirection to see what a callback does — against which a delegate holding the retry counters and the timeouts would put all of it in the one place no simulator and no CI runner can execute. Mocking the framework types is not available: `CBPeripheral` and `CBService` cannot be constructed in a test, so a protocol around them buys a seam with nothing on the other side of it. Hardware would test the real path and cannot run in CI, which is the same problem one step later. \
Why now: C15 is the first commit with a radio, and the untestable surface is a design output rather than a discovery — deciding where the line falls before writing the code is what kept it at one file, and what makes the "verified by CI / needs a device" table in apps/ios/README.md a boundary rather than an apology. The measurable consequence is that the state machine reaches 100% line coverage while the adapter sits near half, and the gate's number therefore means something about the logic rather than averaging it away.

**18. The state type holds every field a transition branches on** \
Decision: `LinkState` carries the phase, `hasStreamed` and `wantsLink` as one value, with the combinations that cannot occur made unrepresentable; the transition table is indexed by that value, and every scheduled effect is cancelled by the state that leaves. \
Alternatives: keep the phase as the state and the two flags beside it, and cover the difference with scenario tests; index the table by phase and assert only the landing state, not the effects; patch the three known-bad behaviours individually. \
Trade-offs: nine states and ninety-nine cells is more table than five and fifty-five, and constructing a state now means naming two booleans where it used to mean naming a case — against which the five-state version was not a state machine but a phase machine with hidden inputs. Patching the three behaviours would have fixed the three found and left the mechanism that produced them; the matrix found a fourth (`wantsLink`) within one run of the remodel, which is the argument. \
Why now: an adversarial pass on C15 found three cells whose answer depended on where the setup path had come from. That is not three bugs, it is one: **when a transition table has path-dependent cells, the missing dimension is state that escaped the state type — and untyped state is where the bugs are.** The three symptoms were a false "readings are being missed" on a restarted session, a stale timer that made switching Bluetooth off look like a radio fault, and a documented 1 s backoff that was 2 s in code. Folding the fields in turned the first into a failing cell; the second needed the table to assert effects as well as states, because a timer outliving its owner is not a state error but a lifetime one, and that distinction is worth keeping separate rather than blurring into the same lesson.
