# @maekbeat/web

The caregiver dashboard, C10–C12 of [docs/ROADMAP.md](../../docs/ROADMAP.md): a React 19 + Vite + TypeScript app with the design tokens the rest of Phase 4 draws from, a typed client for the [apps/server](../server) surface, and — since C11 — live vitals over the fan-out WebSocket. C12 adds the alert timeline, server-recorded acknowledgement, and the WCAG 2.2 AA pass.

## Run it

```sh
pnpm --filter @maekbeat/web dev             # vite dev server on :5173
pnpm --filter @maekbeat/web test
pnpm --filter @maekbeat/web test:coverage   # v8 coverage + threshold gate (joined the CI gate at C10)
pnpm --filter @maekbeat/web typecheck
pnpm --filter @maekbeat/web build           # static bundle in dist/
pnpm --filter @maekbeat/web test:e2e        # Playwright smoke: real browser, real server
```

Point the dashboard at a server with `VITE_API_BASE_URL` ([.env.example](.env.example)); it defaults to `http://127.0.0.1:3000`. The server alone ingests nothing, so `pnpm --filter @maekbeat/server dev` in a second shell gives the honest empty state; add `pnpm --filter @maekbeat/server demo` in a third and the device list fills from the ring buffer that run drives.

## Third consumer of the wire contract

apps/web imports [@maekbeat/protocol](../../packages/protocol) directly, after [packages/vitals-sim](../../packages/vitals-sim) (C2) and [apps/server](../server) (C6), and before the iOS app mirrors it in Swift (planned — C14). Frames and alert events are parsed with the shared schemas themselves in [src/api/contracts.ts](src/api/contracts.ts), so a server that drifts from the contract fails the read here instead of painting a wrong number.

Strictness splits on purpose. Frames and alert events stay strict — an unknown key means a corrupted payload and a real change bumps the protocol version — while the listing and page envelopes around them are permissive, so an added server counter cannot blank a caregiver's screen.

## Design tokens

Every colour, space, size, and radius lives in [src/styles/tokens.css](src/styles/tokens.css); no other file names a value. [src/styles/app.css](src/styles/app.css) reads them through `var(--mb-*)`, and component-local aliases (`--badge-fg`) are assigned from tokens rather than introducing new values.

There is one accent (`--mb-color-accent`) because this is a clinical-adjacent monitoring surface: colour carries state, not decoration. Dark mode arrives through `prefers-color-scheme`, where the block redefines exactly the colour tokens — spacing, type, radii, and the alert marks stay put, so the shape of the interface does not change when the lights go out.

[src/styles/tokens.test.ts](src/styles/tokens.test.ts) enforces all of it across every shipped file: families present, one accent, dark parity, no colour literal or paint attribute outside tokens.css, no dangling `var(--mb-*)`, and no token without a reader. Text pairs are asserted at 4.5:1 in both themes and meaningful non-text pairs at 3:1 (WCAG 2.2 SC 1.4.3 and 1.4.11 contrast minimums). The rest of the WCAG 2.2 AA work landed at C12 and is described below.

## Alert state palette

Fixed at C10 because the C12 timeline renders these same three states. Hue is the last cue, never the only one, so the states stay apart for dichromats and in greyscale:

| State      | Word       | Mark | Border style | Colour role             |
| ---------- | ---------- | ---- | ------------ | ----------------------- |
| `raised`   | "raised"   | ▲    | solid        | `--mb-alert-raised-*`   |
| `ongoing`  | "ongoing"  | ◆    | dashed       | `--mb-alert-ongoing-*`  |
| `resolved` | "resolved" | ✓    | dotted       | `--mb-alert-resolved-*` |

[src/components/AlertStateBadge.tsx](src/components/AlertStateBadge.tsx) renders the word; the mark and border style come from the tokens through the `data-alert-state` attribute. The test asserts the three marks and the three border styles are pairwise distinct, so a later edit cannot quietly collapse the encoding back onto colour.

## States are designed, not fallbacks

Every read renders from one union in [src/data/useAsync.ts](src/data/useAsync.ts), so no screen can render nothing and call it a view. [src/components/StatusPanel.tsx](src/components/StatusPanel.tsx) carries the four:

| State          | Says               | When                                                             |
| -------------- | ------------------ | ---------------------------------------------------------------- |
| `loading`      | "Reading devices"  | read in flight; `role="status"`, `aria-busy`                     |
| `empty`        | "No data yet"      | server reachable, window holds no frames — with the demo command |
| `error`        | "This read failed" | the server answered with a failure, message carried through      |
| `disconnected` | "Connection lost"  | the API could not be reached at all                              |

