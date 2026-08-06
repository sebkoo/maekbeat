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

**19. The banner is scheduled by a policy the framework cannot reach** \
Decision: whether an alert becomes a notification is decided in `NotificationPolicy`, a value type with no UserNotifications import, keyed on `alertId` in a `notified` set and again in the OS notification identifier; `UserNotificationCenterAdapter` translates an authorization status, builds a request and a category, and holds no rule of its own. A decision taken from a notification action posts to the same `POST /devices/:id/alerts/:alertId/decisions` route the dashboard uses, and the banner is withdrawn only after the server has answered. \
Alternatives: schedule directly from the view model and rely on the notification identifier alone to dedupe; keep a `Set` of delivered identifiers by asking `UNUserNotificationCenter` for its pending and delivered requests; withdraw the banner optimistically and reconcile on failure; give the phone its own decision endpoint. \
Trade-offs: the split costs a protocol and a coordinator between the alert and the centre, and the counters on the link screen exist partly because a suppressed notification is otherwise invisible — against which every rule would otherwise sit in the one type this repository cannot execute: `UNUserNotificationCenter.current()` raises `NSInternalInconsistencyException` in a SwiftPM test bundle on macOS and on the simulator alike, so a policy living there would be unreachable by any gate, not merely unverified. Asking the centre for its delivered requests has the same problem and is asynchronous besides. Withdrawing optimistically is the mistake apps/web fixed at C12, one screen further out: a banner that vanishes on a request that failed is the interface claiming a log entry that does not exist. \
Why now: C16 is the first commit that writes to the server from the phone, and the alert-fatigue failure is one the client manufactures on its own — the server guarantees one raise per episode, and a client that notifies per message notifies again after every reconnect. Two things were learned by running it against a real `apps/server` rather than a stub: the engine reports every live episode as `ongoing`, so keying the notify decision on `raised` left a cold launch mid-breach silent — designing against duplicate banners had produced a missing one — and a wrong decision word on the wire passes all 243 tests on the simulator gate and fails only there.

**20. Never a measured value in a span** \
Decision: span attributes on the ingest path carry `deviceId`, `seq`, the session epoch, the duplicate and out-of-order flags, the ingest outcome, the validate and store results, the transition count, and per alert its id, lifecycle state, metric and direction — and never a heart rate, an SpO2, a respiration rate or a motion value. The rule is deliberately "never a measured value" and not the tidier "identifiers only", because the tidier one would be false: an alertId embeds the rule that fired (`spo2-low`) and `maekbeat.alert.metric` names it outright, so an alert span does disclose that a device had a low-SpO2 episode at a time. That is the alert, and a span about an alert that will not say which alert is worth nothing; the line is drawn at the reading rather than at the event. The key list is a single exported object (`SPAN_ATTRIBUTES` in apps/server/src/tracing.ts) that the tests read rather than copy, so an attribute absent from it fails the gate. \
Alternatives: attach the frame's readings to the ingest span, which is what makes a trace self-sufficient during an incident; attach them only when a rule is breaching, on the argument that a raised alert is already about the value; redact at the collector instead of at the source; drop `alert.metric` and `alert.direction` to make "identifiers only" literally true. \
Trade-offs: it costs the thing a trace is most useful for. An operator looking at a raised `spo2-low` sees which frame raised it, when, and whether it arrived out of order, but has to leave the trace and query `GET /devices/:id/frames` to learn what the value was — two systems instead of one, in the minutes when that matters. Redacting at the collector would keep the debuggability and move the control one hop out, which is where it stops being a property of this repository: a span that leaves the process with a reading in it has already left, and every deployment would have to be configured correctly for the guarantee to hold. Emitting only on breach is the worst of both, because the spans that would carry readings are exactly the ones attached to a person having an event. \
Dropping `alert.metric` would have bought nothing: the rule id is already inside every alertId, so the episode's classification travels either way, and removing the readable attribute would only have made the disclosure harder to notice while leaving it in place. \
Why now: C18 is the first commit that sends anything derived from a frame outside the process, and the posture it has to match was already written down — SECURITY.md and DISCLAIMER.md say the data is synthetic and the server authenticates nobody, which is an argument for keeping the blast radius small rather than for relaxing. Deciding it at the first export is what makes it cheap; deciding it after a dashboard depends on the attribute is what makes it a migration. The residual is named rather than implied: `deviceId` is an identifier and a trace backend is a second place it now lives, so a real deployment inherits whatever retention that backend has.

