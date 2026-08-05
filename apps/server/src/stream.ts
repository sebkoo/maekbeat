import type {
  AlertDecisionEvent,
  AlertEvent,
  StoredVitalsFrame,
  StreamMessage,
} from "@maekbeat/protocol";
import type { FastifyPluginAsync } from "fastify";

/**
 * Dashboard fan-out — docs/ARCHITECTURE.md stage 7, dev form: in-process
 * pub/sub keyed by deviceId. The target form is a Lambda fan-out (C19); what
 * makes this the dev form rather than a toy is that publishing is the only
 * coupling to ingest, so the transport can be replaced without touching the
 * ingest path.
 *
 * Read-only by design: a dashboard subscribes and receives; frames enter the
 * system through /ingest and nowhere else.
 */
export class DeviceBroadcaster {
  private readonly listeners = new Map<string, Set<(message: StreamMessage) => void>>();

  /** Subscribing to a device the server has never seen is allowed — a monitor
   *  that must wait for the first frame to attach would miss the first frame. */
  subscribe(deviceId: string, listener: (message: StreamMessage) => void): () => void {
    let forDevice = this.listeners.get(deviceId);
    if (!forDevice) {
      forDevice = new Set();
      this.listeners.set(deviceId, forDevice);
    }
    forDevice.add(listener);
    return () => {
      const current = this.listeners.get(deviceId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(deviceId);
    };
  }

  publishFrame(frame: StoredVitalsFrame): void {
    this.publish(frame.deviceId, { type: "frame", frame });
  }

  publishAlert(alert: AlertEvent): void {
    this.publish(alert.deviceId, { type: "alert", alert });
  }

  /** A decision recorded by one dashboard, sent to every other one (C12). */
  publishDecision(decision: AlertDecisionEvent): void {
    this.publish(decision.deviceId, { type: "decision", decision });
  }

  subscriberCount(deviceId?: string): number {
    if (deviceId !== undefined) return this.listeners.get(deviceId)?.size ?? 0;
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }

  private publish(deviceId: string, message: StreamMessage): void {
    const forDevice = this.listeners.get(deviceId);
    if (!forDevice) return;
    for (const listener of [...forDevice]) {
      try {
        listener(message);
      } catch {
        // A dashboard whose socket died mid-send must not break ingest for the
        // device it was watching. The close handler removes it either way.
      }
    }
  }
}

export interface StreamPluginOptions {
  broadcaster: DeviceBroadcaster;
  /** Frames the store keeps per device; sent in `ready` so a client knows the
   *  largest window a reconnect could possibly recover. */
  ringCapacity: number;
}

/** WS fan-out at GET /devices/:deviceId/stream. */
export const streamPlugin: FastifyPluginAsync<StreamPluginOptions> = async (app, opts) => {
  const { broadcaster, ringCapacity } = opts;

  app.route<{ Params: { deviceId: string } }>({
    method: "GET",
    url: "/devices/:deviceId/stream",
    schema: {
      summary: "WebSocket dashboard fan-out",
      description:
        "WebSocket upgrade endpoint, server to dashboard only — the dashboard " +
        "sends nothing and any message it does send is ignored. On subscribe: " +
        "{type:'ready', deviceId, serverTimeMs, ringCapacity}. Then one " +
        "{type:'frame', frame} per accepted frame (duplicates never reach it) " +
        "and one {type:'alert', alert} per lifecycle transition, both validated " +
        "by @maekbeat/protocol streamMessageSchema. Subscribing to a device the " +
        "server has not seen yet is allowed and stays quiet until its first " +
        "frame. Plain HTTP requests receive 426.",
      params: {
        type: "object",
        additionalProperties: false,
        required: ["deviceId"],
        properties: { deviceId: { type: "string", minLength: 1, maxLength: 64 } },
      },
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
    handler: (request, reply) => {
      void reply.status(426).send({
        statusCode: 426,
        message: `WebSocket upgrade required on /devices/${request.params.deviceId}/stream`,
      });
    },
    wsHandler: (socket, request) => {
      const { deviceId } = request.params as { deviceId: string };
      const send = (message: StreamMessage) => socket.send(JSON.stringify(message));

      send({
        type: "ready",
        deviceId,
        serverTimeMs: Date.now(),
        ringCapacity,
      });

      const unsubscribe = broadcaster.subscribe(deviceId, send);
      request.log.info({ deviceId }, "stream subscriber attached");

      socket.on("close", () => {
        unsubscribe();
        request.log.info({ deviceId }, "stream subscriber detached");
      });
    },
  });
};
