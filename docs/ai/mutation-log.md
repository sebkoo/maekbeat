# Mutation log

Every guard in this repo is proven by breaking what it protects and watching the
guard fail. The loop contract in [AI_USAGE.md](AI_USAGE.md) requires that proof
at writing time; this file is the record it refers to.

One row per proof: the guard, the mutation applied to the code it guards, and
what happened. "caught" means the named suite failed with the mutation applied
and passed again once it was reverted. Every mutation here was applied to a
working tree and reverted immediately; none is present in any commit.

## C10 — scaffold and design tokens

| Guard                                | Mutation                                                | Result |
| ------------------------------------ | ------------------------------------------------------- | ------ |
| coverage ratchet, apps/web           | raise the statements threshold above the measured floor | caught |
| contrast pairs, tokens.test.ts       | wash out `--mb-color-text-muted` in the light theme     | caught |
| no colour literal outside tokens.css | add a hex to a rule in app.css                          | caught |
| no paint attribute in markup         | add `fill="#123456"` to the alert badge                 | caught |
| no dead token                        | define `--mb-space-7`, read by nothing                  | caught |
| dark-theme parity                    | delete one colour token from the dark block             | caught |
| network isolation                    | call `fetch()` from a route component                   | caught |
| superseded-read guard, useAsync      | delete the `signal.aborted` check                       | caught |
| class contract, CSS → DOM            | style a class nothing renders                           | caught |
| class contract, DOM → CSS            | render a class nothing styles                           | caught |

## C11 — live chart over WebSocket

| Guard                                | Mutation                                                    | Result |
| ------------------------------------ | ----------------------------------------------------------- | ------ |
| gaps are gaps                        | make `splitAtGaps` return one run, drawing through the hole | caught |
| decimation keeps the event           | replace the min/max envelope with stride sampling           | caught |
| socket closed on unmount             | drop `subscription.close()` from the effect cleanup         | caught |
| back-fill scoped to its subscription | drop the `controller.signal.aborted` guard                  | caught |
| alert marks stay inside the window   | anchor every alert regardless of the frame window           | caught |
| one session per trace                | draw every session on one device-clock axis                 | caught |
| reboot ordering                      | sort the window by capture time alone                       | caught |
| connection-state honesty             | report "reconnecting" before ever connecting                | caught |

## C12 — timeline, acknowledgement, WCAG 2.2 AA

| Guard                                      | Mutation                                                    | Result                                                                  |
| ------------------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| append-only decision log                   | make `append` replace the existing event for an alert       | caught                                                                  |
| decisions in force                         | count every event instead of the newest per alert           | caught                                                                  |
| the log is not handed out by reference     | return the internal array from `list()`                     | caught                                                                  |
| a decision needs a real alert              | remove the engine membership check from the route           | caught (superseded at C12a: presence is no longer the test — see below) |
| decisions reach other dashboards           | stop publishing the appended event                          | caught                                                                  |
| a refused decision leaves no checkmark     | apply the decision optimistically before the server answers | caught                                                                  |
| a running episode is not shown as finished | drop the "and counting" branch                              | caught                                                                  |
| the chart is not a live region             | add `aria-live` to the chart element                        | caught                                                                  |
| silence on arrival                         | remove the priming guard from the announcer                 | caught                                                                  |
| the announcer speaks only on transitions   | announce on every render                                    | caught                                                                  |
| acknowledgement controls are real buttons  | swap the button for a `div` with `role="button"`            | caught                                                                  |
| lifecycle grouping                         | make `mergeAlerts` append instead of replacing by alertId   | caught                                                                  |
| decisions from the socket are applied      | drop the decision branch from the client's message handler  | caught                                                                  |
| declared target size                       | delete `min-width`/`min-height` from `.mb-button`           | caught                                                                  |

Two C12 proofs failed to catch their mutation on the first attempt, which is the
point of running them: `mergeAlerts` appending was invisible because the test
fed the component one already-merged record (the guarantee belonged to a layer
the test never exercised), and the client's decision branch was uncovered
because the handler was wired but never asserted. Both gaps were closed by
adding the missing assertions, then re-proved.

Four further C12 tests were shown vacuous by the adversarial pass that followed,
after these proofs had passed — recorded in [AI_USAGE.md](AI_USAGE.md). A
mutation proves only what it mutates.

## C12a — semantic eviction

Each guard is broken by mutating the thing it names and, where a neighbour
existed, by mutating that too — the rows with `—` in the third column had none.

| Guard                               | Own mutation                                        | Neighbour mutation                                      | Result |
| ----------------------------------- | --------------------------------------------------- | ------------------------------------------------------- | ------ |
| decided evicted before undecided    | evict in arrival order regardless of decision state | evict the newest decided instead of the oldest          | caught |
| a running episode is not forgotten  | prefer any decided alert, resolved or not           | —                                                       | caught |
| forced evictions counted            | drop the counter increment                          | count but never announce                                | caught |
| the warn means "nobody is triaging" | announce on a healthy decided-first eviction        | —                                                       | caught |
| an evicted alert stays decidable    | require presence in the history again               | stop checking device ownership                          | caught |
| alertIds are canonical              | drop the mint/parse round-trip check                | parse the device id from the left instead of the right  | caught |
| every mintable id is parseable      | allow a rule id outside the alertId charset         | —                                                       | caught |
| decisions are device-scoped         | search every device's log in `isDecided`            | —                                                       | caught |
| the counter is per device           | serve the process-wide counter on the device row    | hard-code zero                                          | caught |
| the feature is actually wired       | drop `isDecided` from the composition root          | drop the forced-eviction warn from the composition root | caught |

Three of these failed to fail on the first attempt, and each exposed something
real: the device-summary counter was only ever asserted against zero, so a
global counter passed; the running-episode test put the open alert after the
resolved one, so arrival order hid the bug; and the whole feature could be
unwired in `buildApp` with all 111 server tests still green, because every unit
test built its own engine. The integration suite in
apps/server/src/retention.integration.test.ts exists because of that last one.

## C13 — Playwright smoke

The acceptance requirement for the smoke suite was not "it runs" but "it catches
the class that got through". Three reverts, each run against both gates:

| Reverted                                             | Unit and integration suites | Smoke suite |
| ---------------------------------------------------- | --------------------------- | ----------- |
| the CORS registration in `buildApp` (the C12 defect) | fail                        | fail        |
| the decision route's fan-out and the client's POST   | fail                        | fail        |
| the production bundle's asset base path              | **pass**                    | fail        |

The first two fail in both places today, and that is worth stating plainly: C12
and C12a added unit tests for exactly those defects after the fact, so the
suites now cover them. What they could not cover before, and still cannot in
general, is the third row — nothing below the browser builds the bundle, so a
production build that cannot load its own assets is invisible to every unit
test in the repo and obvious to the smoke suite in under two seconds.

That is the reach this commit buys: not the specific bugs already caught, but
the class of defect that lives between the pieces.

## C14 — iOS scaffold, SwiftLint, simulator transport

Each guard is broken by mutating the thing it names and, where a neighbour
existed, by mutating that too — the C12a convention, with the same `—` for rows
that had none. Logic mutations were run against `swift test`; the render, lint,
coverage, app-build, and CI-guard rows were run against the gate that owns them.

### The cross-language contract

| Guard                           | Own mutation                            | Neighbour mutation                          | Result |
| ------------------------------- | --------------------------------------- | ------------------------------------------- | ------ |
| golden decode, field by field   | rename `spo2Pct` in the fixture bytes   | rename the same field on the Swift type     | caught |
| golden key set, both directions | add `batteryPct` to every fixture frame | delete `respirationRpm` from the Swift type | caught |
| the header line's shape         | rename the header's `tickMs`            | —                                           | caught |
| transport bounds                | drop the SpO2 bound from `validated()`  | drop the protocol-version check             | caught |

The added-field row is the one that earns the round-trip: a plain decode passes
it, because Swift's `Codable` ignores keys it does not know where
`z.strictObject` rejects them. Comparing the re-encoded key set with the
fixture's is what turns that silence into a failure.

### The transport

| Guard                                  | Own mutation                            | Neighbour mutation                        | Result |
| -------------------------------------- | --------------------------------------- | ----------------------------------------- | ------ |
| a re-open asks the caller to back-fill | drop the `onReconnect` call             | fire it on the first open too             | caught |
| state is reported on transitions only  | report on every attempt                 | say "reconnecting" before ever connecting | caught |
| a pending retry dies with the screen   | drop `cancelRetry?()` from `close()`    | drop `socket?.close()` from `close()`     | caught |
| nothing is delivered after close       | drop the guard in `handleMessage`       | —                                         | caught |
| backoff is capped                      | remove the 15 s cap                     | —                                         | caught |
| a socket built after close is closed   | hand it to the field without checking   | —                                         | caught |
| the back-fill resumes from the newest  | ask for the whole window instead        | —                                         | caught |
| unreachable is not the same as refused | make every failure read as disconnected | —                                         | caught |

### The device screen

| Guard                               | Own mutation                        | Neighbour mutation                           | Result |
| ----------------------------------- | ----------------------------------- | -------------------------------------------- | ------ |
| identity is `(sessionEpoch, seq)`   | key frames on `seq` alone           | key them on the device clock                 | caught |
| a late arrival lands at its capture | append every frame                  | —                                            | caught |
| the window is bounded               | drop the trim                       | —                                            | caught |
| one episode is one row              | append alerts instead of replacing  | key the replacement on metric, not `alertId` | caught |
| the newest decision is in force     | always overwrite                    | never overwrite                              | caught |
| a rejected message is counted       | drop the counter                    | —                                            | caught |
| empty is a state, not a short list  | render an empty device list as data | —                                            | caught |

### The honesty guards

| Guard                               | Own mutation                                 | Neighbour mutation                          | Result |
| ----------------------------------- | -------------------------------------------- | ------------------------------------------- | ------ |
| no radio this app does not have     | add a `CBCentralManager` mention to a view   | add an App Store line to `Copy`             | caught |
| the disclaimer is on screen         | drop `DisclaimerBar()` from `RootView`       | soften the words to "for informational use" | caught |
| the network lives in two files      | name `URLSession` in a view                  | —                                           | caught |
| the app shell stays a shell         | add twelve lines of logic to it              | add a second file to `App/`                 | caught |
| every screen renders in every state | make `StatusPanelView` return an `EmptyView` | —                                           | caught |

### The gates themselves

| Guard                       | Mutation                                                         | Result                                                       |
| --------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------ |
| the coverage ratchet bites  | raise the threshold to 95, above the 91.37% floor                | caught                                                       |
| the gate fails loudly       | point it at a target name the report does not carry              | caught — exits 1 rather than passing on an empty match       |
| SwiftLint `--strict`        | add a force unwrap to `Format`                                   | caught                                                       |
| the app-shell build gate    | make the shell call `RootView` with a parameter it does not have | caught by `build-app.sh`; the package suite stays green      |
| no directory is gate-exempt | create `apps/fake/` with no `package.json`                       | caught — the CI guard's catch-all fails a new one by default |

The last two rows are the C13 lesson in this language. The app-shell mutation is
invisible to every test in the package — the library compiles and its 90 tests
pass — and the thing a person can launch does not build. The `apps/fake/` row is
the hole this commit was written to close: before it, a directory that pnpm
cannot see contributed nothing to any gate and nothing said so.

Five of those rows exist because of the adversarial pass, not the first round,
and each was green before it: the `ios` job could be deleted whole and the guard
written to prevent it applauded, because its `grep` matched its own text; a
second SwiftPM target shipped 26 untested lines with the gate reporting the same
91.37%, and could not be caught in the report at all, since a target with no
exercised code produces no row to object to — so it is caught at the manifest
instead; a Swift file named by the pbxproj from outside `App/` compiled into the
app while `.swiftlint.yml`'s `included:` list silently overrode the path
`lint.sh` passes, so it was neither linted nor scanned nor measured; the
threshold had an environment override, which CLAUDE.md forbids and CI could have
been handed; and `DisclaimerBar()` could be moved inside the `NavigationStack`,
where every push replaces it, with all 83 tests green, because the scan asked
whether the bar was rendered and not where.

### Scope ranges stated in more than one place

`scripts/check-scope-ranges.sh` exists because the board rule did not cover the
Stack table: at C14 it still said the server ended at C11 and the web at C11,
two sections below a repository tour that already said C12 and C13. Nothing was
wrong with the board rule as written — it named the progress board, and the
progress board was correct. The drift was in the sentences beside it.

| Guard                                | Own mutation                                        | Neighbour mutation                                 | Result             |
| ------------------------------------ | --------------------------------------------------- | -------------------------------------------------- | ------------------ |
| the three statements agree           | leave the Stack web row at C10–C11 (the real drift) | leave the Stack server row at C5–C11               | caught             |
| the tour cannot advance alone        | move the tour to C10–C14, Stack table unchanged     | leave `apps/server/README.md`'s headline at C5–C12 | caught             |
| the iOS row is really read           | set the Stack iOS range to C13                      | set the tour's iOS range to C15                    | caught             |
| a headline cannot drift              | set `apps/ios/README.md` to C15                     | —                                                  | caught             |
| the check cannot match nothing       | reword the Stack cell out of the shape it reads     | —                                                  | caught             |
| a planned range is not a shipped one | extend the iOS row's "CoreBluetooth planned, C15"   | —                                                  | no fire, correctly |

The last row is a negative control rather than a proof: the iOS Stack cell
states a shipped C14 and a planned C15 in one sentence, and a guard that read
the last number on the line would call the app shipped through C15. Extending
the planned half must leave the check silent, and it does.

One test in this commit passed vacuously while it was being written, which is
the class the 2026-08-05 amendment in [AI_USAGE.md](AI_USAGE.md) is about.
`StreamClient` holds only weak references to itself inside its socket handlers,
so several transport tests that left the client to a local `let` were asserting
against an object ARC had already released: every assertion about what it did
held, because it did nothing. The suite now keeps the client on the test case
for its lifetime, and the reason is written where the next reader will hit it.

## Fan-out delivery: waiting for a condition, not for the clock

`apps/server/src/stream.test.ts` asserted that a dashboard had received 110
fan-out messages after a fixed 40 ms pause. Fan-out is asynchronous, so what has
arrived by any given millisecond is a property of the machine. On a loaded CI
runner 76 had arrived and `main` went red; on every developer machine it passed.

That is the part worth recording plainly: **this test gave a false green locally
for every commit since C11.** The suite's guarantee was environment-dependent,
and the environment where it was usually run was the fast one. Nothing in the
gate said so, because a test that passes tells you nothing about why.

| Guard                                    | Own mutation                                         | Neighbour mutation                           | Result              |
| ---------------------------------------- | ---------------------------------------------------- | -------------------------------------------- | ------------------- |
| every accepted frame is pushed           | drop `seq` 42 in `publishFrame`                      | —                                            | caught              |
| the dedupe test is real                  | push duplicates instead of dropping them             | —                                            | caught              |
| the repaired test is not slower to trust | delay every send by `n × 2` ms, run the **old** test | the same delay against the **repaired** test | caught, then passes |

The third row is the one that matters and is worth reading as a pair. Under
artificial slowness the old test failed with `expected […] to have a length of
110 but got 17` — the CI failure reproduced on demand — and the repaired test
passed all ten cases against the same slowed server. The fix cannot be hiding a
real drop: with `seq` 42 dropped, the repaired test still fails, and it now says
`timed out after 3000 ms waiting for 110 frame messages; received 109`, which
names the defect instead of shrugging at a clock.

The wait budget is 3 s rather than vitest's default 5 s `testTimeout` on
purpose: whichever fires first writes the message, and the one that counts the
frames is more useful than the one that counts the seconds.

### The sweep, and what was left alone

The class is "a count or a final state of asynchronously delivered messages,
asserted after a fixed wait". Every instance in the repository:

| Site                                               | Verdict                                                                                 |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `stream.test.ts` — 110 delivered frames            | fixed: wait for the count                                                               |
| `stream.test.ts` — the ready greeting              | fixed: wait for the first message                                                       |
| `stream.test.ts` — dedupe pushes one frame         | fixed, and made deterministic — see below                                               |
| `stream.test.ts` — subscriber attach and detach    | fixed: wait for `subscriberCount`                                                       |
| `acks.test.ts` — 110 frames must raise an alert    | fixed: wait for the engine to hold one                                                  |
| `acks.test.ts` — a decision fans out exactly once  | fixed: wait for the first, then a stated grace for the absence of a second              |
| `apps/web/e2e/journey.spec.ts` — two `setTimeout`s | left: pacing between sends and a flush before close, not assertion waits — every        |
|                                                    | assertion in that file is a Playwright web-first `expect`, which retries on a condition |
| `apps/server/scripts/demo.ts` — `sleep`            | left: demo pacing, not a test                                                           |

