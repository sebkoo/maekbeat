# @maekbeat/server

The Maekbeat API server, C5–C8 of [docs/ROADMAP.md](../../docs/ROADMAP.md): WebSocket vitals ingest validated against [@maekbeat/protocol](../../packages/protocol), a bounded per-device ring buffer, a sliding-window alert engine, and REST reads — all in the OpenAPI document. Dashboard fan-out lands at C11.

## Run it

```sh
pnpm --filter @maekbeat/server demo   # first runnable pipeline: sim -> WS -> buffer -> REST
pnpm --filter @maekbeat/server dev    # tsx watch src/main.ts
pnpm --filter @maekbeat/server test
pnpm --filter @maekbeat/server test:coverage   # v8 coverage report (gate lands at C9)
pnpm --filter @maekbeat/server typecheck
```

[scripts/demo.ts](scripts/demo.ts) streams 130 vitals-sim anomaly frames through a real WebSocket client at 40x demo time (alert windows scaled to match), exercises the duplicate, invalid-frame, and reboot-session paths, and reads frames and the alert lifecycle back over REST. The anomaly raises one spo2-low alert near tick 40 and resolves it near tick 93 — one pair, not one alert per bad tick.

## WebSocket ingest — `GET /ingest`

One JSON-encoded vitals frame per message, validated with `vitalsFrameSchema`; there is no batching. Every message gets a JSON reply from [src/ingest.ts](src/ingest.ts): `{type: "ack", deviceId, seq, sessionEpoch, receivedAtMs, newSession}` on accept, or `{type: "rejected", reason: "invalid_json" | "invalid_frame" | "duplicate", ...}` on drop. A reject never closes the socket — one bad frame must not sever a stream carrying good ones.

Declared limits, honestly: max message size is 16 KiB (`INGEST_MAX_PAYLOAD_BYTES`) — the one transport-level exception, closing the connection with code 1009 — and plain HTTP requests to `/ingest` get 426. Ingest is unauthenticated and the device map grows with every distinct `deviceId`, so `RING_CAPACITY` bounds memory per device, not per process. No throughput numbers are claimed anywhere; those arrive with the C19 k6 profile.

`receivedAtMs` is stamped from the server clock at ingest and stored beside each frame. That lands the clock-drift policy of [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md): the `receivedAtMs − capturedAtMs` delta is the drift signal, and C7 alert windows will evaluate on server receive time.

## Sessions and dedupe

Dedupe scope is `(deviceId, sessionEpoch, seq)`, per [docs/DECISIONS.md](../../docs/DECISIONS.md) #11: a `seq` regression past `SEQ_REORDER_WINDOW` (64, [src/store.ts](src/store.ts)) means reboot and starts a new session epoch; regressions inside the window are late arrivals (accepted once) or retransmits (dropped as `duplicate`, counted). Residual limits are recorded in [packages/protocol/README.md](../../packages/protocol/README.md).

## Alert engine

[src/alerts.ts](src/alerts.ts) is frame-driven and clockless: windows advance on `receivedAtMs` injected with each frame — the [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) policy that drift shifts charts, never alerts — and silence moves nothing (a silent device is the `lastReceivedAtMs` signal on `/devices`). Lifecycle per rule: `raised` → `ongoing` → `resolved`, then a cooldown; a breach episode starting inside the cooldown is suppressed (counted once) unless it outlives the cooldown, in which case it raises late rather than never. Hysteresis is structural — enter and exit thresholds differ and both must be sustained (N breaching / M recovered samples in the window) — so a 30-tick anomaly produces one raised and one resolved event, pinned in [src/alerts.test.ts](src/alerts.test.ts).

Every lifecycle transition starts a fresh window: resolving requires `exitCount` recoveries observed after the raise, and a suppressed episode counts once because the latch judges only samples it sees itself (pinned in [src/alerts.test.ts](src/alerts.test.ts)). The window clock is monotonic over `receivedAtMs` — a server clock step back cannot unsort the window or date a resolve before its raise, while a step forward freezes window expiry until stamps catch up, bounded by a 512-sample cap; that freeze is the declared residual limit.

Default rules are DEMO HEURISTICS for a notification demo of the kind used in monitoring research — not clinical rules, not diagnosis (see [DISCLAIMER.md](../../DISCLAIMER.md)). Override the set via `buildApp(config, { alertRules })`; `DEFAULT_ALERT_RULES` in [src/alerts.ts](src/alerts.ts) is the documented default:

| Rule       | Enter    | Exit sustained | Window | Cooldown |
| ---------- | -------- | -------------- | ------ | -------- |
| `spo2-low` | < 90 ×5  | ≥ 93 ×8        | 15 s   | 60 s     |
| `hr-low`   | < 40 ×5  | ≥ 50 ×8        | 15 s   | 60 s     |
| `hr-high`  | > 150 ×5 | ≤ 130 ×8       | 15 s   | 60 s     |

Deduped frames never reach the engine, out-of-order arrivals count at their receive time, and session epochs are deliberately ignored — values are judged as they arrive. `GET /devices/:deviceId/alerts` serves the lifecycle records (capped at 100 per device) plus per-device `raised`/`resolved`/`suppressed` counters — the first metrics of the C23 product loop.

