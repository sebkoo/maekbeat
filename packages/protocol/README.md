# @maekbeat/protocol

The wire contract every Maekbeat component shares: TypeScript types and zod schemas
for the vitals frame. This package is the source of truth — the server imports it
directly (apps/server, since C6), the web dashboard will at C10, and the iOS app
will mirror it in Swift (planned — C14).

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
  never replay older frames; removing these limits outright would take a
  wire-level boot id, i.e. a `v` bump.
- The wire frame carries one timestamp, `capturedAtMs` (device clock). It has no
  freshness bound at the contract level — freshness is an ingest-time check — and the
  server stamps its own `receivedAtMs` at ingest (apps/server/src/ingest.ts, since C6); clock-drift
  handling is specified in docs/ARCHITECTURE.md (the `receivedAtMs − capturedAtMs`
  delta is the drift signal; alert windows evaluate on server receive time).
- Integer scaling is deliberate: `heartRateBpm` is whole beats, matching how BLE
  heart-rate measurements are reported; `spo2Pct` and `respirationRpm` allow
  fractional resolution; `motion` is unitless, normalized to 0–1.

## Commands

```sh
pnpm --filter @maekbeat/protocol test
pnpm --filter @maekbeat/protocol typecheck
```
