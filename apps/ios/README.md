# Maekbeat for iOS

C14 of [docs/ROADMAP.md](../../docs/ROADMAP.md): a SwiftUI app that reads a local [apps/server](../server) over REST and subscribes to its WebSocket fan-out. SwiftLint gates the sources, XCTest gates the behaviour, and a line-coverage ratchet gates the suite.

## What runs today

A simulator app talking to a Maekbeat server on your Mac. Nothing else.

There is no Bluetooth code in this app, no hardware, no App Store presence, and no notifications — [CoreBluetooth arrives at C15](../../docs/ROADMAP.md) and caregiver notifications at C16. Frames reach this app because a server sends them over `GET /devices/:deviceId/stream`, the same endpoint the [apps/web](../web) dashboard subscribes to. A source scan in [MaekbeatKit/Tests/MaekbeatKitTests/SourceDisciplineTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/SourceDisciplineTests.swift) fails the build if any source names a radio, a store, or a push notification; the ban covers prose as well as symbols, so writing about Bluetooth happens in this file and not in that package.

```sh
pnpm --filter @maekbeat/server dev     # shell 1: the API
pnpm --filter @maekbeat/server demo    # shell 2: frames into it
open apps/ios/Maekbeat.xcodeproj       # shell 3: run the Maekbeat scheme
```

`127.0.0.1:3000` is the default because the iOS Simulator shares loopback with the host Mac. A build on a real device needs a LAN address in `MAEKBEAT_API_BASE_URL` (scheme → Run → Arguments → Environment Variables).

## Layout

| Path                        | What                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------- |
| [MaekbeatKit/](MaekbeatKit) | The SwiftPM package: contract types, transport, view models, and every SwiftUI view |
| [App/](App)                 | The `@main` shell — one file, and a test keeps it that way                          |
| `Maekbeat.xcodeproj`        | The app target; the package is a local dependency of it                             |
| [scripts/](scripts)         | The gates, runnable locally with the same commands CI runs                          |

Everything the app does lives in the package, because the package is what the coverage gate can measure. The app target is [App/MaekbeatApp.swift](App/MaekbeatApp.swift): a `WindowGroup` around `RootView` and an environment variable for the base URL.

It is the iOS analogue of `apps/web/src/main.tsx`, one target further out — and unlike `main.tsx`, which apps/web keeps in its coverage denominator, this file is in a target xccov does not report on. That is the exemption, stated. Three compensating controls hold it: a scan capping the shell at twenty lines of code in exactly one file, a scan reading `Maekbeat.xcodeproj`'s sources build phase to assert the app target compiles nothing but that file, and a CI step that builds it (below).

```sh
apps/ios/scripts/lint.sh        # SwiftLint --strict
apps/ios/scripts/build-app.sh   # the app shell compiles and links for a simulator
apps/ios/scripts/test.sh        # XCTest on a simulator + the coverage gate
cd apps/ios/MaekbeatKit && swift test   # the fast local loop; no simulator, no UI tests
```

## The cross-language contract

`packages/protocol` is the source of truth, and the Swift types in [MaekbeatKit/Sources/MaekbeatKit/Contract/](MaekbeatKit/Sources/MaekbeatKit/Contract) are hand-written against it. There is no code generation, deliberately: a generated type is a projection of the schema and agrees with it by construction, which proves nothing about the bytes on the wire.

What keeps the two languages honest is a fixture neither of them owns. [GoldenContractTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/GoldenContractTests.swift) decodes the exact bytes of `packages/vitals-sim/golden/rest.ndjson`, `motion.ndjson`, and `anomaly.ndjson` — the same files the TypeScript golden suite pins byte for byte (C3). Nothing is copied into `apps/ios`; the path is derived from `#filePath`, so a checkout anywhere resolves it and a missing fixture fails the suite rather than skipping it.

The suite asserts four things, in increasing order of what they catch:

