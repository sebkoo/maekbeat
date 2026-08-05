# @maekbeat/server

Fastify skeleton for the Maekbeat API — the C5 commit of [docs/ROADMAP.md](../../docs/ROADMAP.md). It serves `GET /healthz` and an OpenAPI document listing exactly that route; WebSocket ingest, the ring-buffer store, and REST reads land at C6.

## What exists today

- [src/config.ts](src/config.ts) — typed env parsing (zod) with defaults; invalid values fail startup with the offending variable named.
- [src/app.ts](src/app.ts) — Fastify with pino logging, a central error handler that masks 5xx details outside development, and @fastify/swagger; Swagger UI mounts at `/docs` in development only.
- [src/main.ts](src/main.ts) — startup and graceful shutdown: SIGTERM/SIGINT drain in-flight requests via `app.close()`, the same signal path an ECS task stop will use (infra planned — C19).

## Configuration

| Variable    | Default       | Values                                                 |
| ----------- | ------------- | ------------------------------------------------------ |
| `HOST`      | `127.0.0.1`   | bind address; use `0.0.0.0` in containers              |
| `PORT`      | `3000`        | integer, 1–65535                                       |
| `LOG_LEVEL` | `info`        | `fatal` `error` `warn` `info` `debug` `trace` `silent` |
| `NODE_ENV`  | `development` | `development` `test` `production`                      |

Configuration is read from `process.env` only ([src/config.ts](src/config.ts)); [.env.example](.env.example) documents each variable and holds no secrets. To use a file, copy it to `.env` and pass `--env-file=.env` to Node, or export the variables in the shell.

## Run

```sh
pnpm --filter @maekbeat/server dev    # tsx watch src/main.ts
pnpm --filter @maekbeat/server test
pnpm --filter @maekbeat/server typecheck
```

`GET /healthz` returns `{ status, uptimeSec, version }`. The OpenAPI document is served by @fastify/swagger and browsable at `/docs` when `NODE_ENV=development`; tests in [src/](src) pin the route list, the error-handler shape, and the config parsing.
