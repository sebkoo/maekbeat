import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { fastify } from "fastify";

import type { ServerConfig } from "./config";
import { packageVersion } from "./version";

export async function buildApp(config: ServerConfig) {
  const app = fastify({
    logger: { level: config.LOG_LEVEL },
  });

  // Central handler for thrown errors: log the full error and never leak
  // 5xx internals outside development. (404s keep Fastify's default shape.)
  app.setErrorHandler((error: unknown, request, reply) => {
    const err = error instanceof Error ? error : new Error(String(error));
    const statusCode =
      "statusCode" in err && typeof err.statusCode === "number" && err.statusCode >= 400
        ? err.statusCode
        : 500;
    request.log.error({ err, statusCode }, "request failed");
    const message =
      statusCode >= 500 && config.NODE_ENV !== "development"
        ? "Internal Server Error"
        : err.message;
    void reply.status(statusCode).send({ statusCode, message });
  });

  await app.register(fastifySwagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Maekbeat server API",
        description:
          "C5 skeleton: /healthz only. WebSocket ingest and REST reads land at C6 (docs/ROADMAP.md).",
        version: packageVersion,
      },
    },
  });

  // Swagger UI is a development convenience; test and production mount no UI.
  if (config.NODE_ENV === "development") {
    await app.register(fastifySwaggerUi, { routePrefix: "/docs" });
  }

  app.get(
    "/healthz",
    {
      schema: {
        summary: "Liveness probe",
        description: "Process status, uptime in seconds, and package version.",
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["status", "uptimeSec", "version"],
            properties: {
              status: { type: "string", enum: ["ok"] },
              uptimeSec: { type: "number", minimum: 0 },
              version: { type: "string" },
            },
          },
        },
      },
    },
    async () => ({ status: "ok" as const, uptimeSec: process.uptime(), version: packageVersion }),
  );

  return app;
}