A fifth path is the one nobody designs: a component that throws. [src/components/ErrorBoundary.tsx](src/components/ErrorBoundary.tsx) catches it inside the shell, so the failure gets an error panel and the not-a-medical-device line stays on screen — a blank page reads as calm, which is the one thing this surface must never do by accident.

Since C11 the connection has its own four states on the device page, from the transport rather than from a guess: `connecting`, `live`, `reconnecting`, and `disconnected` — the last after three consecutive failed attempts, while retries continue at the capped interval. [src/components/ConnectionBadge.tsx](src/components/ConnectionBadge.tsx) renders them in the same three-cue discipline as the alert badge, so C10's disconnected state is now driven by a real socket rather than by an unreachable REST read alone.

## Live vitals (C11)

The device page opens `GET /devices/:deviceId/stream` on [apps/server](../server) through [src/api/stream.ts](src/api/stream.ts), the second and last module in this package that touches the network. Every message is parsed with `streamMessageSchema` from [@maekbeat/protocol](../../packages/protocol); one that fails is dropped, counted, and reported on the page — never rendered.

A drop is retried with capped exponential backoff (500 ms doubling to a 15 s ceiling, `backoffFor`). Every re-open triggers a REST back-fill rather than a silent resume: [src/data/useLiveDevice.ts](src/data/useLiveDevice.ts) asks for frames captured at or after the newest frame it already holds, capped at the server's 1000-frame read limit, and merges them by `(sessionEpoch, seq)`. **The back-filled window is therefore at most the 1000 most recent frames the server still holds** — its ring keeps `RING_CAPACITY` (1024 by default), anything evicted while the dashboard was away is gone from every source, and that span renders as a gap, which is the honest rendering of data nobody has.

### Gaps are gaps

A monitoring chart that draws a line through a 40-second outage claims coverage the system did not have. [src/chart/geometry.ts](src/chart/geometry.ts) splits the series wherever the interval between samples exceeds three times the window's median interval (floor 2.5 s, so a jittery stream is not all holes), draws one path per run of real coverage, and shades the hole between them. `prepareSeries` finds the gaps **before** decimating and thins each run separately, so shrinking the point count can never bridge a hole.

### Decimation must not eat the event

The ring holds up to 1024 frames and the plot is a few hundred pixels wide, so points must be dropped. They are dropped by min/max envelope — each bucket keeps its lowest and highest sample, in the order they occurred — never by stride. Stride sampling drops whatever falls between its steps, and the single trough of an SpO2 desaturation is exactly the sample this project exists to show; the tests assert that the trough reaches the drawn path and that a stride sampler over the same series loses it, so swapping the implementation fails the build.

### Which clock the x axis uses

Time on the chart is `capturedAtMs`, the device clock, per [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) — drift shifts charts, never alerts. The consequence is stated rather than hidden: a device whose clock drifts slides its whole trace against the alert marks, which carry server receive time. The page shows that drift as `receivedAtMs − capturedAtMs` for the newest frame, and each alert mark is anchored to the frame nearest its raise, so a mark points at a real sample instead of at a timestamp converted between two clocks.

An alert raised outside the frame window is not marked at all. Alerts are kept per process lifetime (100 per device) while frames are a bounded ring, so anchoring an older one would pile it onto the window's first frame and claim an event at a time when nothing happened; the chart counts those instead and says how many it left unmarked.