**21. No reverse proxy in front of the compose stack** \
Decision: `infra/compose.yaml` publishes the API on 127.0.0.1:3000 and the dashboard on 127.0.0.1:8080 as two origins, the browser talks to both, and the two containers never talk to each other; `infra/nginx.conf` serves static files and proxies nothing. The server's CORS allowlist names the web origin explicitly rather than using `*`. \
Alternatives: one nginx in front of both, routing `/api/` to the server and everything else to the bundle, which is the ordinary shape and would give one port and one origin; a compose-level proxy such as Traefik; keeping `CORS_ORIGIN=*` so the allowlist never has to be maintained. \
Trade-offs: it costs a port to explain, a second published address in every quickstart, and the CORS configuration that a same-origin deployment would not need. What it buys is that the composed stack has the same shape as the deployed one — the dashboard is S3-bound behind a CDN and the API is not — and that the crossing stays observable. C12 shipped a dashboard that could not reach its own API from a browser, and nothing caught it because every suite mocked fetch; a proxy would put that failure back out of reach of the C13 smoke while leaving the suite green. `*` has the smaller version of the same defect: an allowlist nobody can break is an allowlist that proves nothing, and removing the web origin from the list is one of the C19 mutations precisely because it must fail. \
Why now: C19 is the first commit where the system runs as more than one process on one machine, and the topology decided here is the one every later deployment inherits. Adding a proxy afterwards is a change to what the smoke tests; deciding against it now costs one paragraph.

**22. Build for amd64 on an arm64 laptop, and assert the architecture** \
Decision: the deploy-target image is built with an explicit `--platform linux/amd64`, and `infra/verify-image.sh` asserts both that `docker image inspect` reports amd64 and that the amd64 image executes and reports `process.arch=x64`. `docker compose up` builds for the host instead, because the stack exists to be run locally. \
Alternatives: build a multi-architecture manifest with `buildx --platform linux/amd64,linux/arm64` and publish both; build only for the host and let CI produce the deploy artifact; declare arm64 the target and choose Graviton instances. \
Trade-offs: two builds instead of one, an amd64 build that is slower on this host because `pnpm install` runs under emulation (20.5 s against 13.1 s, measured — infra/README.md), and two tags to keep straight. A multi-architecture manifest is the better answer once anything is published and is more than this commit needs, since nothing is published yet. Building only for the host is the option that fails silently: `docker build` on an arm64 machine produces an arm64 image and says nothing, so the mistake surfaces as `exec format error` on the target rather than as a red build here. Choosing Graviton would make the host and the target agree and is a hosting decision this repository has not made. \
Why now: C19 is the first commit that produces an artifact for a machine other than the one building it, and the architecture mismatch is the cheapest container failure to prevent and the most expensive to discover. The assertion is on the built artifact rather than on the build command because a flag can be dropped and a comment can be wrong.

**23. A slow fan-out subscriber is dropped, never quietly thinned** \
Decision: each dashboard socket may hold at most `STREAM_MAX_BUFFERED_BYTES` (256 KiB) of undelivered fan-out, checked before every send; a subscriber over that is unsubscribed, closed with code 1013, logged at warn and counted as `slowSubscribersDropped` (apps/server/src/stream.ts). The number is one default ring's worth rounded to a power of two, on the argument that past a ring's worth behind a subscriber gains nothing by staying attached — a reconnect back-fills the whole ring over REST and anything older is already evicted. \
Alternatives: keep the socket and discard the messages that overflow; sample or thin the stream under pressure; derive the cap from `RING_CAPACITY` at runtime; leave it unbounded, which is what C11 through C19 did. \
Trade-offs: dropping costs a caregiver dashboard its live connection at exactly the moment its connection is worst, and costs the server a reconnect and a REST read it would not otherwise serve. Discarding messages instead is cheaper on every axis and is the one option this repository cannot take: a stream that skips frames and stays open produces gaps the client is never told about, so apps/web draws a continuous line across data it never received. That is the C11 gap rule inverted from the server side, and it is the exact signature of the C17 defect in apps/ios — `backfill()` re-read frames and not alerts, so an episode opening during an outage healed the chart across a gap where the alarm did not exist. A visible close is what makes the loss recoverable, because both clients already treat any close as reconnect-and-back-fill. Deriving the cap from `RING_CAPACITY` would tie a per-socket transport bound to a per-device store bound and let a capacity change silently retune the network path; the flat constant is stated once and measured once. Leaving it unbounded was defensible only while nobody had measured what a stalled subscriber costs, which is 12.1 MB over 60 000 frames, about 18 MB a day at 1 Hz. \
Why now: C19 is the commit that ran the server under sustained load, and the gap had been recorded as a stated limit twice on the grounds that picking a threshold before measuring one would be inventing it. The measurement exists now, so the argument for deferring it does not. The composition risk is pinned rather than reasoned about: apps/server/src/fanout-bound.test.ts raises an alert while no subscriber is attached and asserts it is still readable on the reconnect, and a mutation that skipped the alert engine whenever nothing was subscribed — the plausible optimisation that would rebuild C17's hole — fails exactly there.
