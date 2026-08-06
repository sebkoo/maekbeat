# @maekbeat/server

The Maekbeat API server, C5–C19 of [docs/ROADMAP.md](../../docs/ROADMAP.md): WebSocket vitals ingest validated against [@maekbeat/protocol](../../packages/protocol), a bounded per-device ring buffer, a sliding-window alert engine, REST reads, the WebSocket fan-out that feeds [apps/web](../web) — all in the OpenAPI document — OpenTelemetry spans over that path, and since C19 the build identity it serves on `/healthz`.

## Run it

```sh
pnpm --filter @maekbeat/server demo   # first runnable pipeline: sim -> WS -> buffer -> REST
pnpm --filter @maekbeat/server dev    # tsx watch src/main.ts
pnpm --filter @maekbeat/server test
pnpm --filter @maekbeat/server test:coverage   # v8 coverage + threshold gate (in CI since C9)
pnpm --filter @maekbeat/server typecheck
```

[scripts/demo.ts](scripts/demo.ts) streams 130 vitals-sim anomaly frames through a real WebSocket client at 40x demo time (alert windows scaled to match), exercises the duplicate, invalid-frame, and reboot-session paths, and reads frames and the alert lifecycle back over REST. The anomaly raises one spo2-low alert near tick 40 and resolves it near tick 93 — one pair, not one alert per bad tick. Since C11 it also attaches a dashboard subscriber to the fan-out socket and prints what that subscriber received: 131 frames and 2 alert transitions, with duplicates and rejects absent by construction.

## WebSocket ingest — `GET /ingest`

One JSON-encoded vitals frame per message, validated with `vitalsFrameSchema`; there is no batching. Every message gets a JSON reply from [src/ingest.ts](src/ingest.ts): `{type: "ack", deviceId, seq, sessionEpoch, receivedAtMs, newSession}` on accept, or `{type: "rejected", reason: "invalid_json" | "invalid_frame" | "duplicate", ...}` on drop. A reject never closes the socket — one bad frame must not sever a stream carrying good ones.

Declared limits, honestly: max message size is 16 KiB (`INGEST_MAX_PAYLOAD_BYTES`) — the one transport-level exception, closing the connection with code 1009 — and plain HTTP requests to `/ingest` get 426. Ingest is unauthenticated and the device map grows with every distinct `deviceId`, so `RING_CAPACITY` bounds memory per device, not per process. No throughput numbers are claimed anywhere; those arrive with the C19 k6 profile.

Browser reads are cross-origin in every setup this repo documents, since the dashboard runs on another port, so the API sends CORS headers — permissively by default because it is unauthenticated and holds only synthetic data, and `CORS_ORIGIN` narrows that to an allowlist. That was missing until C12 and no suite caught it, because every test used a mocked fetch and none crossed an origin. Capturing the demo GIF through a real browser did.

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

Deduped frames never reach the engine, out-of-order arrivals count at their receive time, and session epochs are deliberately ignored — values are judged as they arrive. `GET /devices/:deviceId/alerts` serves the lifecycle records plus per-device `raised`/`resolved`/`suppressed` counters — the first metrics of the C23 product loop.

### Retention: which alert leaves

The history is bounded at `ALERT_HISTORY_LIMIT` (100 per device) because memory per device must not grow with uptime. Which alert leaves is a judgement rather than a queue position: eviction drops a decided alert — acknowledged or dismissed — before any undecided one ([src/alerts.ts](src/alerts.ts), `evictOne`). Discarding an untriaged alert is the system throwing away exactly what a caregiver has not yet seen, which is the same law as the protocol's transport bounds and the dashboard's min/max decimation.

When every retained alert is undecided the bound still wins and the oldest goes — but that loss is counted as `forcedEvictions`, served as `alertsForcedEvicted` on `GET /devices`, and logged at warn. A backlog with nothing triaged in it means nobody is working through the alerts, which is an operational signal worth raising rather than a detail worth hiding. The decision record is [docs/DECISIONS.md](../../docs/DECISIONS.md) #15 and the hazard it controls is seeded in [docs/regulatory/risk-register.md](../../docs/regulatory/risk-register.md).

## Dashboard fan-out — `GET /devices/:deviceId/stream` (since C11)

The push leg of [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) stage 7, in its dev form: an in-process publisher keyed by `deviceId` ([src/stream.ts](src/stream.ts)), with the Lambda fan-out still the target form at C19. Server to dashboard only — a subscriber that sends anything is ignored, because frames enter this system through `/ingest` and nowhere else.

