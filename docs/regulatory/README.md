# Regulatory posture

**This project is not a medical device. What follows applies the structure the
medical-device lifecycle standards ask for to an educational codebase, to show
the practice rather than to claim conformance.**

Nothing here has been submitted to a regulator, audited, reviewed by a competent
authority, or validated with users. There is no manufacturer, no quality system,
no device, and no patient. Every vital in this repository comes from
`packages/vitals-sim`, and [../../DISCLAIMER.md](../../DISCLAIMER.md) is the
standing statement of that.

Writing "this project follows IEC 62304" would be false, and a medical-device
engineer who read it would be right to discount everything else in this
repository — including the parts that are real. So the sentence above is the
first one, and the rest of this directory is written to be worth reading given
it.

## What is here

- [hazard-analysis.md](hazard-analysis.md) — eight hazards, each populated from a
  defect this project actually had, each citing the test that demonstrates its
  control.
- `scripts/check-hazard-tests.sh` — the guard that fails the build when one of
  those citations stops resolving. Wired into the CI hygiene job.
- [lifecycle-map.md](lifecycle-map.md) — which of this repository's practices
  correspond to which lifecycle process, and which processes have nothing here
  at all. Five of its fourteen rows read absent.
- [soup-inventory.md](soup-inventory.md) — every dependency this project did not
  write, in five classes, recorded by identity and role and deliberately not by
  version.
- `scripts/check-soup-inventory.sh` — the guard that diffs that document against
  the manifests in both directions. Wired into the CI hygiene job.
- [risk-register.md](risk-register.md) — ten rows scored for severity and an
  ordinal fault reachability against criteria stated before the table. Probability
  of harm reads `unestimated` in every row, so no risk score is computed. One
  row comes out `not demonstrated`, and `scripts/check-hazard-tests.sh` reads
  this file too as of C21, cross-checking its hazard IDs and labels against the
  hazard analysis in both directions.

The security documents live next door in [../security/](../security/) and are
governed by this file: the data-flow diagram since C22, and the threat model
that consumes it. They are a different argument — where an attacker could
stand rather than how a device fails — and they are kept apart for that
reason rather than by accident.

## The method: from the codebase upward

A regulatory document written from the standard downward produces a table of
requirements with a repository nervously mapped onto it. This is written the
other way: start from what this codebase already does, and name it.

Configuration management is git with linear history and enforced commit hygiene
(`.githooks/`, `scripts/check-commit-hygiene.sh`). Problem resolution records are
[../ai/mutation-log.md](../ai/mutation-log.md) and
[../DECISIONS.md](../DECISIONS.md). The risk half of that mapping is the hazard
analysis, and it has an advantage the rest does not: the mitigations already
exist and are already proven, because each one was written to fix something that
broke.

## Intended use, stated because it is the operative fact

Under 21 U.S.C. 321(h) — verified 2026-08-07 against the U.S. Code at
uscode.house.gov — whether an article is a "device" turns on what it is
_intended_ for: diagnosis, cure, mitigation, treatment, or prevention of disease.
Intended use is not a disclaimer bolted on afterward; it is the thing the
definition operates on.

The intended use of Maekbeat is to demonstrate engineering practice in a
portfolio. It is intended for reading, running locally, and evaluation as
software craft. It is not intended for the diagnosis, monitoring, or treatment of
any condition in any person, it makes no seizure-detection claim, and the alert
rules in `apps/server/src/alerts.ts` are labeled in the source as demo heuristics
rather than clinical rules.

## Safety classification — an argument, not a claim

**No classification has been made, because there is no device and no
manufacturer.** What follows is the argument someone would have to make, and what
would decide it.

First, a distinction that gets collapsed and should not be. FDA device class
(I, II, III) is a regulatory pathway assigned to a device type by risk. IEC 62304
software safety class (A, B, C) is a property of a software system that sets how
much lifecycle rigour its documentation needs. They are different axes, and a
Class II device can contain Class C software.

### What the real category looks like

A device doing what Maekbeat pretends to do is a known, classified thing. Under
**21 CFR 882.1580**, a "non-EEG physiological signal based seizure monitoring
system" is a noninvasive **prescription** device, **Class II**, product code
**POS**, neurology (verified 2026-08-07 against the eCFR and the openFDA device
classification endpoint).

It is not a thought experiment: Empatica's Embrace cleared under that product
code with a decision date of **2018-01-26** (K172935), and again on **2018-12-20**
(K181861), both "substantially equivalent", both neurology (verified 2026-08-07
against the openFDA 510(k) endpoint). The README's claim that this is a real
regulated product category is carried by those two records.

### The software safety class, if there were one

The argument for the highest class: the software's job is to raise an alert, the
foreseeable consequence of not raising one is an unattended seizure, and seizures
during sleep are where the mortality in this population concentrates. If a missed
alert can precede a death, the harm is death or serious injury, and that is the
top class.

The argument against: the software does not cause the seizure, and a monitor is
almost always adjunct to a caregiver rather than a replacement for one. What
decides it is not the code — it is the intended use statement, the claimed
population, whether the labeling positions the device as standalone or adjunct,
and the risk acceptability criteria set before the analysis. None of those exist
here.

