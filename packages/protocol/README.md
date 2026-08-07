# @maekbeat/protocol

The wire contract every Maekbeat component shares: TypeScript types and zod schemas
for the vitals frame. This package is the source of truth, imported by three
components today: packages/vitals-sim emits these frames (since C2), apps/server
validates every inbound frame against them (since C6), apps/web parses the
frames and alert events inside each response with `vitalsFrameSchema` and
`alertEventSchema` (since C10), and apps/ios mirrors it in hand-written Swift
`Codable` types (since C14).

Swift has no zod, and nothing generates those types. What keeps them from
drifting is that apps/ios decodes the same `packages/vitals-sim/golden`
fixtures the TypeScript golden suite pins, so a rename on either side breaks a
test against bytes neither language owns. The limits of that — the alert and
decision shapes have no cross-language fixture, and Swift's `Codable` ignores
unknown keys where `z.strictObject` rejects them — are tabulated in
apps/ios/README.md.

## Vitals frame

| Field            | Type    | Unit             | Bounds  |
| ---------------- | ------- | ---------------- | ------- |
| `v`              | literal | protocol version | `1`     |
| `deviceId`       | string  | —                | 1–64 ch |
| `seq`            | int     | frame counter    | ≥0      |
| `capturedAtMs`   | int     | Unix epoch ms    | >0      |
| `heartRateBpm`   | int     | beats/min        | 0–300   |
| `spo2Pct`        | number  | %                | 0–100   |
| `respirationRpm` | number  | breaths/min      | 0–120   |
| `motion`         | number  | normalized 0–1   | 0–1     |

Notes on the contract:

- Bounds are transport validity — the sensor-representable range, not clinical
  thresholds. An HR of 15 or an SpO2 of 45 is a frame the pipeline exists to
  surface; the schema rejects only malformed readings, and severity judgment
  belongs to the alert engine (planned — C7).
- The schema is strict — unknown keys are rejected, so corrupted or forged frames
  fail validation instead of passing through (`src/vitals.ts`). Evolution policy:
  a breaking change bumps the literal `v`; receivers reject unknown versions.
- `frameKey` is `(deviceId, seq)` and deliberately excludes timestamps: a device
  clock adjustment must never change a frame's identity. `seq` increments
  monotonically per device; timestamps order frames, they do not identify them.
- Known limit of that identity: it assumes `seq` monotonicity across the device's
  lifetime, so a reboot that resets `seq` to 0 would collide with earlier frames.
  Resolved at C6 (docs/DECISIONS.md #11): ingest scopes dedupe to (deviceId,
  sessionEpoch, seq) — a `seq` regression past a 64-frame reorder window starts a
  new server-side session, while smaller regressions dedupe as late arrivals or
  retransmits (apps/server/src/store.ts).
- Residual limits of that rule, on the record: a reboot occurring before `seq`
  exceeds the reorder window is absorbed as duplicates until `seq` passes the old
  values; and any pre-reboot frame arriving after a new session has started is
  mislabeled into the new epoch — it can re-store an already-stored frame, drag
  the high-water mark back up, and fork a further spurious session. The C15
  gateway must therefore resume from its last delivered `seq` on reconnect and
  never replay older frames. Shipped at C15 (apps/ios `UplinkQueue`), and running
  it against a real server corrected the first half of this note: an in-window
  reboot is **not** absorbed by the server as duplicates, because it never
  reaches the server. The gateway's own resume rule refuses to send anything at
  or below the last acknowledged `seq`, so the rebooted session's early frames
  are dropped on the phone until `seq` passes the old high-water mark — data
  loss rather than deduplication, demonstrated by a test in apps/ios rather than
  predicted here. Removing these limits outright would still take a wire-level
  boot id, i.e. a `v` bump.
- The wire frame carries one timestamp, `capturedAtMs` (device clock). It has no
  freshness bound at the contract level — freshness is an ingest-time check — and the
  server stamps its own `receivedAtMs` at ingest (apps/server/src/ingest.ts, since C6); clock-drift
  handling is specified in docs/ARCHITECTURE.md (the `receivedAtMs − capturedAtMs`
  delta is the drift signal; alert windows evaluate on server receive time).
- Integer scaling is deliberate: `heartRateBpm` is whole beats, matching how BLE
  heart-rate measurements are reported; `spo2Pct` and `respirationRpm` allow
  fractional resolution; `motion` is unitless, normalized to 0–1.

## Alert event (since C7)

`alertEventSchema` (src/alerts.ts) is the first live exercise of the evolution
policy: an additive type — new schema export, vitals frame untouched, `v` stays
`1`. It carries one alert through its lifecycle: `alertId` (stable across
states — the C12 acknowledgement handle), `deviceId`, `metric`, `direction`,
`state` (`raised` → `ongoing` → `resolved`), `raisedAtMs`/`resolvedAtMs`, and
`windowStats` over the judging window.

Timestamps on alert events are server receive time, never device clock —
the clock policy fixed in docs/ARCHITECTURE.md (drift shifts charts, never
alerts). Like the vitals frame, the schema is strict: unknown keys are
rejected.

## Fan-out messages (since C11)

`streamMessageSchema` (src/stream.ts) is the second additive exercise of the
evolution policy: new schemas, the vitals frame untouched, `v` stays `1`. It
types the server-to-dashboard direction, which `/ingest` does not cover.

- `storedVitalsFrameSchema` — the wire frame plus the two server stamps,
  `receivedAtMs` and `sessionEpoch`. Defined here because the shape is now on
  the wire in both directions; apps/server and apps/web both read it from here
  rather than restating it.
- `streamMessageSchema` — a discriminated union of `ready` (sent once on
  subscribe, carrying the server's `ringCapacity`), `frame`, and `alert`. An
  unknown `type` is rejected, so a receiver never renders a message it does not
  understand.

## Acknowledgement (since C12)

`alertDecisionEventSchema` and `alertDecisionRequestSchema` (src/acks.ts) are the
third additive exercise: new schemas, vitals frame untouched, `v` stays `1`. A
decision is an appended event — `eventId`, `alertId`, `decision`, `actor`,
`recordedAtMs` — never a mutable field on the alert, so the current decision is
derived with `latestDecisions()` and the history survives a change of mind.

The two decisions are `acknowledged` (seen, acted on) and `dismissed` (seen,
judged not actionable); that distinction is the false-alarm signal the C23
product loop counts. `actor` is caller-asserted provenance, not an
authenticated identity — nothing in this system authenticates anything yet.

## Device silence (since C20a)

`deviceSilenceEventSchema` (src/silence.ts) is the fourth additive exercise: a
new schema and a fifth `streamMessageSchema` member, vitals frame untouched, `v`
stays `1`.

It is **not** an `alertEventSchema`, and that is the design rather than an
oversight. A threshold alert is a claim about a value and carries a metric, a
direction and a window; silence is a claim about the absence of frames and
carries none of those. `alertMetricSchema` names three vitals, so folding
silence into the alert record means either widening that enum or picking one of
the three — and picking one produces a record saying a heart rate crossed a line
when what happened is that nothing arrived at all. The two share the lifecycle
(`alertStateSchema`) and the `alertId` format, so one decision route judges
both, and nothing else. The full trade, including what it costs apps/ios, is
docs/DECISIONS.md #30.

## Commands

```sh
pnpm --filter @maekbeat/protocol test
pnpm --filter @maekbeat/protocol typecheck
```
