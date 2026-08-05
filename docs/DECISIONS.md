# Decisions

This file is the interview-speed summary layer on top of the ADRs in docs/adr/. It grows one entry per phase, and entries link to a full ADR where one exists — today that is only ADR-0001 (docs/adr/0001-stack-and-name.md). Each entry states the decision, the alternatives, the trade-offs, and why it was made now.

**1. Fastify (see ADR-0001)**  
Decision: Fastify on Node 22 for the ingest and REST server in apps/server.  
Alternatives: Express, NestJS.  
Trade-offs: Smaller middleware ecosystem than Express and fewer batteries than Nest, in exchange for first-class JSON-schema validation, @fastify/swagger OpenAPI generation, and lower per-request overhead.  
Why now: C5–C7 need schema-validated WebSocket and REST routes, and choosing the framework at C0 keeps the path to a runnable C5 unblocked.

**2. WebSocket ingest**  
Decision: WebSocket for phone-to-server frame ingest and server-to-dashboard push.  
Alternatives: MQTT, server-sent events, HTTP polling.  
Trade-offs: MQTT suits constrained devices but adds a broker to operate; SSE is one-way; polling burns phone battery and works against the 2 s frame-to-dashboard target.  
Why now: The C6 ingest path and the C11 live chart both need bidirectional streaming, and one protocol serves both ends.

**3. BLE simulator before hardware**  
Decision: A simulator transport driven by packages/vitals-sim lands (C2, C14) before any CoreBluetooth code (C15).  
Alternatives: Buying a development wearable first; mocking only at the server boundary.  
Trade-offs: A simulator hides real radio behavior — pairing, RSSI drops, mid-stream disconnects — which the C15 state machine must still handle explicitly.  
Why now: It keeps the server path runnable without hardware from C5 on, and CI can drive the simulator deterministically.

**4. Synthetic data only**  
Decision: Every vital sign in this repo comes from packages/vitals-sim; no human data enters the project.  
Alternatives: Public physiological datasets such as PhysioNet; recorded personal data from a consumer wearable.  
Trade-offs: Synthetic traces lack real-world noise and sensor artifacts, so alert-engine results do not generalize to clinical signals.  
Why now: An educational demo has no IRB, no consent pipeline, and no HIPAA posture, and synthetic data keeps the not-a-medical-device positioning honest.

**5. AWS CDK (see ADR-0001)**  
Decision: AWS CDK in TypeScript for the infra/ stacks.  
Alternatives: Terraform, AWS SAM, raw CloudFormation.  
Trade-offs: CDK ties the repo to AWS and CloudFormation semantics, where Terraform would stay portable across clouds.  
Why now: The target stack (S3, Lambda, ECR, ECS) is AWS-specific already, CDK stays inside the monorepo's TypeScript toolchain, and `cdk synth` is checkable in CI at C19.

**6. ECS over EKS**  
Decision: ECS on EC2 as the container runtime for apps/server.  
Alternatives: EKS (Kubernetes), plain EC2 with systemd units.  
Trade-offs: Less portability and a thinner ecosystem than Kubernetes, in exchange for less operational overhead and fewer moving parts.  
Why now: This system prioritizes reliability and iteration speed, and a single service with one task definition does not need a Kubernetes control plane.

**7. pnpm monorepo (see ADR-0001)**  
Decision: One pnpm workspace holding apps/, packages/, and infra/.  
Alternatives: A polyrepo per app; npm or yarn workspaces.  
Trade-offs: One repo couples CI time and release cadence across apps, while pnpm's strict node_modules layout surfaces phantom dependencies early.  
Why now: The packages/protocol schemas must stay in lockstep with server and web from C1 on, and a single lockfile makes that change atomic.

**8. Swift native (see ADR-0001)**  
Decision: Native Swift + SwiftUI for the iOS app in apps/ios.  
Alternatives: React Native (the JD lists both), Flutter.  
Trade-offs: No UI code shared with apps/web, and a second language in the repo.  
Why now: BLE background work is platform-specific — CoreBluetooth state restoration and background modes — and native is my strongest lane.

**9. Single harness commit C0**  
Decision: Single harness commit C0.  
Alternatives: Splitting config, docs, and CI into separate commits.  
Trade-offs: One heavier first diff to review, instead of small reviewable steps.  
Why now: Hooks, CI, and settings implement one rule together; they only work as a whole, and packing them into C0 keeps every later commit pure feature evidence.

**10. Irwin–Hall noise over Box–Muller**  
Decision: vitals-sim approximates gaussian noise as a rescaled sum of three uniforms (packages/vitals-sim/src/prng.ts).  
Alternatives: Box–Muller or ziggurat transforms; a seeded normal-distribution library.  
Trade-offs: A coarser normal — hard ±3 bound, blunter tails — in exchange for arithmetic that is bit-exact under IEEE 754, where Box–Muller's Math.log/Math.cos may round differently per engine.  
Why now: C3 pins byte-identical golden fixtures (packages/vitals-sim/golden/), and that only holds cross-engine if generation never touches engine-dependent math.
