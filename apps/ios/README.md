# Maekbeat for iOS

C14–C17 of [docs/ROADMAP.md](../../docs/ROADMAP.md): a SwiftUI app that reads a local [apps/server](../server) over REST, subscribes to its WebSocket fan-out, implements the BLE central role of [docs/ble-gatt-profile.md](../../docs/ble-gatt-profile.md), forwards what it receives to `/ingest`, and — since C16 — turns the server's alerts into local notifications a caregiver can answer. SwiftLint gates the sources, XCTest gates the behaviour, and a line-coverage ratchet gates the suite.

## What runs today

A simulator app talking to a Maekbeat server on your Mac, plus a CoreBluetooth central that scans for a peripheral which does not exist.

That second half needs saying precisely, because it is the easiest thing in this repository to overstate. **The app does not monitor a wearable.** It implements the central role of a documented profile, and no hardware anywhere speaks that profile. Scanning starts, finds nothing, and the link state machine says so. What C15 adds is the code that would run if a peripheral existed, the state machine that decides what to do when it does not, and an honest account of which of those two can be tested and which cannot.

C16 adds the notification half, and it needs the same precision. The notifications are **local** ones: the phone is already subscribed to the server's fan-out, so it schedules a banner from an alert it received itself. There is no push server, no device token, and no APNs — nothing in this repository could deliver a notification to a phone that is not running.

Still absent, and still guarded: no App Store presence, no in-app purchase, no remote push. Source scans in [SourceDisciplineTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/SourceDisciplineTests.swift) and [NotificationDisciplineTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/NotificationDisciplineTests.swift) fail the build on any of those, on a user-visible string claiming a device is attached, and on either framework — CoreBluetooth or UserNotifications — appearing in any file but its own adapter.

```sh
pnpm --filter @maekbeat/server dev     # shell 1: the API
pnpm --filter @maekbeat/server demo    # shell 2: frames into it
open apps/ios/Maekbeat.xcodeproj       # shell 3: run the Maekbeat scheme
```

`127.0.0.1:3000` is the default because the iOS Simulator shares loopback with the host Mac. A build on a real device needs a LAN address in `MAEKBEAT_API_BASE_URL` (scheme → Run → Arguments → Environment Variables).

## Layout

| Path                        | What                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| [MaekbeatKit/](MaekbeatKit) | The SwiftPM package: contract types, BLE, transport, view models, and every SwiftUI view |
| [App/](App)                 | The `@main` shell — one file, and a test keeps it that way                               |
| `Maekbeat.xcodeproj`        | The app target; the package is a local dependency of it                                  |
| [scripts/](scripts)         | The gates, runnable locally with the same commands CI runs                               |

Everything the app does lives in the package, because the package is what the coverage gate can measure. The app target is [App/MaekbeatApp.swift](App/MaekbeatApp.swift): a `WindowGroup` around `RootView` and an environment variable for the base URL.

It is the iOS analogue of `apps/web/src/main.tsx`, one target further out — and unlike `main.tsx`, which apps/web keeps in its coverage denominator, this file is in a target xccov does not report on. That is the exemption, stated. Three compensating controls hold it: a scan capping the shell at twenty lines of code in exactly one file, a scan reading `Maekbeat.xcodeproj`'s sources build phase to assert the app target compiles nothing but that file, and a CI step that builds it (below).

```sh
apps/ios/scripts/lint.sh        # SwiftLint --strict
apps/ios/scripts/build-app.sh   # the app shell compiles and links for a simulator
apps/ios/scripts/test.sh        # XCTest on a simulator + the coverage gate
apps/ios/scripts/fast.sh        # the fast local loop — prints what it does not cover
```

## The BLE link (C15)

### What CI verifies, and what needs a device

An iOS Simulator has no Bluetooth stack and a CI runner has no peripheral, so most of CoreBluetooth cannot execute in the gate. The design answer is to make the part that cannot be tested as small and as stupid as possible, and to write down exactly where the line falls rather than let a reader assume the coverage number covers it.

| Behaviour                                                            | Verified by CI                              | Needs a physical device |
| -------------------------------------------------------------------- | ------------------------------------------- | ----------------------- |
| Every state transition and every rejected one                        | yes — all 99 cells of the 9 × 11 matrix     | no                      |
| Properties of a whole run, not one step                              | yes — 8 seeds × 500 random events (C17)     | no                      |
| Timeouts, backoff, stall detection, recovery                         | yes — fake clock                            | no                      |
| Effects reaching the radio in the right order                        | yes — mock central                          | no                      |
| Payload decode, MTU arithmetic, bounds, version                      | yes — bytes are bytes                       | no                      |
| Radio-state translation for all six framework cases                  | yes — pure function                         | no                      |
| Constructing a real `CBCentralManager` and receiving its state       | yes — reports `.unsupported` on a simulator | no                      |
| Scanning, discovery, connection, subscription, notification delivery | **no**                                      | **yes**                 |
| State restoration actually relaunching the app                       | **no**                                      | **yes**                 |
| Throughput, latency, range, battery                                  | **no** — and nothing here claims any        | **yes**                 |

Everything in the bottom three rows lives in [MaekbeatKit/Sources/MaekbeatKit/BLE/CoreBluetoothCentral.swift](MaekbeatKit/Sources/MaekbeatKit/BLE/CoreBluetoothCentral.swift), the only file in the package that imports the framework. Its delegate methods translate a callback into a `LinkEvent` and do nothing else — no retries, no timeouts, no state — which is what a test asserts by scanning it for the symbols that would indicate otherwise, and by capping it at 140 lines.