1. **The header line's shape.** Line 0 is the generator header — `seed`, `config.scenario`, `config.deviceId`, `config.startAtMs`, `config.tickMs`, `config.count`, `generatorVersion` — decoded rather than string-matched, and asserted not to decode as a frame. If frames ever started at line 0, every row index below would be off by one.
2. **Field by field on known frames.** `anomaly.ndjson` frame 0 is `deviceId "sim-001"`, `seq 0`, `heartRateBpm 62`, `spo2Pct 97.5`, `respirationRpm 13.7`, `motion 0.003`, at `capturedAtMs 1754265600000`. Frame 1 and `rest.ndjson` frame 0 carry different values and are asserted separately, so a decoder wired to one fixture cannot pass.
3. **The key set, both directions.** Each decoded frame is re-encoded and its key set compared with the fixture line's. This is the check that stands in for `z.strictObject`: Swift's synthesised `Codable` silently ignores keys it does not know, so a field **added** to the wire would decode cleanly and be dropped. Round-tripping catches that, and catches a field removed from the Swift type, and catches a rename on either side.
4. **The whole fixture.** All 120 frames of all three scenarios decode, `seq` equals the row index, `capturedAtMs` advances by the header's `tickMs`, and every reading satisfies its transport bound. Plus one assertion about the data rather than the shape: `anomaly.ndjson` still desaturates below 90, and `rest.ndjson` still does not.

### What the goldens do not cover

The mechanism has a specific reach, and pretending otherwise would be worse than the gap.

| Not covered                                | Why, and what stands in                                                                                                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `z.strictObject` at runtime                | Swift's `Codable` ignores unknown keys, and this app does not walk every payload's key set on a 1 Hz stream to change that. Strictness is enforced at test time against the goldens (check 3), not on the wire.    |
| Alert, decision, and stream-message shapes | The goldens are vitals frames only. Nothing cross-language pins `alertEventSchema`, `alertDecisionEventSchema`, or `streamMessageSchema` — the Swift fixtures for those are hand-written and could drift together. |
| REST envelope shapes                       | Same gap, one layer out: `DeviceList`, `FramesPage`, and `AlertsPage` are checked only against hand-written JSON here and against `apps/server/src/reads.test.ts` there.                                           |
| `resolvedAtMs >= raisedAtMs`               | A zod `.refine`, not a type. Swift decodes an inverted pair without complaint; only the server rejects it.                                                                                                         |
| String length bounds                       | `deviceId` is 1–64 characters in the schema and `String` in Swift.                                                                                                                                                 |
| Version negotiation across a `v` bump      | The client rejects any `v` that is not 1, which is the contract's rule, but no fixture exercises a version 2 frame because none exists.                                                                            |

The honest closure for rows 2 and 3 is a committed artifact both languages read — the OpenAPI document `apps/server/src/openapi.test.ts` already pins is generated at runtime and never written to disk. Committing it would give Swift a second fixture it does not own. That is a change to `apps/server`, so it belongs to a commit that owns that package, not to this one.

## The transport

[StreamClient.swift](MaekbeatKit/Sources/MaekbeatKit/Transport/StreamClient.swift) is the same design as [apps/web/src/api/stream.ts](../web/src/api/stream.ts), on purpose and with the same numbers: 500 ms doubling to a 15 s cap, `disconnected` after three consecutive failures while retries continue, and the connection state reported on transitions only. Two clients that reconnect differently would be two answers to one question.

Both the socket and the timer are ports, so the suite drives a fake socket and a fake clock and never waits on wall time — the whole 90-test run finishes in under a second. The rules the tests pin rather than the prose:

- **A connection that never existed is not a reconnection.** The label is derived in one place; deriving it in two is what let apps/web flip between "connecting" and "disconnected" forever (its C11 mutation log).
- **Silence is not continuity.** Every re-open fires `onReconnect`, and [DeviceDetailModel](MaekbeatKit/Sources/MaekbeatKit/ViewState/DeviceDetailModel.swift) answers it with a REST back-fill from the newest frame it holds. A socket that dropped for forty seconds missed forty seconds.
- **A frame is identified by `(sessionEpoch, seq)`, never by a timestamp.** A device clock adjustment must not change a frame's identity ([packages/protocol](../../packages/protocol)); a late arrival is inserted at its capture time rather than appended where it turned up.
- **A message the contract rejects is counted and shown, never rendered.** That includes a frame outside its transport bounds: the screen says how many were dropped instead of drawing an SpO2 of 140.
- **One episode is one row.** The C7 engine gives one `alertId` per breach, so a lifecycle transition replaces its record. A timeline that counted firings would manufacture the alarm fatigue the engine exists to prevent.
- **The newest decision is the one in force.** A late-arriving older event changes nothing, the same rule `latestDecisions` holds server-side.

