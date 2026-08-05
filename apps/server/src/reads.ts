import type { FastifyPluginAsync } from "fastify";

import type { AlertDecision } from "@maekbeat/protocol";

import type { DecisionLog } from "./acks";
import { parseAlertId, type AlertEngine } from "./alerts";
import type { IngestCounters } from "./ingest";
import type { VitalsStore } from "./store";
import type { DeviceBroadcaster } from "./stream";

export interface ReadsPluginOptions {
  store: VitalsStore;
  engine: AlertEngine;
  counters: IngestCounters;
  /** Append-only decision log behind the acknowledgement route (C12). */
  decisions: DecisionLog;
  /** Fan-out, so one caregiver's decision reaches every open dashboard. */
  broadcaster?: DeviceBroadcaster;
}

// Response schemas are hand-written JSON Schema mirroring the zod wire contract
// (@maekbeat/protocol vitalsFrameSchema) plus the two server-side stamps; a
// drift test in reads.test.ts pins the field sets against each other.
const storedFrameJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "v",
    "deviceId",
    "seq",
    "capturedAtMs",
    "heartRateBpm",
    "spo2Pct",
    "respirationRpm",
    "motion",
    "receivedAtMs",
    "sessionEpoch",
  ],
  properties: {
    v: { type: "integer", enum: [1] },
    deviceId: { type: "string" },
    seq: { type: "integer", minimum: 0 },
    capturedAtMs: { type: "integer", minimum: 1, description: "device clock, epoch ms" },
    heartRateBpm: { type: "integer" },
    spo2Pct: { type: "number" },
    respirationRpm: { type: "number" },
    motion: { type: "number" },
    receivedAtMs: {
      type: "integer",
      description: "server clock at ingest; receivedAtMs - capturedAtMs is the drift signal",
    },
    sessionEpoch: { type: "integer", minimum: 1 },
  },
} as const;

// Mirrors @maekbeat/protocol alertEventSchema; the drift test in
// reads.test.ts pins the field sets against each other.
const alertEventJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["alertId", "deviceId", "metric", "direction", "state", "raisedAtMs", "windowStats"],
  properties: {
    alertId: { type: "string" },
    deviceId: { type: "string" },
    metric: { type: "string", enum: ["heartRateBpm", "spo2Pct", "respirationRpm"] },
    direction: { type: "string", enum: ["low", "high"] },
    state: { type: "string", enum: ["raised", "ongoing", "resolved"] },
    raisedAtMs: { type: "integer", description: "server clock — receive time, never device clock" },
    resolvedAtMs: { type: "integer" },
    windowStats: {
      type: "object",
      additionalProperties: false,
      required: ["windowMs", "sampleCount", "breachCount", "minValue", "maxValue"],
      properties: {
        windowMs: { type: "integer" },
        sampleCount: { type: "integer" },
        breachCount: { type: "integer" },
        minValue: { type: "number" },
        maxValue: { type: "number" },
      },
    },
  },
} as const;

// Mirrors @maekbeat/protocol alertDecisionEventSchema; the drift test in
// reads.test.ts pins the field sets against each other.
const decisionEventJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["eventId", "alertId", "deviceId", "decision", "actor", "recordedAtMs"],
  properties: {
    eventId: { type: "string" },
    alertId: { type: "string" },
    deviceId: { type: "string" },
    decision: { type: "string", enum: ["acknowledged", "dismissed"] },
    actor: { type: "string", description: "asserted by the caller; unauthenticated (C22)" },
    recordedAtMs: { type: "integer", description: "server clock at append" },
    note: { type: "string" },
  },
} as const;

const notFoundJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["statusCode", "message"],
  properties: {
    statusCode: { type: "integer", enum: [404] },
    message: { type: "string" },
  },
} as const;