**How someone with hardware would verify the untested rows.** Build a peripheral that advertises `6D61656B-0001-4265-6174-000000000001` and notifies 19-byte frames on the vitals characteristic — a second iOS device running `CBPeripheralManager`, a Raspberry Pi with BlueZ, or an nRF52 dev board all serve. Then, against a `Debug` build on a real iPhone with a Maekbeat server reachable on the LAN via `MAEKBEAT_API_BASE_URL`:

1. **Connect and stream.** The link screen should walk `connecting → connected → streaming` and the server's `GET /devices` should show the peripheral's identifier with a rising `lastSeq`.
2. **Recovery.** Power the peripheral off mid-stream. The screen must say `recovering`, not `connecting` — that difference is the whole design — and the retry interval should grow 1 s, 2 s, 4 s to a 30 s cap. Power it back on: the link returns to `streaming` through a full discovery, and `duplicatesRefused` on the link screen stays at zero.
3. **Stall.** Stop notifying without disconnecting. After 15 s the link must fall to `recovering` on its own; a peripheral that wedges looks exactly like one that is idle, and this is the only thing that tells them apart.
4. **Background.** See the section below, which is where the claims get thinnest.

None of the above has been run. Marking it as a procedure rather than a result is the point.

### The state machine

Five states, and the deliverable of this commit: [BLELinkMachine.swift](MaekbeatKit/Sources/MaekbeatKit/BLE/BLELinkMachine.swift) is a value type with no radio, no clock and no I/O, and every decision the gateway makes about the link is in it.

```text
disconnected ──start──▶ connecting ──peripheralConnected──▶ connected
     ▲                     │  ▲                                │
     │                     │  └────────retryDue────┐           │ servicesResolved
     │ stop / radio gone   │                       │           │ notificationsEnabled
     │                     ▼                       │           ▼
     └──────────────── recovering ◀────linkLost / timeout──── streaming
```

`connecting` and `recovering` are both "trying", and keeping them apart is the reason the machine holds a `hasStreamed` bit. `recovering` means this link has delivered data before, so silence now is readings a caregiver is missing; `connecting` means there was never anything there. It is the same distinction [apps/web](../web) draws between `connecting` and `reconnecting`, and the same bug it fixed at C11 — deriving the label in two places let a connection that never existed report itself as a reconnection.

Illegal transitions are **rejected**, not ignored, and the two are different outcomes. A radio may report a disconnect twice and that is fine (`ignored`); a radio reporting notifications enabled on a link that was never connected means this model or the adapter is wrong (`rejected`), and the driver counts those and puts the number on screen. A machine that quietly absorbs the second kind is one that will eventually report `streaming` with no link behind it.

The timing constants are in one place, `LinkTiming`: a 10 s connect deadline, a 10 s discovery deadline, a 15 s stall deadline re-armed by every frame, and a retry backoff of 1 s doubling to a 30 s cap. The whole sequence — 1, 2, 4, 8, 16, 30, 30 — is pinned by a test, because it read 2 s in the code and 1 s in three documents until one of them was made to move. The cap is twice the dashboard socket's, because a phone scanning for a peripheral that is out of range is burning a radio rather than a socket.

[BLELinkMatrixTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/BLELinkMatrixTests.swift) asserts all ninety-nine cells of the state-by-event table, each for both the resulting state and the exact effect list.

Exhaustive over what, exactly: the nine reachable `LinkState` values by the eleven `LinkEvent` cases. Not over `attempt`, `unavailable` or `framesReceived` — counters and a last-reason record that no transition branches on. `attempt` does size the retry backoff, so cells scheduling one assert it as a function of the attempt held on entry rather than as a constant.

That sentence used to read "all fifty-five cells, five states by eleven events", and it was false. Three cells had two answers depending on a `hasStreamed` flag held beside the state rather than in it, and whichever setup path a row happened to use decided which answer got asserted. Folding it into the type produced a table that immediately failed on a cell nobody suspected — `radioReady` in `disconnected` — because `wantsLink` had escaped the same way. Both are in `LinkState` now, and three combinations that were merely unused became unrepresentable: no never-streamed `streaming` or `recovering`, and no has-streamed state the app does not want.

### Background execution, and what iOS actually promises

This section is where an honest account matters more than a confident one, so every claim below is labelled. **Nothing here has been observed on a physical device by this author.** They are the documented behaviours the implementation is written against.

The app declares the `bluetooth-central` background mode and passes a restore identifier (`dev.maekbeat.central`) when constructing the manager. What that combination buys, per Apple's documentation:

- **Permitted, and the reason the mode exists:** a central with this mode may continue receiving notifications while the app is suspended, and iOS may relaunch a terminated app into the background to deliver a connection event, calling `willRestoreState:` before anything else.
- **Not guaranteed:** that the app is relaunched at all. iOS relaunches at its discretion, and a user who force-quits the app from the switcher opts out entirely until they open it again — that one is explicit in Apple's documentation and is the failure mode a caregiver would actually hit.
- **Not guaranteed:** delivery rate or timeliness while suspended. Background execution is scheduled by the system, and nothing here is entitled to a frame per second.
- **Unverified by me:** all of the above, plus what happens across a device reboot, and what the real battery cost of a 1 Hz notify stream is.

