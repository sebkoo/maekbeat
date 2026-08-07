# Risk register (seed)

Not the register. C21 builds that one, with the columns a register needs and
this project does not yet have: probability, severity, acceptability against
criteria fixed in advance, and an overall residual risk evaluation.

This file was created at C12a because a hazard was identified while building
something else, and the honest place to put it was here rather than in a commit
message nobody will read again. **Its one row has moved.** It is now H2 in
[hazard-analysis.md](hazard-analysis.md) — the alert evicted before anyone
triages it, controlled by decision-state-ordered eviction in
`apps/server/src/alerts.ts` — where `scripts/check-hazard-tests.sh` checks that
the tests it cites still exist and still run.

The row was moved rather than copied. One hazard stated in two tables is the
drift this repository has already paid for once in the README scope ranges
(`scripts/check-scope-ranges.sh`), and a hazard table is a worse place to learn
it a second time.

Maekbeat is an educational project and not a medical device
([../../DISCLAIMER.md](../../DISCLAIMER.md)); nothing here claims conformity with
any standard. [README.md](README.md) states that position in full.
