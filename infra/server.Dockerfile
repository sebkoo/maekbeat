# The Maekbeat API server as a container image.
#
# Build from the repository root, always with a revision:
#
#   docker build -f infra/server.Dockerfile \
#     --build-arg BUILD_REVISION="$(git rev-parse HEAD)" \
#     --platform linux/amd64 -t maekbeat-server:local .
#
# BUILD_REVISION has no default on purpose. It becomes both the image's
# org.opencontainers.image.revision label and the process's BUILD_REVISION
# variable, and an image built without it refuses to start under
# NODE_ENV=production, naming the variable (apps/server/src/config.ts). An
# image that cannot say which commit it is cannot be caught serving a stale
# layer, which is the failure this whole file is defending against.

ARG NODE_IMAGE=node:22.22.0-alpine3.22

# ---------------------------------------------------------------------------
# Stage 1 — resolve dependencies and produce a self-contained server directory.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build

ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

WORKDIR /repo

# Manifests first, so a source edit does not re-resolve the dependency graph.
# Every workspace manifest is copied, not only the server's: pnpm validates the
# lockfile against all of them, and with one missing --frozen-lockfile would be
# checking a smaller claim than the repository makes.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/protocol/package.json packages/protocol/
COPY packages/vitals-sim/package.json packages/vitals-sim/

# The package manager, resolved from the repository's own `packageManager`
# field before anything invokes it.
#
# What was actually wrong here, and what was not. The C19 review recorded this
# as "the Dockerfile takes whatever pnpm the base image ships"; it does not,
# and the check that would have proved it does not exist because it cannot.
# `corepack enable` installs a shim that reads `packageManager` from the
# nearest manifest at the moment pnpm runs, so the version was already pinned
# to pnpm@11.10.0 — two attempts to dislodge it failed, including installing
# pnpm@10.15.0 globally with `--force` first (docs/ai/mutation-log.md). An
# assertion comparing pnpm's reported version against the manifest would be
# comparing corepack's output to corepack's input, which is a tautology
# wearing a guard's clothes.
#
# What was genuinely implicit is fixed here. The resolution depended on the
# root package.json already having been copied, which is true four lines up
# and was load-bearing without saying so; it happened lazily inside the install
# step, so a download failure surfaced as an install failure; and no build log
# ever named the version. Resolving it explicitly in its own layer makes the
# ordering a stated requirement, gives the download its own cache entry, and
# prints the number a reader of CI output would otherwise have to infer.
RUN corepack enable \
 && pinned="$(node -p "require('/repo/package.json').packageManager")" \
 && corepack prepare "$pinned" --activate \
 && echo "package manager: $pinned, reporting $(pnpm --version)"

# --frozen-lockfile is the drift gate: a dependency added to a package.json
# without the lockfile being regenerated fails the build here rather than
# resolving to whatever is newest on the day the image happens to be built.
RUN pnpm install --frozen-lockfile --filter "@maekbeat/server..."

COPY apps/server apps/server
COPY packages/protocol packages/protocol
COPY packages/vitals-sim packages/vitals-sim

# `deploy --prod` writes a directory with the server's own files plus a
# node_modules holding production dependencies only — no vitest, no typescript,
# no @types, and no @maekbeat/vitals-sim, which is a devDependency because the
# simulator belongs to the tests and the demo rather than to the running server.
#
# --legacy because pnpm 10 and later refuse a non-injected deploy outright
# (ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE). The alternative is
# inject-workspace-packages=true in pnpm-workspace.yaml, which changes how
# every workspace dependency is linked for every developer and every CI job —
# a repository-wide change of install semantics, taken for the benefit of one
# image build. The flag is local to this line, which is where the cost belongs.
RUN pnpm --filter @maekbeat/server --prod deploy --legacy /srv/maekbeat

# ---------------------------------------------------------------------------
# Stage 2 — the image that runs. Nothing from stage 1 comes along except /srv.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

ARG BUILD_REVISION

LABEL org.opencontainers.image.title="maekbeat-server" \
      org.opencontainers.image.description="Maekbeat API server: WebSocket vitals ingest, alert engine, dashboard fan-out" \
      org.opencontainers.image.source="https://github.com/sebkoo/maekbeat" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.revision="${BUILD_REVISION}"

# Configuration comes from the environment and nothing else (.env.example
# documents the contract). These three are the container's defaults, not
# secrets and not baked application state: 0.0.0.0 because 127.0.0.1 inside a
# container is reachable from nothing, and production because that is what this
# image is.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    BUILD_REVISION=${BUILD_REVISION}

WORKDIR /srv/maekbeat
COPY --from=build --chown=node:node /srv/maekbeat ./

# node:alpine ships an unprivileged `node` user (uid 1000). Running as root
# would mean a process that only ever needs to bind a port and hold memory
# could also rewrite its own image contents.
USER node

EXPOSE 3000

# Probes the server, not the container's existence — the distinction the
# negative control in infra/verify-image.sh exists to prove. It reads PORT so
# that a container started on a different port is still checked on the port it
# is actually serving.
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# tsx, not node: the workspace packages export TypeScript sources
# (packages/protocol/package.json `exports`), and `pnpm start` has run them
# through tsx since C5. It is a dependency rather than a devDependency for that
# reason — it is what the server needs to run, which is what the word means.
CMD ["./node_modules/.bin/tsx", "src/main.ts"]