[APIClient.swift](MaekbeatKit/Sources/MaekbeatKit/Transport/APIClient.swift) covers the four read routes plus the two socket URLs, with failures split by cause — `network`, `http`, `contract` — which is what lets the interface tell "the server is down" apart from "the server said no". The acknowledgement route is deliberately absent: this app reads, and writing a client for a route no screen calls would be a claim about a feature.

These two files are the only ones in the package that touch the network, and a source scan fails the build if a third appears — the rule apps/web holds in `src/styles/tokens.test.ts`, for the same reason: a view that can open its own connection is a view whose failure states nobody designed.

### The one real socket, and what it does not prove

`URLSessionStreamSocket` is the shipped factory, and [URLSessionSocketTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/URLSessionSocketTests.swift) opens a genuine socket at a refused loopback port to cover its construction, its failure branch, and close. The success path — a completed handshake, a delivered frame — has no coverage here, because proving it needs a live apps/server process. apps/web has that in its C13 Playwright smoke; apps/ios does not have an equivalent yet.

## States are designed, not fallbacks

Every read lands in one union, [LoadState](MaekbeatKit/Sources/MaekbeatKit/ViewState/LoadState.swift), and the same four panels come out of it as on the dashboard:

| State          | Says               | When                                                |
| -------------- | ------------------ | --------------------------------------------------- |
| `loading`      | "Reading devices"  | a read is in flight                                 |
| `empty`        | "No data yet"      | the server answered and is holding nothing          |
| `error`        | "This read failed" | the server answered with a failure, message carried |
| `disconnected` | "Connection lost"  | nothing was reached at all                          |

`empty` is a state a model chooses, not an array that happened to be short: "nobody has connected a device yet" is a true and useful answer, and an empty list rendered as data is not. The connection has its own four states from the transport rather than from a guess, and both the alert states and the connection states carry a distinct glyph before they carry a hue — [docs/DECISIONS.md](../../docs/DECISIONS.md) #12, asserted pairwise distinct so a later edit cannot collapse the encoding onto colour.

The not-a-medical-device line is in the interface, not only in [DISCLAIMER.md](../../DISCLAIMER.md). [RootView](MaekbeatKit/Sources/MaekbeatKit/Views/RootView.swift) keeps `DisclaimerBar` above the navigation stack, so it survives every screen and every failed one; a source scan asserts the bar is rendered and that its words still say what they must.

## Tests, and the boundary they hold

| File                                                                                          | Pins                                                                                                   |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [GoldenContractTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/GoldenContractTests.swift)     | the cross-language contract above, plus version, bounds, and missing-field rejection                   |
| [StreamClientTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/StreamClientTests.swift)         | state transitions, capped backoff, reconnect, delivery stopping at close, the socket built after close |
| [APIClientTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/APIClientTests.swift)               | the four reads, URL building and escaping, the network/http/contract split, socket URL schemes         |
| [ViewStateTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/ViewStateTests.swift)               | the union, copy for every variant, the device list's four states, formatting, the state marks          |
| [DeviceScreenTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/DeviceScreenTests.swift)         | seed then live append, frame identity, ordering, the bounded window, back-fill, episodes, decisions    |
| [ViewRenderingTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/ViewRenderingTests.swift)       | every screen in every designed state, through a real layout pass on the simulator                      |
| [URLSessionSocketTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/URLSessionSocketTests.swift) | the shipped socket factory against a refused port                                                      |
| [SourceDisciplineTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/SourceDisciplineTests.swift) | no radio, no store, the disclaimer rendered, the network in two files, the app shell still a shell     |

`ViewRenderingTests` is not a snapshot suite and does not claim to be one: nothing compares pixels, and a view that lays out badly still passes. What it proves is that each `body` is evaluated on the platform the app ships on, in each state, without trapping — an index into an empty window, a `ForEach` over non-unique ids. It is also what puts the view files in the coverage denominator honestly; the alternative was a lower threshold and a paragraph explaining why views do not count, which is the exemption the ratchet exists to refuse.

What is **not** covered: no view's layout, spacing, or contrast is asserted, no screen reader has read this interface, and there is no accessibility audit of the kind apps/web ran at C12 — VoiceOver rotor order, dynamic type at accessibility sizes, and target size in points are all unmeasured here. The controls carry accessible labels and a 44x44 minimum by declaration, which is a design intent rather than a measurement.

## The gate, and why it exists at all

