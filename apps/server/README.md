# @maekbeat/server

The Maekbeat API server, C5–C6 of [docs/ROADMAP.md](../../docs/ROADMAP.md): WebSocket vitals ingest validated against [@maekbeat/protocol](../../packages/protocol), a bounded per-device ring buffer, and REST reads — all in the OpenAPI document. The sliding-window alert engine lands at C7.

## Run it

```sh
pnpm --filter @maekbeat/server demo   # first runnable pipeline: sim -> WS -> buffer -> REST
pnpm --filter @maekbeat/server dev    # tsx watch src/main.ts
pnpm --filter @maekbeat/server test
pnpm --filter @maekbeat/server typecheck
```

[scripts/demo.ts](scripts/demo.ts) streams 30 vitals-sim frames through a real WebSocket client, exercises the duplicate and invalid-frame rejects, then reads everything back over REST — including the `receivedAtMs − capturedAtMs` drift signal.

## WebSocket ingest — `GET /ingest`

One JSON-encoded vitals frame per message, validated with `vitalsFrameSchema`; there is no batching. Every message gets a JSON reply from [src/ingest.ts](src/ingest.ts): `{type: "ack", deviceId, seq, sessionEpoch, receivedAtMs, newSession}` on accept, or `{type: "rejected", reason: "invalid_json" | "invalid_frame" | "duplicate", ...}` on drop. A reject never closes the socket — one bad frame must not sever a stream carrying good ones.

Declared limits, honestly: max message size is 16 KiB (`INGEST_MAX_PAYLOAD_BYTES`) — the one transport-level exception, closing the connection with code 1009 — and plain HTTP requests to `/ingest` get 426. Ingest is unauthenticated and the device map grows with every distinct `deviceId`, so `RING_CAPACITY` bounds memory per device, not per process. No throughput numbers are claimed anywhere; those arrive with the C19 k6 profile.

`receivedAtMs` is stamped from the server clock at ingest and stored beside each frame. That lands the clock-drift policy of [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md): the `receivedAtMs − capturedAtMs` delta is the drift signal, and C7 alert windows will evaluate on server receive time.

## Sessions and dedupe

Dedupe scope is `(deviceId, sessionEpoch, seq)`, per [docs/DECISIONS.md](../../docs/DECISIONS.md) #11: a `seq` regression past `SEQ_REORDER_WINDOW` (64, [src/store.ts](src/store.ts)) means reboot and starts a new session epoch; regressions inside the window are late arrivals (accepted once) or retransmits (dropped as `duplicate`, counted). Residual limits are recorded in [packages/protocol/README.md](../../packages/protocol/README.md).

## Store and REST reads

The store ([src/store.ts](src/store.ts)) keeps at most `RING_CAPACITY` frames per device in arrival order, evicting the oldest arrival first; retransmits of evicted frames still dedupe while their `seq` stays inside the reorder window. Reads sort by `(capturedAtMs, seq)` at query time, so out-of-order arrivals sit in the buffer as they came and leave in capture order.

- `GET /devices` — device summaries (`sessionEpoch`, `frameCount`, `lastSeq`, `lastReceivedAtMs` as the staleness signal, `duplicatesDropped`) plus process-lifetime ingest counters.
- `GET /devices/:deviceId/frames?since&limit` — frames from the window; `since` is an inclusive `capturedAtMs` bound, `limit` defaults to 100 (max 1000). Unknown device: 404.
- `GET /healthz` — status, uptime, version. Swagger UI at `/docs` when `NODE_ENV=development`; [src/openapi.test.ts](src/openapi.test.ts) pins the exact route list.

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
