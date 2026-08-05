# Architecture

Maekbeat's scaling chain, stage by stage, with the failure modes each stage must answer. Code-backed claims cite the repo path that proves them; every unbuilt stage is labeled "planned — C\<n\>" against [ROADMAP.md](ROADMAP.md). Every latency number here is a TARGET until C19 measures it, and the measurement method sits next to each number so the targets are falsifiable rather than decorative.

## What exists today

Two packages are real: [packages/protocol](../packages/protocol) — the wire contract, a strict zod `vitalsFrameSchema` with transport-validity bounds and the `frameKey` identity — and [packages/vitals-sim](../packages/vitals-sim), a deterministic synthetic vitals generator whose exact output is golden-pinned in packages/vitals-sim/golden/. Since C6 the server in [apps/server](../apps/server) is real as well: WebSocket ingest validating every frame, the in-process ring buffer, and REST reads — the runnable pipeline apps/server/scripts/demo.ts drives end to end. Stages downstream of the buffer (alert engine, dashboard, notification) stay planned and carry their commit numbers in the table below.

## Scaling chain

```mermaid
flowchart LR
  SIM["BLE sim"] --> GW["iOS gateway"]
  GW --> WS["WS ingest"]
  WS --> Q["queue"]
  Q --> SP["alert engine"]
  Q --> S3["S3 archive"]
  SP --> WEB["dashboard"]
  SP --> NTF["caregiver alert"]
```

| #   | Stage                  | Dev form                    | Target form                                                        | Status                                                                                              |
| --- | ---------------------- | --------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| 1   | BLE device             | packages/vitals-sim frames  | wearable speaking BLE GATT (hardware out of scope — DISCLAIMER.md) | sim shipped (C2); simulator transport planned — C14; BLE GATT doc — C15                             |
| 2   | iOS gateway            | simulator transport in-app  | CoreBluetooth central, background streaming                        | planned — C14–C15                                                                                   |
| 3   | WebSocket ingestion    | Fastify WS endpoint         | same, horizontally scaled                                          | dev form shipped — C6 (apps/server/src/ingest.ts); scaling — C19                                    |
| 4   | Event queue            | in-process ring buffer      | SQS                                                                | ring buffer shipped — C6 (apps/server/src/store.ts); SQS is target architecture, no commit assigned |
| 5   | Stream processor       | sliding-window alert engine | same, consuming SQS                                                | planned — C7                                                                                        |
| 6   | Storage                | ring-buffer window only     | S3 raw archive + time-series read model                            | ring-buffer window shipped — C6; S3 + time-series — C19                                             |
| 7   | Dashboard fan-out      | WS push to apps/web         | Lambda fan-out                                                     | planned — C11, C19                                                                                  |
| 8   | Caregiver notification | iOS notification            | same, triggered via fan-out                                        | planned — C16, C19                                                                                  |

Time-series note: the S3 raw archive (planned — C19) stores frames as NDJSON, whose frame-line serialization is already pinned by the golden fixtures in packages/vitals-sim/golden/ (fixtures additionally carry a header line the archive will not). Whether a dedicated time-series store fronts dashboard history is a C19 decision, made after the k6 profile shows the real read pattern; until then dev reads come from the ring-buffer window.

## Frame lifecycle

```mermaid
sequenceDiagram
  participant D as BLE sim
  participant G as iOS gateway
  participant S as WS ingest
  participant P as alert engine
  participant W as dashboard
  participant C as caregiver
  D->>G: frame (deviceId, seq)
  G->>S: WS send
  S->>S: stamp receivedAtMs, dedupe frameKey
  S->>P: enqueue
  P->>W: fan-out (under 2 s end-to-end TARGET)
  P->>C: notify (under 5 s end-to-end TARGET)
```

The ingest legs are real since C6 — the receivedAtMs stamp and session-scoped dedupe in apps/server/src/ingest.ts and store.ts, with the ring buffer as the enqueue target — while gateway transport (C14–C15), dashboard fan-out (C11), and notification (C16) remain unbuilt. Both TARGETs are end-to-end paths, defined precisely in the budget table below, not budgets for the single leg they annotate.

## Latency budgets — all TARGETS

| Path                                  | Target    | How C19 measures it                                                                                                                                          |
| ------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| frame capture → dashboard paint       | under 2 s | k6 drives vitals-sim frames over WS while OpenTelemetry spans (wired at C18) time ingest → queue → fan-out, and the dashboard logs receipt − `capturedAtMs`. |
| anomaly frame → notification dispatch | under 5 s | the same k6 run traces the anomaly frame's ingest span through to the notification-dispatch span, one trace per alert.                                       |