On subscribe the socket sends `{type:"ready", deviceId, serverTimeMs, ringCapacity}`, then one `{type:"frame", frame}` per accepted frame and one `{type:"alert", alert}` per lifecycle transition, both shaped by `streamMessageSchema` in [@maekbeat/protocol](../../packages/protocol). Publishing happens after the engine has judged the frame, so a dashboard never sees an alert before the frame that raised it, and deduped frames never reach it at all.

Subscribing to a device the server has never seen is allowed and stays silent until its first frame — a monitor that had to wait for data before attaching would miss the data it was waiting for. A subscriber whose socket dies mid-send is dropped without disturbing ingest for that device, and the close handler unsubscribes it.

### A slow subscriber is bounded, and dropped rather than quietly thinned (since C19)

Every other bound in this server is a decision with a number on it: the frame ring at `RING_CAPACITY`, the alert history at `ALERT_HISTORY_LIMIT`, the dedupe set at `SEQ_REORDER_WINDOW`, the inbound message at `INGEST_MAX_PAYLOAD_BYTES`. Until C19 the fan-out had none, and it was the only client-driven memory growth in the server. `publish` called `socket.send()` per subscriber and nothing inspected `bufferedAmount`, so a dashboard that could not keep up had its frames queued in the `ws` send buffer without limit.

The gap was stated rather than fixed for two commits, on the argument that choosing a threshold before measuring what a subscriber falls behind by would be inventing one. The measurement: a peer that completes the handshake and then never reads held 12.1 MB against 12.7 MB published over 60 000 frames, with nothing dropped and nothing closed, and one fan-out frame message is 211 bytes on the wire — so a device at 1 Hz adds about 18 MB a day for as long as that socket stays open. `bufferedAmount` tracks it almost exactly, which is what makes it a meter the server can act on.

`STREAM_MAX_BUFFERED_BYTES` is 256 KiB ([src/stream.ts](src/stream.ts)): one default ring's worth, rounded up to a power of two. That is the argument rather than a taste — past a ring's worth behind, a subscriber has nothing to gain from staying attached, because reconnecting back-fills the whole ring over REST and anything older is evicted and gone. It bounds the process's own write queue; the operating system's socket buffer sits underneath it and is not this server's memory.

At the bound the subscriber is dropped, with close code 1013 and a `warn` line naming the device and the byte count, counted as `slowSubscribersDropped`. The rejected alternative is the dangerous one: discarding messages and keeping the socket open bounds memory just as well and produces a stream whose gaps are undetectable, because a client cannot render a gap it was never told about. That is [apps/web](../web)'s C11 rule broken from the server side, and it is the exact signature of the C17 defect in [apps/ios](../ios) where the chart healed across an outage while the alarm that belonged in it did not exist. The decision record is [docs/DECISIONS.md](../../docs/DECISIONS.md) #23.

A drop is safe because both clients already recover from one: any close puts apps/web into capped-backoff reconnect and a REST back-fill of frames and alerts, and apps/ios follows the same rules. [src/fanout-bound.test.ts](src/fanout-bound.test.ts) pins the three properties that matter — the queue peak never exceeds the bound by more than the one message that crossed it, a healthy subscriber on the same device is untouched, the dropped one receives a contiguous prefix and then a close, and an alert raised while nobody is attached is still there for the reconnect that follows.

The question was raised by a test that broke: [src/stream.test.ts](src/stream.test.ts) asserted 110 delivered frames after a fixed 40 ms pause and saw 76 on a loaded CI runner. That failure was the assertion being made too early rather than the server falling behind — the fix was to wait for the delivery rather than for the clock ([test-support.ts](test-support.ts)) — but the question it raised is what this section now answers. `ringCapacity` is sent so a client knows the largest window a reconnect could recover; anything evicted past it is gone, and apps/web renders that as a gap rather than a join.

## Acknowledgement — `POST /devices/:deviceId/alerts/:alertId/decisions` (since C12)

Appends a decision to the device's log ([src/acks.ts](src/acks.ts)) and returns the appended event. The log is append-only by construction — the class has no update and no delete — so a change of mind appends a second event and the decision in force is the newest one for that alert. Who judged what, and when, survives it, which is the shape [docs/ROADMAP.md](../../docs/ROADMAP.md) C22 needs for the audit log.