The dedupe case did better than a wait. Rather than pausing to see whether a
duplicate shows up, the test now sends the duplicate followed by a distinct
frame and waits for _that_ to arrive: delivery order on one socket is preserved,
so a pushed duplicate would already be sitting between them. An absence became a
condition, and the only remaining grace period in the suite is the one in
`acks.test.ts`, where a second fan-out of a single decision genuinely is an
absence and no amount of polling can prove one.

## The guard that rejected a true statement

`main` went red because GitHub's squash merge writes an accurate trailer:

```text
Co-authored-by: dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>
```

and G1's pattern opened with a bare `co-authored-by:` term. Two correct commits
(822af19, 8f6c411) were rejected for stating who wrote them. The fix is the
guard, not the commits — deleting a true co-author line to satisfy a check would
falsify authorship, which is the opposite of what G1 exists to protect. The term
now requires an AI name on the same line.

| Guard                                 | Own mutation                               | Neighbour mutation                                | Result |
| ------------------------------------- | ------------------------------------------ | ------------------------------------------------- | ------ |
| the co-author term names an AI        | widen it back to bare `co-authored-by:`    | widen only the CI script, leaving the hook narrow | caught |
| the same widening fails CI's history  | widen it in `check-commit-hygiene.sh` only | —                                                 | caught |
| the AI co-author term is load-bearing | drop it from the pattern                   | —                                                 | caught |
| the session-marker term               | drop `claude-session`                      | —                                                 | caught |
| the anthropic-address term            | drop `noreply@anthropic`                   | —                                                 | caught |
| the generated-with term               | drop `generated with claude`               | —                                                 | caught |
| the two copies stay identical         | narrow one file and not the other          | —                                                 | caught |

The matrix in `scripts/test-githooks.sh` grew six reject rows and three accept
rows, and gained an assertion that the pattern is byte-identical in the hook and
in the history scan — anchored to the executable lines, because both files now
discuss the rule in prose and an unanchored match compares comments. That was
itself a first-attempt failure: the check matched a backticked mention in a
comment and reported a drift that did not exist.

### The fourth landmine, and the first that was not caught first

This is the fourth member of a family: a platform behaviour that turns a correct
guard into a wrong one.

| #   | Landmine                                                                                | Found                                        |
| --- | --------------------------------------------------------------------------------------- | -------------------------------------------- |
| 1   | merge commits have git-generated subjects, so Conventional Commits cannot apply to them | before it fired — C6 added `--no-merges`     |
| 2   | GitHub withholds Actions secrets from fork pull requests                                | before it fired — C10 conditioned the upload |
| 3   | Dependabot runs read a separate secret store                                            | before it fired — same commit                |
| 4   | GitHub's squash merge adds a real `Co-authored-by:` trailer                             | **after it fired**                           |

Three were anticipated by reading how the platform behaves before it had a
chance to bite. This one was not, and it is worth being plain about why that
matters more than the two commits it reddened: the same guard would have
rejected **the first outside contributor's squash merge at C23**, on a
repository that opens for contributions at C23, for the offence of recording who
wrote the code. A contributor's first interaction would have been a red build
blaming them for accurate authorship. The two Dependabot commits were the cheap
version of that failure.

The general shape, since three of the four are the same shape: a guard written
against _what this project does_ meets _what the platform does on its behalf_.
Merge subjects, secrets, and trailers are all written by GitHub, not by an
author, and none of them were in view when the rule was drafted.

## C15 — CoreBluetooth central, BLE state machine, gateway uplink

Own mutation and, where a neighbour existed, its neighbour. Logic ran against
`swift test`; the rows marked REAL SERVER ran against a live apps/server through
apps/ios/scripts/integration.sh.

### The state machine

| Guard                              | Own mutation                               | Neighbour mutation                   | Result |
| ---------------------------------- | ------------------------------------------ | ------------------------------------ | ------ |
| recovering is not connecting       | make `retryState` always `.connecting`     | make it always `.recovering`         | caught |
| illegal transitions are rejected   | turn the `default` reject into an ignore   | —                                    | caught |
| stop clears the intent             | keep `wantsLink` through `halt()`          | clear it when the radio goes instead | caught |
| a success resets the failure count | drop `attempt = 0` on notificationsEnabled | —                                    | caught |
| a frame re-arms the stall deadline | stop re-arming on `frameReceived`          | —                                    | caught |

### The profile

| Guard                          | Own mutation                           | Neighbour mutation                 | Result |
| ------------------------------ | -------------------------------------- | ---------------------------------- | ------ |
| the frame fits the default MTU | widen the payload to 21 bytes          | zero the ATT notification overhead | caught |
| the codec is little-endian     | read `seq` most-significant-byte first | —                                  | caught |
| bounds hold on the radio path  | drop `validated()` from `decode`       | accept any profile version         | caught |

### Resume, and the C6 contract

| Guard                             | Own mutation                               | Neighbour mutation                          | Result |
| --------------------------------- | ------------------------------------------ | ------------------------------------------- | ------ |
| a reconnect resends only the tail | keep the in-flight mark across a reconnect | clear the acknowledged mark too — see below | caught |
| a reboot is not replayed across   | keep the pre-reboot buffer                 | —                                           | caught |
| the reboot window is the server's | set `reorderWindow` to 0                   | set it to 4096                              | caught |
| the buffer is bounded             | remove the cap                             | —                                           | caught |
| the model actually resumes        | drop the pump from `onReconnect`           | stop marking frames sent                    | caught |
| REAL SERVER: no replay on resume  | clear the acknowledged mark on reconnect   | —                                           | caught |
| REAL SERVER: the window matches   | set `reorderWindow` to 4096                | —                                           | caught |

### The honesty guards, evolved rather than deleted

C14 banned the radio's whole vocabulary from apps/ios because there was no
radio. C15 has one, so the ban became a boundary — the framework may be named in
`CoreBluetoothCentral.swift` and nowhere else — and the tests moved from
scanning file text to scanning code, so a file can explain the rule it obeys
without tripping it.

| Guard                            | Own mutation                                | Neighbour mutation                             | Result |
| -------------------------------- | ------------------------------------------- | ---------------------------------------------- | ------ |
| the radio lives in one file      | name `CBCentralManager` in the driver       | rename the adapter so the check has no subject | caught |
| the adapter holds no logic       | give it an `attempt` counter                | —                                              | caught |
| no user-visible wearable claim   | add "your device is connected" to `Copy`    | —                                              | caught |
| the background mode is declared  | remove `UIBackgroundModes` from the pbxproj | remove the usage description                   | caught |
| the network stays in three files | open a `URLSession` from a view             | —                                              | caught |

### The remodel: three bugs that were one design problem

An adversarial pass found three cells of the transition table whose answer
depended on which setup path reached the state. That is one problem wearing
three faces: the table was indexed by phase, the machine also consulted
`hasStreamed`, and so a cell could have two answers and the test asserted
whichever the setup happened to produce.

Folding `hasStreamed` into `LinkState` and re-running produced a failing cell
nobody had predicted — `disconnected + radioReady` — because `wantsLink` had
escaped the type the same way. Both are in the state now, nine states, and three
combinations are unrepresentable rather than merely unused.

What the remodel surfaced, and what it did not, because the difference is the
point:

| Symptom                                                           | Surfaced by the remodel?                                                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| a restarted session reporting "readings are being missed"         | **yes** — the cell forced a decision about what `stop` produces                                         |
| `radioReady` resuming a link nobody asked for                     | **yes** — a cell that failed on the first run after folding in the flag                                 |
| a retry timer outliving the state that scheduled it               | **no** — a lifetime error, not a state one; the table had to start asserting effects before it appeared |
| the cold-start backoff reading 2 s where three documents said 1 s | **no** — an off-by-one in a counter, found by pinning the sequence                                      |

| Guard                                    | Own mutation                               | Neighbour mutation                   | Result                                     |
| ---------------------------------------- | ------------------------------------------ | ------------------------------------ | ------------------------------------------ |
| stop ends the session                    | keep `hasStreamed` through `halt()`        | clear it when the radio goes instead | caught                                     |
| every exit cancels a pending retry       | drop `cancelRetry` from `halt()`           | drop it from `radioLost()`           | caught                                     |
| a fresh start cancels an inherited retry | drop `cancelRetry` from `beginAttempt`     | —                                    | caught                                     |
| the driver acts on `cancelRetry`         | make the effect a no-op in `BLEDriver.run` | —                                    | caught, after a test was added — see below |
| the cold-start backoff is 1 s            | start the counter at 1 again               | —                                    | caught                                     |
| `wantsLink` gates a returning radio      | resume whether or not it is wanted         | —                                    | caught                                     |
| `streaming` implies `hasStreamed`        | make the accessor return false             | —                                    | caught                                     |

Two rows there earned their place by failing first. The driver's handling of
`cancelRetry` was uncaught: the matrix proves the machine _emits_ the effect,
and nothing proved the driver _acts_ on it — the half of the fix that stops the
timer. A driver test now asserts that after leaving a pending retry, firing the
scheduler produces no reconnect and no rejected event, which is exactly the
symptom the original bug had.

The other was a deletion. Clearing the driver's retry handle from inside the
fired closure could not be caught by any mutation, and the three questions gave
the same answer they gave for `resumeSeq`: cancelling a spent timer is already a
no-op, there is no threat to name, so the line went. The rule added to
AI_USAGE.md in this same commit had teeth within an hour of being written.

One more thing the remodel exposed, and it is about the harness rather than the
code: `swift test` on macOS does not compile the UIKit-guarded render tests, so
a green fast loop is not a green gate. The state-type change broke
`ViewRenderingTests` and only `scripts/test.sh` on the simulator said so.

### `lastAckedSeq`: the mutation that could not be caught

One C15 mutation resisted every attempt — clearing `lastAckedSeq` on an uplink
reconnect changed nothing observable, because `acknowledge` already removes the
acknowledged frames from `pending`. Rather than write a test to chase it, the
field was put through the three questions now recorded in
[AI_USAGE.md](AI_USAGE.md): does it change anything observable, what specific
threat does it defend against, and if neither can be answered, should it exist?

Probing each of its five uses separately gave three different answers, so the
resolution is three different actions:

| Use                                              | Mutation result | Branch taken                                          |
| ------------------------------------------------ | --------------- | ----------------------------------------------------- |
| `offer()` refuses a frame at or below the mark   | caught          | **(a)** — observable, already tested                  |
| the `lastAckedSeq` term in `nextBatch()`'s floor | NOT caught      | **(c)** — deleted; `pending` cannot hold such a frame |
| `resumeSeq`, read by no production code          | NOT caught      | **(c)** — deleted; public API nothing called          |
| cleared on a peripheral reboot                   | caught          | **(a)** — observable, already tested                  |
| surviving an uplink reconnect                    | NOT caught      | **(b)** — threat named, test written, now caught      |

The named threat for the last row: **the uplink reconnects, and the peripheral
then re-offers a frame the server has already filed.** Peripheral retransmits
are not hypothetical in this design — they are the reason the queue borrows the
server's reorder window instead of treating every regression as a reboot — and
both links can drop together, since a phone going out of range takes the radio
and the wifi with it. Without the surviving mark that re-offer is queued, sent,
and answered `duplicate`, which is the one outcome the resume rule exists to
prevent. The test stages exactly that, at unit level and again against the real
server, and the once-uncatchable mutation is caught by both.

Two of the C15 rows above reported NOT CAUGHT on the first attempt and were
neither a missing test nor dead state — they were the harness. The mutation
script replaced only the first occurrence of its anchor, and
`project.pbxproj` declares `INFOPLIST_KEY_UIBackgroundModes` twice, once per
build configuration; the Debug copy went away and the Release copy kept the
assertion green. Both are caught once the mutation removes both. Worth recording
because a mutation harness is a test of the tests, and it can be wrong in the
direction that flatters everyone: a false NOT CAUGHT invites deleting a guard
that works.

Two things were deleted rather than tested, and that is the part worth keeping:
a second filter for a state that cannot occur, and a computed property only its
own tests read. Writing tests for either would have pinned internals nothing
observes, and left two pieces of parallel truth to drift.

## The fast loop states its own scope

The C15 remodel broke `ViewRenderingTests` and `swift test` on macOS did not
notice, because that file is behind `#if canImport(UIKit)` and the fast loop
never compiles it. Only the simulator gate said so. The footnote recording that
had been in apps/ios/README.md the whole time, which is the problem: a green
check that verifies less than it appears to gets trusted eventually, and a
document is not a mechanism.

Neither command in the package is complete, and the gaps point opposite ways —
the macOS loop cannot compile the UIKit render tests, and the simulator gate
cannot spawn the process the integration suite needs. So each run now prints
what it did not compile, derived from the platform guards in the sources rather
than from a list somebody must remember to update, and `scripts/fast.sh`
refuses to run under CI.

| Guard                                             | Own mutation                                 | Neighbour mutation                  | Result                                      |
| ------------------------------------------------- | -------------------------------------------- | ----------------------------------- | ------------------------------------------- |
| the README documents a loop that states its scope | point it back at a bare `swift test`         | remove the fast-loop script from it | caught                                      |
| the loop always prints its scope                  | drop the notice call from `fast.sh`          | —                                   | caught                                      |
| the notice is derived, not hard-coded             | put a new file behind `#if canImport(UIKit)` | —                                   | the notice listed it — derivation confirmed |
| the loop is not a gate                            | run it with `CI=1`                           | —                                   | refuses, exit 1                             |

The third row is worth reading as written. It is not a caught mutation, because
the notice is not an assertion — it is output, and the check is that the output
changed. Adding a guard to `GattProfileTests.swift` made the notice list it
immediately; reverting removed it. That is the property the row claims, verified
directly rather than through a pass/fail the harness could misread — which is
the same lesson as the `.pbxproj` episode one section up, applied before it bit.

## C16 — caregiver notifications

Fourteen mutations, each verified to have taken effect before its result was
read, per the sequenced rule the `.pbxproj` episode forced. Every one caught,
with two entries below that are not pass/fail rows and say so.

| Guard                                    | Own mutation                                     | Neighbour mutation                      | Result |
| ---------------------------------------- | ------------------------------------------------ | --------------------------------------- | ------ |
| one episode, one banner                  | never record an episode as notified              | a first raise still notifies            | caught |
| a decided episode stays closed           | drop the `closed` guard                          | a first raise still notifies            | caught |
| nothing is scheduled while denied        | drop the authorization guard                     | an authorized alert still notifies      | caught |
| an open episode notifies however it came | key the decision on `raised` again               | an `ongoing` repeat is still suppressed | caught |
| the owner state withdraws its banner     | resolution suppresses instead of withdrawing     | a first raise still notifies            | caught |
| the two suppression reasons stay apart   | collapse `notANewEpisode` into `alreadyNotified` | the reconnect-storm count is unchanged  | caught |
| the identifier is the `alertId`          | append a suffix to it                            | the denied path is unaffected           | caught |
| the body does not diagnose               | reword it to "is dangerously below normal"       | the policy is unaffected                | caught |
| launch registers the actions             | drop `registerCategories()` from `prepare()`     | scheduling still works                  | caught |
| the record lands before the banner goes  | withdraw first, then post                        | a dashboard decision still withdraws    | caught |
| socket alerts reach the centre           | stop routing `.alert` to the coordinator         | the REST seed still routes              | caught |
| the REST seed goes through the policy    | stop routing the seed                            | the socket still routes                 | caught |
| a decision on the socket withdraws       | stop routing `.decision`                         | the socket alert path still routes      | caught |
| the shell constructs the coordinator     | delete the `NotificationCoordinator.live(` call  | —                                       | caught |

Two entries are weaker than the table's other rows, and flattening them into it
would misreport what was checked.

**`RootView` prepares the centre** is a source scan, not a behavioural
assertion. Deleting the `.task { await notifications.prepare() }` line fails
`testTheRootScreenPreparesTheNotificationCentre`, so the mutation is caught —
but what is caught is the line being written, not the call happening. A rendered
SwiftUI view does not run its own `.task` in these tests, and no assertion
available here would notice a `prepare()` that never fired. The distinction is
recorded rather than papered over.

