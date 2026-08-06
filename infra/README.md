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

| File                                   | What it is                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| [server.Dockerfile](server.Dockerfile) | The API server image: pnpm deploy of production dependencies, non-root, healthcheck |
| [web.Dockerfile](web.Dockerfile)       | The dashboard bundle behind unprivileged nginx — for the smoke, not for deployment  |
| [nginx.conf](nginx.conf)               | Static serving, SPA fallback, and no proxy of any kind                              |
| [compose.yaml](compose.yaml)           | The two services, their ports, and the CORS allowlist that names the web origin     |
| [verify-image.sh](verify-image.sh)     | Image proofs: non-root, red healthcheck, fast config failure, no debris, amd64      |
| [compose-smoke.sh](compose-smoke.sh)   | Stack proofs: build identity, golden replay, the C13 smoke, graceful stop           |
| [replay-golden.mjs](replay-golden.mjs) | Streams `anomaly.ndjson` into the container and asserts the alert and the fan-out   |
| [rude-peer.mjs](rude-peer.mjs)         | A WebSocket client that never answers a close frame                                 |

```sh
infra/verify-image.sh     # builds for both architectures, then asserts
infra/compose-smoke.sh    # brings the stack up, runs every stack proof, tears it down
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

Two columns because they answer different questions: unpacked is what the host
disk holds (`docker image ls`), layer content is roughly what a pull transfers
(`docker image inspect .Size`). Reporting one of them as "the size" would be
choosing whichever number reads better.

## Not here yet

No image is published to any registry, no CI job builds one, and no CDK stack
exists — all of that is the rest of the C19 row in
[docs/ROADMAP.md](../docs/ROADMAP.md). Every proof above has been run locally
and none has run in CI.