One thing is verified, and it is a launch-time crash rather than a degradation: **CoreBluetooth raises `NSInternalInconsistencyException` if a restore identifier is passed and the app has not declared the background mode**, and again if the delegate does not implement `willRestoreState:`. Both were observed while writing this commit, in a test bundle that declared neither. That is why the app target's `UIBackgroundModes` and `NSBluetoothAlwaysUsageDescription` are asserted from `project.pbxproj` by a test: the simulator gate runs the library, not the app, so nothing else in this repository would notice their absence until launch.

What a caregiver would actually miss, stated plainly: if iOS declines to relaunch the app, or the user force-quits it, the phone stops forwarding and the server sees a device go quiet. The server already renders that honestly — `lastReceivedAtMs` on `GET /devices` is the staleness signal, and the dashboard breaks the chart across the gap rather than interpolating — so the failure is visible rather than silent. It is not prevented, and C16's notifications do not prevent it either.

### Resume, and the C6 contract it binds

[packages/protocol/README.md](../../packages/protocol/README.md) recorded the promise before there was a gateway to keep it: resume from the last delivered `seq` on reconnect, never replay older frames, because a replay past the server's 64-frame reorder window forks a session epoch. [UplinkQueue.swift](MaekbeatKit/Sources/MaekbeatKit/Gateway/UplinkQueue.swift) is where that becomes code.

- **Resume is the absence of a reset.** A reconnect drops only the in-flight mark — frames written to a socket that then died may never have arrived — while the acknowledged mark survives. The tail is resent; the session is not.
- **A peripheral reboot is surfaced, not smuggled.** A `seq` regression past 64 frames drops the pre-reboot buffer rather than replaying across the boundary, because pushing high seqs after low ones would drag the server's high-water mark back up and fork a further session.
- **The window is the server's, not an invention.** `UplinkQueue.reorderWindow` is 64 because `SEQ_REORDER_WINDOW` in [apps/server/src/store.ts](../server/src/store.ts) is 64. The phone could claim better information — notifications are ordered within one BLE connection, so any regression looks like a reboot — but a peripheral that reconnects and re-sends its last notification produces a regression that is not one. Sharing the number means the two ends agree about what a reboot is and inherit one blind spot instead of two.

None of that is asserted against a restatement of the server's behaviour. [GatewayIntegrationTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/GatewayIntegrationTests.swift) launches a real `apps/server`, drives the real client over a real WebSocket, and reads that server's own `ack` and `rejected` replies. It runs on the macOS host rather than the simulator, because it spawns a process — which puts it outside the coverage gate, and [scripts/integration.sh](scripts/integration.sh) fails the step if the suite skips.

That suite corrected the documentation twice, which is the argument for it existing:

1. The server calls a device's **first** frame a new session, so a run containing one reboot reports two. That was learned from an assertion that failed.
2. The residual limit is worse than the protocol README predicted. It expected an in-window reboot to be absorbed by the server as duplicates. It never reaches the server: the gateway's own resume rule refuses to send anything at or below the last acknowledged `seq`, so a peripheral that reboots before its counter passes 64 has its new session's early frames dropped **on the phone**, silently, until `seq` climbs past the old high-water mark. That is data loss rather than deduplication. The fix is the one already named — a wire-level boot id, which is a `v` bump — and until then it is a stated limit with a test that demonstrates it.

## Caregiver notifications (C16)

The circuit this commit closes: a rule in [apps/server/src/alerts.ts](../server/src/alerts.ts) fires, the alert reaches this phone on the fan-out socket it was already holding, a banner appears with two buttons, and the caregiver's answer lands in the same append-only decision log the dashboard writes to — same route, same `alertId`, same `POST /devices/:id/alerts/:alertId/decisions`. The only difference from a dashboard decision is the `actor` field, which reads `ios-gateway` instead of `web-dashboard`.

### One episode, one banner

The bug this design exists to prevent is one the client manufactures on its own. The server guarantees one raise per breach episode (C7), but a phone that notifies on every alert message it receives notifies again after every reconnect — a reconnect re-reads the alert history over REST and the fan-out replays transitions. Nothing on the server is wrong in that story and the caregiver is buried anyway.

So the decision lives in [NotificationPolicy.swift](MaekbeatKit/Sources/MaekbeatKit/Notifications/NotificationPolicy.swift), a value type with no framework in it, which keys on `alertId` in two ways at once: a `notified` set it consults before scheduling, and the OS-level notification identifier, which is the `alertId` itself — so even a policy bug replaces a banner rather than stacking one. Suppressions are counted by reason and shown on the link screen rather than swallowed.

C15's invariant carries over unchanged: every scheduled effect has an owner state, and leaving that state cancels it. A notification's owner is the open episode. The episode resolving, or anyone deciding on it from any client, withdraws the banner — a caregiver should not be left holding an alert somebody else already handled.

**What an integration test found that fourteen unit tests did not.** The first version keyed the notify decision on `state == .raised`, and every test in `NotificationPolicyTests` agreed, because every one of them started from a `raised`. The real server does not: it mutates a stored alert to `ongoing` on the second breaching sample, so `GET /devices/:id/alerts` reports every live episode as `ongoing`. The REST seed is the only path a cold launch has, which made the silent case the one that matters — an episode running right now, on a phone that has never heard of it. Designing against duplicate banners had produced a missing one. The rule is now that an _open, unseen_ episode notifies however it arrived, and the two suppression reasons stay apart only to say why a repeat was refused.

### Wording, and what a notification may not say

A notification is labelling, and labelling is subject to [G3](../../CLAUDE.md). The body says a demo threshold rule fired on synthetic data, names the metric and the direction, and stops. For the alert the tests build, verbatim:

> `spo2Pct went below a demo threshold at 00:00:40 UTC. Synthetic data from a simulated device; not a medical device.`

`spo2Pct went below a demo threshold` is a statement about a rule in a file in this repository. "Low blood oxygen" would be a statement about a person, and there is no person. [NotificationCopyTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/NotificationCopyTests.swift) holds the wording to a banned-word list covering diagnosis, urgency and instruction — the lock screen is exactly where a demo starts sounding like a device.

The body does not say "not a diagnosis" even though it would be true. The word list is total, prose included, and a disclaimer that has to be exempted from a ban weakens the ban for everything else.

### Permission is a state, not an error path

`denied` is the state this app has to be loudest about, because a monitoring app whose notifications are silently refused is worse than one with none: the person believes they are covered. It gets the same three-cue treatment the connection badge gets — the word, then a sentence saying what is lost, then colour — and every one of the five authorization states is rendered by a test rather than assumed.

The ask is a button on the link screen, next to that sentence, rather than a prompt at launch. iOS shows the system prompt once per install; asking before the user has seen what it is for spends the only chance there is.

### What CI verifies about notifications, and what needs a device

| Behaviour                                                        | Verified by CI                                | Needs a physical device |
| ---------------------------------------------------------------- | --------------------------------------------- | ----------------------- |
| Dedupe across reconnect, replay and re-seed                      | yes — pure policy, and through the view model | no                      |
| Withdrawal on resolve, on decision, from any client              | yes                                           | no                      |
| Every authorization state rendering, `denied` loudest            | yes — all five, in a real window              | no                      |
| The decision round-trip into the server's own log                | yes — against a real `apps/server` process    | no                      |
| Authorization translation for every framework case               | yes — pure function                           | no                      |
| The request and category the centre would be handed              | yes — built, then inspected                   | no                      |
| **Any call on `UNUserNotificationCenter` itself**                | **no** — see below                            | **yes**                 |
| The permission prompt, and what a person answers                 | **no**                                        | **yes**                 |
| A banner appearing, and its buttons working from the lock screen | **no**                                        | **yes**                 |
| Delivery while backgrounded, suspended or terminated             | **no**                                        | **yes**                 |

The seventh row is a harder line than C15's radio, which at least constructs on a simulator. `UNUserNotificationCenter.current()` raises `NSInternalInconsistencyException` — `bundleProxyForCurrentProcess is nil` — in a SwiftPM test bundle on macOS _and_ on the simulator, because the xctest agent has no app bundle proxy. Every instance method on [UserNotificationCenterAdapter.swift](MaekbeatKit/Sources/MaekbeatKit/Notifications/UserNotificationCenterAdapter.swift) is therefore unexercised by any gate here, not merely unverified in its effect. Closing that would take an app-hosted test target, which this package does not have. A test was written against a real centre during this commit and deleted when it turned out to be unrunnable rather than merely failing; the adapter's header says so.

That is the reason the adapter holds no decisions at all. It translates an authorization status, builds a request, builds a category, and forwards four calls. A test scans it for the symbols that would indicate otherwise and caps it at ninety lines.

**Background reality.** Nothing about background delivery has been observed on a device by this author. What is documented: a local notification scheduled with no trigger is delivered by the system whether or not the app is running, so the delivery leg does not depend on background execution. What the _alert_ depends on is the app being alive to receive it — the socket in [StreamClient.swift](MaekbeatKit/Sources/MaekbeatKit/Transport/StreamClient.swift) is an ordinary `URLSessionWebSocketTask` with no background mode of its own, so a suspended or force-quit app hears nothing to notify about. The `bluetooth-central` mode may keep the app alive for BLE traffic; it makes no promise about a WebSocket. **Unverified by me:** all of it, plus whether a notification action taken while the app is terminated relaunches it in time for `act(_:on:)` to reach the server.

**How someone with a device would verify the untested rows.** Run a `Debug` build on a real iPhone against a Maekbeat server on the LAN, allow notifications when the link screen asks, and run `pnpm --filter @maekbeat/server demo`, which streams the anomaly scenario:

1. **One banner.** The episode should produce exactly one, with `Acknowledge` and `Dismiss` on it.
2. **The circuit.** Tap `Acknowledge` from the lock screen. `GET /devices/sim-001/alerts` should show the decision with `actor: "ios-gateway"`, and the dashboard should show it too.
3. **No storm.** Turn Wi-Fi off and on to force a reconnect and re-seed. No second banner.
4. **The other client.** Acknowledge on the dashboard instead. The phone's banner should disappear on its own.

None of that has been run. It is a procedure, not a result.

## Closing the seams (C17)

Phase 5 kept finding one defect wearing different clothes: a unit suite proving
its own behaviour while nothing proved the composition. C12a's retention was
correct and unwired, C12's CORS was correct and had never crossed an origin,
C14's fast local loop compiled less than it looked, C16's notify rule was right
about `raised` and wrong about the only path a cold launch has. C17 asks the
question those share — **what here is only ever exercised through an
explicitly-injected dependency, so the default path has no caller?** — and gives
each answer a test that takes it.

### The defaults, and the sixth defect