## Store and REST reads

The store ([src/store.ts](src/store.ts)) keeps at most `RING_CAPACITY` frames per device in arrival order, evicting the oldest arrival first; retransmits of evicted frames still dedupe while their `seq` stays inside the reorder window. Reads sort by `(capturedAtMs, seq)` at query time, so out-of-order arrivals sit in the buffer as they came and leave in capture order.

- `GET /devices` — device summaries (`sessionEpoch`, `frameCount`, `lastSeq`, `lastReceivedAtMs` as the staleness signal, `duplicatesDropped`) plus process-lifetime ingest counters.
- `GET /devices/:deviceId/frames?since&limit` — frames from the window; `since` is an inclusive `capturedAtMs` bound, `limit` defaults to 100 (max 1000). Unknown device: 404.
- `GET /devices/:deviceId/alerts` — alert lifecycle records + counters (see [src/reads.ts](src/reads.ts)); the alert shape mirrors `alertEventSchema` from [@maekbeat/protocol](../../packages/protocol), pinned by a drift test.
- `GET /healthz` — status, uptime, version. Swagger UI at `/docs` when `NODE_ENV=development`; [src/openapi.test.ts](src/openapi.test.ts) pins the exact route list.

## Test map

One row per test file, mapping it to the behaviors it pins — the file-to-behavior half of the C20 traceability story, wired before requirement IDs exist. Property suites run on fixed seeds with fixed iteration counts, so CI is deterministic; the review attacks from C6 and C7 live on here as regression tests, not as one-off session artifacts.

| File                                                       | Pins                                                                                                                       |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| [src/config.test.ts](src/config.test.ts)                   | env defaults and overrides; invalid values rejected with the variable named                                                |
| [src/app.test.ts](src/app.test.ts)                         | /healthz body and version; central error handler masks 5xx outside development, passes 4xx through                         |
| [src/store.test.ts](src/store.test.ts)                     | dedupe identity, reorder-window edges, reboot epochs, eviction, read ordering                                              |
| [src/store.property.test.ts](src/store.property.test.ts)   | seeded seq-pattern attacks vs a docs/DECISIONS.md #11 oracle — 5 seeds × 400 rounds × 2 devices × 2 capacities             |
| [src/alerts.test.ts](src/alerts.test.ts)                   | lifecycle, hysteresis, cooldown latch, monotonic window clock, golden transition ticks, 10-seed silence sweep              |
| [src/alerts.property.test.ts](src/alerts.property.test.ts) | clock-regression fuzz (10 seeds × 400 frames): alternation, timestamp order, monotonicized-clock equivalence; frozen clock |
| [src/ingest.test.ts](src/ingest.test.ts)                   | per-message WS replies, reject-never-closes, dedupe-before-engine seam, HTTP 426, close 1009                               |
| [src/failures.test.ts](src/failures.test.ts)               | mid-stream drop then reconnect (same epoch resumes), malformed burst continuation, post-1009 state intact                  |
| [src/isolation.test.ts](src/isolation.test.ts)             | parallel sockets with interleaved devices: no window, session, or counter bleed across devices                             |
| [src/journey.test.ts](src/journey.test.ts)                 | vitals-sim → WS client → ingest → engine → REST anomaly journey, DEFAULT_ALERT_RULES unscaled                              |
| [src/reads.test.ts](src/reads.test.ts)                     | REST read ordering, since/limit, 404 shape, wire-contract drift guards                                                     |
| [src/openapi.test.ts](src/openapi.test.ts)                 | exact route surface in the OpenAPI document, Swagger UI mounted in development only                                        |

Coverage is measured with `pnpm --filter @maekbeat/server test:coverage` ([vitest.config.ts](vitest.config.ts), v8 provider, all of src/ minus tests in the denominator — including the uncovered process entry [src/main.ts](src/main.ts)). The number is reported in the C8 commit body; the CI gate that ratchets it lands at C9.

## Configuration

| Variable        | Default       | Values                                                 |
| --------------- | ------------- | ------------------------------------------------------ |
| `HOST`          | `127.0.0.1`   | bind address; use `0.0.0.0` in containers              |
| `PORT`          | `3000`        | integer, 1–65535                                       |
| `LOG_LEVEL`     | `info`        | `fatal` `error` `warn` `info` `debug` `trace` `silent` |
| `NODE_ENV`      | `development` | `development` `test` `production`                      |
| `RING_CAPACITY` | `1024`        | frames kept per device, 1–65536                        |

Configuration is read from `process.env` only ([src/config.ts](src/config.ts)); [.env.example](.env.example) documents each variable and holds no secrets. To use a file, copy it to `.env` and pass `--env-file=.env` to Node, or export the variables in the shell.

## Skeleton (C5)

[src/app.ts](src/app.ts) carries the C5 base: pino logging, a central error handler that masks 5xx details outside development, @fastify/swagger. [src/main.ts](src/main.ts) handles startup and graceful shutdown — SIGTERM/SIGINT drain in-flight requests via `app.close()`, the same signal path an ECS task stop will use (infra planned — C19).