**Percent-encoding the `alertId`** is an equivalent mutant, not a test gap.
Switching `escape` from `.urlPathAllowed` to `.alphanumerics` turns
`sim-001:spo2-low:1` into `sim%2D001%3Aspo2%2Dlow%3A1` on the wire — and nothing
fails, at either level. The unit assertion reads `URL.path`, which decodes; the
real server decodes too and files the decision under the same id. Both spellings
are the same request by the time anything acts on it, so there is no behaviour
to pin. Per the three-branch rule in AI_USAGE.md this is branch (c) for the
_choice_ — no test was added for it — while the `/` replacement beside it is
branch (b) and already has one at `APIClientTests.swift`.

### The integration test earns its place

The clearest evidence for spawning a real `apps/server` is a mutation the
stubbed suite cannot see. Sending `"acknowledge"` where the protocol says
`"acknowledged"` — one dropped suffix in the request body — leaves the whole
simulator gate green, all 243 tests, because a stub answers whatever it was
handed. The real server
rejects it, and `testANotificationActionRecordsADecisionInTheServersOwnLog`
fails on three assertions at once: no decision recorded, one failure counted,
nothing in the log.

That is the same category as C15's resume tests correcting the protocol README
twice, and it happened again here in the other direction: the integration test
also found the `ongoing` hole described in apps/ios/README.md, which every test in
`NotificationPolicyTests` had agreed about. A suite can only test what it assumes the
other side says.

## C17 — closing the iOS seams

Seventeen mutations of a guard, each verified to have taken effect before its
result was read, and every one caught. Beside them: two defects the new suites
found on their own first run — recorded here because a test that catches a real
bug is a stronger proof than one that survives a synthetic one — and one block
of NOT CAUGHT results that is a claim about the code rather than about the
suite, worked through the branches in [AI_USAGE.md](AI_USAGE.md) rather than
flattened into a row.

### Mutations of the guards

| Guard                                     | Own mutation                                        | Neighbour mutation                        | Result |
| ----------------------------------------- | --------------------------------------------------- | ----------------------------------------- | ------ |
| the root screen starts the gateway        | delete `gateway.start()` from `RootView`'s task     | the centre is still prepared              | caught |
| the root screen prepares the centre       | delete `notifications.prepare()` from the same task | the gateway is still started              | caught |
| the link screen re-reads the permission   | delete its `.task`                                  | the launch read still lands               | caught |
| the device list reads from its own task   | delete `.task { await model.load() }`               | the other screens are unaffected          | caught |
| the device screen closes its socket       | delete `.onDisappear { model.disconnect() }`        | the open on appearance still fires        | caught |
| no effect outlives its owner (driver)     | drop `cancelRetry` from connecting → connected      | the ledger property fails too             | caught |
| no effect outlives its owner (ledger)     | the same mutation                                   | the well-definedness property is unmoved  | caught |
| a rejected event changes nothing          | increment `attempt` on the rejected branch          | —                                         | caught |
| one episode, one banner, ever             | never record an episode as notified                 | the denied-permission property is unmoved | caught |
| every effect is accounted for             | stop counting `notANewEpisode` suppressions         | —                                         | caught |
| a refused permission schedules nothing    | drop the authorization guard from the policy        | —                                         | caught |
| the back-fill re-reads the alert history  | delete the alerts read from `backfill()`            | the frames back-fill is unaffected        | caught |
| a dead server reads as disconnected       | make `.network` report `isDisconnected` false       | the http and contract splits are unmoved  | caught |
| a refused decision leaves the banner      | withdraw before the server answers                  | a successful decision still withdraws     | caught |
| the default HTTP transport is a real one  | resolve it to a closure returning a canned response | —                                         | caught |
| the default scheduler is the real timer   | resolve it to a no-op scheduler                     | —                                         | caught |
| the default scheduler's canceller cancels | return a no-op canceller instead of `work.cancel()` | —                                         | caught |

Rows six and seven are one mutation read twice, and worth separating because the
two tests fail at different distances from the fault. The ledger property fails
48 times — it is bookkeeping over the effect lists, so it objects the moment
`connected` is reached with a retry still pending. The driver property fails
3613 times, because it only notices when the orphaned timer actually fires, and
then keeps noticing for the rest of the run. The first localises the fault; the
second is the one that resembles what a caregiver would see.

### Two defects the suites found unprompted

Neither is a mutation. Both are recorded because the point of the discipline is
to catch things nobody thought to break.

**A retry that outlived its state.** `BLELinkPropertyTests` failed on its first
run at seed 1, step 435, with "a timer fired into `connected`, which never armed
it". `connecting` is two situations under one name — trying now, and waiting out
a backoff after a failed attempt — and a connect that landed in the second left
the retry running. It later delivered `retryDue` into `connected`, where the
machine rejected it and `BLEDriver.rejectedEvents` went up, putting an
"unexpected radio event" on the link screen that the radio had not produced. The
counter exists to mean "the radio did something this model says is impossible";
the model was what did it. Fixed in `BLELinkMachine.applyConnecting`, with the
matrix cell and the connect-path scenario moved with it.

**An alert raised into an outage.** `ServerFailureIntegrationTests` cut the
fan-out socket, raised a real alert on the real engine while it was down, and
waited for the caregiver to hear about it. Nothing came:
`DeviceDetailModel.backfill()` re-read frames and not alerts, so the episode had
no fan-out message and nothing ever asked for it again. The chart healed across
the gap and the alarm did not exist. "Silence is not continuity" was written
about frames at C11 and is truer about alerts.

Both had passed C15 and C16 unnoticed, including their adversarial passes.

### NOT CAUGHT, and what that means here

Five `??` fallbacks survive mutation on both platforms. Step 1 first: each
mutation was confirmed present in the source and both suites rebuilt and ran —
262 tests on the macOS host, 269 on the simulator, all green with
`?? window.count` turned into `?? -1` (which would trap on an insert) and four
`APIClient` fallbacks turned into sentinels that would show in a URL.

| Fallback                                      | Why nothing observes it                                                                                        |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `DeviceDetailModel.merge` `?? window.count`   | the guard above it establishes `frame.capturedAtMs < last.capturedAtMs`, so `firstIndex` finds `last` at worst |
| `APIClient.escape` `?? segment`               | `addingPercentEncoding` returns nil only for a string Swift cannot hold                                        |
| `APIClient.makeURL` `?? ""`                   | `URLComponents(url:resolvingAgainstBaseURL:)` returns nil only for a URL Foundation would not have built       |
| `APIClient.webSocketURL` `?? baseURL` (twice) | the same, plus a `components.url` that cannot fail once the components parsed                                  |

Branch (a) does not apply: nothing observable changes. Branch (b) has no named
threat beyond "Foundation's contract changes". Branch (c) says delete — and here
it is refused deliberately, because deleting an unreachable `??` in Swift means a
force unwrap, and trading an unreachable branch for a reachable crash in a 1 Hz
path on a monitoring screen is the wrong direction. They are recorded as
unreachable by construction rather than as untested, which is the distinction
this section exists to keep.

### One test-support bug, found by volume

`FakeTransport`'s scheduler cancelled a pending timer by array index, and
`fireScheduled()` empties that array — so a canceller held from before a firing
zeroed whichever timer had since taken slot 0. A spent canceller silently
killing a live deadline can only ever turn a red into a green. No existing test
was wrong because of it; the property suite, which cancels and fires hundreds of
times in one run, is what made it matter. Now keyed by ticket.

## C18 — OpenTelemetry tracing across ingest, alert, and fan-out

The guard that matters here is not "a span was emitted". Every orphan-span
integration emits spans, names them correctly, and passes its unit tests. So
each mutation below is aimed at the causal structure or at the attribute
contract, and the neighbour column names a guard that had to stay green — a
parentage mutation that also broke the attribute assertions would prove only
that the tests are entangled.

| Guard                                  | Mutation                                                                                                 | Fails                                                                                                            | Neighbour that stayed green                                            | Result |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------ |
| a transition is a grandchild           | start `alert.transition` as a root instead of under `alert.evaluate`                                     | parentage by span id; the "each ingest span its own root" count; the transition-count tie                        | every attribute assertion, the arrival suite, traced-vs-untraced bytes | caught |
| the transition carries its state       | drop the `alert.state` attribute                                                                         | transition attributes; the raised-then-resolved replay assertion                                                 | all four parentage assertions                                          | caught |
| no reading reaches an attribute        | write `spo2Pct` (97.5) into a declared attribute                                                         | the numeric gate — every span attribute must be a non-negative integer                                           | parentage, arrival flags, alert attributes                             | caught |
| no reading reaches an attribute        | write `heartRateBpm` (62, an integer) into the `seq` attribute                                           | identifier pinning on the ingest span; the arrival-flag table                                                    | parentage, privacy key allowlist                                       | caught |
| off means off                          | build the OTLP exporter unconditionally                                                                  | the provider then reports a BatchSpanProcessor where the disabled one reports none                               | the tracing-on flush-and-exit proof                                    | caught |
| off means off                          | arm a BatchSpanProcessor inside the DISABLED provider                                                    | the same assertion, with `enabled` still reporting false — the isolating form of the above                       | the tracing-on positive control                                        | caught |
| flush after the server closes          | swap the order to flush first, then close                                                                | the shutdown-order assertions in the lifecycle suite                                                             | the tracing shape and privacy suites                                   | caught |
| a late arrival is reported as late     | make the store return `outOfOrder: false` for accepted frames                                            | store cases, the DECISIONS #11 property oracle, the arrival-flag span table                                      | parentage, alert attributes, privacy                                   | caught |
| the coverage ratchet bites             | raise the statements threshold to 98, above the measured 96.94                                           | `pnpm --filter @maekbeat/server test:coverage` fails with every test still passing                               | —                                                                      | caught |
| the server stops with clients attached | drop `app.close()` from the shutdown sequence entirely                                                   | the spawned server never exits; the open-socket proof fails on its own 60 s timeout                              | —                                                                      | caught |
| a transition names its own alert       | rewrite the raise ordinal inside the `alertId` attribute                                                 | the transition-attribute assertion, cross-checked against the REST alert history                                 | parentage, privacy, arrival flags                                      | caught |
| a child belongs to ITS frame           | reuse one ingest context for every frame on the socket                                                   | per-parent child counts, the per-frame subtree walk, the numeric-attribute contract, the duplicate-subtree check | —                                                                      | caught |
| no reading in an unpinned slot         | write the integer heart rate into `seq` on the validate span AND into `message_count` on the ingest span | the total numeric-attribute assertion                                                                            | key allowlist and key-name regex both stay green, which is the point   | caught |
| a crashed frame is not green           | (verified directly) make the engine throw mid-handler                                                    | the ingest span carries ERROR, an `exception` event and `outcome=error`, and the open child is closed            | —                                                                      | caught |

Two of these are worth naming beyond the table.

The privacy gate needed two mutations, not one, and the second is the reason
the first is not enough. A fractional reading — SpO2 97.5, respiration 13.7,
motion 0.003 — fails the "every numeric attribute is a non-negative integer"
rule outright, and 119 of the 164 distinct reading values in the anomaly
fixture are fractional. Heart rate is not: it is an integer, and it slides
through that rule untouched. What catches it is the separate assertion that
every numeric attribute equals something the replay derives independently —
the frame's own `seq`, the session epoch, the count of a span's actual
children. A gate built only on the shape of the value would have had a hole
exactly the width of one vitals channel.

The unconditional-exporter mutation failed in a way that was not designed for,
and the surprise turned out to be a defect in the shipping code rather than a
bonus signal. With no endpoint configured the exporter defaults to
`localhost:4318`, nothing is listening, and the flush on shutdown failed — so
the spawned server exited 1 instead of 0. Chased down, that is not specific to
the mutation at all: **any** server whose collector is unreachable exited
non-zero on SIGTERM, and only if it had carried enough traffic to have spans
buffered. A server that did its job failed its stop; an idle one stopped clean.
`shutdown` now logs a failed flush and lets the stop succeed, and
src/lifecycle.test.ts pins both halves.

The first version of the off-means-off proof was itself vacuous, and an
adversarial pass caught it rather than a mutation: it compared
`process.getActiveResourcesInfo()` before and after, and both sides were empty
whether tracing was on or off, because `BatchSpanProcessor` calls `unref()` on
its batch timer and an unref'd handle never appears in that list. The
assertion could not have failed. It now asks the provider which span
processors it holds, with an enabled provider as the positive control — and
the second row above is the mutation that proves the new form is not vacuous
in turn.

Three of the C18 rows exist because an adversarial pass found the first version
of the proof unable to fail, which is the same lesson C12 recorded and worth
recording again in its new shape.

The headline parentage assertion compared each child's `traceId` to its
parent's. That is a tautology: the SDK derives a child's trace id **from** the
parent context it was handed, so once the span-id link holds the trace ids
cannot differ. Underneath it, the real assertion only said "the parent is some
ingest span" — so hoisting the context out of the message handler, which
parents all 480 children onto the first frame's span, passed the entire suite.
Every span emitted, correctly named, correctly nested, and every one of them
attributed to the wrong frame. That is the orphan-span failure wearing a
different coat, and the file written to reject it accepted it.

The privacy gate had a hole exactly one vitals channel wide. Of the four
channels, SpO2, respiration and motion are fractional in almost every fixture
frame, so "every numeric attribute is a non-negative integer" catches them.
Heart rate is an integer in all 120, and the pinning that was supposed to cover
it listed only five span-and-key pairs. Writing a heart rate into any other
pairing — `seq` on the validate span, `message_count` on the ingest span — put
120 real heart rates on the wire with all four assertions green.

Both are now total rather than enumerated: children are checked per parent and
by walking each frame's subtree, and every numeric attribute on every span is
compared by exact equality against what the replay derives for that span. The
general form of the lesson: a gate written as a list of the cases you thought
of is a gate with a hole the shape of the case you did not.

## C19 — the shutdown residual C18 left

C18 recorded a residual in `src/lifecycle.ts` and left it: `app.close()` asks
@fastify/websocket to close its clients and does not destroy one that ignores
the close frame. In a process that is a slow exit. Under an orchestrator it is
SIGKILL after the stop grace period, which discards the span flush C18 shipped,
the shutdown log line, and the exit code an operator reads.

The container found it before any of these rows existed: `docker compose stop -t 10`
with a raw peer attached killed the server at 11 s with exit 137, measured while
building the C19 stack that lands next. The fix is a sweep armed alongside the
close that terminates whoever is left after `PEER_CLOSE_GRACE_MS`.

| Guard                                 | Mutation                                              | Result |
| ------------------------------------- | ----------------------------------------------------- | ------ |
| peers that ignore close are destroyed | delete `peer.terminate()` from the sweep body         | caught |
| the grace is a real interval          | set the sweep delay to 0                              | caught |
| polite peers keep their handshake     | terminate every peer unconditionally before the close | caught |
| a failed close leaves no live timer   | drop `clearTimeout(sweep)` from the `finally`         | caught |

The second row failed to catch its mutation on the first attempt, and the
reason is the useful part. The polite-peer control originally had `close()`
delete its peer immediately, which resolves on a microtask — so a sweep delay
of 0 was cancelled before its timer could fire, and the test asserted only that
`terminate` is not called synchronously. A close handshake is a round trip, so
the control now takes 150 ms to leave, and the grace became a number the test
can be wrong about.

## C19 — container image and compose stack

Nine acceptance criteria, each an executable proof, and each proof broken on
purpose to see it fail. `infra/verify-image.sh` covers the image;
`infra/compose-smoke.sh` covers the stack. The criterion number in each row is
the one those two scripts print.

| Guard                                    | Mutation                                                       | Result |
| ---------------------------------------- | -------------------------------------------------------------- | ------ |
| 1 — non-root                             | delete `USER node` from infra/server.Dockerfile                | caught |
| 3 — the browser really crosses an origin | drop `http://127.0.0.1:8080` from the compose CORS allowlist   | caught |
| 3 — the served bundle is loadable        | set `base: "/wrong-base/"` in apps/web/vite.config.ts          | caught |
| 5 — the image says which commit it is    | pin `org.opencontainers.image.revision` to a fixed SHA         | caught |
| 5 — the process says which commit it is  | run the smoke against the live stack with a wrong expected SHA | caught |
| 7 — no debris from this repository       | delete the `**/*.test.ts` line from .dockerignore              | caught |
| 8 — the deploy image is amd64            | drop `--platform` from the build, so the host arch wins        | caught |

