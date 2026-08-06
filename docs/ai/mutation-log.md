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
