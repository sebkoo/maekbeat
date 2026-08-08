# The v0.2 product loop

For a monitoring product the question is not whether it works but whether anyone
keeps reading it. This states what would be measured to answer that.

**No target appears here.** There are no users, no real data and no deployment,
so any figure to stay under or reach would be invented in the vocabulary that
makes invention hardest to spot — the thing
[regulatory/risk-register.md](regulatory/risk-register.md) refused to do with
probability. Every number below is one that can be pointed at in the code today.

## The row's own metric does not exist yet

`docs/ROADMAP.md` asks for a false-alarm rate, and `packages/protocol/src/acks.ts`
says counting `dismissed` against `acknowledged` is it. **It is not, and the
hazard analysis already says why.**

H7's harm is "a missed alert, arriving through the caregiver rather than through
the software, and no log will show anything but a delivered notification that was
dismissed". A dismissal has at least three causes and the schema records none of
them: the alert was wrong; the alert was right and handled another way; or the
caregiver has stopped reading, which is H7 itself. **The same event counts as a
product success and a safety failure, and nothing in the data separates them.**

A false-alarm rate also needs to know whether the event was real. Nothing here
does. The only false-alarm number this repository has is zero alerts across the
quiet-scenario seed sweep in `apps/server/src/alerts.test.ts`, measured against a
simulator it also wrote — H7 calls that a closed loop and not evidence.

So `dismissed / (acknowledged + dismissed)` is a **dismissal rate**. Naming it a
false-alarm rate would make H7 invisible in the number that is supposed to
surface it.

Retention has the same shape one layer down. Nothing identifies a returning
person: `actor` is a caller-asserted string with no authentication behind it
(C22 TH2), and `sessionEpoch` is a device's connection, not a human's visit.

## Three categories, because they are not equally available

### Computable today, against synthetic data, through the existing API

- Alerts raised, resolved and suppressed per device — `GET /devices/:deviceId/alerts`.
- Decisions by kind — `acknowledged` and `dismissed`, from `DecisionLog.countsFor`.
- **Undecided alerts**, the count neither of the above includes: alerts with no
  decision event. This is the interesting one and nothing currently serves it.
- Forced evictions — `alertsForcedEvicted` on `GET /devices`, bounded by
  `ALERT_HISTORY_LIMIT` (100) and `DecisionLog`'s own 200 per device.
- Time from raise to decision, from `raisedAtMs` and `recordedAtMs`.

### Needs a schema change, and here is the cost

- **A reason on a dismissal.** `note` exists and is free text capped at 280
  characters, which is a record and not a metric. Separating "wrong" from
  "already handled" from "stopped reading" needs an enum, and the third option
  is one nobody selects about themselves.
- **Ground truth**, without which no false-alarm rate is computable at all. No
  code can produce it; it is a label applied by someone who knows what happened.
- **Identity**, without which retention is not defined. That is authentication,
  which is C22's TH2 and its own piece of work.

### Needs a deployment and real people, and cannot be planned from here

Any target value. Actual retention. Whether a caregiver who dismisses often goes
on to miss a real alert — the question H7 exists about, answerable only where
there are caregivers.

## Where this meets the safety work

H2 asks whether an untriaged alert can be lost. This asks whether a person has
stopped triaging. **They are the same population seen from two sides**: the
undecided alerts. H2 rations eviction to protect them; a product metric built on
`acknowledged + dismissed` would not count them at all, so the number would
improve as engagement fell.

That is the connection worth keeping, and it means the first metric v0.2 should
serve is the undecided count rather than the ratio the row asked for.
