# Roadmap

Maekbeat ships as a sequence of atomic, one-feature commits, C0 through C23. This file is the plan of record; each commit number maps to one reviewable diff on `main`.

## Ordering note

Commits are ordered by dependency, not by calendar, and independent commits may interleave. In particular, C3 (golden tests) and C4 (ARCHITECTURE.md) must never block the runnable-server path to C5; the pipeline itself becomes runnable at C6. The 48–72 hour pace target for reaching C5 binds that runnable path, not the documentation commits.

## Phase 1 — Foundations

- C0 — chore: repo bootstrap (this commit — shipped). Config, hooks, CI, and the docs set including this file.

## Phase 2 — Contract & simulator (complete)

- C1 — feat(protocol): shared types + zod schemas in packages/protocol — shipped [63be391](https://github.com/sebkoo/maekbeat/commit/63be391): strict vitals frame schema with transport-validity bounds, the `frameKey` dedupe identity, and the workspace test + typecheck CI job pulled forward from the C5 plan.
- C2 — feat(vitals-sim): synthetic HR/SpO2/respiration/motion generator with rest, motion, and anomaly scenarios — shipped [01b9007](https://github.com/sebkoo/maekbeat/commit/01b9007): Irwin–Hall noise for cross-engine byte determinism, HR read noise coupled to motion amplitude, and an enforced spo2LagTicks ≥ 1 desaturation-lag invariant.
- C3 — test(vitals-sim): golden-file scenario tests — shipped [6ba9c91](https://github.com/sebkoo/maekbeat/commit/6ba9c91): NDJSON fixtures regenerable byte-for-byte from their own headers, four gates per fixture, and golden:update running the full suite with its pass-by-construction byte gates documented.
- C4 — docs: ARCHITECTURE.md with mermaid diagrams and latency budgets (frame→dashboard under 2 s, alert fan-out under 5 s — all labeled targets until C19 measures them). Scaling chain: BLE device (sim) → iOS gateway → WebSocket ingestion → event queue (in-process ring buffer in dev; SQS in the target architecture) → stream processor (alert engine) → storage (S3 raw archive; time-series considerations) → dashboard fan-out + caregiver notification. Each stage must answer for five failure modes: device disconnect, duplicate packets, delayed or out-of-order packets, clock drift, and offline buffering with replay. — shipped [aa568a5](https://github.com/sebkoo/maekbeat/commit/aa568a5): failure-mode ownership table code-backed to packages/protocol, the clock-drift policy fixed (receivedAtMs − capturedAtMs delta, alert windows on server receive time), and per-budget C19 measurement methods.

## Phase 3 — Server (complete)

- C5 — feat(server): Fastify skeleton, /healthz, OpenAPI, CI wiring — shipped [d352705](https://github.com/sebkoo/maekbeat/commit/d352705): typed env config (zod defaults + .env.example), pino logging, central error handler masking 5xx outside development, graceful SIGTERM/SIGINT shutdown, and an OpenAPI document then listing exactly /healthz; the existing pnpm -r CI job picks the package up unchanged.
- C6 — feat(server): WebSocket ingest + ring-buffer store + REST reads — shipped [0170638](https://github.com/sebkoo/maekbeat/commit/0170638): every inbound frame validated against vitalsFrameSchema (structured reject, socket stays open), server-side receivedAtMs stamped and stored per frame, the reboot-dedupe decision resolved as session epochs on seq regression past a 64-frame reorder window (docs/DECISIONS.md #11), bounded per-device ring buffer read-ordered by (capturedAtMs, seq), /devices + per-device frame reads in the OpenAPI doc, the first runnable pipeline (apps/server/scripts/demo.ts), and Conventional Commit enforcement in .githooks/commit-msg + CI.
- C7 — feat(server): sliding-window alert engine — shipped [2a1d563](https://github.com/sebkoo/maekbeat/commit/2a1d563): frame-driven and clockless (windows advance on injected receivedAtMs — drift shifts charts, never alerts), lifecycle raised → ongoing → resolved with structural hysteresis (enter ≠ exit thresholds, N/M sustained) and a re-fire cooldown that delays persistent breaches rather than silencing them, alertEventSchema added to packages/protocol as the evolution policy's first additive exercise (v stays 1), GET /devices/:id/alerts with raised/resolved/suppressed counters, golden-pinned transition ticks against all three sim scenarios (rest and motion: zero alerts), and demo-time alert output in apps/server/scripts/demo.ts; thresholds are demo heuristics, not clinical rules.
- C8 — test(server): unit + integration suite — shipped [2356a62](https://github.com/sebkoo/maekbeat/commit/2356a62): the C6 seq-pattern attacks and C7 clock-regression fuzz promoted into permanent seeded property suites (a docs/DECISIONS.md #11 oracle checked on every ingest; a monotonicized-clock equivalence check over 10 fuzz seeds), a full-journey integration test (vitals-sim → real WS client → ingest → engine → REST with DEFAULT_ALERT_RULES unscaled), multi-device isolation over parallel interleaved sockets, failure paths (mid-stream drop with same-epoch resume, malformed burst continuation, post-1009 state intactness), the 10-seed rest/motion silence sweep made permanent, and a test map in apps/server/README.md; coverage measured locally at 92.9% statements / 94.6% branches (vitest v8 provider, src/ minus tests, main.ts included) — the C9 gate turns that floor into a ratchet.
- C9 — ci: coverage gate — shipped: per-package vitest thresholds set just under the measured floors (statements/branches/functions/lines: server 90/92/89/90 against measured 92.88/94.64/91.66/92.79; vitals-sim 96/95/97/96 against 98.57/97.36/100/98.52; protocol 95 across against 100 across), enforced by the existing CI tests job running pnpm -r test:coverage once — no duplicate test invocation — plus a guard step that fails CI when any workspace package lacks the test:coverage script (pnpm -r silently skips script-less packages), with the ratchet policy recorded in CLAUDE.md (thresholds move only up; no new exclusions, narrowed globs, or CLI-flag overrides), lcov uploads to Codecov with fail_ci_if_error so a dead upload breaks the build instead of leaving the badge stale, and badge #6 unlocked: the README coverage badge renders the last uploaded number, never a static percentage; sha chip backfills at C10. The gate then caught its own upload leg at C10: GitHub withholds Actions secrets from fork pull requests and routes Dependabot runs to a separate secret store, so `fail_ci_if_error` would have failed healthy contributions the moment C23 opens the repo — the upload step is now conditioned on the token being reachable, while the vitest thresholds, which are the actual gate, still run on every trigger.

## Phase 4 — Web (in progress)

- C10 — feat(web): React scaffold + design tokens — shipped [6e9c81c](https://github.com/sebkoo/maekbeat/commit/6e9c81c): Vite + React 19 + TypeScript in apps/web, joining the coverage gate in the scaffold commit (thresholds 92/91/95/93 under a measured 94.81/93.87/97.72/95.04, with the untested browser entry src/main.tsx left in the denominator per the apps/server precedent); design tokens in one file — one accent, and a dark theme that redefines exactly the colour tokens so the shape of the interface never moves; an alert-state palette encoded three ways — word, mark glyph, border style — before hue is asked to carry anything, fixed now because the C12 timeline renders the same three states (docs/DECISIONS.md #12); the not-a-medical-device line rendered in the header itself, not only in DISCLAIMER.md; loading, empty, error, and disconnected as designed states behind one async union, plus an error boundary that keeps the shell and that line on screen when a component throws; a typed client over the five-route server surface with the fetch call isolated behind an injected `fetchImpl` — a source scan fails the build if anything else opens a connection — and a context seam through which C11 supplies the streaming transport; and a token contract test that fails the build on a colour literal outside tokens.css, a dangling `var(--mb-*)`, a token no file reads, or a text pair under 4.5:1 in either theme. Also carries the Codecov upload guard recorded in the C9 line above.
- C11 — feat(web): live vitals chart over WebSocket — shipped: the fan-out leg of docs/ARCHITECTURE.md stage 7 built end to end, since a live dashboard cannot exist without it — an in-process per-device publisher and `GET /devices/:deviceId/stream` in apps/server (frames published after the engine judges them, so no dashboard sees an alert before the frame that raised it; deduped frames never reach it), `streamMessageSchema` + `storedVitalsFrameSchema` added to packages/protocol as the second additive exercise (`v` stays 1), and in apps/web the `subscribe` member the C10 seam was built for: an injectable socket with capped exponential backoff (500 ms doubling to 15 s), four connection states on screen, and a REST back-fill on every re-open instead of a silent resume — bounded, honestly, by the 1000 frames one read can return against the server's 1024-frame ring. Two rules the tests pin rather than the prose: a hole in coverage breaks the line and is shaded, never interpolated across (gaps are found before decimation, so thinning cannot bridge one), and decimation is min/max envelope per bucket, never stride — the suite asserts a one-sample SpO2 trough survives and that a stride sampler over the same series loses it. The x axis is `capturedAtMs` with the consequence stated on the page: a drifting device slides its trace against receive-time alert marks, each anchored to the frame nearest its raise and, if it was raised outside the window the chart holds, not drawn at all but counted. Two small multiples rather than a dual axis, no animation on the newest sample, and apps/web thresholds ratcheted up to 95/91/96/96 against a measured 96.95/92.10/98.19/98.46 — branches measured lower than C10's 93.87% and its threshold therefore held at 91 rather than following it down.
- C12 — feat(web): event timeline + acknowledgement + WCAG 2.2 AA pass. Ships docs/demo/preview.gif and the README "Demo" section (refreshed at C23).
- C13 — test(web): vitest + Testing Library + Playwright smoke. The vitest + Testing Library harness landed early at C10, since the coverage gate requires a suite in the scaffold commit; C13 adds the Playwright smoke and the deeper component suites.

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
