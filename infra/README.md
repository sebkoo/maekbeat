# infra

The Maekbeat system as containers, C19 of [docs/ROADMAP.md](../docs/ROADMAP.md).
One command brings up the API server and the dashboard; the rest of this
directory is the set of proofs that what came up is this commit and works.

## Run it

```sh
BUILD_REVISION=$(git rev-parse HEAD) docker compose -f infra/compose.yaml up --build
```

The dashboard is then at <http://127.0.0.1:8080> and the API at
<http://127.0.0.1:3000>. Nothing else has to be installed — no pnpm, no Node,
no Xcode. `BUILD_REVISION` has no default and the build stops without it
([compose.yaml](compose.yaml)).

## What is here

| File                                             | What it is                                                                          |
| ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| [server.Dockerfile](server.Dockerfile)           | The API server image: pnpm deploy of production dependencies, non-root, healthcheck |
| [web.Dockerfile](web.Dockerfile)                 | The dashboard bundle behind unprivileged nginx — for the smoke, not for deployment  |
| [nginx.conf](nginx.conf)                         | Static serving, SPA fallback, and no proxy of any kind                              |
| [compose.yaml](compose.yaml)                     | The two services, their ports, and the CORS allowlist that names the web origin     |
| [verify-image.sh](verify-image.sh)               | Image proofs: non-root, red healthcheck, fast config failure, no debris, amd64      |
| [compose-smoke.sh](compose-smoke.sh)             | Stack proofs: build identity, golden replay, the C13 smoke, graceful stop           |
| [replay-golden.mjs](replay-golden.mjs)           | Streams `anomaly.ndjson` into the container and asserts the alert and the fan-out   |
| [rude-peer.mjs](rude-peer.mjs)                   | A WebSocket client that never answers a close frame                                 |
| [stalled-subscriber.mjs](stalled-subscriber.mjs) | A fan-out subscriber that attaches and then stops reading                           |
| [k6.Dockerfile](k6.Dockerfile)                   | The load generator as an image, so no k6 install is needed                          |
| [stalled.Dockerfile](stalled.Dockerfile)         | The stalled subscriber on the compose network, where it can create backpressure     |
| [k6/](k6)                                        | The two load profiles: ingest throughput, fan-out delivery latency                  |
| [load.sh](load.sh)                               | Runs the matrix and prints the numbers with the environment beside them             |

```sh
infra/verify-image.sh     # builds for both architectures, then asserts
infra/compose-smoke.sh    # brings the stack up, runs every stack proof, tears it down
infra/load.sh             # k6 on the compose network; reports, never gates
```

## Why there is no reverse proxy

A proxy in front of both services would mean one port instead of two and one
origin instead of two. It would also erase the origin crossing that
[apps/web/e2e/journey.spec.ts](../apps/web/e2e/journey.spec.ts) exists to prove:
C12 shipped a dashboard that could not reach its own API from a browser because
no test had ever crossed an origin. The recorded decision is
[docs/DECISIONS.md](../docs/DECISIONS.md) #21.

The consequence is that the two containers never talk to each other at all —
the browser talks to both. So no service name appears in any address, and
`VITE_API_BASE_URL` is a host address because it is compiled into JavaScript
that runs on the host's browser.

## Why the images run TypeScript

The workspace packages export `.ts` sources
([packages/protocol/package.json](../packages/protocol/package.json)), and
`pnpm start` has run the server through `tsx` since C5. So `tsx` is a
dependency of [@maekbeat/server](../apps/server/package.json) rather than a
devDependency — it is what the server needs in order to run, which is what the
word means. The alternative, bundling with esbuild, would produce a smaller
image and a second build path to keep in agreement with the one every test
uses.

## The base image, and where the 305 MB goes

The base is `node:22.22.0-alpine3.22`, named in the `NODE_IMAGE` build argument
at the top of [server.Dockerfile](server.Dockerfile) and used for both the build
stage and the runtime stage. Measured inside the built image, the arm64 server
image's 301 MB breaks down as roughly 118 MB of Node binary, 60 MB of the
server's production dependencies, and 19 MB of the npm the base ships and this
image never invokes — its `CMD` is `tsx`. So image-size work here is base-image
work, not dependency work.

Two smaller bases were considered and neither is taken in this commit. Dropping
the bundled npm from the runtime stage is a real 19 MB and is named here as an
untaken measurement rather than applied, because it changes the artifact and
this commit is about the build's package manager. A distroless Node image is
the larger saving and costs more than it looks: three of the nine proofs in
[verify-image.sh](verify-image.sh) run `docker run --entrypoint` with `sh`, `id`
and `sleep`, none of which exist there, so the move trades image bytes for
rewriting the checks that make the image trustworthy.

What is not a reason: native modules. The deployed tree contains no `.node`
addon at all, and esbuild — the one native binary in it, arriving under `tsx` —
ships as a static Go executable per architecture rather than per libc. A libc
change would not break this image, and saying otherwise would have been a
plausible-sounding claim with nothing behind it.

