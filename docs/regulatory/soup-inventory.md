# SOUP inventory

Maekbeat is not a medical device and there is no manufacturer here. Read
[README.md](README.md) in this directory first — it states the position this
file depends on and lists what a real submission would need that this has none
of.

SOUP is software already available and not developed for incorporation into
this system, or software whose development records are not available to the
people using it. Every dependency this project did not write is SOUP: the npm
packages, the GitHub Actions, the container base images, the build tools, the
language runtimes. This file is the list, and
`scripts/check-soup-inventory.sh` fails the build when the list and the
manifests disagree.

No clause number appears here. The description above is my own paraphrase from
secondary reading — IEC 62304 is paywalled at CHF 1,150 and I have not read it,
per [README.md](README.md#citations-i-could-not-verify) and the same rule
[lifecycle-map.md](lifecycle-map.md#why-no-clause-numbers-appear) follows.

## What this records, and the one thing it deliberately omits

**No version numbers.** A version-carrying inventory is stale the first time
Dependabot merges, and the guard behind it would fail on a bot's pull request
until a human hand-edits a table. That is how a guard gets switched off.

The versions live in `pnpm-lock.yaml` (lockfileVersion 9.0), in the `ARG`
defaults in `infra/*.Dockerfile`, and in the pins in `.github/workflows/ci.yml`,
all of which are already under configuration management. This file records
**identity, role and consequence** — what each item is, what it does here, and
what fails without it — and cites those manifests as the version record rather
than duplicating them.

The cost is stated rather than discovered: a version regression is invisible to
this document and to its guard. What the guard catches is an item entering or
leaving the build without the analysis noticing, which is the failure that
matters for an inventory.

That trade is measured. Replaying all 12 Dependabot commits in this
repository's history and diffing the dependency **name** set on each side gives
`names changed: NONE` for 12 of 12, including two major-version jumps
(`react-router` 7 to 8, `vite` 7 to 8). A name-set guard would have gone red on
none of them, and goes red only on the feature commits that actually change what
is in the build.

## The guard

`scripts/check-soup-inventory.sh` reads the tables below and the manifests, and
fails on a disagreement in either direction — an item named here that no
manifest carries, or an item in a manifest that is named nowhere here. It reads
five sources, all in the working tree and none over the network, for the reason
`scripts/check-action-versions.sh` gives: a check that asks the internet gives a
different verdict on Tuesday than on Monday.

It runs in the CI hygiene job (`.github/workflows/ci.yml`) and under
`/ship-check`. What it cannot see is named in its header and in
[what this inventory does not reach](#what-this-inventory-does-not-reach).

## Runtime SOUP — the server

Declared in `apps/server/package.json` as production dependencies, so
`pnpm --filter @maekbeat/server --prod deploy` copies them into the runtime
stage of `infra/server.Dockerfile`. **These are the packages that execute in the
shipped container.**

<!-- soup:npm -->

| Item                                      | Role in this system                                  | What breaks without it                        |
| ----------------------------------------- | ---------------------------------------------------- | --------------------------------------------- |
| `fastify`                                 | HTTP and lifecycle core of the API server            | No server                                     |
| `@fastify/websocket`                      | Vitals ingest and dashboard fan-out sockets          | No ingest, no live dashboard                  |
| `@fastify/cors`                           | Cross-origin access for the browser dashboard        | Dashboard cannot reach the API (found at C12) |
| `@fastify/swagger`                        | OpenAPI document generated from the route schemas    | No API description                            |
| `@fastify/swagger-ui`                     | Serves that document as a browsable page             | No API explorer                               |
| `zod`                                     | The wire contract in `packages/protocol`             | No frame validation anywhere                  |
| `tsx`                                     | Runs `src/main.ts` directly; the container's `start` | The shipped server does not start             |
| `@opentelemetry/api`                      | Span interface used across ingest, alert and fan-out | No tracing calls compile                      |
| `@opentelemetry/sdk-trace-node`           | Tracer provider in the Node process                  | Spans are recorded by nothing                 |
| `@opentelemetry/sdk-trace-base`           | Span processors and the batch pipeline               | No span batching or flush on shutdown         |
| `@opentelemetry/exporter-trace-otlp-http` | Ships spans to the OTLP endpoint when one is set     | Spans never leave the process                 |
| `@opentelemetry/resources`                | Resource attributes attached to every span           | Spans arrive unattributed                     |
| `@opentelemetry/semantic-conventions`     | Standard attribute keys                              | Attribute names drift from the convention     |

`tsx` is the entry worth pausing on. The runtime image does not ship compiled
JavaScript — `"start": "tsx src/main.ts"` means a transpiler is in the serving
path of the container that would, in a real product, be the monitored device's
server. Nothing here treats that as a defect; it is recorded because a SOUP
analysis that missed it would have missed the component with the widest reach.

## Runtime SOUP — the web dashboard

Declared in `apps/web/package.json` as production dependencies. These are
compiled into the bundle `infra/web.Dockerfile` copies into nginx; the runtime
stage contains no Node and no `node_modules`.

<!-- soup:npm -->

| Item           | Role in this system                  | What breaks without it        |
| -------------- | ------------------------------------ | ----------------------------- |
| `react`        | Component model for the dashboard    | No dashboard                  |
| `react-dom`    | Browser renderer                     | Nothing mounts                |
| `react-router` | Device list and device detail routes | No navigation between devices |

`zod` is also a production dependency of `apps/web`, where it parses frames and
alert events inside each response; it is listed once, above.

## Infrastructure SOUP

Declared in `infra/cdk/package.json`. These never run in a serving path — they
synthesize a CloudFormation template that has never been deployed.

<!-- soup:npm -->

| Item          | Role in this system                            | What breaks without it           |
| ------------- | ---------------------------------------------- | -------------------------------- |
| `aws-cdk-lib` | Construct library the stack is written against | No stack                         |
| `constructs`  | Base composition model CDK is built on         | No stack                         |
| `cdk-nag`     | Rule pack asserted during synthesis            | Synthesis stops checking itself  |
| `aws-cdk`     | The CLI wrapper `cdk synth` runs in CI         | `cdk.json` goes unverified (C19) |

## Development and verification SOUP

Never present in any shipped artifact, and load-bearing anyway: these are the
tools that decide whether a change is allowed to merge. A defect in this class
does not reach a patient; it lets a defect reach one by reporting green.

<!-- soup:npm -->

| Item                          | Role in this system                                           |
| ----------------------------- | ------------------------------------------------------------- |
| `vitest`                      | Test runner for all five TypeScript packages                  |
| `@vitest/coverage-v8`         | Coverage measurement behind the ratchet in every package      |
| `typescript`                  | Type checking across the workspace                            |
| `vite`                        | Dev server and bundler for `apps/web`                         |
| `@vitejs/plugin-react`        | React transform in that bundler                               |
| `jsdom`                       | DOM environment for the component tests                       |
| `@testing-library/react`      | Renders components the way the tests assert on them           |
| `@testing-library/user-event` | Drives keyboard and pointer interaction in those tests        |
| `@playwright/test`            | The end-to-end journey through a real browser                 |
| `@axe-core/playwright`        | Drives the accessibility pass inside that browser             |
| `axe-core`                    | The WCAG 2.2 AA rule engine itself                            |
| `puppeteer-core`              | Captures `docs/demo/preview.gif` from the running system      |
| `ws`                          | WebSocket client the server and web suites drive sockets with |
| `@types/node`                 | Type declarations for the Node API                            |
| `@types/react`                | Type declarations for React                                   |
| `@types/react-dom`            | Type declarations for the React DOM renderer                  |
| `@types/ws`                   | Type declarations for `ws`                                    |

The four `@types/*` entries are declarations only and emit no code. They are
inventoried because they can still cause a defect: a wrong type declaration
makes the compiler agree with a call that fails at runtime.

## Continuous integration SOUP

Every job in `.github/workflows/ci.yml` runs third-party code before it runs any
of this repository's. `scripts/check-action-versions.sh` holds each of these to
one version across every reference — internal consistency, not newness.

<!-- soup:actions -->

| Item                         | Role in this system                                    |
| ---------------------------- | ------------------------------------------------------ |
| `actions/checkout`           | Puts the working tree on the runner                    |
| `actions/setup-node`         | Installs the Node the tests and builds run on          |
| `actions/cache`              | Caches the pnpm store and Docker layers                |
| `codecov/codecov-action`     | Uploads coverage; the badge in `README.md` reads it    |
| `docker/setup-buildx-action` | Builder for the image jobs                             |
| `docker/login-action`        | Authenticates the GHCR publish                         |
| `docker/build-push-action`   | Builds and pushes; attaches SLSA provenance by default |

## Container base image SOUP

Pinned in `infra/*.Dockerfile` as `ARG` defaults and in `infra/compose.yaml`.
The whole userland of every shipped container comes from these, which makes them
the largest SOUP items here by code volume and the least enumerated.

<!-- soup:images -->

| Item                          | Role in this system                                          |
| ----------------------------- | ------------------------------------------------------------ |
| `node`                        | Build and runtime base for the server; the compose collector |
| `nginxinc/nginx-unprivileged` | Runtime base serving the built dashboard as static files     |
| `grafana/k6`                  | Load generator for the C19 harness                           |

The nginx choice is a risk control rather than a preference: the unprivileged
variant runs as uid 101 and listens on 8080, where the stock image starts as
root to bind port 80 (`infra/web.Dockerfile`).

## Build-tool SOUP outside every manifest

These gate the build and appear in **no** `package.json`, so
`pnpm install --frozen-lockfile` does not reproduce them and Dependabot's npm
ecosystem cannot see them. They are pinned in `.github/workflows/ci.yml` alone.

<!-- soup:tools -->

| Item                | Role in this system                                          |
| ------------------- | ------------------------------------------------------------ |
| `prettier`          | Formatting gate over the whole tree in the `docs-lint` job   |
| `markdownlint-cli2` | Markdown gate over every `.md` file in that job              |
| `realm/SwiftLint`   | Swift lint gate in the `ios` job; downloaded and checksummed |

SwiftLint is the only item in this inventory verified by checksum at install
time (`SWIFTLINT_SHA256` in the `ios` job), and it is verified because it is
fetched from a release URL rather than resolved through a lockfile. The two
`npx --yes` tools are pinned to an exact version and trusted to the registry.

## Platform and toolchain SOUP — inventoried, not checked

Not machine-checked, because these are not declared in a manifest a script can
diff. They are listed because omitting them would misrepresent the iOS app
entirely.

| Item                                                | Where it is pinned                                        |
| --------------------------------------------------- | --------------------------------------------------------- |
| Node                                                | `engines.node` `>=22` in the root `package.json`          |
| pnpm                                                | `packageManager` `pnpm@11.10.0`, root `package.json`      |
| Swift toolchain                                     | `swift-tools-version:5.10` in `MaekbeatKit/Package.swift` |
| iOS SDK, Foundation, SwiftUI, CoreBluetooth, XCTest | `platforms: [.iOS(.v17), .macOS(.v14)]`, same file        |

**`apps/ios` declares zero external Swift packages and has no `Package.resolved`
file.** That is not an absence of SOUP; it means the iOS app's SOUP is entirely
platform — Foundation, SwiftUI, CoreBluetooth and XCTest — and an inventory that
only read `package.json` would have reported the app as dependency-free, which is
the opposite of true. CoreBluetooth in particular is the component the whole
`apps/ios` link-state machine is written against, and hazard H4's threshold is
derived from its reconnect behaviour.

## What Dependabot actually covers

"This repository has automated dependency updates" is true and misleading at
once, which is the reason this section exists rather than a badge.

Dependabot runs daily on two ecosystems (`.github/dependabot.yml`). But it
examines a dependency only after a full manifest scan has read it, and
`docs/DECISIONS.md` #27 measures what that meant: the npm scan of 2026-08-05
examined **eight** packages, against a workspace declaring **37** third-party
dependencies across six manifests. Twenty-nine had never been looked at.

That entry also predicted the next full scan would open at most five pull
requests, the documented default for `open-pull-requests-limit`. **The
prediction held.** Pull requests #7 through #11 — `vite`,
`@vitejs/plugin-react`, `puppeteer-core`, `jsdom`, `react-router` — merged
between 23:32 and 00:11 on 2026-08-06/07, 31 minutes after #27 landed at
`a4e7a3b`.

So the number has moved. **Derived 2026-08-07** by intersecting three sets, each
read from its source rather than transcribed: the dependencies the manifests
declare today (`find . -name package.json -not -path '*/node_modules/*'`, the
same expression the guard uses), the eight the #27 job log names (read out of
`docs/DECISIONS.md`), and the packages Dependabot has opened a merged pull
request for (read out of `git log`, author `dependabot`).

| Quantity                                                   | Count  |
| ---------------------------------------------------------- | ------ |
| Third-party npm dependencies declared across six manifests | 37     |
| Named by the 2026-08-05 scan log (`docs/DECISIONS.md` #27) | 8      |
| Of those, since removed from every manifest                | 0      |
| Additionally evidenced by a merged Dependabot bump         | 5      |
| **Demonstrably examined**                                  | **13** |
| **Not demonstrably examined**                              | **24** |

**"Not demonstrably examined" is weaker than "unexamined" on purpose, and the
weaker claim is the true one.** Dependabot's own view of this repository is not
observable from inside it — the update-job logs are not a public API, and a scan
that reads a package and finds it current leaves no pull request behind. So this
counts what the bot demonstrably acted on plus the one scan that left a log, and
treats the remaining 24 as **unknown** rather than as untouched. The real figure
is 24 or lower, and nothing in this repository can say where.

The subtraction is taken against what is declared today, which matters more than
it looks. If one of #27's eight had since been dropped from every manifest,
counting it as examined would shrink the unknown figure and flatter the
coverage — so that intersection is checked rather than assumed, and the row
above reads 0.

The three staleness items #27 named — `actions/cache`, `codecov/codecov-action`,
`vite` — have all since been bumped, so the mechanism works; it is the coverage
that was never complete.

The actions ecosystem has the same shape, and the evidence is a commit rather
than an argument. `docker/setup-buildx-action` and `docker/build-push-action`
were moved to their Node 24 majors by hand in `9b93a4f` (2026-08-07), not by a
pull request — so two of the seven actions in this inventory were brought
current by a person while the bot that exists to do that had not reached them.

Restating this as a standing number would be the mistake. It is a dated
derivation, reproducible from `git log`, and it moves every time a bump merges.

## What this inventory does not reach

The gaps, named here rather than left to be noticed.

- **The transitive set is not inventoried.** `pnpm-lock.yaml` resolves **340**
  package versions across **330** distinct names, and that count already
  includes the 37 named here. Everything the guard checks is the directly
  declared surface, so the code actually resolved into this workspace is
  roughly nine times the analysis.
- **No anomaly list has been evaluated for any item.** A SOUP analysis is
  supposed to review each item's published defects and decide whether any of
  them can produce a hazardous situation. Nothing here has done that for a
  single package, and no row above cites a CVE feed, an advisory or a release
  note.
- **No functional or performance requirement is stated for any item.** The
  "Role" column says what each is for, which is not the same as a requirement it
  can be verified against.
- **No version is recorded**, by choice — see the trade above, and read
  `pnpm-lock.yaml` for the answer. The cost is that a version pin moving
  backwards is invisible to this document and to its guard.
- **The Swift side is asserted at zero, not inventoried, and its transitive
  closure is unread.** A dependency _declared_ in `Package.swift` is caught —
  the guard fails on any that declares anything. What would resolve beneath one
  is not: `Package.resolved` is where a Swift transitive set gets written, the
  guard does not read it, and none exists because `apps/ios` declares nothing.
  So Swift has the same direct-only limit as npm, reached by a different route.
  That assertion exists because a mutation found its absence: adding one
  `.package(...)` line to `Package.swift` left the guard reporting "document and
  manifests agree", the one **not caught** row in this commit's battery
  (`docs/ai/mutation-log.md`).
- **Dependabot alerts are disabled for this repository** (confirmed 2026-08-07:
  `gh api repos/sebkoo/maekbeat/dependabot/alerts` returns HTTP 403, "Dependabot
  alerts are disabled for this repository"). So nothing here is watching for a
  published vulnerability in any of the 330 packages the lockfile resolves.
  Version currency and vulnerability alerting are different mechanisms, and this
  repository has the first and not the second.
- **`docs/regulatory/hazard-analysis.md` contains no SOUP-caused hazard.** All
  eight rows come from defects in code this project wrote. A failure originating
  in a dependency is a category the hazard analysis has never encountered, which
  is a statement about this project's history and not about the likelihood.