Each mutation failed its own criterion and left its neighbours green, which is
the part worth checking. Dropping the CORS origin failed four of the five
journey tests and left the identity assertion, the golden replay and the
shutdown proof passing — Playwright's `request` fixture is not a browser
context, so it is not subject to CORS, and that is why the identity check is
not a substitute for the browser one. Breaking the asset base path failed all
five journey tests and left identity and replay green. Pinning the revision
label failed the label comparison alone: `/healthz` still served the right SHA,
because the label and the environment variable come from the same build
argument and only one of them was mutated.

Criteria 2, 4, 6 and 9 are proved by controls rather than by mutations, because
each already has a natural negative case:

- 2 — the golden replay asserts eleven properties of one fixture; a container
  that serves nothing fails at the first socket.
- 4 — the healthcheck runs twice on the same image, once with the server behind
  it and once with the entrypoint replaced by `sleep`. Green then red, from one
  image and one HEALTHCHECK line.
- 6 — the image is run with `BUILD_REVISION=` and must exit non-zero naming the
  variable, and then run again with it set as the positive control, so the
  assertion is about the variable and not about a broken image.
- 9 — the negative case was the starting state: before the fix in the preceding
  commit, `docker compose stop -t 10` with a rude peer attached ended in exit
  137 at 11 s. Afterwards, exit 0 at 2 s.

One mutation was rejected as uninformative before being run. Deleting `.git`
from .dockerignore proves nothing here: the Dockerfiles copy named paths rather
than the whole context, so no `.git` can reach an image whether the line is
there or not. The line stays for build speed, and the image assertion that
there is no `.git` stays as a check on the copies, but neither is evidence
about the other.

## C19 — what only load reaches

Three behaviours here are invisible to a suite that drives a handful of frames,
and two of them had already failed once. C18's stop inversion is the clearest:
a clean stop exited non-zero only when the server had carried enough traffic to
buffer spans, so the servers doing their job were the ones failing their stop,
and no idle test could have seen it. The others are alert timing under a busy
event loop — receive times bunch, and the whole engine runs on receive time —
and dedupe across parallel streams, where a retransmit re-counted into a window
is a second alert for a caregiver rather than a duplicate row.

The guards are in `src/load.test.ts`. Each mutation below had to fail its own
target and leave its neighbours green.

| Guard                                     | Mutation                                          | Result |
| ----------------------------------------- | ------------------------------------------------- | ------ |
| a stop after traffic flushes what it held | delete the flush from `shutdown`                  | caught |
| a refused flush does not decide the exit  | delete the flush from `shutdown`                  | caught |
| alerts land on the same frames under load | widen the spo2-low hysteresis to 92/95            | caught |
| dedupe holds across parallel streams      | `false &&` the `seenSeqs` check in `store.ingest` | caught |

The differential is not self-sufficient, and finding out why is the useful
part. The load run's oracle is the quiet run — the same fixture, the same
projection, compared entry for entry — and a widened hysteresis moves both runs
identically, so equality alone walks straight past it. What catches it is the
anchor beside the differential: the raise must land on seq 89 and the resolve
on seq 152, the frames `src/journey.test.ts` derives. **A differential test can
only see what makes two runs disagree; anything that moves both is invisible to
it, and needs an absolute assertion sitting next to it.**

Two of the three sections were written wrong first, and both times the test was
green while asserting nothing.

The saturation control took two corrections. Paced one round per event-loop
turn, the background flood landed entirely after the replay had finished, so
the "loaded" run was a second quiet run and the comparison was between two
identical idle servers. Pre-queued instead — all 16 000 frames written before
the replay — the server drained every one of them before the replay's first
frame was even acknowledged, three runs out of three, which is the same failure
with the opposite shape. What works is continuous: one frame per device per
turn, sustained, with the control asserting that more background frames were
acknowledged **between this fixture's first frame and its last** than the
fixture itself contains. The general form: a positive control for "under load"
has to be read at the moment the property is exercised, not at the end of the
test.

The reorder generator claimed a window it had no bound on. Drawing from a
sliding pool of 32 reads like "reordered by at most 32" and is not — an unlucky
seq can sit in the pool arbitrarily long — and the first run produced
regressions deep enough for the store to call them reboots, twenty-nine session
epochs on the first device. The store was right and the test was wrong.
Shuffling inside fixed blocks makes the worst case a number: no frame is ever
more than `REORDER_DEPTH - 1` below the highest seq sent.

One smaller thing, on the way: `watch()` attached its message listener after
awaiting the socket's open event, and `ready` is sent the instant the upgrade
completes. Three red runs before it was a lost greeting rather than what it
would have been a commit later — a lost frame, on a suite whose entire job is
counting frames.

## C19 — the fan-out bound, and what happens at it

The gap this closes had been on the record since C11 and deferred twice, in
apps/server/README.md and docs/ARCHITECTURE.md, on the argument that choosing a
threshold before measuring one would be inventing it. Running the server under
load is what produced the measurement: a subscriber that completes the
handshake and then never reads held 12.1 MB of undelivered fan-out against
12.7 MB published over 60 000 frames, with nothing dropped, nothing closed and
nothing counted.

Bounding the queue forces a second decision the memory number does not settle —
what happens to the messages at the bound — and one of the two options
contradicts a rule this repository already holds. The guards are in
`src/fanout-bound.test.ts`.

| Guard                                         | Mutation                                          | Result |
| --------------------------------------------- | ------------------------------------------------- | ------ |
| a stalled subscriber is dropped               | `false &&` the `bufferedAmount` check             | caught |
| the overflow is visible, not a silent thin    | drop the message, keep the subscriber             | caught |
| a healthy subscriber is never dropped         | `if (true)` — drop every subscriber on every send | caught |
| an alert survives the outage the bound causes | skip `engine.process` when nothing is subscribed  | caught |

The last row is the one worth keeping. It is not a mutation of this commit's
diff at all — it is a plausible-looking optimisation somewhere else, "do not
compute alerts nobody is listening for" — and it is exactly the C17 defect
rebuilt one layer down, where apps/ios `backfill()` re-read frames and not
alerts and an episode opening during an outage healed the chart across a gap
the alarm was missing from. A bound that drops subscribers manufactures that
outage deliberately, so the composition had to be pinned rather than reasoned
about.

It also caught the test before it caught the mutation. The first version of the
alert-survival test left a healthy subscriber watching alongside the stalled
one, so something was always subscribed and the mutation walked straight past
it while every other guard stayed green. **A test of an outage has to contain
the outage**: the stalled subscriber is now the only one, which is the caregiver
case anyway — one dashboard, on a connection that cannot keep up, dropped, and
then the episode starts with nobody attached.

The visible-overflow guard is the reason the rejected alternative is recorded in
docs/DECISIONS.md #23 rather than dismissed in a comment. Discarding messages
and keeping the socket open passes a memory assertion exactly as well as
dropping does; the test that separates them reads the bytes the server actually
sent — a contiguous prefix of seqs and then a close frame carrying 1013 — and a
skipped frame in the middle of that prefix is the whole failure.

## C19 — the pnpm pin that was already there

The C19 review recorded the image build as taking "whatever pnpm the base image
ships" and asked for a pin to the repository's `packageManager` field. The
premise turned out to be wrong, and the two attempts to demonstrate it are the
entry worth keeping.

| Guard                                 | Mutation                                                     | Result     |
| ------------------------------------- | ------------------------------------------------------------ | ---------- |
| the image builds with the pinned pnpm | `npm i -g --force pnpm@10.15.0` before the version is read   | NOT CAUGHT |
| the image builds with the pinned pnpm | the same, with `corepack prepare --activate` removed as well | NOT CAUGHT |

Both builds reported pnpm 11.10.0 and installed with it. `corepack enable`
leaves a shim that resolves the version from the nearest manifest at the moment
pnpm is invoked, so the pin was already in force and neither a globally
installed pnpm nor a missing `prepare` step displaces it. The mutations landed —
the build log shows the `npm i -g` line running — so this is a guard that cannot
fail rather than a mutation that missed.

That is also the finding about the assertion originally written here. It
compared `pnpm --version` against `packageManager`, which is comparing corepack's
output to corepack's input: a tautology in the shape of a check, and the same
mistake C18 recorded when a `process.getActiveResourcesInfo()` delta proved
nothing because both sides were empty. It was removed rather than kept for
appearances. **A guard nobody can construct a failure for is not a strict
guard; it is decoration, and the honest move is to delete it and say why.**

What was genuinely implicit is fixed: the resolution depended on the root
package.json already having been copied, which was true and unstated; it
happened lazily inside the install step; and no build log named the version.
Resolving it explicitly in its own layer makes the ordering a requirement,
gives the download its own cache entry, and prints the number.

## C19 — the guard that was already red

| Guard                                 | Mutation                                      | Result |
| ------------------------------------- | --------------------------------------------- | ------ |
| every non-Node directory names a gate | add `infra/k6/orphan.js`, wired to nothing    | caught |
| every non-Node directory names a gate | stop `infra/load.sh` from running `fanout.js` | caught |
| the catch-all still fails an unknown  | add `infra/newthing/` with no package.json    | caught |

The mutation that mattered was not applied by this session. The k6 commit added
`infra/k6/` — a directory under `infra/` with no `package.json` — and the C9
guard's catch-all arm fails exactly that by design. The hygiene job has been red
on `main` since it landed, unobserved, because GitHub Actions has been in outage
for the whole of that time. **A guard that has never been executed is a guard
with an unknown result, not a passing one**, and the only reason this was found
is that the CDK work added a second directory the same arm would have to judge.