`acknowledged` means seen and acted on; `dismissed` means seen and judged not actionable. Counting the second against the first is the false-alarm signal the C23 product loop asks for, and both appear in the counters on `GET /devices/:deviceId/alerts` alongside the log itself. A decision on an alert this engine never raised is refused with 404 rather than recorded, because a fiction in an audit log is worse than a missing row.

`actor` is asserted by the caller and authenticated by nothing — this server has no identity model at all (see "Declared limits" above). It is provenance, and C22 owns making it a claim worth trusting. Each appended decision is also published to every dashboard watching that device.

Presence of the alert record is deliberately not the test. The log is authoritative and the alert history in front of it is a bounded cache, so a decision is accepted for any well-formed `alertId` this device owns — the id carries its device, so ownership is checkable without the record ([src/alerts.ts](src/alerts.ts), `parseAlertId`). A malformed id is 400 and an id belonging to another device is 404, but an evicted alert stays decidable: a cache must never make a real event permanently un-triageable.

Owned and well formed is not the same as plausible, and without the record three things are still checkable from the id: the rule is one this engine judges by, the raise ordinal is one it has reached for that device, and the raise time is not in the future. An id failing those is refused, which keeps decisions on alerts this server could never have minted out of an append-only log. The residual limit is on the record: counters and history are in-process, so a restart resets what "has reached" means, and this server authenticates nobody.

## Store and REST reads

The store ([src/store.ts](src/store.ts)) keeps at most `RING_CAPACITY` frames per device in arrival order, evicting the oldest arrival first; retransmits of evicted frames still dedupe while their `seq` stays inside the reorder window. Reads sort by `(capturedAtMs, seq)` at query time, so out-of-order arrivals sit in the buffer as they came and leave in capture order.

- `GET /devices` — device summaries (`sessionEpoch`, `frameCount`, `lastSeq`, `lastReceivedAtMs` as the staleness signal, `duplicatesDropped`) plus process-lifetime ingest counters.
- `GET /devices/:deviceId/frames?since&limit` — frames from the window; `since` is an inclusive `capturedAtMs` bound, `limit` defaults to 100 (max 1000). Unknown device: 404.
- `GET /devices/:deviceId/alerts` — alert lifecycle records + counters (see [src/reads.ts](src/reads.ts)); the alert shape mirrors `alertEventSchema` from [@maekbeat/protocol](../../packages/protocol), pinned by a drift test.
- `POST /devices/:deviceId/alerts/:alertId/decisions` — append an acknowledgement or a dismissal (see [src/acks.ts](src/acks.ts)).
- `GET /devices/:deviceId/stream` — the WebSocket fan-out above (see [src/stream.ts](src/stream.ts)).
- `GET /healthz` — status, uptime, version. Swagger UI at `/docs` when `NODE_ENV=development`; [src/openapi.test.ts](src/openapi.test.ts) pins the exact route list.

## Tracing — instrumented, not observable (since C18)

The ingest path emits OpenTelemetry spans ([src/tracing.ts](src/tracing.ts), created in [src/ingest.ts](src/ingest.ts)). This is instrumentation: no collector is deployed and no backend is stood up here, so nothing in this repository makes the running system observable.

One trace per frame, rooted at `ingest.frame` because nothing upstream propagates trace context. Its children are `ingest.validate`, `store.ingest`, `alert.evaluate` and `stream.fanout`; each lifecycle transition is an `alert.transition` grandchild under the evaluation that produced it. Every parent is passed explicitly rather than taken from an ambient context, and [src/tracing.shape.test.ts](src/tracing.shape.test.ts) asserts the tree by span id — a name check would pass a pile of correctly-named roots.

