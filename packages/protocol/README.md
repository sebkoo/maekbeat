# @maekbeat/protocol

The wire contract every Maekbeat component shares: TypeScript types and zod schemas
for the vitals frame. This package is the source of truth — the server (planned — C5)
and web dashboard (planned — C10) will import it directly, and the iOS app will
mirror it in Swift (planned — C14).

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
  The resolution — a session/boot id in the dedupe scope, or treating `seq`
  regression as a new session — is a C6 ingest decision, exercised for real by
  the C15 BLE reconnect work (docs/ROADMAP.md).
- The wire frame carries one timestamp, `capturedAtMs` (device clock). It has no
  upper bound at the contract level — freshness is an ingest-time check — and the
  server stamps its own `receivedAtMs` at ingest (planned — C6); clock-drift
  handling lands with the C4 architecture doc (docs/ROADMAP.md).
- Integer scaling is deliberate: `heartRateBpm` is whole beats, matching how BLE
  heart-rate measurements are reported; `spo2Pct` and `respirationRpm` allow
  fractional resolution; `motion` is unitless, normalized to 0–1.

## Commands

```sh
pnpm --filter @maekbeat/protocol test
pnpm --filter @maekbeat/protocol typecheck
```