The arm added for it does not claim a coverage number the load rig does not
produce (docs/DECISIONS.md #24). It asserts reachability instead: every `.js` in
`infra/k6/` must be invoked by `infra/load.sh`, anchored to the `run_k6 <name>
<file>` call so that a mention in a comment does not satisfy it.

## C19 — the keepalive on an idle fan-out socket

| Guard                              | Mutation                                                    | Result     |
| ---------------------------------- | ----------------------------------------------------------- | ---------- |
| an idle subscriber is pinged       | make the interval body a no-op                              | caught     |
| the ping is not a protocol message | (positive control — the message count assertion, unmutated) | n/a        |
| the timer dies with its socket     | remove `clearInterval` from `stop()`                        | caught     |
| the timer dies with its socket     | remove `clearInterval` **and** `unref()` the interval       | NOT CAUGHT |
| the timer dies with its socket     | drop-path `stop()` reverted to `unsubscribe?.()` alone      | NOT CAUGHT |

The first two are ordinary. The second failed by hanging rather than by
asserting: with the `clearInterval` gone the interval keeps firing after its
socket is gone, the event loop never drains, `src/main.ts` never reaches an exit
because it calls no `process.exit` on the successful path, and the test dies on
its own 30-second timeout. That is the shape src/lifecycle.ts predicted in
prose — "a ref'd handle left by anything else, a stray interval, an unclosed
server, hangs the stop visibly" — met by an actual stray interval for the first
time.

The third is the reason the interval is not `unref()`d, and it is a design
decision rather than an oversight. Adding `.unref()` on top of the same leak
turns all four tests green: an unref'd handle never holds the loop open, so the
process exits on time with a timer still firing behind it. **The safe-looking
call is the one that would have made the leak unobservable.** The cost is
stated: nothing here bounds how long a leaked heartbeat would run in a process
that is not being stopped.

The fourth is honest about a line no test can distinguish. Clearing the timer in
the slow-subscriber drop path shortens the window between `socket.close()` and
the `close` event — up to thirty seconds when the peer ignores its close frame —
but the `close` handler is the real owner and fires either way, so nothing
observable changes. It is kept because one exit function is simpler than two
different cleanups, not because a test demands it.

A guard written first and deleted before commit belongs here too. The ping was
wrapped in a `readyState === OPEN` check on the theory that `ws` raises when
pinging a closing socket. It does not: with no payload and no callback the call
routes into `sendAfterClose`, which increments nothing and emits nothing —
checked against a real `ws` peer that ignores its close frame rather than
reasoned about. The check was removed, on the C19 precedent that a guard nobody
can construct a failure for is decoration.

## C19 — one required-variable list instead of five

| Guard                                           | Mutation                                                                           | Result |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- | ------ |
| the exported list is the enforced list          | enforce `BUILD_REVISION` with a hand-written `if` and add a second key to the list | caught |
| the requirement is about production, not always | (positive control — the `NODE_ENV=test` case, unmutated)                           | n/a    |

`REQUIRED_PRODUCTION_ENV` is exported so infra/cdk can assert that the
synthesized task definition supplies every entry. An exported list that the
server does not itself consult would be a second copy with a public name — the
worst of the two, because it looks authoritative. So `loadConfig` is driven by
the object, and the mutation that proves it is the shape the code was in
before: the requirement enforced by a hand-written branch, with the list beside
it drifting one key ahead. The test iterates the object rather than naming
`BUILD_REVISION`, which is what makes it fail on the key nobody wired.

## C19 — the CDK stack, and what a template cannot be trusted to say

| Guard                                     | Mutation                                                          | Result |
| ----------------------------------------- | ----------------------------------------------------------------- | ------ |
| the required-env contract                 | drop `BUILD_REVISION` from the task definition                    | caught |
| websocket survival                        | set the ALB idle timeout to 10 s, below the 25 s heartbeat        | caught |
| the health check path                     | point the target group at `/health`                               | caught |
| the dashboard origin                      | set `CORS_ORIGIN` to a literal domain instead of the distribution | caught |
| the image's source                        | pull from another account's ECR registry at the same tag          | caught |
| the OTLP implication                      | configure an endpoint with nothing in the task listening on 4318  | caught |
| no resource without a counterpart         | add an SQS queue no code in this repository reads                 | caught |
| a suppression reason that says something  | replace one with "By design."                                     | caught |
| the entry point wires the rule pack       | stop registering `AwsSolutionsChecks` in src/main.ts              | caught |
| one task, because the state is in process | raise `desiredCount` to 2                                         | caught |
| one task, transitively                    | make the deploy a rolling replacement (100/200 instead of 0/100)  | caught |

The five the brief named are the first five, and each fails only its own target:
changing the health-check path, the origin or the image repository leaves the
other fourteen property assertions green. Dropping `BUILD_REVISION` fails three,
which is the required-env test doing its job plus two tests that legitimately
read the same variable. The snapshot fails on all eleven by construction, which
is what a snapshot is for and is why it is not the proof of any of them.

**The two findings were both composition failures, and neither is visible from
either side alone.**

The first is why a `fix(server)` commit precedes this one. An ALB closes a
connection carrying no bytes after 60 seconds; a dashboard watching a device
that has stopped sending is exactly that connection; apps/server had no
keepalive. Both halves individually correct, and the symptom — a socket that
dies on a timer and is rebuilt by the client's reconnect on the next one — reads
as a flaky network rather than as a missing ping, because apps/web's REST
back-fill hides the gap it leaves.

The second was in the first draft of this stack, which ran `desiredCount: 2`
because two is what a service behind a load balancer normally runs. apps/server
keeps the frame ring, the alert engine, the decision log and the fan-out
registry in process and shares none of them, so the second task is not capacity:
a device's frames exist only on the task its ingest socket landed on, a
dashboard that lands on the other subscribes to silence forever, and its REST
reads alternate between a full history and an empty one. **Nothing in the
template would have looked wrong.** The count is now 1, the deploy stops before
it starts so a rolling replacement cannot do transiently what the count forbids,
and both are asserted with the reason attached.

One guard was written and deleted before commit, on the C19 precedent. The
`instanceof AwsSolutionsChecks` check on the registered rule pack fails against
the correct object — CDK stores validation plugins across a jsii boundary and
hands back a structural proxy — so it was replaced with a match on the pack's
own `name`, read off a fresh instance rather than typed as a string.

## C19 — a budget that fits the runner it runs on

| Guard                                | Mutation                                                                 | Result |
| ------------------------------------ | ------------------------------------------------------------------------ | ------ |
| the cold synth is out of test bodies | put it back, with the budget scaled to this machine (1200 ms)            | caught |
| part 1 alone, at CI's defaults       | hoisted, budgets scaled to CI's own 5 s / 10 s defaults (1480 / 2960 ms) | passes |
| the hook budget bites                | `hookTimeout` just under this machine's cold synth                       | caught |
| the test budget bites                | `testTimeout` under the one test that builds a real apps/server          | caught |

Three tests died on CI at vitest's 5 s per-test default and every one of them
was the first full `Template.fromStack` in its file. Nothing hung: the work is
synchronous CPU, which is also why the reported durations exceed the timeout —
vitest cannot interrupt it, so 6137 ms is very nearly the real cost of one cold
synth on a two-core runner with four other packages' vitest processes beside it.
Locally the same synth is 1.34-1.82 s and fitted under the default, which is the
whole reason it landed.

The first mutation reproduces the CI failure here by scaling the budget instead
of the machine: with the synths back in their test bodies and `testTimeout` at
1200 ms, the same four tests fail with the same message. **A failure you can
only observe on the runner is a failure you cannot iterate on.**

The second is the one worth reporting. With the synths hoisted and both budgets
set to CI's own defaults scaled by the measured CI:local ratio, all 28 pass — so
**part 1 alone would have been sufficient and part 2 is belt-and-braces.** The
qualification is that it would have passed with 1.6-2.2x headroom on the hook,
against a runner whose throughput this repository has already recorded as
depending on what else is on the host (docs/DECISIONS.md #24). Sufficient is not
the same as sized, which is what part 2 buys.

The third has a failure signature worth knowing: a hook that times out reports
28 skipped rather than 28 failed. A run that says "skipped" is not a run that
passed, and the distinction is easy to miss when scanning a log.

## C19 — the board that nobody was responsible for

| Guard                                   | Mutation                                                   | Result |
| --------------------------------------- | ---------------------------------------------------------- | ------ |
| a landed row carries a link             | delete the C17 chip from the README board                  | caught |
| a link resolves                         | point one at a real commit that is not an ancestor of HEAD | caught |
| a link resolves                         | point one at a well-formed SHA that is not a commit at all | caught |
| at most one linkless row, and it newest | strip the newest shipped entry's link only                 | passes |
| at most one linkless row, and it newest | strip the newest and one older                             | caught |
| at most one linkless row, and it newest | strip one older, leave the newest linked                   | caught |
| the check reads something               | drift the shipped-entry pattern so it matches nothing      | caught |
| the check reads something               | delete all 61 links from both files                        | caught |

The defect was a process gap rather than a mistake: **a commit cannot contain
its own hash, so a chip is always added by a later commit, and nothing said
whose job that was.** Eleven commits landed on `main` with the board showing no
link for any of them. The C18 and C19 briefs each said to leave links empty
until the push, which was right, and neither said who filled them in afterwards.

Two mutations are worth more than their row. The first is the one that did not
land: pointing a link at `origin/wip/c19-load` was supposed to produce a
non-ancestor SHA and did not, because that branch turned out to be an ancestor
of `HEAD` — the check passed and would have been recorded as NOT CAUGHT on a
condition the mutation never created. The replacement builds a real orphan with
`git commit-tree`, which is a commit object by every test except ancestry. **A
mutation that does not establish its own precondition proves nothing about the
guard, and reads exactly like one that does.**

The second is the pattern-drift case, which is the failure
`scripts/check-scope-ranges.sh` was written against and the one this class of
script keeps rediscovering: a guard whose regex silently matches nothing
reports success. Renaming the shipped-entry pattern so it matches no line fails
the script rather than passing it, and deleting every link from both files
produces 47 problems rather than a clean run.

The scope was wider than the brief named. C17 through C19 were the missing
links asked for; C0, C9, C15 and C16 were also unlinked in docs/ROADMAP.md
while the README already carried chips for three of them, so the two files
disagreed about what had shipped. Backfilling only what was asked for would
have left the new guard red on its own first run.

## C19 — one chip per row, and the exemption that swallowed a regression

| Guard                               | Mutation                                                    | Result |
| ----------------------------------- | ----------------------------------------------------------- | ------ |
| compare ends are real ancestors     | base to a real non-ancestor; base to a non-commit           | caught |
| compare ends are real ancestors     | head to a real non-ancestor; head to a non-commit           | caught |
| a range runs forwards               | reverse the two ends                                        | caught |
| a range spans something             | both ends the same commit                                   | caught |
| a range is not too narrow           | stop it at the k6 commit, dropping the last five            | caught |
| a range is not too wide             | start it at C17's tip, swallowing C18                       | caught |
| a range can be checked at all       | relabel the chip so it names no roadmap row                 | caught |
| the board links every landed row    | delete the compare chip's link; delete a single-commit chip | caught |
| the one-commit lag is still allowed | roadmap entry and board chip both linkless                  | passes |

**The finding is the tenth row, and it was invisible until it was mutated.**
Deleting the C19 chip's link from the board passed. The board's exemption said
"the newest row may be linkless", C19 _is_ the newest row, and C19 had been
landed for days across eleven linked commits — so the allowance meant for a
commit that cannot contain its own hash was silently covering a row whose hashes
were all known. That is the hole the brief predicted in a different place: an
exemption shaped exactly like the thing the guard exists to prevent.

The fix makes the two exemptions different sizes, which they always should have
been. The roadmap may leave its newest entry linkless, because that entry
describes the commit being written. The board is exempt **only while the roadmap
entry is itself linkless** — the moment the hash is written down anywhere, the
board has no excuse left.

Fixing that exposed a second defect in the same breath: the first version tested
"does the newest roadmap line contain a commit link", and the newest line
contains three, because that bullet links neighbouring commits inline in its
prose. The legitimate one-commit lag started failing. An entry's own link is the
one immediately after the word — `shipped [sha]` — and that is now what both
checks read, so mentioning somebody else's hash no longer counts as carrying
your own.

One process note. Two of these mutations were first recorded against a stale
script: `git checkout scripts/check-commit-links.sh` was used to revert a
mutation and reverted the uncommitted rewrite with it, so three later runs
tested the previous version and two of them reported a pass that meant nothing.
**Reverting a mutation with `git checkout` only works when the file under test
is committed.** The rest of the battery was re-run from a copy.

## C19 — the sixth test, and the number nobody was asserting

| Guard                        | Mutation                                              | Result    |
| ---------------------------- | ----------------------------------------------------- | --------- |
| skip budget, unset revision  | park a second journey test under `test.skip(true, …)` | caught    |
| skip budget, set revision    | run with `E2E_EXPECTED_REVISION` at HEAD, no mutation | 0 skipped |
| skip budget, set revision    | freeze `identity.spec.ts`'s condition to `true`       | caught    |
| the reporter is what catches | unwire `skip-budget.ts`, keep the second parked test  | passes    |

The smoke job has printed `1 skipped, 5 passed` since C19 and the line was true.
The skipped case is `e2e/identity.spec.ts`, which compares the revision on
`/healthz` against the one the stack was built from and has nothing to compare
against unless `E2E_EXPECTED_REVISION` says what to expect. The skip is correct
and the reason is written at the skip site — **what was missing is any statement
that one is the right number.**

The fourth row is the whole argument. With the reporter unwired, a suite running
four of its six tests exits 0 and prints its own shortfall into a green job, and
that is the state the repository was in: nothing read the count. The reporter is
what turns the count into a verdict, and the two rows above it show it failing in
both directions.

The second and third rows matter more than the first. Under
`infra/compose-smoke.sh` the budget is zero, so a stale condition in
`identity.spec.ts` — the exact way a conditional test goes quiet — fails the run
instead of printing `1 skipped` where nobody would look twice. That is the only
assertion in the repository that the identity check actually executes against the
containers, and until the compose smoke runs in CI it is the only place it
executes at all.

One thing this does not do. It counts skips; it does not run the skipped test.
`identity.spec.ts` still runs on a developer's machine and nowhere else, and the
commit that changes that is the compose-smoke-in-CI commit named as remaining in
the C19 row of [../ROADMAP.md](../ROADMAP.md).

## C19 — one action, one version

| Guard                         | Mutation                                                        | Result |
| ----------------------------- | --------------------------------------------------------------- | ------ |
| one action, one version       | none — the drift already on `main`, `setup-node` at v7 and v4   | caught |
| one action, one version       | drop docs-lint's `setup-node` to v6                             | caught |
| one action, one version       | add `actions/cache/restore@v6` beside `actions/cache@v4`        | caught |
| the rule is per-action        | move `codecov-action` to v3, three versions across four actions | passes |
| the guard reads something     | drift its `uses:` pattern to `consumes:`                        | caught |
| the hygiene job still runs it | delete the invocation from the hygiene job                      | caught |
| the hygiene job still runs it | append `\|\| true` to the invocation                            | caught |

The first row is the one that costs nothing and proves the most: the guard was
written, run against unmodified `main`, and failed. **The defect it exists to
catch was already there** — `actions/setup-node` at v7 in four jobs and v4 in
the ios job, saying so only through a Node 20 deprecation warning in a green
log. No mutation was needed to produce the condition, so none can be accused of
having produced it.

The fourth row is the rule's boundary, not a hole in it. `checkout@v7`,
`setup-node@v7`, `cache@v4` and `codecov-action@v3` disagree with each other in
every direction and the script is silent, because versions are not comparable
across actions. That is also the shape of what this does **not** catch: an
action that is uniformly stale is uniformly consistent. `actions/cache@v4` is
exactly that, its deprecation warning survives this commit, and the reasoning is
in docs/DECISIONS.md #26 rather than left to be inferred.

The last two rows are why the assertion lives in the `tests` job. A guard asked
whether it is still wired reports nothing at all when the wiring is what was
deleted — it does not run to report it. Anchoring the grep to the step as CI
would execute it is what makes the `|| true` row a catch instead of a pass.

One mutation was recorded only after being rebuilt. The subpath row was first
written as a **replacement** of `actions/cache@v4` by `actions/cache/restore@v6`
and came back NOT CAUGHT — correctly, because a swap leaves one reference and
one version, and the disagreement the row claims to test never existed. The
totals said so plainly: 11 references to 4 actions, unchanged from the baseline.
**A mutation that does not change the counts did not create the condition**, and
the corrected version adds the subpath step rather than substituting it.

## C19 — the docs page, as opposed to the docs route

| Guard                          | Mutation                                                | Old test | New test |
| ------------------------------ | ------------------------------------------------------- | -------- | -------- |
| the docs page renders          | mount the UI at `/api-docs` instead of `/docs`          | caught   | caught   |
| the docs page renders          | 404 every `/docs/static/` asset, leave the page at 200  | passes   | caught   |
| the docs page renders          | answer `/docs` with 200 `text/html` that is not the UI  | passes   | caught   |
| the docs page renders          | 404 `/docs/json`, leave the page and its assets serving | passes   | caught   |
| the asset loop reads something | serve the mount point with zero asset references        | passes   | caught   |

`@fastify/swagger-ui` went from 5.2.6 to 6.1.1 — a major bump on a runtime
dependency — and merged green. The reason is in the first column: **every
assertion in `openapi.test.ts` was about the OpenAPI document**, which
`@fastify/swagger` produces, and the one case that touched `/docs` asked only
whether the status was in `[200, 302]`. The UI is a different package and could
have shipped broken with this file entirely satisfied.

The first row is the weak mutation and is recorded as such: moving the route
prefix is caught by the old test too, because it turns 200 into 404 and a status
check can see that. The next three are the commit's actual justification. Each
leaves `/docs` answering 200 with HTML — the old assertion's whole content —
while the page is blank, or styleless and scriptless, or an empty Swagger UI
whose spec fetch 404s. **A status code cannot see a blank screen.**

The fifth row is the loop's positive control. The page's assets are read out of
its markup rather than listed in the test, which is right — a bundle that
renames a file must stay served, and a hard-coded list would go on asserting the
old names. The cost of reading them is that a page carrying no references at all
makes the loop vacuous, so the count is asserted before the loop runs.

Two notes on method. The third mutation also failed an unrelated case, because a
hand-rolled `/docs` route joins the OpenAPI document and changes the route
surface — noise, not a second catch, and the fifth mutation hides its routes with
`schema: { hide: true }` to keep the signal clean. And the fifth landed without a
confirming grep: the shell escaping for `id="swagger-ui"` did not match, but the
failure reads `expected 0 to be greater than or equal to 5` against a baseline
page carrying seven references, which only the mutated page can produce.

## C20 — the hazard row that cites a test, and the guard that checks it

| Guard                         | Mutation                                                                   | Result |
| ----------------------------- | -------------------------------------------------------------------------- | ------ |
| the cited test exists (TS)    | rename a cited vitest title in the row: "one" → "ones"                     | caught |
| the cited test runs           | repoint a row at `identity.spec.ts::serves the revision it was built from` | caught |
| a row cites something         | delete H4's only citation, leaving the cell empty                          | caught |
| the row pattern reads rows    | drift `ROW_RE` to `HAZARD-ROW-[0-9]+`, matching nothing                    | caught |
| the cited file exists         | repoint a citation at `apps/server/src/heartbeat.test.ts`                  | caught |
| the cited test exists (Swift) | rename a cited XCTest method in the row: append `2`                        | caught |
| the title is a declaration    | comment out the cited `it(...)`, leaving the title in the comment          | caught |
| one table, no strays          | add a second hazard table under its own heading                            | caught |

`scripts/check-hazard-tests.sh` is the only thing standing between
`docs/regulatory/hazard-analysis.md` and the fate of every hazard analysis
written outside a quality system, which is to go quietly out of date while
reading exactly the same. So the mutations are aimed at the four ways a citation
can rot — the file goes, the test is renamed, the test stops running, the row
stops citing — plus the two ways the guard itself can go blind.

**Row two is the real positive control, and it is a real skipped test.**
`apps/web/e2e/identity.spec.ts` compares the revision on `/healthz` against the
one the stack was built from, and skips when `E2E_EXPECTED_REVISION` is unset,
which is every CI run today (C19, and the skip budget added at `094c83b`). It is
the one skipped test in the repository, so the assertion that a skipped citation
fails is checked against a genuine instance rather than against a skip written
to be caught.

Rows four and eight are the guard's own blind spots, and they are the pair that
matters most. A check whose pattern no longer matches anything reports success —
`check-scope-ranges.sh` was built shape-sensitive for the same reason, and
`check-commit-links.sh` learned it the hard way. So drifting `ROW_RE` must fail,
and it does: zero rows is an error rather than a clean run. Row eight closes the
other door, where the table stays intact and a second one appears beside it
holding the hazards nobody wants checked; any table line that is neither a
hazard row nor the header is named rather than skipped.

Two notes on method, both about mutations that did not behave the first time.
**Row four initially did not land at all** — the perl escaping for a pattern
full of backslashes and brackets silently rewrote nothing, and the harness
reported "MUTATION DID NOT LAND" rather than a result, which is the amendment of
2026-08-05 doing its job: an uncatchable mutation is a question about the setup
before it is a question about the code. Re-run with the substitution anchored to
`^ROW_RE=`, the drifted line was confirmed in the file by grep and the guard
failed. And **row seven exists because the first version of the check was too
weak to catch it**: matching the title with `grep -F` alone meant a title quoted
in a comment satisfied the citation, so the check now requires the line carrying
the title to also be a test declaration. That mutation was written to fail, did,
and the guard was tightened until it passed.

The whole-file skip rule is deliberately conservative and is not a defect. Any
skip or `.only` in a cited file fails the citation, whether or not it encloses
the cited test, because working that out needs a parser and the cheap rule errs
toward a false alarm instead of a silent pass. `.only` counts as a skip here for
the reason that matters: it makes every other test in the run skip.

Every mutation above was applied to a working tree copy, confirmed present in
the file by grep before the guard was run, and reverted from a file copy rather
than by `git checkout` — with the guard confirmed green again after each revert.
None is present in any commit.

## C20a — the alarm on the absence of data

The feature this commit adds is an alarm, so the mutations are asked a question
the earlier rows are not: does breaking it produce a **silence** in the tests,
the way the defect produced a silence in the system? Two of the twelve came back
NOT CAUGHT, and both changed the code rather than the log.

| Guard                                    | Mutation                                                                              | Result     |
| ---------------------------------------- | ------------------------------------------------------------------------------------- | ---------- |
| the sweep actually repeats               | `setInterval` → `setTimeout` in `silencePlugin`, so it fires once and never again     | caught     |
| the threshold clears a working reconnect | `DEVICE_SILENCE_MS_DEFAULT` 45 000 → 30 000, under the gateway's 36 000               | caught     |
| the clear path                           | `if (false && device.lastReceivedAtMs > open.lastFrameAtMs)` — silence never resolves | caught     |
| dedupe                                   | push the open episode to `transitions` on every sweep                                 | caught     |
| the detector cannot move the alerts      | make `sweep` return `[]` before reading the fleet — the whole feature off             | see below  |
| eviction never takes the open episode    | delete the `closed()` predicate from `evictOne`                                       | NOT CAUGHT |
| eviction takes the oldest                | `splice(state.episodes.length - 1, 1)` — drop the newest instead                      | caught     |
| the ordering not chosen                  | clear on `device.sessionEpoch !== open.sessionEpoch` instead of on a frame            | caught     |
| the monotonic sweep clock                | drop the `Math.max(this.clockMs ?? …, …)` clamp                                       | NOT CAUGHT |
| a silence row names the absence of data  | `label: "spo2Pct low"` on the timeline row                                            | caught     |
| a silence row measures its own duration  | `durationMs: 0`, letting `nowMs` decide as a threshold row does                       | caught     |
| silence is decidable                     | `const raisedBySilence = false` in the decision route                                 | caught     |
| the hazard citation resolves             | rename the test H4 cites in `silence.test.ts`                                         | caught     |

**The negative control, row five.** Turning the detector off leaves the
golden-fixture equality test's four comparisons GREEN — identical alert history,
identical fan-out, identical counters — and that is correct rather than a
failure: a mechanism that is off cannot change what it observes. What fails is
the fifth assertion in that file, the one that checks the ON run raised silence
at all. Without it the equality test would have passed with the whole feature
deleted, which is the exact shape of the vacuous guard this repository has
shipped twice before (C12a, C19). The non-vacuity check is written first in the
file for that reason.

**Row six, NOT CAUGHT, and the code was wrong rather than the test.** `evictOne`
carried an explicit "never the open episode" clause and removing it broke
nothing. The setup was suspected first, per the 2026-08-05 amendment, and the
setup turned out to be right: the clause is unreachable. Episodes sit in raise
order and at most one is open, so the open one is always the LAST element and
never the oldest; and eviction runs at exactly one moment, inside `raise`, on an
alertId minted a few statements earlier that no client can have decided. Neither
"decided first" nor "oldest first" can select it. So the clause was deleted the
way `src/stream.ts` deleted a `readyState` check no test could tell from its
absence, the invariant it was guarding is now asserted directly in
`src/silence.test.ts`, and the mutation that DOES break that invariant — evicting
from the wrong end — is row seven, which is caught. Deleting the clause then
cost one covered function and dropped apps/server under its 98% functions
threshold, which is how the coverage ratchet pointed at the thing actually
missing: the silence detector's `onForcedEviction` callback in `src/app.ts`
had no caller in any test. That is C12a's defect exactly — a bound wired in
`buildApp` that nothing reaches — and it is why
`src/silence.integration.test.ts` drives the history past its limit.

**Row nine, NOT CAUGHT, and the tests were looking at the wrong thing.** Two
clock tests already existed and both survived the clamp's removal, because
neither observed anything the clamp changes: an episode is only raised when none
is open, so a stepped-back clock cannot un-raise one, and the resolve stamp has
its own `Math.max` guard. What the clamp actually defends is narrower and worth
defending — that an OPEN episode's reported `silentForMs` never shrinks. A
duration that goes backwards mid-episode is how a caregiver learns not to trust
the display, and an NTP correction is the ordinary way it happens. The test was
written to that property and the mutation is caught.

Every mutation above was applied to a working tree copy, run against the named
suite, and reverted from that copy rather than by `git checkout`, with the suite
confirmed green again after each revert. `grep -rn MUTATION` over `apps/` and
`packages/` returns nothing; none is present in any commit.

## C19 — the image build in CI, and an anchor that agrees with itself

| Guard                                             | Mutation                                                                         | Result     |
| ------------------------------------------------- | -------------------------------------------------------------------------------- | ---------- |
| image label, verify-image-identity.sh             | bake a literal SHA into `org.opencontainers.image.revision`                      | caught     |
| served revision, verify-image-identity.sh         | bake a literal SHA into the runtime `ENV BUILD_REVISION`                         | caught     |
| the expected revision comes from the working tree | read the expected revision from `BUILD_REVISION` instead of `git rev-parse HEAD` | NOT CAUGHT |

The first two are a pair, and each one leaves the other green. A literal in the
`LABEL` line fails the label assertion while `/healthz` still answers correctly,
and a literal in the `ENV` line fails the served assertion while the label still
reads right — which is the argument for asking twice. The label is what a build
recorded and the served value is what the software says about itself, and only a
layer that ran produces both.

The third is the one worth the entry. `infra/verify-image-identity.sh` takes its
expected revision from `git rev-parse HEAD` and deliberately not from
`BUILD_REVISION`; mutated to prefer the environment variable, it was handed an
image built three commits behind with `BUILD_REVISION` set to that same older
SHA, and passed both assertions. Nothing was wrong with the image's internal
consistency — the label matched the process, the process matched the variable,
and the variable matched nothing at all in the repository. **An identity proof
whose expected value is supplied by whoever built the image is a value agreeing
with itself.** The anchor has to come from the tree the build was made from,
which is the one thing the builder does not get to choose.

Applied to a copy of `infra/server.Dockerfile` and a copy of
`infra/verify-image-identity.sh`, reverted from those copies rather than by
`git checkout`, with `git diff` confirmed empty and the positive control rebuilt
and re-run green after each.

## C19 — a row that reopened, and a guard that assumed rows are contiguous

| Guard                                            | Mutation                                                       | Result |
| ------------------------------------------------ | -------------------------------------------------------------- | ------ |
| board chips cover the row, check-commit-links.sh | delete C19's second compare chip                               | caught |
| no chip reaches across another row               | widen C19's second chip to start before C20                    | caught |
| no chip reaches across another row               | collapse both chips back into one range spanning the whole row | caught |

The third mutation is how this was found rather than a mutation invented
afterwards. Backfilling C19's ninth commit and widening the board's compare
range to `3260723...3ca620e` failed the guard twice — the range swallows C20 and
C20a, which have chips of their own. The guard was right and the assumption
underneath it was wrong: it checked each compare chip's coverage on its own,
which is only possible if a row occupies one unbroken stretch of history. C19
was left open, two later rows shipped, and its CI work landed after them, so its
commits now sit on both sides of C20 and C20a.

Coverage is therefore checked once per row against the union of that row's
chips. The anti-swallowing half is untouched and still binds each range
separately, which is what the second mutation confirms: a second chip buys a row
the right to skip over another row's commits and nothing else. Widening one
range instead would have been a claim that C20 and C20a belong to C19.

Applied to a copy of `README.md`, reverted from that copy rather than by
`git checkout`, with the guard confirmed green again after each.

## C19 — the compose smoke in CI, and a revision that came from the caller

| Guard                                       | Mutation                                                       | Result     |
| ------------------------------------------- | -------------------------------------------------------------- | ---------- |
| identity, infra/compose-smoke.sh            | bake a literal SHA into the server image's revision label      | caught     |
| identity, infra/compose-smoke.sh            | drop `--build` and pre-tag an image built three commits back   | caught     |
| skip budget, e2e/skip-budget.ts             | force `EXPECTED_SKIPS` to 1 for the compose run                | caught     |
| the revision under test comes from the tree | run the whole smoke with `BUILD_REVISION` three commits behind | NOT CAUGHT |

The first two are the two ways a stack can be the wrong software. A literal in
the `LABEL` line is caught by the label assertion alone — `/healthz`, the golden
replay and all six Playwright tests stay green, which is the whole argument for
asserting identity separately from behaviour. Pre-tagging `maekbeat-server:compose`
from a tree three commits back and removing `up --build` is the stale-cache case,
and it is caught three times over: the label, the served revision, and
`e2e/identity.spec.ts` failing inside the Playwright run (`5 passed`, not 6).
That last one is the test this whole job exists to run, catching the exact
failure it was written for, in CI's shape rather than a laptop's.

The third is the budget proving it is a budget. Forced to 1 while the compose
run skips nothing, `e2e/skip-budget.ts` reported `0 test(s) skipped, 1 expected`
and failed the run — so the zero on the compose side is asserted rather than
observed, which is what makes it evidence that `identity.spec.ts` ran.

The fourth changed the code. `infra/compose-smoke.sh` read its revision as
`${BUILD_REVISION:-$(git rev-parse HEAD)}`, so a caller could supply it — and
compose builds from the working tree regardless of what that variable says. Run
with `BUILD_REVISION` set three commits behind, every proof in the file passed,
including all three identity assertions and `identity.spec.ts` itself: the label
matched the served revision, the served revision matched the build argument, and
the build argument matched nothing in the repository. **Three places agreeing is
only evidence when the value they agree on came from somewhere none of them
chose.** The script now takes `git rev-parse HEAD` and refuses a disagreeing
override rather than silently correcting it, because a caller that set the
variable meant something by it.

Applied to copies of `infra/server.Dockerfile`, `infra/compose-smoke.sh` and
`apps/web/playwright.config.ts`, reverted from those copies rather than by
`git checkout`, with `git diff` confirmed empty and the full smoke re-run green
after each — `6 passed`, no skips, `stack proofs pass`.

## C19 — two size columns, and what each command was actually reporting

| Guard                                    | Mutation                                                       | Result |
| ---------------------------------------- | -------------------------------------------------------------- | ------ |
| the amd64 image is 305 MB unpacked       | run the freshly built image once and re-read `docker image ls` | caught |
| `inspect .Size` tracks the unpacked size | same image, before and after that run                          | caught |

Not a guard failing but an explanation failing, and the shape is the one this
row keeps finding: the numbers stayed true while the sentence explaining them
went false. `infra/README.md` recorded 305 MB unpacked and 68 MB of layer
content for the amd64 server image and read the pair as "unpacked is what the
host disk holds (`docker image ls`), layer content is roughly what a pull
transfers (`docker image inspect .Size`)". The same script printed **207 MB in
both columns** in CI, where the sentence cannot be true of either.

The first explanation reached for — that the containerd image store reports
compressed content — was plausible, unconfirmed, and only half of it survived
being tested. What the measurements say, on this host under Colima with
`driver-type: io.containerd.snapshotter.v1`:

- a freshly built **amd64** image reads **68.1 MB** from `docker image ls`, and
  **305 MB** after it has been run once. `inspect .Size` reads 68 MB both times.
- the control is a native **arm64** build, which reads **301 MB** before it has
  ever been run — because a native build is unpacked as it is built, while a
  cross-platform one has no snapshots until something makes it run.
- `docker save | wc -c` on the amd64 image is 68 MB, confirming the compressed
  side a second way.

So `inspect .Size` is the content store and `ls` is the unpacked snapshots, but
only where snapshots exist; and on the runner's classic image store both
commands report uncompressed layer content and the distinction collapses.
`infra/verify-image.sh` now prints which store produced its table, so the
measurement is self-labelling rather than needing this paragraph. The
store-independent number is the registry's, which the `publish` job sums from
the manifest on every publish.

No file was mutated for this one; the experiment ran against images built from
an unmodified tree, and `git diff` was empty throughout.

## C19 — synth in CI, and the sliver the suite cannot see

| Guard                                            | Mutation                                                      | Result     |
| ------------------------------------------------ | ------------------------------------------------------------- | ---------- |
| cdk-nag fails the synth, `pnpm -r test:coverage` | remove one acknowledgement from infra/cdk/src/suppressions.ts | caught     |
| the CDK suite covers `cdk synth`                 | point cdk.json's `app` at a file that does not exist          | NOT CAUGHT |

The row promised "synth-in-CI" and the first question was whether a job for it
would check anything the existing one does not. It would not. Removing a single
acknowledgement fails `pnpm --filter @maekbeat/infra-cdk test` with
`ValidationFailed` raised **inside** `Template.fromStack` in `src/main.test.ts`
— the rule pack failing the synthesis, which is precisely what `cdk synth`
does with a finding — plus three assertion failures in `src/nag.test.ts`. The
synthesis, the rule pack and the acknowledgements all execute in CI today and
have since the CDK commit landed.

The second mutation is the part that is genuinely uncovered, and it is narrow.
With `cdk.json`'s `app` pointed at `src/main-typo.ts`, all 28 tests passed in
2.66 s while `pnpm --filter @maekbeat/infra-cdk synth` failed with
`Subprocess exited with error 1`. The suite imports `./main` directly, so the
manifest that names it, `tsx`, and the `aws-cdk` CLI's agreement with
`aws-cdk-lib` are all outside it. One step in the `tests` job covers exactly
that and costs about five seconds; a job would have cost a runner, a checkout
and an install to add nothing (docs/DECISIONS.md #31).

Applied to copies of `infra/cdk/cdk.json` and `infra/cdk/src/suppressions.ts`,
reverted from those copies rather than by `git checkout`, with `git diff`
confirmed empty and the suite re-run green (28 passed) after each.

## C19 — the publish gate, and what a skipped job proves

| Guard                                        | Mutation                                              | Result |
| -------------------------------------------- | ----------------------------------------------------- | ------ |
| `publish` is unreachable from a pull request | none — the control, PR #12 against the unmutated job  | caught |
| the ref clause excludes a non-main push      | widen `on: push` to `[main, ci-publish]`, gate intact | caught |
| the ref clause excludes a non-main push      | the same, minus `github.ref == 'refs/heads/main'`     | caught |

**Read the third row as skipped-versus-executed, not green-versus-red.** Every
one of these ran with `push: false` on the publish step, so with the gate
removed the job reaches its build and then fails at the pull-back verification,
which has nothing to pull. A red `publish` is the expected shape of that
mutation and not a broken job; the observable is that the job ran at all.
`push: false` is not a convenience here — without it the mutation would publish
an image from a branch, which is exactly the artifact the clause exists to
prevent, so the test would manufacture its own counterexample. It was asserted
present in the committed tree before each push rather than assumed.

The first two rows are what make the third mean anything. The control is the
ordinary case: on PR #12, seven jobs succeeded and `publish` was the one skip.
That alone does not say which half of the condition did the work, because a
pull request fails `github.event_name == 'push'` and the ref clause is never
consulted.

So the second row satisfies the first clause on purpose. With `on: push`
widened to `[main, ci-publish]`, a push to this branch is a push event, and
`github.ref` is `refs/heads/ci-publish` — `publish` skipped in 0 s
(run 31191484750). That is the ref clause with a measured effect rather than an
argued one, and it is the answer to a claim made earlier in this row and
withdrawn: that the clause was pure defence-in-depth and could not be observed
under the current trigger. It could not be observed without widening the
trigger, which is a different sentence, and widening it is a two-line change to
a branch that never merges.

One more thing the second mutation showed, which it was not designed for. With
`push: false`, `docker/build-push-action` succeeded — it built the image and had
nothing to upload — and the job went red one step later, at the pull-back. That
is the arrival check earning its place against a real negative rather than a
hypothetical one: a publish step exiting 0 while no image exists in the registry
is precisely the case it was written for, and it is the step that noticed.

## C19 — a ceiling sized from a belief, and a run that proved nothing

`URLSessionSocketTests.swift` carried the claim that a refused connection on
loopback "answers immediately" and sized a 10 s ceiling from it. Measured, that
refusal takes 0.077–0.338 s on an idle Mac, up to 6.083 s under local load, and
1.613–7.336 s on a green CI runner. The claim was wrong by roughly 40x, and it
is what failed run 31195019557.

**The first attempt at this proof is VOID. It is not "not caught" and must not
be read as one.** A second process was editing `StreamClient.swift` and
building into the same `-derivedDataPath` at the same time, so the binary under
test cannot be identified. A void run and an uncaught mutation produce the same
green table and mean opposite things: one says the guard is weak, the other
says nothing at all.

That attempt had a second, independent defect worth recording. The mutation was
a bare `return` placed before the call it meant to skip, and Swift parses
`return` followed by an expression as `return <expression>` — it warns
"expression following 'return' is treated as an argument of the 'return'" and
calls it anyway. A scratch binary confirmed it: `sideEffect ran after a bare
'return': true`. Mutations below are by deletion.

The redone proof used a fresh derived-data directory, a full clean build, and
two gates before any test ran: build `rc == 0`, and the mutated file named in
the build log by a path-anchored pattern. `Transport/StreamClient\.swift` and
not a bare `StreamClient`, which also matches `StreamClientTests.swift`. The
unreachable-code warning is not a gate here, because the compiler does not emit
one for this construct.

| Guard                                              | Mutation                                                        | Result     |
| -------------------------------------------------- | --------------------------------------------------------------- | ---------- |
| a refused socket makes the client schedule a retry | drop `retryAfterFailure()` from `StreamClient.handleClose`      | caught     |
| the real socket reports a refusal as a close       | drop `handlers.onClose()` from `URLSessionStreamSocket.receive` | caught     |
| the real uplink socket reports its drop            | drop `handlers.onClose()` from `URLSessionIngestSocket.receive` | caught     |
| the uplink client surfaces the drop as a state     | drop `setState(currentState())` from `IngestClient.handleClose` | not caught |

Neighbours are half of this. Mutation A reddened the two `StreamClient` tests
and left three green; B reddened the three stream-side tests and left both
ingest tests green; C reddened the two ingest tests and left the three
stream-side ones green. A mutation that reddens everything would say the tests
share a single point of failure.

The fourth row is a bad mutation rather than a weak test, and the code says
why. `IngestClient.connect()` also calls `setState(currentState())`, so the
scheduled retry reports `.reconnecting` even with the call removed from
`handleClose` — the mutation deletes a duplicate report and delays the
surviving one by a 500 ms backoff, which a 60 s budget absorbs. The behaviour
that test names is broken by mutation C, and it failed there in 72.752 s.

What this establishes: all five recalibrated tests still fail when the retry
path they name is actually broken. What it does not establish: that 60 s and
190 s are the right ceilings. Nothing can — a ceiling is justified by the
measurement recorded in the file header, not by a run that passed.

Applied to copies of `StreamClient.swift` and `IngestClient.swift`, reverted
from those copies rather than by `git checkout`, each revert verified by
`shasum` against both the copy and `git show HEAD:`, and the suite rebuilt and
re-run green (5 passed) at the end.

## Phase 6 — the status marker nothing was checking

`scripts/check-phase-status.sh` holds the roadmap heading as the single source
for a phase's status, propagates it to the README board (R1), and refuses a
phase marked complete that still lists a row without a `shipped [sha]` (R2).
The mutations are grouped by which of the two rules, or which fail-open path,
each one aims at.

| Guard                                | Mutation                                                     | Result |
| ------------------------------------ | ------------------------------------------------------------ | ------ |
| R1, board follows heading            | uncheck Phase 6 on the board, roadmap still complete         | caught |
| R1, in the other direction           | check Phase 7 on the board, roadmap still in progress        | caught |
| R2, a complete phase has shipped     | Phase 7 complete in BOTH places, C21 and C22 carrying no sha | caught |
| fail-open, the board anchor          | rename the `## Status` heading                               | caught |
| fail-open, the board data            | delete every phase row, heading intact                       | caught |
| fail-open, the roadmap anchor        | rename every `## Phase N —` heading                          | caught |
| fail-open, an undecided heading      | strip the marker off Phase 6's heading                       | caught |
| R2's boundary, premature declaration | Phase 7 complete in both places, C21 and C22 bullets deleted | passes |

The third row is the one worth reading twice. It was run with the board changed
to agree, because R1 fires first and returns before R2 is reached — mutating the
roadmap alone would have gone red on R1 and proved nothing about R2. The verdict
is R2's own message naming C21 and C22, not R1's.

The three fail-open rows are the ones that had to go red rather than quiet, and
each names its reason instead of exiting silently. The middle one is the
interesting case: the `## Status` heading survives and the rows under it do not,
so a guard that finds its anchor, loops the rows and compares each would exit 0
with every claim satisfied because there are no claims. `check-hazard-tests.sh`
already fails on zero rows and this follows it.

The last row passes, and it is recorded as a boundary rather than a gap. R2 asks
whether the rows a phase lists have shipped, so deleting the unshipped bullets
and then declaring the phase complete satisfies it. **R2 catches a regression —
a listed row that has not shipped — and not a premature declaration whose
remaining work was never written down.** The judgement that a phase is finished
stays human, and no rule here replaces it.

One more, against the wiring rather than the guard. The check that
`.github/workflows/ci.yml` invokes this script parses the YAML and reads the
`hygiene` job's `run` values, and its first version tested for the substring and
for an unanchored regex — two assertions agreeing with each other and sharing one
blind spot. Rewritten to `/^\s*bash scripts\/check-phase-status\.sh/m`, and both
halves proved: commenting the invocation out inside a `run: |` block leaves the
substring and unanchored tests reporting **true** on a disabled guard, while the
anchored one reports false. Commenting out a single-line `- run:` step is a
different case and was checked too — it removes the step from `steps` entirely,
so all three report false.

Applied to copies of `README.md` and `docs/ROADMAP.md`, reverted from those
copies rather than by `git checkout`, each revert verified by `shasum` and by
re-running the guard green.

## The back-fill wait that watched the wrong half

`DeviceDetailModel.backfill()` performs two reads, frames then alerts.
`DeviceScreenTests` waited for the frames to merge and then asserted on the
alerts request, so the condition went true one read before the thing the
assertion tested. That is what failed run 31185142716, at the alerts count and
never at the frames.

| Guard                                | Mutation                                          | Result             |
| ------------------------------------ | ------------------------------------------------- | ------------------ |
| a re-open asks what alerts it missed | remove the alerts read from `backfill()`          | caught             |
| the same, against the old condition  | remove the alerts read from `backfill()`          | caught             |
| the wait covers both reads           | delay the alerts read 300 ms, corrected condition | passes, 0.327 s    |
| the same, against the old condition  | delay the alerts read 300 ms, old condition       | **fails, 0.761 s** |

The first two rows are the ordinary proof and they do not discriminate: deleting
the alerts read entirely breaks the assertion either way, so both conditions
catch it. Rows three and four are the ones that separate them, and they are the
same mutation and the same build read twice.

Delaying the alerts read by 300 ms makes the race deterministic. The old
condition exits on the frames, finds one alerts request where it wants two, and
fails at `:175` with the exact message from CI. The corrected condition waits
the delay out and passes in 0.327 s, which is the 300 ms plus the poll interval
— evidence it actually waited rather than passing for some other reason.

The deadline moved from an iteration count to a wall-clock `Date` bound, and
the reason is in the numbers rather than in taste. `100 x 10 ms` reads as one
second and bounded nothing of the sort: the same case took 11.643 s on the
runner it failed on, because a 10 ms `Task.sleep` does not cost 10 ms under
contention. A hang detector that cannot state its own bound in seconds is not
one.

Applied to a copy of `DeviceDetailModel.swift`, reverted from that copy rather
than by `git checkout`, verified by `shasum` against both the copy and
`git show HEAD:`, rebuilt after the mutation and after the revert, with the
mutated file named in each build log by a path-anchored pattern.

### The family, listed and not fixed

Twenty-seven waiting sites across the apps/ios suite were read with their
assertions — twenty `wait(until:)` / `settle(until:)` call sites and seven
expectation waits. The earlier count of fourteen counted helper definitions
rather than call sites, which is the wrong unit: a helper is generic and
whether its condition covers the assertions is decided where it is called.

**One other site has this defect: `CompositionTests.swift:151`.**
`NotificationCoordinator.prepare()` calls `port.registerCategories()` and then
awaits `refreshAuthorization()`. The test waits on `categoryRegistrations > 0`,
the first half, and then asserts `notifications.authorization == .authorized`,
which the second half sets. It passes today because a fake port resolves fast,
and its budget is 100 x 20 ms.

The rest divide into three groups that are all sound. Most name the condition
their assertion tests. Several observe the _later_ effect of an ordered pair and
so cover the earlier one for free — `CompositionTests.swift:124` waits on the
radio scan while `GatewayModel.start()` opens the uplink socket first, and
`DefaultPathTests.swift:186` waits on the drop after an open that must precede
it. A handful assert a negative (`prompts == 0`, `scheduled.count == 0`), which
no condition can wait for by construction.

The direction is the whole rule: waiting on the later half of an ordered pair is
safe, and waiting on the earlier half is the bug. One instance is not a commit
of its own yet; it is recorded here so the second one finds this note.

## The second instance, found by that scan

`NotificationCoordinator.prepare()` calls `registerCategories()` and then awaits
`refreshAuthorization()`. `CompositionTests` waited on the registration and
asserted on the authorization, which is the same shape one entry above. The fix
is the directional rule: wait on the later half, which covers the registration
for free.

| Guard                                   | Mutation                                        | Result             |
| --------------------------------------- | ----------------------------------------------- | ------------------ |
| launch reads the permission, not assume | delay `refreshAuthorization()` 300 ms, new wait | passes, 0.421 s    |
| the same, against the old condition     | delay `refreshAuthorization()` 300 ms, old wait | **fails, 1.108 s** |

Same mutation, same build, read twice. The old condition fails at `:154` with
`("notDetermined") is not equal to ("authorized")`; the corrected one passes in
0.421 s, which is the 300 ms delay plus a poll interval and the hosting
overhead — the right duration, not merely a green result. Deleting the read
instead of delaying it was not used, because both conditions catch that.

The neighbour stayed green throughout:
`testTheLinkScreenReReadsThePermissionOnEveryAppearance` already waits on the
authorization itself and passed under the mutation.

`settle` also moved from 100 iterations to a wall-clock deadline, which changes
all seven waits in the file. Measured over them: local idle 0.000–0.197 s across
70 waits in 10 runs, local under 12-core load 0.000–1.833 s across 42 waits in
6 runs. **1.833 s against a count that read as two seconds** is the argument;
30 s is about 16x it and the multiple is a judgement.

The elapsed-time instrumentation used to take those numbers was removed rather
than shipped, so the measurement was taken on code that differs from what
landed. Applied to a copy of `NotificationCoordinator.swift`, reverted from that
copy, verified by `shasum` against the copy and `git show HEAD:`, rebuilt after
the mutation and after the revert.

## C21 — the SOUP inventory diffed against the manifests

`scripts/check-soup-inventory.sh` claims that every dependency this project did
not write is named in `docs/regulatory/soup-inventory.md`. Each mutation below
breaks that correspondence one way and asks whether the script notices.

| Guard                            | Mutation                                                                       | Result         |
| -------------------------------- | ------------------------------------------------------------------------------ | -------------- |
| an item leaves the document      | delete the `fastify` row from the server runtime table                         | caught         |
| an item the manifests never had  | add a `left-pad` row beside `react-router`                                     | caught         |
| a dependency enters the build    | add `p-limit` to `apps/server/package.json` dependencies                       | caught         |
| an action leaves the document    | delete the `actions/cache` row                                                 | caught         |
| a base image leaves the document | delete the `grafana/k6` row                                                    | caught         |
| a build tool leaves the document | delete the `prettier` row                                                      | caught         |
| a row the parser cannot read     | strip the backticks from `jsdom`'s first cell, leaving the row intact          | caught         |
| a class goes unread              | rename the marker `<!-- soup:actions -->` to `<!-- soup:action -->`            | caught         |
| the npm source reads nothing     | point the `find` expression at `package.jsonX`, so the manifest side is empty  | caught         |
| an action enters CI              | replace `uses: actions/cache@v6` with `uses: foo/bar@v1` in `ci.yml`           | caught         |
| a document that claims nothing   | empty every row's first cell, markers and tables intact                        | caught         |
| a base image is swapped          | `ARG NGINX_IMAGE` from `nginxinc/nginx-unprivileged` to `caddy:2-alpine`       | caught         |
| a build tool is swapped          | `npx --yes prettier@3.9.6` to `npx --yes biome@2.0.0` in the `docs-lint` job   | caught         |
| a Swift package appears          | add one `.package(url: .../swift-log.git)` line to `MaekbeatKit/Package.swift` | **NOT CAUGHT** |

The negative controls matter as much as the rows above, because the guard's
whole design is that it keys on names and never on versions. Each of these must
leave it green, and each does:

| Property                            | Mutation                                                    | Result |
| ----------------------------------- | ----------------------------------------------------------- | ------ |
| a version bump is not a SOUP change | `fastify` `^5.x` to `^99.0.0` in `apps/server/package.json` | green  |
| a workspace link is not SOUP        | add `@maekbeat/vitals-sim` to `apps/server` dependencies    | green  |
| an action version bump              | `actions/cache@v6` to `actions/cache@v7`                    | green  |
| a base image version bump           | `node:22.22.0-alpine3.22` to `node:24.0.0-alpine3.22`       | green  |

**Read this before trusting the two tables above: the harness misreported its
own state at least once, and the cause was never found.** One run of the battery
printed its closing line, `final — tree restored — exit 0`, and the very next
command in the same shell ran `scripts/check-soup-inventory.sh` and got a
failure. Those two statements cannot both be true of the same tree, and the
battery is the one that produced every row above.

**No cause is offered, because none was established.** The plausible stories —
a restore that had not completed, a stale copy, an editor writing underneath —
were all consistent with the evidence and none was demonstrated, so none is
written here as though it were. Recording a guess would be worse than recording
the gap, because the next person would stop looking.

What is established is the state afterwards, verified five independent ways
rather than by re-running the thing in question: a residue grep against each of
the five mutation targets in turn (`swift-log` in `Package.swift`, `p-limit` in
`apps/server/package.json`, `foo/bar` and `biome` in `ci.yml`, `caddy` in
`infra/web.Dockerfile`, `left-pad` in the inventory), all zero;
`git diff --stat` showing only the files this commit intends to change; and all
eight hygiene guards run with their exit codes printed individually, all zero.
The tables above were then re-run in full against that verified tree.

Two rules come out of it, and they are the point of writing this down.
**A battery's own summary line is not evidence about the tree it mutated** —
verification has to come from outside the thing being verified, which is the
same principle the guards themselves rest on. And **`guard-a && guard-b` hides
a failure**: when the first command fails the second never runs, and its
absence from the output reads exactly like a pass. Guards here are run
separately with each exit code printed, never chained.

**The NOT CAUGHT row changed the script.** Adding a real Swift package
dependency to `Package.swift` left the guard printing `50 items, document and
manifests agree` and exiting 0. The cause was not a broken parser but a missing
one: `apps/ios` declares no Swift dependencies, so the first draft was given no
Swift source, and a source that is never read cannot disagree with anything.
Every other class fails loudly on drift; this one failed silently, which is the
only failure mode a guard must not have.

The fix is an assertion rather than a fifth class. A Swift class with an empty
manifest side would trip the script's own "a source that reads nothing agrees
with any document" rule on every run, and a guard that is red by design gets
switched off. So the document's claim — that `apps/ios` declares zero external
Swift packages — is checked as a claim: any `Package.swift` declaring anything
now fails, naming the line it found and telling the reader to build the class
and the table together.

**The row stays NOT CAUGHT because that is what the first run showed, and the
two runs together are the record.** Same mutation, same file, twice: against the
guard as written it exited 0 with `document and manifests agree`, and against
the guard with the assertion it exits 1 naming the `.package(url: ...)` line it
found. Recording only the second would describe a script that was always right,
and recording only the first would describe a limitation that still exists.
Neither is what happened.

One row was already caught before its check existed, and the check was still
worth writing. "Every row emptied" failed through the opposite direction — all
50 manifest items came back unnamed — producing 151 lines across 50 reports of
a dependency entering the build, when what had happened was that one document
left. The reader would go looking for 50 new dependencies. The document-side
assertion now names the cause in 17 lines and skips the diff for a class that
declared nothing, because a guard is also a thing people read while it is red.

Two blind spots have no mutation here and cannot have one. Versions are outside
the guard by design, so a pin moving backwards is invisible — that is the trade
the name-keyed design buys, argued in the script header and measured by the four
negative controls. And the transitive closure is outside both the document and
the check in both languages: 340 resolved package versions against 37 declared
on the npm side, and on the Swift side `Package.resolved` is where a transitive
set would be written and nothing reads it. What M14 closed is the direct
declaration, not what resolves beneath it.

Every mutation was applied by writing a modified copy over the target and
restored by `cp` from a backup taken before the first one; six paths were backed
up, one per target. No `git` command appears in the battery.

## C21 — the register, and the guard extended to read it

`scripts/check-hazard-tests.sh` now reads two documents. The register marks a
row `demonstrated` partly on the grounds that this script checks its citation,
so the script had to actually check it; a criterion that asserts its own
enforcement and is not enforced is worse than one that claims nothing.

| Guard                                      | Mutation                                                             | Result         |
| ------------------------------------------ | -------------------------------------------------------------------- | -------------- |
| a cited test must exist (P4)               | change one row's test title only: `not 30 alerts` to `not 31 alerts` | caught         |
| a cited file must exist (P5)               | change one row's path only: `alerts.test.ts` to `alarms.test.ts`     | caught         |
| a single-citation row fails closed (P6)    | mangle the register H6 row's ONLY citation to `banana:`              | caught         |
| both ID sets agree, analysis side (P2)     | delete the H6 row from `hazard-analysis.md`                          | caught         |
| both ID sets agree, register side (P3)     | delete the H6 row from `risk-register.md`                            | caught         |
| `register-only` grants the exemption (P7a) | strip `register-only` from H10, which sits in no hazard table        | caught         |
| `register-only` grants nothing else (P7b)  | keep the marker on H10, break one citation's path to `quiet.test.ts` | caught         |
| a multi-citation row losing one (P1)       | mangle ONE of H7's three citations to `banana:`                      | **NOT CAUGHT** |

P4 and P5 are the two that matter, because they are the only mutations here
that make a row **claim something false** — a control demonstrated by a test
that does not exist. Both fail the build naming the row and the missing test.
P2 and P3 cover the cross-check added at C21, in both directions.

### The `register-only` marker, and why it is a door with a hinge

The cross-check exempts a register row from "must exist in the hazard analysis"
when the row says `register-only`. An exemption is a way to make a row
unfalsifiable if it exempts too much, so both halves are observed rather than
reasoned about.

**It is not an unexercised branch.** H9 and H10 carry the marker today and are
the reason it exists: both are hazards this register adds that no hazard table
identifies. The accepting path runs on every green build, and P7a shows the
marker is what grants the exemption — strip it from H10 and the build fails.

**It exempts exactly one assertion.** Citations are verified in `check_lines`,
which runs over every row of both documents before the cross-check is reached,
so the marker cannot reach them. P7b holds the marker in place and breaks one
of H10's citation paths: the build fails on the citation. Marking a row
`register-only` does not make it unfalsifiable; it says only "this hazard is
identified here rather than in the hazard analysis", and everything else about
the row is still checked.

That is why the marker stays rather than the cross-check being made
unconditional. It is not a door built for a case that has not arrived — two
rows walk through it today, and an unconditional cross-check would make those
two rows impossible to write.

### The limitation P1 marks, stated as a boundary rather than a worry

**What is not caught:** a row carrying several citations loses one of them to a
form outside the citation grammar. The row still passes.

**Why it is not caught:** `banana:` has one colon, not two, so it is not a
malformed citation — it is prose. Rows legitimately carry backtick spans that
are not citations (`ALERT_HISTORY_LIMIT`, `apps/server/src/alerts.ts`,
`21 CFR 882.1580`, `.swift`), and no rule on the span's shape separates a
broken citation from an env-var reference. Rejecting every non-citation span
would fail every row in both documents.

**Why it does not falsify the row:** the surviving citations still demonstrate
the control, so the row's claim remains true and merely rests on less evidence
than it did. That is a weaker defect than the one this guard exists to prevent,
which is a row claiming a test nobody can find — and P4 and P5 show that one is
caught.

**Where the boundary is, observed and not assumed:** when the mangled citation
is the row's **only** one, the row fails closed. That is P6, run against the
register's H6, and the failure names the offending span in its output:
`Backtick spans found in this row, none of them a citation: ... banana:`. So
the gap is exactly "multi-citation row, one span corrupted", and it closes
itself as soon as a row is down to its last citation.

**What would close it, deliberately not done:** parse citations from a
dedicated column rather than from the whole row, so that every backtick span
inside that one cell must be well formed. `hazard-analysis.md` already has a
`Verified by` column that would serve; the register does not, and adding one
would restructure a table introduced in this same commit to catch a defect that
does not make any row untrue. The cost is not worth the coverage, and writing
the boundary down is the alternative to pretending there is none.

**P1 was a mis-specified perturbation and is recorded as one.** It was written
to test whether an unrecognised citation form fails, but `banana:` falls
outside the grammar by construction, so it asked the guard to distinguish
something it has no rule to distinguish. What it should have been is P4 —
well-formed, resolvable-looking, unresolvable — which is the shape an actual
false claim takes. The record is kept because a perturbation that passes for
the wrong reason is easy to re-run later and misread as coverage.

Two defects in the guard were found by writing these rows rather than by
running them. A row could carry **both** a resolvable citation and the
`no-control:` sentinel: `cites` is tested first, so the contradiction was
accepted as controlled and the sentinel branch was never reached. And the
sentinel did not exist at all until C21 — the branch failed unconditionally
while its own message offered "or say in the row that none exists", so **a
hazard with no control could not be recorded in a checked table**, which made
these documents structurally capable of holding only hazards already fixed.
H9, the battery row, is the first row in this repository to declare an absent
control, and it is counted and reported rather than waived.

Every perturbation was applied by writing a modified copy over the target and
restored by `cp` from a backup taken before the first; `diff -q` confirmed both
files byte-identical to their backups between each one. No `git` command was
used to restore anything.

## C21, after the row closed — a hole that was not there

No behaviour changed here. This entry exists because a wrong conclusion was
reached by a method worth not repeating, and the measurement that settled it is
cheap to re-run.

**The method error.** `scripts/check-commit-links.sh` has several
`git cat-file -e ... || continue` and `git rev-parse ... || continue` sites.
Read on their own they say "an unresolvable sha is skipped", which would mean an
invented compare base passes silently — a real hole, and in the one place that
decides which commits a roadmap row is claimed to contain. The reading came from
grepping the `continue` sites and never reading what feeds the loop they sit in.

**What the input actually is.** The `compare_shas` / `linked_shas` assignments
in section 1 split every compare range on `...` and fold BOTH ends into
`linked_shas`, next to the plain commit links. A compare
base does not have to be a shipped sha to get there; `7e80bb5` is in that set
today and belongs to no row. The loop that follows walks `linked_shas` and fails
any sha that is not a commit or is not an ancestor of HEAD, and it runs before
every one of the `continue` sites. They cannot turn a bad range green. What they
do is stop one bad sha from burying its own accurate error under three vaguer
ones.

| Guard                                 | Perturbation                                             | Result         |
| ------------------------------------- | -------------------------------------------------------- | -------------- |
| a compare base must resolve (Q1)      | `compare/7e80bb5...eeecfcf` base to `7e80bb0`            | caught         |
| a compare head must resolve (Q2)      | same chip, head to `eeecfc0`                             | caught         |
| a range must run forwards (Q3)        | reverse it to `eeecfcf...91af466`, both ends valid       | caught         |
| a range shape must be recognised (Q4) | add `compare/91af466..eeecfcf`, two dots, both ends real | **NOT CAUGHT** |

Q3 is the one worth keeping, because it is the case the ancestry `|| continue`
appears to cover and the only one that silently mislabels which commits a row
contains. It fails in the block above that one, before the branch that looks
like it would skip it.

**What would make the reading correct.** A sha reaching those loops without
passing through `linked_shas` — a new link shape, a tag, a range written with
`..` rather than `...`. The script now says so at the point a reader would
otherwise draw the same conclusion, and names the two independent reasons the
branches are kept rather than deleted.

**Q4 is the one that found something, and it came from the comment rather than
the code.** The comment written for Q1-Q3 named "a range written with `..`" as a
thing that would break the invariant. That was a hypothetical nobody had tried,
which is the shape this repository keeps finding in other people's work, so it
was tried.

A two-dot compare chip pointing at two real commits produced a **byte-identical
green summary**: `3 compare range(s)`, exit 0, with a fourth range sitting in
`README.md`. Every collector keys on `...`, so the token never split, neither
end reached `linked_shas`, and the chip loop did not recognise it as a compare
link at all. It was not rejected. It was unseen — which is worse than rejected,
because the summary counted three ranges and read as complete.

The fix rejects the shape rather than widening the collectors to read it.
GitHub's two-dot and three-dot compares do not mean the same thing, so `..` is a
different claim about which commits a row holds, and widening would have meant
editing four separate patterns plus the split — which is how the shapes came
apart in the first place. Q4 now fails, naming the link and the file and line;
Q1 to Q3 still fail unchanged.

Two smaller things fell out. The comment first cited "line 83" and "line 73",
and moving one function made both stale inside the same commit — the references
are by name now, since a guard whose own comment rots is the failure it exists
to prevent. And Q1 and Q2 named the sha but not the chip, because the failing
loop reads a flat set and has lost which link each sha came from; that is now
one grep for the file and line rather than a restructure of which loop reports.

**The sweep this lesson asked for, and what it found.** A reference to a line
number in another file rots, and this commit demonstrated it rotting inside
itself. So the class was swept rather than assumed unique: `line N`, `lines
N-M` and `file.ext:N` across `README.md`, `docs/` and `scripts/`. It found
**nine live cross-file line references across five files** — `docs/DECISIONS.md`
to `StreamClient.swift:195` and `DeviceDetailView.swift:74`,
`docs/regulatory/hazard-analysis.md` to `DeviceDetailView.swift:74`,
`docs/ai/AI_USAGE.md` twice to `stream.test.ts:162`, this file three times to
`CompositionTests.swift` and `DefaultPathTests.swift`, and
`scripts/check-phase-status.sh` to `check-commit-hygiene.sh` line 18.

Every one sampled resolves correctly today, which is the finding rather than a
reassurance: they are accurate, unguarded, and nothing would report the day one
stops being true. **They are not fixed here.** Nine references in five files is
a refactor, and running it inside a commit about a single stale comment is how a
commit stops being one thing. It is a candidate, named the way C21's closing
bullet names the two it declined — and it is the same unguarded class as the one
recorded there, a prose claim about another file that no guard reaches.

The one instance fixed here is the one this commit introduced: the paragraph
above cited "lines 72-74" of the script while describing why line-number
citations rot.

The handoff, so this does not rest in a log nobody re-reads: the candidate
belongs beside the two `docs/ROADMAP.md` already declines in C21's closing
bullet, and the place to write it is C22's row when that row is written — not by
reopening a closed row from a commit scoped to `scripts/` and this file.

**One thing left as it is, recorded rather than fixed.** The summary line counts
compare ranges _found_ rather than ranges _checked_. That is the report agreeing
with itself, and it cannot mislead while the fail-closed loop stands, because a
range whose ends do not resolve fails the run. It is honest by consequence, not
by construction, which is a weaker property than it reads as.

Q1 and Q2 named the sha and not the chip, because the failing loop reads a flat
set and has lost which link each sha came from. That is now one grep for the
file and line rather than a restructure of which loop reports: both print
`linked at README.md:108`. Q3's message was already specific and is unchanged.

## C22 — the data-flow diagram, and what its guard could not be

`scripts/check-dataflow-paths.sh` asserts that every element and boundary in
`docs/security/data-flow.md` cites a path that resolves. Four mutations, each
applied by writing over the target and reverted by `cp`, with `diff -q` clean
between:

| Guard                             | Mutation                                                         | Result |
| --------------------------------- | ---------------------------------------------------------------- | ------ |
| a cited path must exist           | point E7 at `apps/server/src/quiet.ts`                           | caught |
| a table must hold rows            | empty the elements table, markers intact                         | caught |
| a region must be findable         | rename `<!-- dfd:boundaries -->` to `<!-- dfd:boundary -->`      | caught |
| a renamed module is the real case | `mv apps/server/src/silence.ts apps/server/src/silence.ts.moved` | caught |

The fourth is the one worth keeping. The other three break the document; that
one breaks the world the document describes, which is the failure a diagram
actually suffers and the one it shows least — a box labelled with a module
renamed six commits ago renders exactly like a correct one.

### The measurement that scoped the guard, and what it costs a C21 candidate

The guard reads two marked tables rather than prose, and the general form was
tried first: assert that every backticked path-shaped token in
`docs/regulatory/` resolves. **22 failures out of 100 citations, and almost none
is an error.** `.swift` and `.md` appear as nouns, `/ship-check` is a slash
command, `actions/cache`, `grafana/k6`, `realm/SwiftLint` and
`nginxinc/nginx-unprivileged` are SOUP identifiers rather than paths,
`webstore.iec.ch/en/publication/22794` is a URL, and
`apps/ios/.../BLE/LinkState.swift` is deliberately elided. A guard failing 22
times on its first run is one somebody switches off inside a week.

**This changes a candidate C21 recorded, and the record should not be read
without it.** C21's closing bullet defers the "nothing checks a prose claim
about another file" gap and justifies deferring rather than declining it on the
grounds that a check is possible. That is still true, but its cost is now
measured rather than assumed: the naive form does not work, because a
path-shaped token in prose is not a path and no rule on shape separates the two.
A working version needs a **declaration mechanism** — a marked region, a
dedicated column, some convention by which a path is a path because the document
says so rather than because it looks like one. That is what this commit built
for one document, and it is what the candidate would need for the rest. A future
reader picking that candidate up as cheap would be picking up the 22-failure
version.

### The claim this commit made about another file, and got wrong

The first draft of `docs/security/data-flow.md` said `docs/ARCHITECTURE.md`'s flowchart
depicts components that no longer exist. It does depict a queue and an S3
archive, and neither exists — but that file **says so itself**, in the Dev
form / Target form table directly beneath the diagram: the queue reads "SQS is
target architecture, no commit assigned, and infra/cdk omits it deliberately",
and the archive reads "planned, no commit assigned".

The section was written from the diagram without reading the table under it.
That is the fifth prose claim about another file this sequence has corrected,
and the first committed **inside** a document whose subject is artifacts that rot
and whose guard exists to prevent exactly this. It is recorded rather than
quietly fixed because the useful part is not the error, it is that knowing the
failure mode in detail, while writing about it, did not prevent committing it.
No guard here would have caught it: `check-dataflow-paths.sh` verifies that
`docs/ARCHITECTURE.md` exists, not that a sentence about it is true.

## C22 — the threat model, and the guard extended to read it

`scripts/check-dataflow-paths.sh` grows a second half: every `B<n>` and `E<n>`
that `docs/security/threat-model.md` cites must be an id
`docs/security/data-flow.md` declares. An extension rather than a tenth script,
by the same test that split this file off from `check-hazard-tests.sh` — both
halves read a marked table, take a declared label, and assert it resolves to
something. Adding a script to keep the shapes symmetrical would be symmetry.

| Guard                                    | Mutation                                                    | Result            |
| ---------------------------------------- | ----------------------------------------------------------- | ----------------- |
| a cited id must be declared              | a threat cites `B9`, which the diagram has no row for       | caught            |
| removing a declared id breaks its citers | delete the `B3` row from the diagram, threats still cite it | caught            |
| the threat table must hold rows          | empty it, markers intact                                    | caught            |
| the threat document must exist           | move `threat-model.md` aside                                | caught            |
| the id column must be parseable          | rewrite every id as `id-E4`, so nothing resolves against it | caught            |
| a renamed id breaks its citers           | `E9` to `E99` in the diagram only                           | caught            |
| ~~a renamed id nothing cites~~           | `E1` to `X1`, and no threat cites `E1`                      | **mis-specified** |

The last row is recorded rather than deleted, for the reason the C21 battery
recorded a mis-specified perturbation instead of quietly dropping it. It was
written to test "the diagram's id column moved" and it does not: renaming an id
that nothing references breaks nothing, so passing is the correct answer and the
mutation asks the guard a question with no wrong answer. The version that tests
the intended property is the fifth row, which makes every id unparseable at
once. A perturbation that passes for the wrong reason is easy to re-run later
and misread as coverage.

### What the model does not have a guard for, stated where it is measurable

The threat rows cite hazard ids — `H2`, `H3`, `H4`, `H7` — as prose, and
**nothing asserts those exist.** That is the same measured limitation the path
half of this script has: 22 of 100 path-shaped tokens in prose are not paths,
and no rule on shape separates a real `H2` reference from the characters `H2`
appearing in a sentence. Making them checkable needs the declaration mechanism
this repository has built in `soup-inventory.md`, `risk-register.md`,
`data-flow.md` and now `threat-model.md` — a marked region with a column that
means something. They are named rather than counted, because a count in prose is
a fact in two places and this sequence has already corrected five of those. The threat model says so itself rather than implying its harm
citations are checked.