`apps/ios` is not a pnpm workspace package. It has no `package.json`, so `pnpm -r test:coverage` skips it and the C9 guard that fails when a package lacks that script cannot see it — the exact hole C9 closed for the web, reopening in a new language. Leaving it ungated was never the option; the choice was between a real iOS CI job and a written exemption, and the job won because it costs nothing:

**GitHub-hosted macOS runners are free and unmetered for public repositories.** Standard runners carry no charge in a public repo, macOS included, and only the larger (`-large`, `-xlarge`) runners are billed. Checked 2026-08-05 against GitHub's Actions billing documentation and the `actions/runner-images` support matrix; this repository is public.

If it ever went private, macOS minutes would be billed at the standard macOS rate and this decision would need making again.

The `ios` job in [.github/workflows/ci.yml](../../.github/workflows/ci.yml) runs three steps, and the `tests` job asserts the third one still exists — anchored to the step as CI would execute it, because an unanchored `grep` for that path matches the guard's own line and would have applauded the job's deletion:

1. `scripts/lint.sh` — SwiftLint `--strict`, so every violation is an error, over all of `apps/ios` rather than a list of directories. `.swiftlint.yml` carries no `included:` key on purpose: it would override the path the script passes, and a Swift file added anywhere else under `apps/ios` would compile into the app and never be linted. The binary is a pinned 0.65.0 release verified against a recorded SHA-256, the way the docs gates pin prettier and markdownlint.
2. `scripts/build-app.sh` — the app target for a simulator. Nothing in the package build links the shell, so this is the only step that proves the thing a person can launch still compiles. C12a's lesson, one target out.
3. `scripts/test.sh` — `xcodebuild test` on a discovered simulator destination with coverage, then `scripts/coverage-gate.sh`.

### The ratchet, and how it differs from the others

The threshold is **89% line coverage on the `MaekbeatKit` target**, set just under a measured **91.37% (911/997 lines)** — Xcode 26.6, iOS 26.5 simulator, 2026-08-05. It moves only up, in its own deliberate commit, and never by excluding a file ([CLAUDE.md](../../CLAUDE.md)).

Two differences from the TypeScript packages, both stated rather than smoothed over:

- **One number, not four.** `xccov` reports lines covered out of lines executable. It has no branch or function percentage of the kind vitest's v8 provider gives, so this gate cannot ratchet branches the way `apps/server` and `apps/web` do.
- **The denominator is a target, not a directory.** It is the `MaekbeatKit` library — every line the app's logic and views ship — with the test target excluded, which is the same "src/ minus tests" rule each `vitest.config.ts` uses. `App/MaekbeatApp.swift` is outside it, as recorded above.
- **There is no environment override.** `THRESHOLD` is a literal in [scripts/coverage-gate.sh](scripts/coverage-gate.sh). CLAUDE.md forbids lowering a threshold by a flag, and an override that exists is one CI can be given; proving the gate bites means editing that line and reverting it, exactly as the vitest packages are proved by editing their configs.

A target is the unit the gate measures, which makes a second target the way to ship code no threshold covers. That cannot be caught in the coverage report — a target with no exercised code produces no row to object to — so it is caught at the manifest: [SourceDisciplineTests](MaekbeatKit/Tests/MaekbeatKitTests/SourceDisciplineTests.swift) asserts `Package.swift` declares exactly `MaekbeatKit` and `MaekbeatKitTests`, and that `Sources/` holds exactly one directory. The same test reads `Maekbeat.xcodeproj`'s sources build phase and asserts the app target compiles nothing but `MaekbeatApp.swift`, because the project file can name any path and the shell cap only ever looked inside `App/`.

The simulator destination is discovered rather than pinned ([scripts/simulator-destination.sh](scripts/simulator-destination.sh)): this machine and the runner have different device line-ups, and a hard-coded model name breaks on whichever one Apple retires first. The runner image's default Xcode is what runs, echoed in the job output rather than pinned — pinning a version the image later drops would break CI on Apple's release schedule instead of on a change here. The language does not float with it: the package is `swift-tools-version:5.10` and the app target builds at `SWIFT_VERSION 5.0`.

Every guard in this commit was broken by a mutation of the thing it names and, where a neighbour existed, by that too. The results are in [docs/ai/mutation-log.md](../../docs/ai/mutation-log.md), including the two the adversarial pass added after the first round found them missing.