Neither number has been measured; both are budget targets per [ROADMAP.md](ROADMAP.md), and measured values replace them at C19. Scale (device concurrency) carries no number at all until the C19 k6 profile defines and measures one.

## Failure modes

| Failure mode              | Owning stage(s)           | Mechanism                                                | Status                                                    |
| ------------------------- | ------------------------- | -------------------------------------------------------- | --------------------------------------------------------- |
| duplicate packets         | ingest (3)                | `frameKey` dedupe                                        | shipped — C6 (apps/server/src/store.ts, session-scoped)   |
| delayed / out-of-order    | ingest (3), processor (5) | identity never by time; order by (capturedAtMs, seq)     | read ordering shipped — C6; alert windows — C7            |
| clock drift               | ingest (3), processor (5) | `receivedAtMs − capturedAtMs` delta; server-time windows | stamping shipped — C6; alert windows — C7                 |
| device disconnect         | ingest (3), gateway (2)   | staleness signal; BLE state machine                      | lastReceivedAtMs shipped — C6; rendering — C11; BLE — C15 |
| offline buffering, replay | gateway (2)               | on-device buffer, replay in seq order, idempotent        | dedupe shipped — C6 (windowed); gateway buffer — C15      |

The stages absent from the owning column answer by construction. The simulator (1) emits strictly monotonic `seq` and synthetic tick time, so it cannot itself produce duplicates, reordering, or drift — pinned by the golden fixtures in packages/vitals-sim/golden/ — while queue, storage, fan-out, and notification (4, 6, 7, 8) consume frames only after ingest has deduplicated and receive-stamped them, so all five modes are resolved upstream of their input. What those downstream stages still owe — delivery latency under load — is exactly what the C19 k6 profile measures.

### Duplicate packets

Frame identity is `frameKey` = (deviceId, seq), shipped in [packages/protocol/src/vitals.ts](../packages/protocol/src/vitals.ts); since C6, ingest keeps the first frame per key within a server-side session ([apps/server/src/store.ts](../apps/server/src/store.ts)), so in-session retries and replays become no-ops. The reboot caveat is resolved: a `seq` regression past the 64-frame reorder window starts a new session epoch, per the decision in [docs/DECISIONS.md](DECISIONS.md) #11 with residual limits recorded in [packages/protocol/README.md](../packages/protocol/README.md). The C15 BLE reconnect work exercises it for real.

### Delayed and out-of-order packets

A frame's identity never depends on when it arrives — `frameKey` excludes timestamps by design (packages/protocol/README.md). Ordering is (`capturedAtMs`, `seq`): the ring buffer stores frames in arrival order and REST reads sort at query time (apps/server/src/store.ts), so a late arrival inside the 64-frame reorder window is accepted once and lands in capture order. The C7 sliding window must likewise accept late frames inside its window; that part is still planned.

### Clock drift

The wire carries one timestamp, `capturedAtMs`, from the device clock, deliberately without a contract-level freshness bound ([packages/protocol/src/vitals.ts](../packages/protocol/src/vitals.ts)). The handling this document fixed now runs: the server stamps `receivedAtMs` per frame at ingest ([apps/server/src/ingest.ts](../apps/server/src/ingest.ts)) and stores it beside the frame, the `receivedAtMs − capturedAtMs` delta is the drift signal, and the C7 alert windows will evaluate on server receive time — a drifting device clock can shift a chart, never an alert. `frameKey` excludes both timestamps, so drift cannot change a frame's identity.

### Device disconnect

The server side shipped at C6 as a signal, not a verdict: GET /devices exposes `lastReceivedAtMs` per device ([apps/server/src/reads.ts](../apps/server/src/reads.ts)), sessions survive WS reconnects by design, and rendering silence instead of stale numbers is the C11 dashboard's job. C15 owns the BLE side with the state machine documented in apps/ios/README at that commit (disconnected → connecting → connected → streaming → recovering). The simulator is a pure generator ([packages/vitals-sim](../packages/vitals-sim)); transport-level disconnect simulation arrives with the C14 simulator transport.

### Offline buffering and replay

The gateway half is planned — C15: buffer frames on-device while offline, replay in `seq` order on reconnect. The server half is live: C6 ingest dedupes replays within the 64-frame reorder window (apps/server/src/store.ts), which binds the C15 gateway to resume from its last delivered `seq` rather than replaying whole sessions — the constraint recorded in packages/protocol/README.md and docs/DECISIONS.md #11.

## Measurement plan

OpenTelemetry wiring lands at C18 (Docker, compose, dashboards-as-code in infra/) and the k6 load profile at C19; from C19 on, measured numbers replace every TARGET label in this document and the README, per the [ROADMAP.md](ROADMAP.md) rule. Until then, any latency claim quoted from this file must carry the word "target".
