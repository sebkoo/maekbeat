# Roadmap

Maekbeat ships as a sequence of atomic, one-feature commits, C0 through C23. This file is the plan of record; each commit number maps to one reviewable diff on `main`.

## Ordering note

Commits are ordered by dependency, not by calendar, and independent commits may interleave. In particular, C3 (golden tests) and C4 (ARCHITECTURE.md) must never block the runnable-pipeline path to C5. The 48–72 hour pace target for reaching C5 binds the runnable path, not the documentation commits.

## Phase 1 — Foundations

- C0 — chore: repo bootstrap (this commit — shipped). Config, hooks, CI, and the docs set including this file.

## Phase 2 — Contract & simulator (in progress)

- C1 — feat(protocol): shared types + zod schemas in packages/protocol; workspace test + typecheck CI job (shipped).
- C2 — feat(vitals-sim): synthetic HR/SpO2/respiration/motion generator with rest, motion, and anomaly scenarios (shipped).
- C3 — test(vitals-sim): golden-file scenario tests.
- C4 — docs: ARCHITECTURE.md with mermaid diagrams and latency budgets (frame→dashboard under 2 s, alert fan-out under 5 s — all labeled targets until C19 measures them). Scaling chain: BLE device (sim) → iOS gateway → WebSocket ingestion → event queue (in-process ring buffer in dev; SQS in the target architecture) → stream processor (alert engine) → storage (S3 raw archive; time-series considerations) → dashboard fan-out + caregiver notification. Each stage must answer for five failure modes: device disconnect, duplicate packets, delayed or out-of-order packets, clock drift, and offline buffering with replay.

## Phase 3 — Server (planned)

- C5 — feat(server): Fastify skeleton, /healthz, OpenAPI, CI wiring.
- C6 — feat(server): WebSocket ingest + ring-buffer store + REST reads. Decides the dedupe scope for device reboots (`seq` reset to 0): session/boot id vs treating `seq` regression as a new session — caveat recorded in packages/protocol/README.md.
- C7 — feat(server): sliding-window alert engine.
- C8 — test(server): unit + integration suite.
- C9 — ci: coverage gate; the coverage badge unlocks here (badge #6).

## Phase 4 — Web (planned)

- C10 — feat(web): React scaffold + design tokens.
- C11 — feat(web): live vitals chart over WebSocket.
- C12 — feat(web): event timeline + acknowledgement + WCAG 2.2 AA pass. Ships docs/demo/preview.gif and the README "Demo" section (refreshed at C23).
- C13 — test(web): vitest + Testing Library + Playwright smoke.

## Phase 5 — iOS (planned)

- C14 — feat(ios): SwiftUI scaffold (Swift 5.10+) + SwiftLint + simulator transport.
- C15 — feat(ios): CoreBluetooth central + background streaming + live screen. Documents the BLE state machine (disconnected → connecting → connected → streaming → recovering) in apps/ios/README.
- C16 — feat(ios): caregiver notifications.
- C17 — test(ios): XCTest unit + snapshot tests.

## Phase 6 — Infra & operations (planned)

- C18 — feat(infra): Dockerfile + compose + CI image build + OpenTelemetry wiring + dashboards-as-code (dashboard definitions checked into infra/).
- C19 — feat(infra): CDK stacks (S3, Lambda fan-out, ECR, ECS/EC2) with synth-in-CI, plus a k6 load profile. Measured numbers replace "target" language from here on.

## Phase 7 — Depth (planned)

- C20 — docs(regulatory): intended-use statement + IEC 62304 class rationale tied to the real architecture + SOUP inventory.
- C21 — docs(regulatory): risk register seeded from the C4 failure modes plus alarm-fatigue and battery rows.
- C22 — docs(security): STRIDE threat model + data-flow diagram + append-only audit log + CycloneDX SBOM in release CI.

Defensibility rule for C20 and C21: every claim cites a repo path or is marked "planned — C(n)". No guidance or standard is cited without a demonstrating artifact in the repo.

## Phase 8 — Release (planned)

- C23 — release: v0.1.0. Refreshed demo GIF, a quickstart that runs in 30 seconds or less, changelog, release badge (badge #7 — final; the lifetime badge cap is 7), issue templates + labels (good first issue, help wanted, architecture discussion), and seeded good-first-issues.
- C23 also defines the v0.2 product loop: instrument alert usefulness (acknowledged vs dismissed), false-alarm rate, and retention signals. For a health app the question is not "does it work" but "does it keep being used".

## JD traceability

| JD line                                              | Artifact                                                    | Commit              |
| ---------------------------------------------------- | ----------------------------------------------------------- | ------------------- |
| Full-stack connected platforms                       | device→cloud→web pipeline across apps/ and packages/        | C1–C19              |
| React responsive UX                                  | apps/web dashboard, WCAG 2.2 AA pass                        | C10–C13             |
| Swift iOS                                            | apps/ios SwiftUI app                                        | C14–C17             |
| Backend REST APIs                                    | apps/server REST routes + OpenAPI                           | C5–C6               |
| AWS EC2/S3/Lambda/ECR                                | infra/ CDK stacks, synth-in-CI                              | C19                 |
| Device→phone→web pipeline                            | end-to-end demo GIF at docs/demo/preview.gif                | C12, C15            |
| Scale target + load test                             | k6 profile with measured numbers                            | C19                 |
| Testing, validation, documentation                   | golden tests, server suite, coverage gate, web + iOS tests  | C3, C8–C9, C13, C17 |
| Architecture, performance, security                  | ARCHITECTURE.md budgets, k6 measurements, STRIDE model      | C4, C19, C22        |
| Written communication                                | docs/adr/, PR template, commit discipline                   | C0                  |
| DevOps (observability, Docker, CI/CD)                | Dockerfile, compose, OpenTelemetry, CI pipelines            | C0, C18             |
| APIs & connected-device ecosystems                   | BLE GATT doc + BLE lifecycle state machine                  | C15                 |
| FDA-regulated literacy                               | intended-use + IEC 62304 rationale + SOUP inventory         | C20                 |
| Cybersecurity SOPs + post-market surveillance mirror | SECURITY.md CVD, Dependabot, SBOM at release, patch cadence | C0, C22             |
| BLE, sensors, IoT                                    | vitals-sim transport + CoreBluetooth central                | C2, C14–C15         |
| Real-time pipelines                                  | WebSocket ingest, ring buffer, alert engine                 | C6–C7               |
| Product mindset                                      | v0.2 loop definition + post-release track                   | C23                 |

## Post-release track (no commit numbers)

Growth here means trust signals, not star counts. The targets are README conversion (a visitor understands and believes the repo in under a minute), a current demo GIF, answered issues, and small honest commits.

Launch distribution follows each channel's norms: Show HN on a Tuesday–Thursday morning ET without vote soliciting, stack subreddits per each sub's rules, a dev.to build-log series, and awesome-list PRs after the 30-day rule.

Product explorations, in no fixed order:

- ASO sheet for a future App Store listing.
- StoreKit 2 IAP exploration: premium reports, caregiver circles.
- GitHub Sponsors.
- AGENTS.md, CODE_OF_CONDUCT, and an OpenSSF Scorecard run.

Monetization follows a real free core; it never precedes it. Any consumer-facing release with real caregivers would need a regulated posture that this educational repo (see DISCLAIMER.md) does not claim; until then these explorations stay design exercises.
