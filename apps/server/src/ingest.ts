import { vitalsFrameSchema } from "@maekbeat/protocol";
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import type { FastifyPluginAsync } from "fastify";
import type { RawData } from "ws";

import type { AlertEngine } from "./alerts";
import type { VitalsStore } from "./store";
import type { DeviceBroadcaster } from "./stream";
import { SPAN_ATTRIBUTES, SPAN_NAMES, disabledTracer } from "./tracing";

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
  /** Spans for this path (C18); omitted, every span is non-recording. */
  tracer?: Tracer;
  /**
   * The receive clock. Injected for the one test that has to replay the same
   * fixture twice and compare the alerts byte for byte — a wall clock makes
   * two runs differ whether or not tracing is on, which would turn that
   * comparison into a normalisation exercise. Production passes nothing.
   */
  now?: () => number;
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(data).toString("utf8");
}

/** A rejected frame ends its validation span red and marks the ingest span. */
function failValidation(ingestSpan: Span, validateSpan: Span, reason: string): void {
  validateSpan.setAttribute(SPAN_ATTRIBUTES.validateResult, reason);
  validateSpan.setStatus({ code: SpanStatusCode.ERROR, message: reason });
  validateSpan.end();
  ingestSpan.setAttribute(SPAN_ATTRIBUTES.ingestOutcome, reason);
  ingestSpan.setStatus({ code: SpanStatusCode.ERROR, message: reason });
}

/**
 * WS ingest at GET /ingest. Per-message replies: `ack` on accept, `rejected`
 * (invalid_json | invalid_frame | duplicate) on drop. Rejects never close the
 * socket — one bad frame must not sever a stream carrying good ones.
 */
