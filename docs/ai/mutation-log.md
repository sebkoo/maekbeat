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