## Why the build is amd64 and this machine is not

The host here is arm64 and the deploy target is x86-64, which is the container
failure with the least warning attached: an image that runs perfectly on the
laptop cannot execute at all on the target. `docker build` on this machine
produces arm64 by default and says nothing about it, so
[verify-image.sh](verify-image.sh) asserts the built artifact's architecture and
then makes the amd64 image execute and report `process.arch`. The recorded
decision is [docs/DECISIONS.md](../docs/DECISIONS.md) #22.

`docker compose up` builds for the host, because the stack exists to be run and
emulating the deploy architecture for local use would cost speed for nothing.
The amd64 build is what `verify-image.sh` covers.

## Measurements

Measured 2026-08-06 on an Apple M3 Pro (12 cores, 36 GiB) running macOS 26.6,
under **Colima 0.10.3** (vm-type `vz`, Rosetta enabled, virtiofs) with 4 CPUs
and 7.7 GiB inside the VM — Docker client 29.7.2, server 29.5.2, compose 5.4.0,
buildx 0.36.1. The runtime is named because these numbers are not Docker
Desktop's: build times here are the VM's, not the host's.

| Build                                    | Time   |
| ---------------------------------------- | ------ |
| server, linux/amd64, cold                | 20.5 s |
| server, linux/amd64, warm, no change     | 0.5 s  |
| server, linux/amd64, after a source edit | 11.6 s |
| server, linux/arm64, cold                | 13.1 s |
| web, linux/amd64, cold                   | 11.7 s |

"Cold" is `--no-cache` after `docker builder prune -af`, with the `node` and
`nginx` base images already pulled; the base pull is not in these numbers.
"After a source edit" is the case a developer actually waits on — dependency
layers cached, `apps/server/src` re-copied. amd64 is slower than arm64 on this
host because `pnpm install` runs emulated.

| Image           | Unpacked | Layer content | Architecture |
| --------------- | -------- | ------------- | ------------ |
| maekbeat-server | 305 MB   | 68 MB         | amd64        |
| maekbeat-server | 301 MB   | 68 MB         | arm64        |
| maekbeat-web    | 84 MB    | 24 MB         | amd64        |

Two columns because they answer different questions **on this machine**, and
the qualifier is the correction: what those two commands report depends on which
image store the daemon runs, and the sentence that used to be here stated the
local behaviour as a general one.

Under the **containerd image store**, which is what Colima runs here
(`docker info` reports `driver-type: io.containerd.snapshotter.v1`),
`docker image inspect --format '{{.Size}}'` reports the content store — the
compressed blobs — and `docker image ls` reports the unpacked overlayfs
snapshots. So the two columns really are two questions, and the second really is
close to what a pull transfers.

Under the **classic image store**, which is what the `image` job's
`ubuntu-latest` runner uses, both commands report the sum of uncompressed layer
diffs and the distinction collapses: the same `verify-image.sh` run that
produced 305 / 68 here printed 207 MB in both columns in CI. Neither number
there is what a pull transfers.

Measured rather than assumed, with a control, because the first explanation
reached for was wrong. A freshly built amd64 image on this arm64 host reads
68.1 MB from `docker image ls` and 305 MB after it has been run once, while
`inspect .Size` stays at 68 MB throughout — a cross-platform build has no
snapshots until something makes it run under emulation. The control is a native
arm64 build, which reads 301 MB before it is ever run, because a native build is
unpacked as it is built. `docker save | wc -c` on the amd64 image is 68 MB,
which is the compressed side confirmed a second way.

The store-independent answer to "what a pull transfers" is the registry's, and
getting it takes one step more than it looks. The tag resolves to an OCI
**index**, not a manifest: `docker/build-push-action` attaches a SLSA provenance
attestation by default on a registry push, so the index lists the `linux/amd64`
image manifest beside an attestation manifest marked
`vnd.docker.reference.type: attestation-manifest`. Summing the index would fold
the attestation blob into the number, and a client pulling this tag fetches the
matching platform's manifest and its layers and never the attestation.

**The honest number is the layer sum of the platform manifest.** For `49185bf`
that is 68,070,567 bytes across six layers, the largest of them 51.6 MB. The
`publish` job resolves the index by platform and prints it on every publish, so
it is recomputed rather than copied out of this paragraph.

That figure and the 68 MB in the table above are both compressed-content
numbers and they agree to about two parts in ten thousand, which is as far as
the comparison is worth taking: the two images were built from different commits,
so a decomposition of the remaining bytes into config blob and revision string
would be arithmetic on two things that are not the same artifact.

## Load

```sh
infra/load.sh                 # the whole matrix
RUN_MS=5000 infra/load.sh     # a faster, noisier pass
```

k6 runs as a container on the compose network ([k6.Dockerfile](k6.Dockerfile),
scripts in [k6/](k6)), not as a host install, for the same reason the images
exist: anyone who clones this gets the load rig with no extra tooling. It does
not gate CI and it is not a capacity claim; the reason is recorded as
[docs/DECISIONS.md](../docs/DECISIONS.md) #24, and the deterministic half that
does gate CI is apps/server/src/load.test.ts and
apps/server/src/fanout-bound.test.ts.

