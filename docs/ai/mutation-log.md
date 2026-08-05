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

Each guard is broken twice: by mutating the thing it names, and by mutating the
thing next to it.

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