And the argument that ends it: this is a teaching artifact over synthetic data
with no user, so no harm reaches anyone and the classification question is not
live. Both arguments are written out because _choosing between them is the
skill_, and a repository that asserted one without the other would be showing
the answer instead of the work.

## Gaps — what a real submission would need that this has none of

The most credible section, and the one to read first. Several items are the
literal special controls of 21 CFR 882.1580, so they are the actual list for this
device category rather than a generic one.

- **Clinical performance testing** in the intended population, reporting positive
  percent agreement and false alarm rate. This repository's false-alarm baseline
  (hazard H7) is measured against a simulator it also wrote, which is a closed
  loop and not evidence.
- **Usability validation with representative users.** No caregiver has ever seen
  this. Hazard H8 controls what a notification may say; nothing has tested what a
  frightened person reads it as at 03:00.
- **A design history file**, and design controls under a quality system.
- **A risk management file** under that quality system, with risk acceptability
  criteria **fixed in advance**, probability estimates, and an overall residual
  risk evaluation. [risk-register.md](risk-register.md) adds severity and an
  ordinal reachability at C21 and closes none of these three: its criteria were
  written after the hazards were known and it names that as a defect in its own
  method, probability of harm is carried as `unestimated` rather than
  estimated, and with only one of the two probabilities there is no risk score
  to evaluate overall.
- **Verification and validation planning as artifacts separate from the tests.**
  There are many suites; there is no V&V plan they execute.
- **Biocompatibility, and electrical, thermal, mechanical and EMC testing.**
  There is no hardware — `packages/vitals-sim` is where a sensor would be.
- **Training materials for intended users**, and labeling for both health-care
  professionals and patients/caregivers, including a clinical performance summary
  and threshold-setting guidance.
- **A manufacturer**: establishment registration, device listing, UDI, complaint
  handling, CAPA, and medical device reporting. Since **2026-02-02** the quality
  system requirement in the U.S. is the QMSR (89 FR 7496, published 2024-02-02,
  effective 2026-02-02; technical amendments at 90 FR 55978), which amended
  21 CFR Part 820 to incorporate ISO 13485:2016 (verified 2026-08-07 against the
  Federal Register API).
- **Software documentation at the level FDA asks for in a premarket submission**,
  per "Content of Premarket Submissions for Device Software Functions" (Docket
  FDA-2021-D-0775; availability notice 88 FR 38870, 2023-06-14).
- **SOUP analysis beyond an inventory.** The inventory and the lifecycle map
  landed at C21, and both are narrower than this item was. No published anomaly
  list has been reviewed for a single dependency, no functional or performance
  requirement is stated for any of them, and the 340 package versions
  `pnpm-lock.yaml` resolves are outside the analysis entirely
  ([soup-inventory.md](soup-inventory.md)).
- **Post-market surveillance.** `SECURITY.md` describes coordinated disclosure
  for a repository, which is not the same obligation.

Writing this list changed one thing about the engineering. The gap that turned
out to matter most is not on it, because it is not a paperwork gap: **nothing in
this system alarms on the absence of data.** A device that stops sending is
visible as a `lastReceivedAtMs` field on `GET /devices` and nothing else, so the
quietest failure in a monitoring system is the one it does not report. That is
hazard H4's residual risk and it is a real defect, found by writing the document
rather than by testing the code.

## Citations I could not verify

Recorded because a confident wrong clause number is the tell that someone is
bluffing, and describing a requirement accurately beats citing it precisely and
wrongly.

- **IEC 62304.** The standard's identity is verified: IEC 62304:2006+AMD1:2015,
  edition 1.1, "Medical device software — Software life cycle processes",
  published 2015-06-26 (publisher's own catalogue record, checked 2026-08-07). Its
  **text is paywalled at CHF 1,150 and I have not read it.** So no clause number
  appears anywhere in this directory — not for the safety classification clause,
  not for the lifecycle processes. Where a requirement is described, it is
  described in my own words from secondary sources, and it should be checked
  against the standard before anyone relies on it.
- **ISO 14971:2019.** iso.org returned HTTP 403 to both the catalogue page and the
  Online Browsing Platform on 2026-08-07, so I verified neither the definitions
  nor the clause structure. The terms in
  [hazard-analysis.md](hazard-analysis.md) are stated in my own words and marked
  as such there.
- **The FDA software guidance.** I verified the availability notice — title,
  docket, Federal Register citation and date — through the Federal Register API,
  **not the guidance document itself**; the FDA's own web host returned 404 to
  every fetch on 2026-08-07. Its Basic and Enhanced Documentation Levels are named in the
  gap list above from secondary reading, and the criteria that separate them are
  deliberately not restated here.

Everything else cited in this directory was read at its primary source on
2026-08-07: the U.S. Code, the eCFR, the Federal Register API, and the openFDA
device endpoints. Dates are recorded as checks rather than as standing verdicts,
because external state moves and this file does not.