/** REST reads over the ring buffer: device listing + per-device frames. */
export const readsPlugin: FastifyPluginAsync<ReadsPluginOptions> = async (app, opts) => {
  const { store, engine, counters, decisions, broadcaster } = opts;

  app.get(
    "/devices",
    {
      schema: {
        summary: "List devices and ingest counters",
        description:
          "Every device seen by ingest, with its current session epoch and " +
          "lastReceivedAtMs — the staleness signal a dashboard renders (C11). " +
          "The ingest block carries process-lifetime counters. " +
          "alertsForcedEvicted counts undecided alerts dropped because the " +
          "history held nothing triaged to drop instead — a backlog nobody is " +
          "working through.",
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["ingest", "devices"],
            properties: {
              ingest: {
                type: "object",
                additionalProperties: false,
                required: [
                  "received",
                  "accepted",
                  "rejectedInvalid",
                  "duplicatesDropped",
                  "sessionsStarted",
                ],
                properties: {
                  received: { type: "integer" },
                  accepted: { type: "integer" },
                  rejectedInvalid: { type: "integer" },
                  duplicatesDropped: { type: "integer" },
                  sessionsStarted: { type: "integer" },
                },
              },
              devices: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "deviceId",
                    "sessionEpoch",
                    "frameCount",
                    "lastSeq",
                    "lastReceivedAtMs",
                    "duplicatesDropped",
                    "alertsForcedEvicted",
                  ],
                  properties: {
                    deviceId: { type: "string" },
                    sessionEpoch: { type: "integer", minimum: 1 },
                    frameCount: { type: "integer", minimum: 0 },
                    lastSeq: { type: "integer", minimum: 0 },
                    lastReceivedAtMs: { type: "integer" },
                    duplicatesDropped: { type: "integer", minimum: 0 },
                    alertsForcedEvicted: {
                      type: "integer",
                      minimum: 0,
                      description:
                        "undecided alerts dropped because the history held only undecided alerts",
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    async () => ({
      ingest: {
        received: counters.received,
        accepted: store.stats.accepted,
        rejectedInvalid: counters.rejectedInvalid,
        duplicatesDropped: store.stats.duplicatesDropped,
        sessionsStarted: store.stats.sessionsStarted,
      },
      // The alert history is bounded per device, and a device whose backlog
      // of undecided alerts has forced a drop says so here rather than losing
      // the event quietly.
      devices: store.listDevices().map((device) => ({
        ...device,
        alertsForcedEvicted: engine.countersFor(device.deviceId).forcedEvictions,
      })),
    }),
  );

  app.get<{
    Params: { deviceId: string };
    Querystring: { since?: number; limit: number };
  }>(
    "/devices/:deviceId/frames",
    {
      schema: {
        summary: "Read frames for one device",
        description:
          "Frames from the bounded ring buffer, ordered by (capturedAtMs, seq) " +
          "regardless of arrival order. `since` is an inclusive lower bound on " +
          "capturedAtMs. The buffer keeps at most RING_CAPACITY frames per " +
          "device (oldest arrival evicted first), so this is a window, not history.",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["deviceId"],
          properties: { deviceId: { type: "string", minLength: 1, maxLength: 64 } },
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            since: { type: "integer", minimum: 0, description: "inclusive capturedAtMs bound" },
            limit: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
          },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["deviceId", "count", "frames"],
            properties: {
              deviceId: { type: "string" },
              count: { type: "integer", minimum: 0 },
              frames: { type: "array", items: storedFrameJsonSchema },
            },
          },
          404: notFoundJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const { deviceId } = request.params;
      const frames = store.readFrames(deviceId, {
        sinceMs: request.query.since,
        limit: request.query.limit,
      });
      if (frames === undefined) {
        return reply.status(404).send({ statusCode: 404, message: `unknown device: ${deviceId}` });
      }
      return { deviceId, count: frames.length, frames };
    },
  );

  app.get<{ Params: { deviceId: string } }>(
    "/devices/:deviceId/alerts",
    {
      schema: {
        summary: "Read alerts for one device",
        description:
          "Alert lifecycle records from the sliding-window engine " +
          "(apps/server/src/alerts.ts), oldest first, capped at 100 per device. " +
          "raised/resolved/suppressed are process-lifetime counts per device; " +
          "acknowledged/dismissed are the decisions in force over the retained " +
          "decision log, so they can fall as well as rise. Thresholds are demo heuristics for a " +
          "notification demo of the kind used in monitoring research, not " +
          "clinical rules.",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["deviceId"],
          properties: { deviceId: { type: "string", minLength: 1, maxLength: 64 } },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["deviceId", "counters", "alerts", "decisions"],
            properties: {
              deviceId: { type: "string" },
              counters: {
                type: "object",
                additionalProperties: false,
                required: ["raised", "resolved", "suppressed", "acknowledged", "dismissed"],
                properties: {
                  raised: { type: "integer" },
                  resolved: { type: "integer" },
                  suppressed: { type: "integer" },
                  acknowledged: { type: "integer" },
                  dismissed: { type: "integer" },
                },
              },
              alerts: { type: "array", items: alertEventJsonSchema },
              decisions: { type: "array", items: decisionEventJsonSchema },
            },
          },
          404: notFoundJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const { deviceId } = request.params;
      // 404 keys on the store: a device the server has never ingested is
      // unknown; a known device without alerts gets an empty list.
      if (store.readFrames(deviceId, { limit: 1 }) === undefined) {
        return reply.status(404).send({ statusCode: 404, message: `unknown device: ${deviceId}` });
      }
      return {
        deviceId,
        counters: { ...engine.countersFor(deviceId), ...decisions.countsFor(deviceId) },
        alerts: engine.listAlerts(deviceId),
        decisions: decisions.list(deviceId),
      };
    },
  );

  app.post<{
    Params: { deviceId: string; alertId: string };
    Body: unknown;
  }>(
    "/devices/:deviceId/alerts/:alertId/decisions",
    {
      schema: {
        summary: "Record a decision on one alert",
        description:
          "Body shape and the two decisions come from @maekbeat/protocol " +
          "alertDecisionRequestSchema, mirrored here as JSON Schema so the " +
          "OpenAPI document and the validator are one thing; a drift test in " +
          "reads.test.ts pins the field sets against each other. " +
          "Appends an acknowledgement or a dismissal to the device's decision " +
          "log (apps/server/src/acks.ts) and returns the appended event. The " +
          "log is append-only: recording a second decision on the same alert " +
          "appends a second event and the newest one is the decision in force, " +
          "so who judged what, and when, survives a change of mind. " +
          "`acknowledged` means seen and acted on, `dismissed` means seen and " +
          "judged not actionable — the difference is the false-alarm signal the " +
          "C23 product loop counts. `actor` is asserted by the caller and is " +
          "not authenticated (C22 owns that). The alert record need not still " +
          "be retained: the log outlives the bounded history, so a decision is " +
          "accepted for an alertId this device owns whose rule, raise ordinal " +
          "and raise time this engine could have minted — checked from the id " +
          "itself, not from the record. A malformed id or an unknown rule is " +
          "400; another device's id, or one this device never raised, is 404.",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["deviceId", "alertId"],
          properties: {
            deviceId: { type: "string", minLength: 1, maxLength: 64 },
            alertId: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["decision", "actor"],
          properties: {
            decision: { type: "string", enum: ["acknowledged", "dismissed"] },
            actor: { type: "string", minLength: 1, maxLength: 64 },
            note: { type: "string", maxLength: 280 },
          },
        },
        response: {
          201: decisionEventJsonSchema,
          400: notFoundJsonSchema,
          404: notFoundJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const { deviceId, alertId } = request.params;
      const body = request.body as { decision: AlertDecision; actor: string; note?: string };

      // Presence is deliberately NOT the test. The decision log is
      // authoritative and append-only; the alert history in front of it is a
      // bounded cache, so an alert that has been evicted must still be
      // decidable — otherwise the cache could make a real event permanently
      // un-triageable. What is checked is that the id is well formed and that
      // this device owns it, which the id itself carries (alerts.ts).
      const parsed = parseAlertId(alertId);
      if (parsed === undefined) {
        return reply
          .status(400)
          .send({ statusCode: 400, message: `malformed alertId: ${alertId}` });
      }
      if (parsed.deviceId !== deviceId) {
        return reply.status(404).send({
          statusCode: 404,
          message: `alert ${alertId} does not belong to ${deviceId}`,
        });
      }
      // Well formed and owned is not yet plausible. Without the record, three
      // things are still checkable: the rule is one this engine judges by, the
      // raise ordinal is one it has actually reached for this device, and the
      // raise time is not in the future. That keeps decisions on alerts this
      // server could never have minted out of an append-only log.
      if (!engine.hasRule(parsed.ruleId)) {
        return reply
          .status(400)
          .send({ statusCode: 400, message: `unknown alert rule: ${parsed.ruleId}` });
      }
      if (parsed.ordinal > engine.countersFor(deviceId).raised || parsed.raisedAtMs > Date.now()) {
        return reply
          .status(404)
          .send({ statusCode: 404, message: `alert ${alertId} was never raised on ${deviceId}` });
      }

      const event = decisions.append({
        deviceId,
        alertId,
        decision: body.decision,
        actor: body.actor,
        ...(body.note === undefined ? {} : { note: body.note }),
        recordedAtMs: Date.now(),
      });
      broadcaster?.publishDecision(event);
      return reply.status(201).send(event);
    },
  );
};