**These numbers describe this laptop under this runtime. They are not the
system's capacity, nothing here extrapolates, and no number below says how many
devices this supports.**

Measured 2026-08-06 on an Apple M3 Pro (Mac15,7) running macOS 26.6, under
Colima with 4 CPUs and 7.7 GiB inside the VM — Docker server 29.5.2, k6 1.4.0,
arm64 images built for the host rather than the deploy target. Fifteen seconds
per run, one run each. Differences under about 1 ms are noise at this sample
size and are reported as such rather than rounded into a result.

| Profile                                    | Acked frames/s | Ack p95 | Fan-out delivery p95 | Server memory peak |
| ------------------------------------------ | -------------- | ------- | -------------------- | ------------------ |
| ingest, 16 devices over 8 sockets at 50 Hz | 742.0          | 6 ms    | —                    | 99 MiB             |
| fan-out, 8 devices at 50 Hz                | —              | —       | 1 ms (avg 377 µs)    | 87 MiB             |
| ingest, same profile, OTLP export on       | 743.6          | 7 ms    | —                    | 106 MiB            |
| fan-out, same profile, OTLP export on      | —              | —       | 1 ms (avg 370 µs)    | 108 MiB            |
| fan-out, with one stalled subscriber       | —              | —       | 1 ms (avg 387 µs)    | 96 MiB             |
| ingest, 32 devices at 12.5 Hz (~400/s)     | 385.7          | 7 ms    | —                    | 102 MiB            |
| ingest, 8 devices at 50 Hz (~400/s)        | 365.2          | 4 ms    | —                    | 102 MiB            |

**What OTLP export costs.** Nothing measurable in throughput (742.0 against
743.6 frames/s, which is noise) and nothing measurable in fan-out delivery.
What it costs is memory: about 7 MiB, consistently, for the batch queue and the
exporter. Ack p95 moves 6 ms to 7 ms, which is one bucket at this resolution
and is not a result. C18 proved tracing does not change what an alert says;
this says it does not change what an alert costs either, on this machine.

**What a stalled subscriber costs the healthy ones.** Not latency: delivery p95
is unchanged at 1 ms and throughput is unchanged, with a subscriber attached to
`k6-fanout-0` that reads nothing for the whole run. What it costs is memory —
peak 96 MiB against the 87 MiB baseline — and that is the growth
`STREAM_MAX_BUFFERED_BYTES` caps.

**Where the bound actually lands, which is not where the arithmetic says.**
256 KiB at 211 bytes a message is about 1240 frames, and a stalled subscriber
sails past that: its own kernel receive buffer holds several megabytes before
the server's write queue grows at all. Driving one device hard, the drop fires
after roughly 36 000 frames — `bufferedBytes: 262182, limit: 262144` in the
server log, 38 bytes over. So the bound protects against a subscriber that
stays behind, not against a brief stall, and `bufferedAmount` is the server's
own queue with the operating system's buffers in front of it. The drop itself
is pinned in apps/server/src/fanout-bound.test.ts, which can control both ends.

**Device count or frame rate.** At the same total throughput and the same eight
sockets, 32 devices at 12.5 Hz gives ack p95 7 ms and 8 devices at 50 Hz gives
4 ms. So the cost tracks device count rather than frame rate: each device
carries its own ring buffer, dedupe set and per-rule alert windows, and a frame
arriving on a device the server already has open is cheaper than the first
frame of a new one. Holding the socket count equal across the two runs is what
makes this readable — a first version varied it and the gap could have been
either cause.

The k6 thresholds (`ack_latency_ms p(95)<1000`, `frames_rejected count==0`,
`fanout_delivery_ms p(95)<1000`) are a smoke signal set far under the measured
floor, not a capacity gate: a run that cannot acknowledge a frame inside a
second, or that rejects one at all, is broken in a way worth failing on. They
bite — `ACK_P95_MS=0` makes k6 exit 99 with the threshold marked failed.

## Not here yet

No image is published to any registry and no CI job builds one — that is the
rest of the C19 row in [docs/ROADMAP.md](../docs/ROADMAP.md), along with
dashboards-as-code. Every proof above has been run locally and none has run in
CI.

The AWS stack now exists as code in [cdk/](cdk): `cdk synth` produces a
CloudFormation template and a suite asserts against it with no credentials.
It has never been applied to an account. What it corresponds to, resource by
resource, and what it deliberately leaves out are in [cdk/README.md](cdk/README.md).

The load numbers do not cover the whole of either latency budget in
[docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md), and the budgets keep the word
"target" until they do. What is measured is the server's leg — ingest stamp to
fan-out delivery. Frame capture to dashboard paint additionally spans a device,
a phone and a browser render, and notification dispatch has no span in this
server at all.
