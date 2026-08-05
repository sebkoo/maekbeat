# ADR-0001: Stack and name

- Status: Accepted
- Date: 2026-08-04

## Context

The C0 bootstrap needs two decisions locked before any application code lands: the project name and the technology stack. Both were locked in two dated passes: adversarial name research conducted 2026-08-04 to 2026-08-05 (dates as recorded in the author's research notes), and an independent bootstrap-day re-check performed 2026-08-04 (evening EDT, at execution).

## Name decision: Maekbeat

Maekbeat (맥비트, pronounced "Mac-beat") joins _maek_ (맥), the Korean word for one's pulse, with "beat". It was chosen after adversarial collision checks across fourteen candidates in two rounds.

Scope per check, applied to every candidate: web search, GitHub, npm, PyPI, USPTO/Justia, Apple App Store, Google Play, Korean-language web, RDAP.

### Round 1 — initial ten candidates

Nine of the initial ten were rejected on collisions. Examples:

- Auralert — an existing Duke University seizure-prediction wearable of the same name.
- VitalArc — a live USPTO application in health/wellness, plus a same-name HealthKit iOS repo.

Maekbeat was the survivor of round 1.

### Round 2 — four challengers, re-tested later the same day

All four were rejected:

- PulseArc — live PULSEARC registration, an active pulsearc.io LLC, and the homophone OSS game Pulsarc.
- VitalLoop — live same-name caregiver health-records product at getvitalloop.com, with a physician network and a smart ring.
- BioRelay — a same-field health-data-relay company with a same-name USPTO mark in its history.
- BeatBridge — an actively maintained same-name OSS app on F-Droid/GitHub, plus a same-name software company.

## Bootstrap-day re-check (2026-08-04, evening EDT)

Recorded as a dated procedure, not a timeless verdict:

- `npm view maekbeat` → E404 Not Found at check time.
- `gh api "search/repositories?q=maekbeat"` → total_count 0 at check time.
- Web search for "maekbeat" → no exact-match results at check time; only unrelated, similarly-spelled music acts.

## Limitations

This is a point-in-time snapshot; registries change daily. KIPRIS and Naver were not directly queried. This is not a legal clearance opinion.

## Re-check procedure

For any future rename decision: run the three commands/searches above, date the run, and record the results in this file.

## Fallbacks if a future collision appears

1. VitalBeacon — known adjacencies: a same-name AI LLC, a parked .com, and a crowded Vital- prefix field.
2. Alrimo — known adjacencies: the 알리모 school-notifier app, and Nintendo's Alarmo name adjacency.

## Stack decision (summary)

- pnpm monorepo holding apps/, packages/, and infra/.
- Fastify on Node 22 for WebSocket ingest and REST.
- React 19 + Vite + TypeScript for the caregiver dashboard.
- Native Swift + SwiftUI for iOS.
- AWS CDK targeting S3, Lambda, ECR, and ECS/EC2.

Per-decision alternatives and trade-offs are recorded in docs/DECISIONS.md; this ADR records that the set was accepted together on 2026-08-04.
