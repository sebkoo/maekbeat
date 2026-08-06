# The apps/web dashboard as a static-serving container.
#
# This image exists to run the C13 smoke against a composed stack, not as a
# deployment artifact: the dashboard is a bundle of static files and its target
# is an S3 origin behind a CDN (docs/ARCHITECTURE.md). Nothing here should grow
# a runtime — the moment this container starts making decisions, the thing
# being tested stops being the thing that ships.
#
#   docker build -f infra/web.Dockerfile \
#     --build-arg BUILD_REVISION="$(git rev-parse HEAD)" \
#     --build-arg VITE_API_BASE_URL=http://127.0.0.1:3000 \
#     -t maekbeat-web:local .

ARG NODE_IMAGE=node:22.22.0-alpine3.22
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.29-alpine

# ---------------------------------------------------------------------------
# Stage 1 — build the production bundle with the API address compiled into it.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build

ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /repo

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/protocol/package.json packages/protocol/
COPY packages/vitals-sim/package.json packages/vitals-sim/

RUN pnpm install --frozen-lockfile --filter "@maekbeat/web..."

COPY apps/web apps/web
COPY packages/protocol packages/protocol
COPY packages/vitals-sim packages/vitals-sim

# The address the browser will use, not one the container can reach: this value
# is compiled into the JavaScript a visitor downloads, so it has to be resolvable
# from the host. A compose service name here would produce a bundle that fails
# in every browser and in no build (apps/web/.env.example).
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN pnpm --filter @maekbeat/web build

# ---------------------------------------------------------------------------
# Stage 2 — nginx over the built files. No Node, no node_modules, no source.
# ---------------------------------------------------------------------------
FROM ${NGINX_IMAGE} AS runtime

ARG BUILD_REVISION

LABEL org.opencontainers.image.title="maekbeat-web" \
      org.opencontainers.image.description="Maekbeat caregiver dashboard: static production bundle" \
      org.opencontainers.image.source="https://github.com/sebkoo/maekbeat" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.revision="${BUILD_REVISION}"

COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html

# The nginxinc/nginx-unprivileged base runs as uid 101 and listens on 8080; the
# stock nginx image starts as root to bind 80 and drops privileges afterwards.
# One line of image choice replaces a page of configuration.
EXPOSE 8080

HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "--quiet", "--spider", "http://127.0.0.1:8080/index.html"]