Every port in this package is injectable and every suite injects, which is what
makes the suite fast and is also how a default resolution ends up unreached.
[DefaultPathTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/DefaultPathTests.swift)
and [DefaultValueTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/DefaultValueTests.swift)
are the enumeration: the real `URLSession` transport, the real timer and its
canceller, the real fan-out and uplink sockets through the clients that build
them, the driver's fallback scheduler, the three defaulted `StreamHandlers`
closures, the inert `#else` ports, the queue's shipped capacity and batch bound, and the
`ios-gateway` actor on a decision. The device screen's production initialiser is
the same family and lives in `ViewRenderingTests`, because rendering it is what
takes it. C16 had already paid for one of these: `APIClient`'s transport was
a default argument, every unit test passed one explicitly, and the first caller
to take the default from an `async` function segfaulted the process rather than
failing.

The largest was not a default at all but the composition above them.
**`RootView` took a `GatewayModel`, rendered its state, and never called
`start()`.** The shipped app therefore opened no `/ingest` socket and began no
scan — it sat on `disconnected(wantsLink: false)` for as long as it ran.

Every test in `GatewayModelTests` passed throughout, because each of them calls
`start()` itself: the lines were covered and the caller was not the app.
[CompositionTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/CompositionTests.swift)
is what caught it, and the fix is one line in
[RootView.swift](MaekbeatKit/Sources/MaekbeatKit/Views/RootView.swift).

That file is possible because of a fact recorded the other way round in C16's
mutation log — "a rendered SwiftUI view does not run its own `.task` in these
tests". It runs one, given a **key** window and an `await` for the result: a
window that is only laid out never gets that far, which is why
`ViewRenderingTests` sees no tasks and why that entry was true as written. Two
source scans became assertions about what happened as a result: the root screen
really does register the notification actions, and the link screen really does
re-read the permission every time it appears.

### Properties, not examples

The C15 and C16 adversarial findings are permanent seeded suites now, the way
C8 did it for apps/server. Fixed seeds, fixed lengths, deterministic in CI, and
every failure names the seed and the step.

[BLELinkPropertyTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/BLELinkPropertyTests.swift)
runs eight seeds of five hundred events over the transition table. The matrix
suite asserts ninety-nine cells one step deep; this asserts properties of a
_run_: no landing outside `LinkState.allCases`, a rejected event that changes
nothing at all, a backoff always sized by the attempt that earned it,
`hasStreamed` earned only by streaming and lost only by stopping — and the
invariant C15 wrote down and could only spot-check, **every scheduled effect has
an owner state, and leaving that state cancels it**.

It found a violation on its first run, at seed 1 step 435. `connecting` is two
situations under one name — trying now, and waiting out a backoff after a failed
attempt — and a connect that landed in the second left the retry timer running.

That timer fired `retryDue` into `connected` seconds later, where the machine
rejected it and the link screen counted an "unexpected radio event" the radio
had not produced, in the one counter whose entire job is to mean the opposite.
The fix adds `cancelRetry` to that transition, and the matrix cell and the
connect-path scenario moved with it.

[NotificationPropertyTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/NotificationPropertyTests.swift)
runs six seeds of four hundred steps over six episodes, interleaving fan-out
replays, REST re-seeds, resolutions, decisions from either client, and a
caregiver answering a banner. One episode never produces two banners, a closed
episode never has one standing, nothing is withdrawn that was not scheduled, and
delivered + withdrawn + suppressed always equals the number of things the
coordinator was asked to judge — a suppression that goes uncounted is the
alarm-fatigue argument losing its evidence.

Its first run failed, and the oracle was wrong rather than the code: it replayed
`ongoing` for an episode it had already resolved. An `alertId` names one breach
episode for its whole life (C7) and the server mints a new id for the next
breach, so a resolved episode never reopens under it. The generator was fixed,
not the policy.

### Failure paths, against a server that is really failing

[ServerFailureIntegrationTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/ServerFailureIntegrationTests.swift)
launches a real `apps/server` and breaks it five ways, because a stub told to
throw is not the same event as a process that has stopped listening — and the
whole point of splitting `APIFailure` into `network`, `http` and `contract` is
that the screen has to tell those apart.

- **Cold launch against a server that is gone.** Both screens must say
  `disconnected`, not `empty`. `empty` is a claim the server answered.
- **A decision posted to a dead server.** The banner stays: withdrawing it would
  be the interface claiming a log entry that does not exist. The 404 half — the
  server refusing a decision on an alert it never raised — is C15's.
- **The fan-out socket cut mid-episode and resumed.** This is also where
  `URLSessionStreamSocket`'s success path finally gets coverage; C14 recorded
  that gap and it stayed open through C16.
- **An alert raised while the socket was down.** It has to reach the caregiver
  when the socket returns.
- **A refused permission.** Nothing scheduled, the refusal counted, and the
  episode still readable on the screen.

The fourth found the second real defect. `backfill()` re-read frames and not
alerts, so an episode that opened during an outage produced no fan-out message
and nothing ever asked for it again — the chart healed across the gap and the
alarm did not exist. "Silence is not continuity" was written about frames at C11
and is truer about alerts.

`DeviceDetailModel.backfill()` now re-reads the alert history too. Re-offering
episodes already seen is safe by construction: `NotificationPolicy` keys on
`alertId` and refuses a repeat, which is why it is a policy rather than a
branch.

### What C17 did not close, stated rather than implied

Three defaults have no test because no assertion can be written on the far side
of the call, and the reason was taken from a run rather than from documentation.
On the iOS 26.5 simulator, 2026-08-06:

| Call                              | What actually happens                                                                                                                                                                                      |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GatewayModel.live()`             | `NSInternalInconsistencyException` at `CoreBluetoothCentral.swift:61` — "State restoration of CBCentralManager is only allowed for applications that have specified the bluetooth-central background mode" |
| `NotificationCoordinator.live()`  | `NSInternalInconsistencyException` at `UserNotificationCenterAdapter.swift:34` — "bundleProxyForCurrentProcess is nil"                                                                                     |
| `UserNotificationCenterAdapter()` | the same raise; it is the default argument `.current()` that does it                                                                                                                                       |

An ObjC exception is not catchable from Swift, so these end the test process
rather than failing a test. The compensating control is unchanged from C14 — a
source scan asserting the app shell constructs both factories — and it is a
weaker control than a call, which is why it is named here.

One result contradicts a guess and is worth recording as such: `GatewayModel.live()`
**does** construct on the macOS host, where CoreBluetooth does not enforce the
background-mode rule. The simulator is the platform the gate runs on, and there
it raises.

Also still uncovered, and none of it accidental: the SwiftUI closures that only
run on user interaction — the retry button on a failed read, the permission-ask
button, and the `navigationDestination` that builds the device screen — because
this package has no UI-automation harness, and the `CoreBluetooth` delegate
methods, which need a peripheral.

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

Both the socket and the timer are ports, so almost every test drives a fake socket and a fake clock and never waits on wall time. The exceptions are named rather than left to be discovered: [DefaultPathTests](MaekbeatKit/Tests/MaekbeatKitTests/DefaultPathTests.swift) takes the real timer and the real socket against a refused port, which is the only way to cover the ports the app actually ships with, and the two macOS integration suites wait on a real server. The rules the tests pin rather than the prose:

- **A connection that never existed is not a reconnection.** The label is derived in one place; deriving it in two is what let apps/web flip between "connecting" and "disconnected" forever (its C11 mutation log).
- **Silence is not continuity.** Every re-open fires `onReconnect`, and [DeviceDetailModel](MaekbeatKit/Sources/MaekbeatKit/ViewState/DeviceDetailModel.swift) answers it with a REST back-fill from the newest frame it holds. A socket that dropped for forty seconds missed forty seconds.
- **A frame is identified by `(sessionEpoch, seq)`, never by a timestamp.** A device clock adjustment must not change a frame's identity ([packages/protocol](../../packages/protocol)); a late arrival is inserted at its capture time rather than appended where it turned up.
- **A message the contract rejects is counted and shown, never rendered.** That includes a frame outside its transport bounds: the screen says how many were dropped instead of drawing an SpO2 of 140.
- **One episode is one row.** The C7 engine gives one `alertId` per breach, so a lifecycle transition replaces its record. A timeline that counted firings would manufacture the alarm fatigue the engine exists to prevent.
- **The newest decision is the one in force.** A late-arriving older event changes nothing, the same rule `latestDecisions` holds server-side.

[APIClient.swift](MaekbeatKit/Sources/MaekbeatKit/Transport/APIClient.swift) covers the four read routes plus the two socket URLs, with failures split by cause — `network`, `http`, `contract` — which is what lets the interface tell "the server is down" apart from "the server said no". The acknowledgement route is deliberately absent: this app reads, and writing a client for a route no screen calls would be a claim about a feature.

Three files in the package touch the network — these two and [IngestClient.swift](MaekbeatKit/Sources/MaekbeatKit/Transport/IngestClient.swift), the uplink C15 added — and a source scan fails the build if a fourth appears — the rule apps/web holds in `src/styles/tokens.test.ts`, for the same reason: a view that can open its own connection is a view whose failure states nobody designed.

### The one real socket, and what it does not prove

`URLSessionStreamSocket` is the shipped factory, and [URLSessionSocketTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/URLSessionSocketTests.swift) opens a genuine socket at a refused loopback port to cover its construction, its failure branch, and close.

The success path — a completed handshake, a delivered frame — needs a live apps/server process, which is why C14 through C16 recorded it as uncovered. C17 covers it in [ServerFailureIntegrationTests](MaekbeatKit/Tests/MaekbeatKitTests/ServerFailureIntegrationTests.swift), where the device screen subscribes to a real server over that socket and has it cut mid-episode. Two limits stay: that suite runs on the macOS host, so those lines are outside the coverage number the gate prints, and it is not a browser-level smoke of the kind apps/web has at C13 — nothing renders.

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

## Test map

One row per test file, mapping it to the behaviours it pins — the same
file-to-behaviour table [apps/server/README.md](../server/README.md) carries,
and the iOS half of the C20 traceability story. Property suites run on fixed
seeds with fixed iteration counts, so CI is deterministic. The **Runs** column
matters here in a way it does not for the server: two of these files are behind
platform guards, and neither command in this package compiles both
([scripts/scope-notice.sh](scripts/scope-notice.sh) prints which one you just
ran).

| File                                                                                                          | Runs      | Pins                                                                                                     |
| ------------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------- |
| [BLELinkMatrixTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/BLELinkMatrixTests.swift)                       | both      | all 99 state-by-event cells, each asserting the landing state and the exact effect list                  |
| [BLELinkScenarioTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/BLELinkScenarioTests.swift)                   | both      | the effects each path emits, connecting vs recovering, backoff growth and reset, stall, radio loss       |
| [BLELinkPropertyTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/BLELinkPropertyTests.swift)                   | both      | 8 seeds × 500 events: no illegal state, no effect outliving its owner, backoff sized by its attempt      |
| [BLEDriverTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/BLEDriverTests.swift)                               | both      | effects becoming radio calls against a mock central, the fake-clock timers, undecodable payloads         |
| [GattProfileTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/GattProfileTests.swift)                           | both      | the MTU arithmetic, the codec round trip, byte order against hand-written bytes, every rejection         |
| [CoreBluetoothAdapterTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/CoreBluetoothAdapterTests.swift)         | both      | the six radio-state translations, and a real manager reporting `.unsupported` on a simulator             |
| [UplinkQueueTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/UplinkQueueTests.swift)                           | both      | resume from the last acknowledged seq, reboot handling, the bound, the reorder window                    |
| [IngestClientTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/IngestClientTests.swift)                         | both      | uplink states, capped backoff, a frame refused when the socket is not live, reply decoding               |
| [GatewayModelTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/GatewayModelTests.swift)                         | both      | notification in, `/ingest` frame out, acknowledgement back, and the resume across a reconnect            |
| [GoldenContractTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/GoldenContractTests.swift)                     | both      | the cross-language contract above, plus version, bounds, and missing-field rejection                     |
| [StreamClientTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/StreamClientTests.swift)                         | both      | state transitions, capped backoff, reconnect, delivery stopping at close, the socket built after close   |
| [APIClientTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/APIClientTests.swift)                               | both      | the four reads, URL building and escaping, the network/http/contract split, socket URL schemes           |
| [URLSessionSocketTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/URLSessionSocketTests.swift)                 | both      | the two shipped socket factories against a refused port: construction, failure branch, close             |
| [DefaultPathTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/DefaultPathTests.swift)                           | both      | every injected port taken at its default — the real transport, timer, sockets, driver clock, inert ports |
| [DefaultValueTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/DefaultValueTests.swift)                         | both      | the shipped queue bound and batch limit, the `ios-gateway` actor, the pre-open connection state          |
| [NotificationPolicyTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/NotificationPolicyTests.swift)             | both      | one episode one banner, the two suppression reasons, withdrawal on resolve or decision, permission       |
| [NotificationPropertyTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/NotificationPropertyTests.swift)         | both      | 6 seeds × 400 steps of replay and reconnect: dedupe, closure, and every effect accounted for             |
| [NotificationCoordinatorTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/NotificationCoordinatorTests.swift)   | both      | the decision round trip, a refused decision leaving the banner, permission read and asked                |
| [NotificationAdapterTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/NotificationAdapterTests.swift)           | both      | the authorization translation for every framework case, the request and the category as built            |
| [NotificationCopyTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/NotificationCopyTests.swift)                 | both      | the banned-word list over the notification body — what an alert may not say on a lock screen             |
| [NotificationWiringTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/NotificationWiringTests.swift)             | both      | socket alerts, REST seeds and decisions all reaching the centre through the policy rather than around it |
| [ViewStateTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/ViewStateTests.swift)                               | both      | the union, copy for every variant, the device list's four states, formatting, the state marks            |
| [DeviceScreenTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/DeviceScreenTests.swift)                         | both      | seed then live append, frame identity, ordering, the bounded window, back-fill, episodes, decisions      |
| [SourceDisciplineTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/SourceDisciplineTests.swift)                 | both      | no radio, no store, the disclaimer rendered, the network in three files, the app shell still a shell     |
| [NotificationDisciplineTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/NotificationDisciplineTests.swift)     | both      | no APNs, no device token, no push server, and UserNotifications in its own adapter alone                 |
| [ViewRenderingTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/ViewRenderingTests.swift)                       | simulator | every screen in every designed state through a real layout pass, and the production screen initialiser   |
| [CompositionTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/CompositionTests.swift)                           | simulator | the screens running their own `.task`: the gateway started, the centre prepared, the permission re-read  |
| [GatewayIntegrationTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/GatewayIntegrationTests.swift)             | macOS     | the resume contract and the decision circuit against a real apps/server process                          |
| [ServerFailureIntegrationTests.swift](MaekbeatKit/Tests/MaekbeatKitTests/ServerFailureIntegrationTests.swift) | macOS     | a dead server, a refused decision, a socket cut mid-episode, an alert raised during the outage, denial   |

**What remains verifiable only on physical hardware:** scanning, discovery,
connection, subscription and notification delivery over a real radio; iOS
relaunching a terminated app into a restored central; throughput, latency, range
and battery; the permission prompt and what a person answers; a banner appearing
and its buttons working from the lock screen; delivery while backgrounded,
suspended or terminated; and every instance method on
`UserNotificationCenterAdapter`, which no gate here can call at all. The two
tables above — one per commit — list those row by row alongside the procedure
someone with a device would follow.

`ViewRenderingTests` is not a snapshot suite and does not claim to be one:
nothing compares pixels, and a view that lays out badly still passes. What it
proves is that each `body` is evaluated on the platform the app ships on, in each
state, without trapping — an index into an empty window, a `ForEach` over
non-unique ids. It is also what puts the view files in the coverage denominator
honestly; the alternative was a lower threshold and a paragraph explaining why
views do not count, which is the exemption the ratchet exists to refuse.

`CompositionTests` is its opposite number and the two are kept apart
deliberately. Rendering evaluates bodies and must not reach a server;
composition makes the window key so the `.task` modifiers really fire, and its
gateway is the injected one for the same reason.

What is **not** covered: no view's layout, spacing, or contrast is asserted, no
screen reader has read this interface, and there is no accessibility audit of the
kind apps/web ran at C12 — VoiceOver rotor order, dynamic type at accessibility
sizes, and target size in points are all unmeasured here. The controls carry
accessible labels and a 44x44 minimum by declaration, which is a design intent
rather than a measurement. Notification authorization is read at launch and on
every appearance of the link screen, and not on foregrounding: picking up a
change made in Settings while the app is away would need a `scenePhase` observer
that no gate here can drive, so it is a stated limit rather than a claim.

## The gate, and why it exists at all

`apps/ios` is not a pnpm workspace package. It has no `package.json`, so `pnpm -r test:coverage` skips it and the C9 guard that fails when a package lacks that script cannot see it — the exact hole C9 closed for the web, reopening in a new language. Leaving it ungated was never the option; the choice was between a real iOS CI job and a written exemption, and the job won because it costs nothing:

**GitHub-hosted macOS runners are free and unmetered for public repositories.** Standard runners carry no charge in a public repo, macOS included, and only the larger (`-large`, `-xlarge`) runners are billed. Checked 2026-08-05 against GitHub's Actions billing documentation and the `actions/runner-images` support matrix; this repository is public.

If it ever went private, macOS minutes would be billed at the standard macOS rate and this decision would need making again.

The `ios` job in [.github/workflows/ci.yml](../../.github/workflows/ci.yml) runs three steps, and the `tests` job asserts the third one still exists — anchored to the step as CI would execute it, because an unanchored `grep` for that path matches the guard's own line and would have applauded the job's deletion:

1. `scripts/lint.sh` — SwiftLint `--strict`, so every violation is an error, over all of `apps/ios` rather than a list of directories. `.swiftlint.yml` carries no `included:` key on purpose: it would override the path the script passes, and a Swift file added anywhere else under `apps/ios` would compile into the app and never be linted. The binary is a pinned 0.65.0 release verified against a recorded SHA-256, the way the docs gates pin prettier and markdownlint.
2. `scripts/build-app.sh` — the app target for a simulator. Nothing in the package build links the shell, so this is the only step that proves the thing a person can launch still compiles. C12a's lesson, one target out.
3. `scripts/test.sh` — `xcodebuild test` on a discovered simulator destination with coverage, then `scripts/coverage-gate.sh`.
4. `scripts/integration.sh` — the gateway against a real apps/server on the macOS host (C15). Outside the coverage gate, because the simulator cannot spawn a process; the script fails the step if the suite skips for want of an installed workspace, since a skip in CI is a green tick for a check nobody ran.

### The ratchet, and how it differs from the others

The threshold is **91% line coverage on the `MaekbeatKit` target**, raised at C17 from the 89 C14 set. Every measurement so far, each on the method above: C14 measured 91.37%, C15 measured 91.71% (1782/1943 lines), C16 measured 91.36% (2137/2339), and C17 measures **93.80% (2239/2387)** — Xcode 26.6, iOS 26.5 simulator, 2026-08-06 — with the CoreBluetooth and UserNotifications adapters' untestable halves counted against it.

C17 raises it because C17 is the commit that earned it: the number moved because defaults that had no caller got one, not because a number was chased. C15 and C16 left it alone for the same rule in reverse — a raise is its own deliberate commit ([CLAUDE.md](../../CLAUDE.md)), and a feature commit is not that commit. It moves only up, and never by excluding a file.

Two differences from the TypeScript packages, both stated rather than smoothed over:

- **One number, not four.** `xccov` reports lines covered out of lines executable. It has no branch or function percentage of the kind vitest's v8 provider gives, so this gate cannot ratchet branches the way `apps/server` and `apps/web` do.
- **The denominator is a target, not a directory.** It is the `MaekbeatKit` library — every line the app's logic and views ship — with the test target excluded, which is the same "src/ minus tests" rule each `vitest.config.ts` uses. `App/MaekbeatApp.swift` is outside it, as recorded above.
- **There is no environment override.** `THRESHOLD` is a literal in [scripts/coverage-gate.sh](scripts/coverage-gate.sh). CLAUDE.md forbids lowering a threshold by a flag, and an override that exists is one CI can be given; proving the gate bites means editing that line and reverting it, exactly as the vitest packages are proved by editing their configs.

A target is the unit the gate measures, which makes a second target the way to ship code no threshold covers. That cannot be caught in the coverage report — a target with no exercised code produces no row to object to — so it is caught at the manifest: [SourceDisciplineTests](MaekbeatKit/Tests/MaekbeatKitTests/SourceDisciplineTests.swift) asserts `Package.swift` declares exactly `MaekbeatKit` and `MaekbeatKitTests`, and that `Sources/` holds exactly one directory. The same test reads `Maekbeat.xcodeproj`'s sources build phase and asserts the app target compiles nothing but `MaekbeatApp.swift`, because the project file can name any path and the shell cap only ever looked inside `App/`.

The simulator destination is discovered rather than pinned ([scripts/simulator-destination.sh](scripts/simulator-destination.sh)): this machine and the runner have different device line-ups, and a hard-coded model name breaks on whichever one Apple retires first. The runner image's default Xcode is what runs, echoed in the job output rather than pinned — pinning a version the image later drops would break CI on Apple's release schedule instead of on a change here. The language does not float with it: the package is `swift-tools-version:5.10` and the app target builds at `SWIFT_VERSION 5.0`.

Every guard in this commit was broken by a mutation of the thing it names and, where a neighbour existed, by that too. The results are in [docs/ai/mutation-log.md](../../docs/ai/mutation-log.md), including the two the adversarial pass added after the first round found them missing.