Only the newest session is drawn. `sessionEpoch` bumps when a device reboots or its `seq` regresses past the reorder window ([docs/DECISIONS.md](../../docs/DECISIONS.md) #11), and a reboot may reset the device clock — so joining two sessions on one device-clock axis would invent a shape neither session had. The chart says which session it is showing and how many frames it left out.

The two metrics render as separate small multiples sharing one time axis — no dual y-axis, which would invite comparing shapes that are not comparable. Alert marks reuse the palette of [docs/DECISIONS.md](../../docs/DECISIONS.md) #12, with the badge's border style mirrored as a stroke dash pattern so the three states stay apart in greyscale. Nothing in the chart animates: an eased line would put the newest sample on screen later than it arrived.

## Acknowledgement and the timeline (C12)

An alert episode is one row, not one row per firing: the C7 engine already gives one `alertId` per breach episode, so a 30-tick anomaly reads as a single entry with a duration. Alarm fatigue is the design constraint the C21 risk register will cite, and a timeline that counted firings would manufacture the noise the engine exists to prevent. [src/components/AlertTimeline.tsx](src/components/AlertTimeline.tsx) puts the newest episode first and repeats the state encoding of [docs/DECISIONS.md](../../docs/DECISIONS.md) #12 on the row's leading edge — colour plus border style, so an episode's state survives greyscale.

Acknowledgement is server state, not a checkbox. The dashboard POSTs to `/devices/:deviceId/alerts/:alertId/decisions` and the server appends an event to its log ([apps/server/src/acks.ts](../server/src/acks.ts)); the decision in force is derived by reading the newest event for an alert, never by mutating a row. A metric that dies on reload is not a metric, and the C23 product loop counts acknowledged against dismissed — the distinction that carries the false-alarm signal: `acknowledged` is seen and acted on, `dismissed` is seen and judged not actionable.

A decision can outlive the alert it judged: the server's log is append-only while its alert history is a bounded cache that evicts decided alerts first ([docs/DECISIONS.md](../../docs/DECISIONS.md) #15). The timeline shows those as their own rows rather than dropping them, because hiding a judgement whose subject was evicted would lose the only record that anyone triaged the event.

Nothing is shown as decided until the server says so. The row goes busy while the request is in flight and the decision appears only from the appended event; a refusal leaves the buttons in place and states the reason, because a checkmark for an audit-log entry that does not exist would be the interface lying about a record. A decision recorded on another dashboard arrives over the same fan-out socket.

## Accessibility (WCAG 2.2 AA, C12)

[src/a11y.test.tsx](src/a11y.test.tsx) runs axe-core over the device list, the device page, and the page after a decision, and asserts zero violations. What that proves and what it does not is worth stating plainly: axe in jsdom checks structure — roles, names, labels, landmarks, heading order, duplicate ids — and cannot check anything requiring layout, so colour contrast is gated statically instead in [src/styles/tokens.test.ts](src/styles/tokens.test.ts) and target size is asserted as a CSS declaration rather than a measured box.

Unproven here, and named rather than implied: no real screen reader has read this interface, no real browser has laid it out in CI, and reflow and focus visibility are argued from the stylesheet rather than measured. The Playwright smoke at C13 is where a real engine starts checking those.

Every acknowledgement control is a real `<button>`: reachable by Tab, operable by Enter and Space, never a `div` with a click handler, and declared at 44x44 CSS pixels — past the 24x24 minimum of SC 2.5.8, asserted against the stylesheet in [src/styles/tokens.test.ts](src/styles/tokens.test.ts). Each carries an accessible name that begins with its visible word, so SC 2.5.3 holds and a voice user can say "Acknowledge" while a screen-reader user hears which episode it belongs to. The focus ring comes from the token accent and is never removed.

### Why the chart is not a live region

A vitals chart streaming at 1 Hz inside `aria-live` would interrupt a screen-reader user roughly once a second with a number they did not ask for. That is not access; it is a denial of it dressed as thoroughness. So the numbers stay silent and remain available on demand — each chart is `role="img"` with a summary label a user reads when they navigate to it.

At rest the page has exactly one live region ([src/components/AlertAnnouncer.tsx](src/components/AlertAnnouncer.tsx)), it is `polite`, and it announces three things: an alert changing state, a decision landing, and the feed dropping or returning. It stays silent for the backlog present at page load, because arriving somewhere is not news.

`polite` rather than `assertive` even for a raised alert: the timeline, the badge, and the row order carry the same information without cutting off whatever the user is reading. The one assertive region is deliberate and appears only on a refused decision — a failed action the user has to know about now. The tests assert the chart has no live-region ancestor by role as well as by attribute, that twenty streamed frames leave the region empty, and that the refusal adds exactly one assertive region.

## API client

[src/api/client.ts](src/api/client.ts) types the seven-route surface pinned by [apps/server/src/openapi.test.ts](../server/src/openapi.test.ts): `/healthz`, `/devices`, `/devices/:deviceId/frames`, `/devices/:deviceId/alerts`, and `POST /devices/:deviceId/alerts/:alertId/decisions` over HTTP; `/devices/:deviceId/stream`, the fan-out socket `subscribe()` opens; and `/ingest`, whose URL `ingestUrl()` derives for the C14 gateway — the device-to-server leg this app never sends on.

The fetch call is isolated in [src/api/http.ts](src/api/http.ts) and the socket in [src/api/stream.ts](src/api/stream.ts), both injected (`fetchImpl`, `createSocket`, `schedule`), so tests drive a fake socket and a fake clock and never patch globals — and a source scan in [src/styles/tokens.test.ts](src/styles/tokens.test.ts) fails the build if any other file opens a connection. Components reach data only through the context in [src/data/api-context.tsx](src/data/api-context.tsx): C11 added the `subscribe` member there, exactly as the C10 seam was built for, and no component constructs a transport.

Failures are typed by cause — `network`, `http`, `contract` — which is what lets the UI tell "the server is down" apart from "the server said no" ([src/components/StatusPanel.tsx](src/components/StatusPanel.tsx)).

## What end-to-end owns, and what it does not (C13)

The smoke suite in [e2e/](e2e) runs a real Chromium against the production bundle and a real apps/server process, talking across origins. It exists because two defects reached `main` with every other gate green: a dashboard that could not reach its own API from a browser, and a server feature that could have been left unwired. Both are the same disease — nothing verified what the process runs.

The boundary is deliberate, and holding it is the point. End-to-end owns wiring, origins, the production build, and behaviour that only a real engine has: computed styles, focus, layout-dependent contrast, target boxes. Unit tests own logic, edge cases, properties, and every failure path that is expensive or impossible to stage in a browser — a refused decision, a malformed frame, a clock stepping backwards.

So the suite is five tests, not fifty. One journey covers load, list, stream, alert, acknowledge, and reload; one covers the honest-failure path; three re-run the accessibility assertions in the real engine. Anything that could be a unit test belongs in `src/`, because a slow suite gets skipped and a skipped gate is worse than none.

| Check                                  | Browser-verified (e2e) | jsdom-only (src)                           |
| -------------------------------------- | ---------------------- | ------------------------------------------ |
| axe structural rules                   | yes                    | yes                                        |
| axe colour contrast                    | yes                    | no — asserted statically in tokens.test.ts |
| keyboard activation of the ack control | yes, real key events   | yes, via user-event                        |
| focus ring visible                     | yes, computed style    | no                                         |
| target size at 24x24                   | yes, measured box      | no — asserted as a CSS declaration         |
| live-region scope                      | yes                    | yes                                        |

Retries are set to zero, in CI too ([playwright.config.ts](playwright.config.ts)). A smoke test that quietly passes on the second attempt reports a system that works when what it saw was a system that failed and then worked — the same lie as a coverage badge left quietly stale.

The suite is excluded from the unit coverage ratchet ([vitest.config.ts](vitest.config.ts)): an end-to-end pass that walks through a file is not the same evidence as a unit test that pins its behaviour, and letting it count would let the threshold rise while real coverage fell.

## Test map

| File                                                                       | Pins                                                                                                                                                                           |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [src/App.test.tsx](src/App.test.tsx)                                       | shell and disclaimer, routing, the four read states, retry, the error boundary, live append, connection states, no socket left open, and the class contract in both directions |
| [src/api/client.test.ts](src/api/client.test.ts)                           | four REST routes over a mocked fetch, URL building, the network/http/contract failure split, and `subscribe` routing frames and alerts                                         |
| [src/api/stream.test.ts](src/api/stream.test.ts)                           | contract-checked messages, capped backoff, reconnect telling the caller to back-fill, disconnected after repeated failure, close cancelling a pending retry                    |
| [src/chart/geometry.test.ts](src/chart/geometry.test.ts)                   | gap threshold from the sample rate, no segment spanning a hole, and the desaturation trough that stride sampling drops                                                         |
| [src/components/VitalsChart.test.tsx](src/components/VitalsChart.test.tsx) | a broken path across a 40 s outage, gaps surviving decimation, alert marks by state, empty window                                                                              |
| [src/data/useLiveDevice.test.tsx](src/data/useLiveDevice.test.tsx)         | REST seed then live append, merge by (sessionEpoch, seq), bounded window, back-fill on reconnect, socket closed on unmount                                                     |
| [src/styles/tokens.test.ts](src/styles/tokens.test.ts)                     | token families, one accent, dark parity, contrast ratios, no literals, no dead tokens, and the network kept inside the two transport modules                                   |
| [src/data/useAsync.test.tsx](src/data/useAsync.test.tsx)                   | loading → ready → error, reload, abort on unmount, and a superseded read never repainting the current one                                                                      |
| [src/format.test.ts](src/format.test.ts)                                   | UTC instants, fixed-decimal values, signed clock delta                                                                                                                         |

Coverage runs with `pnpm --filter @maekbeat/web test:coverage` ([vitest.config.ts](vitest.config.ts), v8 provider, all of src/ minus tests). The browser entry [src/main.tsx](src/main.tsx) stays in the denominator untested, the apps/server `main.ts` precedent: excluding a file to make the number look better is a G3 event, not a convenience. Thresholds were raised at C11 against a measured 96.95% statements / 92.10% branches / 98.19% functions / 98.46% lines. Branches is the one that did not move — it measured 93.87% at C10 and 92.10% here, because the live path adds branchier code than it adds covered branches, so the threshold stays at 91 rather than following a measurement downwards ([CLAUDE.md](../../CLAUDE.md)).

## Configuration

| Variable            | Default                 | Notes                                                    |
| ------------------- | ----------------------- | -------------------------------------------------------- |
| `VITE_API_BASE_URL` | `http://127.0.0.1:3000` | base URL of apps/server; only `VITE_` reaches the bundle |

Vite exposes nothing else to the browser, and [.env.example](.env.example) holds no secrets — the development server it points at is unauthenticated ([apps/server/README.md](../server/README.md)).