export const ingestPlugin: FastifyPluginAsync<IngestPluginOptions> = async (app, opts) => {
  const { store, engine, counters, broadcaster } = opts;
  const tracer = opts.tracer ?? disabledTracer();
  const now = opts.now ?? Date.now;

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

        // One trace per frame, rooted here: nothing upstream propagates trace
        // context — the gateway sends a bare JSON frame (docs/ble-gatt-profile.md)
        // — so claiming a parent would be inventing one.
        const ingestSpan = tracer.startSpan(SPAN_NAMES.ingest, { kind: SpanKind.SERVER });
        // Every child below names this context, built on ROOT_CONTEXT rather
        // than on `context.active()`. The two are the same thing today, since
        // nothing calls `provider.register()` and no context manager is
        // installed — but only today: the moment anything in this process
        // registers one, `context.active()` inside a ws 'message' callback
        // would return whatever ambient context that callback inherited,
        // plausibly the long-finished HTTP upgrade, and every ingest trace
        // would silently become a child of it. Naming the root is the whole
        // discipline of this file applied to the root itself.
        const ingestCtx = trace.setSpan(ROOT_CONTEXT, ingestSpan);

        // The child span currently open, so a throw can close it and mark the
        // ingest span red instead of leaving a green span with a missing child.
        let openChild: Span | undefined;

        try {
          const validateSpan = tracer.startSpan(SPAN_NAMES.validate, undefined, ingestCtx);
          openChild = validateSpan;

          let payload: unknown;
          try {
            payload = JSON.parse(rawDataToString(data));
          } catch {
            counters.rejectedInvalid += 1;
            failValidation(ingestSpan, validateSpan, "invalid_json");
            socket.send(JSON.stringify({ type: "rejected", reason: "invalid_json" }));
            return;
          }

          const parsed = vitalsFrameSchema.safeParse(payload);
          if (!parsed.success) {
            counters.rejectedInvalid += 1;
            failValidation(ingestSpan, validateSpan, "invalid_frame");
            const issues = parsed.error.issues
              .slice(0, 5)
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`);
            socket.send(JSON.stringify({ type: "rejected", reason: "invalid_frame", issues }));
            return;
          }
          validateSpan.setAttribute(SPAN_ATTRIBUTES.validateResult, "ok");
          validateSpan.end();
          openChild = undefined;

          // The receive stamp: server clock, per frame, at ingest — the
          // clock-drift policy of docs/ARCHITECTURE.md lands on this line.
          const receivedAtMs = now();
          const frame = parsed.data;

          const storeSpan = tracer.startSpan(SPAN_NAMES.store, undefined, ingestCtx);
          openChild = storeSpan;
          const result = store.ingest(frame, receivedAtMs);
          storeSpan.setAttributes({
            [SPAN_ATTRIBUTES.storeResult]: result.kind,
            [SPAN_ATTRIBUTES.sessionEpoch]: result.sessionEpoch,
          });
          storeSpan.end();
          openChild = undefined;

          // The identifiers and the arrival judgement, on the span an incident
          // starts from. Duplicate and out-of-order are the two behaviours a
          // reader is squinting at when the numbers look wrong, and they are
          // invisible in the ack, which reports only that the frame landed.
          ingestSpan.setAttributes({
            [SPAN_ATTRIBUTES.deviceId]: frame.deviceId,
            [SPAN_ATTRIBUTES.seq]: frame.seq,
            [SPAN_ATTRIBUTES.duplicate]: result.kind === "duplicate",
            [SPAN_ATTRIBUTES.outOfOrder]: result.outOfOrder,
            [SPAN_ATTRIBUTES.newSession]: result.kind === "accepted" && result.newSession,
            [SPAN_ATTRIBUTES.sessionEpoch]: result.sessionEpoch,
          });

          if (result.kind === "duplicate") {
            ingestSpan.setAttribute(SPAN_ATTRIBUTES.ingestOutcome, "duplicate");
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
          const evaluateSpan = tracer.startSpan(SPAN_NAMES.evaluate, undefined, ingestCtx);
          openChild = evaluateSpan;
          const evaluateCtx = trace.setSpan(ingestCtx, evaluateSpan);
          const transitions = engine.process(stored);
          evaluateSpan.setAttribute(SPAN_ATTRIBUTES.transitionCount, transitions.length);
          for (const transition of transitions) {
            // A grandchild, not a sibling: the trace has to say which frame's
            // evaluation raised this alert, and a flat tree says only that
            // something did.
            const transitionSpan = tracer.startSpan(SPAN_NAMES.transition, undefined, evaluateCtx);
            transitionSpan.setAttributes({
              [SPAN_ATTRIBUTES.alertId]: transition.alertId,
              [SPAN_ATTRIBUTES.alertState]: transition.state,
              [SPAN_ATTRIBUTES.alertMetric]: transition.metric,
              [SPAN_ATTRIBUTES.alertDirection]: transition.direction,
            });
            transitionSpan.end();
            request.log.info(
              { alertId: transition.alertId, state: transition.state, metric: transition.metric },
              "alert transition",
            );
          }
          evaluateSpan.end();
          openChild = undefined;

          // Fan-out after the engine, so a dashboard never sees a frame before
          // the alert that frame raised (C11; docs/ARCHITECTURE.md stage 7).
          const fanoutSpan = tracer.startSpan(SPAN_NAMES.fanout, undefined, ingestCtx);
          openChild = fanoutSpan;
          broadcaster?.publishFrame(stored);
          for (const transition of transitions) {
            broadcaster?.publishAlert(transition);
          }
          fanoutSpan.setAttributes({
            [SPAN_ATTRIBUTES.subscriberCount]: broadcaster?.subscriberCount(frame.deviceId) ?? 0,
            [SPAN_ATTRIBUTES.messageCount]: broadcaster === undefined ? 0 : 1 + transitions.length,
          });
          fanoutSpan.end();
          openChild = undefined;

          ingestSpan.setAttribute(SPAN_ATTRIBUTES.ingestOutcome, "accepted");
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
        } catch (err: unknown) {
          // A frame that crashed the handler must not export as a healthy
          // trace. Without this the `finally` would end the ingest span with no
          // status and no outcome, and the one span an incident starts from
          // would look green with a child silently missing — the failure
          // inverted for exactly the reader it exists to serve.
          const error = err instanceof Error ? err : new Error(String(err));
          openChild?.end();
          ingestSpan.recordException(error);
          ingestSpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
          ingestSpan.setAttribute(SPAN_ATTRIBUTES.ingestOutcome, "error");
          throw err;
        } finally {
          ingestSpan.end();
        }
      });

      socket.on("close", () => {
        request.log.info("ingest connection closed");
      });
    },
  });
};