Attributes never carry a measured value. The full set is `deviceId`, `seq`, the session epoch, the duplicate and out-of-order flags, the ingest outcome, the validate and store results, the transition count, and per alert its id, lifecycle state, metric and direction — enumerated once in `SPAN_ATTRIBUTES` ([src/tracing.ts](src/tracing.ts)), which the privacy test reads rather than copies. "Never a measured value" is the honest phrasing rather than "identifiers only": the alert id embeds the rule that fired, so an alert span does say a device had a low-SpO2 episode. Heart rate, SpO2, respiration and motion never appear (docs/DECISIONS.md #20). `alert.transition` spans carry `raised` and `resolved` only — an episode's `ongoing` frames update the record in place and do not cross the fan-out seam, so no transition event exists for them.

Off unless `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set: the provider then holds no span processor at all, so there is no exporter, no batch queue and no timer, and every span is non-recording. On `SIGTERM` the server is closed first and the tracer provider flushed second, so spans from requests still draining are exported rather than dropped ([src/lifecycle.ts](src/lifecycle.ts)). A flush that cannot reach its collector is logged and does not fail the stop — otherwise a server that carried traffic would exit non-zero on every deploy while the collector was down, and an idle one would exit clean.

The close frame is a request, not a guarantee. `app.close()` asks every WebSocket peer to leave and waits, and a peer that never answers — a phone that lost signal mid-episode — is destroyed by `ws` only after thirty seconds, longer than any container grace period. So a sweep runs one second into the stop and terminates whoever is left, at warn ([src/lifecycle.ts](src/lifecycle.ts)); without it the orchestrator's SIGKILL arrives first and takes the flush, the log line and the exit code with it.

## Test map

One row per test file, mapping it to the behaviors it pins — the file-to-behavior half of the C20 traceability story, wired before requirement IDs exist. Property suites run on fixed seeds with fixed iteration counts, so CI is deterministic; the review attacks from C6 and C7 live on here as regression tests, not as one-off session artifacts.

| File                                                           | Pins                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [src/config.test.ts](src/config.test.ts)                       | env defaults and overrides; invalid values rejected with the variable named; BUILD_REVISION required in production and absent elsewhere                                                                                                                           |
| [src/app.test.ts](src/app.test.ts)                             | /healthz body and version; central error handler masks 5xx outside development, passes 4xx through                                                                                                                                                                |
| [src/store.test.ts](src/store.test.ts)                         | dedupe identity, reorder-window edges, reboot epochs, eviction, read ordering                                                                                                                                                                                     |
| [src/store.property.test.ts](src/store.property.test.ts)       | seeded seq-pattern attacks vs a docs/DECISIONS.md #11 oracle — 5 seeds × 400 rounds × 2 devices × 2 capacities                                                                                                                                                    |
| [src/alerts.test.ts](src/alerts.test.ts)                       | lifecycle, hysteresis, cooldown latch, monotonic window clock, golden transition ticks, 10-seed silence sweep                                                                                                                                                     |
| [src/alerts.property.test.ts](src/alerts.property.test.ts)     | clock-regression fuzz (10 seeds × 400 frames): alternation, timestamp order, monotonicized-clock equivalence; frozen clock                                                                                                                                        |
| [src/ingest.test.ts](src/ingest.test.ts)                       | per-message WS replies, reject-never-closes, dedupe-before-engine seam, HTTP 426, close 1009                                                                                                                                                                      |
| [src/failures.test.ts](src/failures.test.ts)                   | mid-stream drop then reconnect (same epoch resumes), malformed burst continuation, post-1009 state intact                                                                                                                                                         |
| [src/isolation.test.ts](src/isolation.test.ts)                 | parallel sockets with interleaved devices: no window, session, or counter bleed across devices                                                                                                                                                                    |
| [src/journey.test.ts](src/journey.test.ts)                     | vitals-sim → WS client → ingest → engine → REST anomaly journey, DEFAULT_ALERT_RULES unscaled                                                                                                                                                                     |
| [src/reads.test.ts](src/reads.test.ts)                         | REST read ordering, since/limit, 404 shape, wire-contract drift guards                                                                                                                                                                                            |
| [src/stream.test.ts](src/stream.test.ts)                       | fan-out isolation per device, unsubscribe on close, a broken subscriber not breaking ingest, frame-before-its-alert order                                                                                                                                         |
| [src/acks.test.ts](src/acks.test.ts)                           | append-only log, decisions in force, retention by eviction, the decision route, its 404 and 400 paths, fan-out of a decision                                                                                                                                      |
| [src/openapi.test.ts](src/openapi.test.ts)                     | exact route surface in the OpenAPI document, Swagger UI mounted in development only                                                                                                                                                                               |
| [src/lifecycle.test.ts](src/lifecycle.test.ts)                 | shutdown order (server closed before tracing flushed), no exit on the clean path, non-zero exit on a failed one, the peer sweep and its polite-client control                                                                                                     |
| [src/tracing.shape.test.ts](src/tracing.shape.test.ts)         | span parentage by span id over a golden replay, arrival attributes, identifiers-not-readings, traced vs untraced alert bytes                                                                                                                                      |
| [src/tracing.lifecycle.test.ts](src/tracing.lifecycle.test.ts) | off wires no span processor; SIGTERM flushes over real OTLP/HTTP and the process exits on its own — with a polite client attached, and with a raw peer that answers nothing                                                                                       |
| [src/load.test.ts](src/load.test.ts)                           | what only load reaches: a stop after real traffic exits clean and flushes every span, and still exits clean when the flush is refused; alert transitions identical to a quiet run under eight other devices; dedupe across parallel reordered, duplicated streams |
| [src/fanout-bound.test.ts](src/fanout-bound.test.ts)           | the per-subscriber send-buffer bound: the queue peak, the healthy-subscriber control, a contiguous prefix and a 1013 close for the one dropped, and an alert raised during the outage still readable on the reconnect                                             |

Coverage is measured with `pnpm --filter @maekbeat/server test:coverage` ([vitest.config.ts](vitest.config.ts), v8 provider, all of src/ minus tests in the denominator — including the uncovered process entry [src/main.ts](src/main.ts); the one file outside the gate is the demo wiring, [scripts/demo.ts](scripts/demo.ts)). Since C9 the config carries thresholds set just under the measured floor, and the CI tests job runs the coverage-enabled suite, so a regression fails the build. Thresholds are a ratchet — they move only up, never down, never via new exclusions or narrowed globs (policy: [CLAUDE.md](../../CLAUDE.md)).

The gate and the reporting are separate things, and C10 separated them in CI ([.github/workflows/ci.yml](../../.github/workflows/ci.yml)): the vitest thresholds run on every trigger, while the Codecov upload is skipped where its token cannot exist. Checked 2026-08-05 against GitHub's documented behaviour, that means pull requests opened off forks, which are denied Actions secrets, and Dependabot-triggered runs, which read a separate secret store. Without the condition `fail_ci_if_error` would fail healthy contributions once C23 opens the repo; with it, a fork pull request still cannot slip a coverage regression through, because the threshold check is local to vitest.

## Configuration

| Variable                             | Default           | Values                                                                |
| ------------------------------------ | ----------------- | --------------------------------------------------------------------- |
| `HOST`                               | `127.0.0.1`       | bind address; use `0.0.0.0` in containers                             |
| `PORT`                               | `3000`            | integer, 1–65535                                                      |
| `LOG_LEVEL`                          | `info`            | `fatal` `error` `warn` `info` `debug` `trace` `silent`                |
| `NODE_ENV`                           | `development`     | `development` `test` `production`                                     |
| `RING_CAPACITY`                      | `1024`            | frames kept per device, 1–65536                                       |
| `CORS_ORIGIN`                        | `*`               | browser origins allowed to read: `*` or a comma list                  |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | unset             | http(s) URL; unset means tracing is off entirely                      |
| `OTEL_SERVICE_NAME`                  | `maekbeat-server` | `service.name` on every exported span                                 |
| `BUILD_REVISION`                     | unset             | the commit this build came from; required under `NODE_ENV=production` |

Configuration is read from `process.env` only ([src/config.ts](src/config.ts)); [.env.example](.env.example) documents each variable and holds no secrets. To use a file, copy it to `.env` and pass `--env-file=.env` to Node, or export the variables in the shell.

`BUILD_REVISION` is the one variable whose absence is fatal, and only in production. A developer checkout is a working tree rather than a commit, so outside production the server says `unidentified` on `/healthz` instead of inventing a SHA. A production image that cannot name its commit cannot be caught serving a stale layer, so there it refuses to start with the variable named — the container image passes it as a build argument and stamps the same value on `org.opencontainers.image.revision` ([infra/server.Dockerfile](../../infra/server.Dockerfile)).

## Skeleton (C5)

[src/app.ts](src/app.ts) carries the C5 base: pino logging, a central error handler that masks 5xx details outside development, @fastify/swagger. [src/main.ts](src/main.ts) is composition only; the shutdown sequence moved to [src/lifecycle.ts](src/lifecycle.ts) at C18, where it is tested — SIGTERM/SIGINT drain in-flight requests via `app.close()` and then flush the tracer provider, the same signal path an ECS task stop will use. The container form of that stop shipped at C19: `docker compose stop -t 10` against [infra/compose.yaml](../../infra/compose.yaml), asserted with a peer attached that answers nothing ([infra/compose-smoke.sh](../../infra/compose-smoke.sh)).
