import { vitalsFrameSchema } from "@maekbeat/protocol";
import type { FastifyPluginAsync } from "fastify";
import type { RawData } from "ws";

import type { AlertEngine } from "./alerts";
import type { VitalsStore } from "./store";
import type { DeviceBroadcaster } from "./stream";

/**
 * Transport bound, not a throughput claim: one JSON vitals frame per WS
 * message (~200 bytes on the wire), no batching at C6. Messages above this
 * cap close the connection (ws maxPayload, close code 1009) — that is the one
 * transport-level exception to "a bad frame never closes the socket".
 */
export const INGEST_MAX_PAYLOAD_BYTES = 16 * 1024;

/** Ingest counters that live outside the store: message- and parse-level. */
export interface IngestCounters {
  received: number;
  rejectedInvalid: number;
}

export interface IngestPluginOptions {
  store: VitalsStore;
  engine: AlertEngine;
  counters: IngestCounters;
  /** Fan-out to subscribed dashboards (C11); omitted, ingest runs unchanged. */
  broadcaster?: DeviceBroadcaster;
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(data).toString("utf8");
}

/**
 * WS ingest at GET /ingest. Per-message replies: `ack` on accept, `rejected`
 * (invalid_json | invalid_frame | duplicate) on drop. Rejects never close the
 * socket — one bad frame must not sever a stream carrying good ones.
 */
export const ingestPlugin: FastifyPluginAsync<IngestPluginOptions> = async (app, opts) => {
  const { store, engine, counters, broadcaster } = opts;

  app.route({
    method: "GET",
    url: "/ingest",
    schema: {
      summary: "WebSocket vitals ingest",
      description:
        "WebSocket upgrade endpoint. Send one JSON-encoded vitals frame " +
        "(@maekbeat/protocol vitalsFrameSchema) per message, max 16 KiB, no batching. " +
        "Every message gets a JSON reply: {type:'ack', deviceId, seq, sessionEpoch, " +
        "receivedAtMs, newSession} on accept, or {type:'rejected', reason: " +
        "'invalid_json'|'invalid_frame'|'duplicate'} on drop. Rejects do not close " +
        "the socket; only an over-limit message does (close code 1009). " +
        "Plain HTTP requests receive 426.",
      response: {
        426: {
          type: "object",
          additionalProperties: false,
          required: ["statusCode", "message"],
          properties: {
            statusCode: { type: "integer", enum: [426] },
            message: { type: "string" },
          },
        },
      },
    },
    handler: (_request, reply) => {
      void reply
        .status(426)
        .send({ statusCode: 426, message: "WebSocket upgrade required on /ingest" });
    },
    wsHandler: (socket, request) => {
      request.log.info("ingest connection opened");

      socket.on("message", (data: RawData) => {
        counters.received += 1;

        let payload: unknown;
        try {
          payload = JSON.parse(rawDataToString(data));
        } catch {
          counters.rejectedInvalid += 1;
          socket.send(JSON.stringify({ type: "rejected", reason: "invalid_json" }));
          return;
        }

        const parsed = vitalsFrameSchema.safeParse(payload);
        if (!parsed.success) {
          counters.rejectedInvalid += 1;
          const issues = parsed.error.issues
            .slice(0, 5)
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`);
          socket.send(JSON.stringify({ type: "rejected", reason: "invalid_frame", issues }));
          return;
        }

        // The receive stamp: server clock, per frame, at ingest — the
        // clock-drift policy of docs/ARCHITECTURE.md lands on this line.
        const receivedAtMs = Date.now();
        const frame = parsed.data;
        const result = store.ingest(frame, receivedAtMs);

        if (result.kind === "duplicate") {
          socket.send(
            JSON.stringify({
              type: "rejected",
              reason: "duplicate",
              deviceId: frame.deviceId,
              seq: frame.seq,
              sessionEpoch: result.sessionEpoch,
            }),
          );
          return;
        }

        // Deduped frames never reach the engine — a retransmit cannot
        // re-count toward a window that already saw the value.
        const stored = { ...frame, receivedAtMs, sessionEpoch: result.sessionEpoch };
        const transitions = engine.process(stored);
        for (const transition of transitions) {
          request.log.info(
            { alertId: transition.alertId, state: transition.state, metric: transition.metric },
            "alert transition",
          );
        }

        // Fan-out after the engine, so a dashboard never sees a frame before
        // the alert that frame raised (C11; docs/ARCHITECTURE.md stage 7).
        broadcaster?.publishFrame(stored);
        for (const transition of transitions) {
          broadcaster?.publishAlert(transition);
        }

        socket.send(
          JSON.stringify({
            type: "ack",
            deviceId: frame.deviceId,
            seq: frame.seq,
            sessionEpoch: result.sessionEpoch,
            receivedAtMs,
            newSession: result.newSession,
          }),
        );
      });

      socket.on("close", () => {
        request.log.info("ingest connection closed");
      });
    },
  });
};
