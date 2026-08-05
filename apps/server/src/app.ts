import fastifyCors from "@fastify/cors";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import fastifyWebsocket from "@fastify/websocket";
import { fastify } from "fastify";

import { DecisionLog } from "./acks";
import { AlertEngine, DEFAULT_ALERT_RULES, type AlertRuleConfig } from "./alerts";
import type { ServerConfig } from "./config";
import { INGEST_MAX_PAYLOAD_BYTES, ingestPlugin, type IngestCounters } from "./ingest";
import { readsPlugin } from "./reads";
import { VitalsStore } from "./store";
import { DeviceBroadcaster, streamPlugin } from "./stream";
import { packageVersion } from "./version";

declare module "fastify" {
  interface FastifyInstance {
    vitalsStore: VitalsStore;
    alertEngine: AlertEngine;
    deviceBroadcaster: DeviceBroadcaster;
    decisionLog: DecisionLog;
  }
}

export interface BuildAppOptions {
  /** Override the alert rule set; defaults to DEFAULT_ALERT_RULES. */
  alertRules?: readonly AlertRuleConfig[];
}

export async function buildApp(config: ServerConfig, options: BuildAppOptions = {}) {
  const app = fastify({
    logger: { level: config.LOG_LEVEL },
    // An unknown key in a request body is a corrupted or forged payload, the
    // same judgement @maekbeat/protocol's strict schemas make on the wire.
    // Fastify strips them by default, which would let one through silently.
    ajv: { customOptions: { removeAdditional: false } },
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

  // The dashboard is cross-origin in every documented setup, so the API says
  // so explicitly rather than leaving the browser to block the read.
  await app.register(fastifyCors, {
    origin: config.CORS_ORIGIN === "*" ? true : config.CORS_ORIGIN.split(",").map((o) => o.trim()),
    methods: ["GET", "POST", "OPTIONS"],
  });

  await app.register(fastifySwagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Maekbeat server API",
        description:
          "Vitals ingest, sliding-window alert lifecycle, reads, acknowledgement, " +
          "and dashboard fan-out: WebSocket /ingest, /devices listing, per-device " +
          "frame and alert reads, the append-only decision route, WebSocket " +
          "/devices/{deviceId}/stream, /healthz.",
        version: packageVersion,
      },
    },
  });

  // Swagger UI is a development convenience; test and production mount no UI.
  if (config.NODE_ENV === "development") {
    await app.register(fastifySwaggerUi, { routePrefix: "/docs" });
  }

  const store = new VitalsStore(config.RING_CAPACITY);
  const decisions = new DecisionLog();
  // The engine evicts triaged alerts first and asks the log which those are;
  // a forced eviction — the history full of undecided alerts — is an
  // operational signal, so it is logged rather than counted quietly.
  const engine = new AlertEngine(options.alertRules ?? DEFAULT_ALERT_RULES, {
    isDecided: (deviceId, alertId) => decisions.isDecided(deviceId, alertId),
    onForcedEviction: ({ deviceId, alertId }) =>
      app.log.warn(
        { deviceId, alertId },
        "alert history full of undecided alerts; dropped the oldest undecided one",
      ),
  });
  const broadcaster = new DeviceBroadcaster();
  const counters: IngestCounters = { received: 0, rejectedInvalid: 0 };
  app.decorate("vitalsStore", store);
  app.decorate("alertEngine", engine);
  app.decorate("deviceBroadcaster", broadcaster);
  app.decorate("decisionLog", decisions);

  await app.register(fastifyWebsocket, { options: { maxPayload: INGEST_MAX_PAYLOAD_BYTES } });
  await app.register(ingestPlugin, { store, engine, counters, broadcaster });
  await app.register(readsPlugin, { store, engine, counters, decisions, broadcaster });
  await app.register(streamPlugin, { broadcaster, ringCapacity: config.RING_CAPACITY });

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
