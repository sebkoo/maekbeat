# Risk register (seed)

Not the register. C21 builds that one, seeded from the failure modes in
[../ARCHITECTURE.md](../ARCHITECTURE.md) plus alarm-fatigue and battery rows,
with a column per question worth answering: hazard, cause, control,
verification, residual risk.

This file exists because a hazard was identified while building something else,
and the honest place to put it is here rather than in a commit message nobody
will read again. It holds only rows discovered before C21, each pointing at the
code that controls it. Maekbeat is an educational project and not a medical
device ([../../DISCLAIMER.md](../../DISCLAIMER.md)); nothing here claims
conformity with any standard.

| Hazard                                                                                              | Cause                                                                                             | Control                                                                                                                             | Verification                                                          | Residual                                                                                                                                                                                                                 | Seeded |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| An alert is evicted before anyone triages it: a caregiver never sees an event the system did detect | The per-device alert history is bounded (`ALERT_HISTORY_LIMIT`, 100) and evicted in arrival order | Eviction sorts by decision state first, age second — decided alerts go before undecided ones (apps/server/src/alerts.ts `evictOne`) | apps/server/src/eviction.test.ts, proven against its inverse mutation | A device whose backlog is entirely undecided still forces a drop; it is counted (`forcedEvictions`), served on GET /devices, and logged at warn. The decidability of an evicted alert is in-process: a restart resets it | C12a   |
