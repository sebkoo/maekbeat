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

  /**
   * Subscribers dropped for falling too far behind (see
   * STREAM_MAX_BUFFERED_BYTES). Counted rather than only logged, for the same
   * reason `forcedEvictions` is: a bound that discards something has to be able
   * to say how often it did.
   */
  readonly stats = { slowSubscribersDropped: 0 };

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

/**
 * How many bytes of undelivered fan-out one subscriber may hold before it is
 * dropped instead of buffered.
 *
 * The number, and why this one. A stalled subscriber's queue is `ws`'s
 * `bufferedAmount`, and it tracks what was published almost exactly: a peer
 * that completes the handshake and then never reads held 12.1 MB against
 * 12.7 MB published over 60 000 frames, with nothing dropped and nothing
 * closed (measured 2026-08-06, apps/server, one device, ingest under flow
 * control). One fan-out frame message is 211 bytes on the wire, so a device at
 * 1 Hz adds about 18 MB a day for as long as the socket stays open. That was
 * the C11 gap this replaces: the only client-driven memory growth in the
 * server, where the ring buffer, alert history, dedupe set and inbound payload
 * each carry a number.
 *
 * 256 KiB is one default ring's worth, rounded up to a power of two —
 * `RING_CAPACITY` is 1024 frames, which is about 216 KB of fan-out. That is
 * the argument rather than a taste: past a ring's worth behind, a subscriber
 * has nothing left to gain from staying attached, because reconnecting
 * back-fills the whole ring over REST and anything older is evicted and gone.
 * It is a flat constant rather than a function of `RING_CAPACITY` because the
 * two are different bounds — one is per device in the store, this is per
 * socket in the transport — and coupling them would let a store-capacity
 * change silently retune the network path.
 */
export const STREAM_MAX_BUFFERED_BYTES = 256 * 1024;

/**
 * Close code for a subscriber dropped by that bound: 1013, "Try Again Later".
 * Registered for a server shedding load on a temporary condition, which is
 * exactly the claim — reconnecting is the correct response and the dashboard
 * already makes it.
 */
export const STREAM_SLOW_SUBSCRIBER_CLOSE = 1013;

/**
 * How long a fan-out socket may stay silent before the server pings it.
 *
 * This is a WebSocket control frame, not a protocol message, and the
 * distinction is the whole design. `streamMessageSchema` is a strict union of
 * `ready`, `frame`, `alert` and `decision` — packages/protocol/src/stream.test.ts
 * asserts that `{type:"heartbeat"}` is rejected — so a keepalive invented at
 * the application layer would be a fourth message every client had to learn,
 * including apps/ios, and would break both of them the day it shipped. A ping
 * is answered by the browser's WebSocket implementation, by `ws` and by
 * `URLSessionWebSocketTask` without any of them being told, and it is invisible
 * to every `onmessage` handler in this repository.
 *
 * Why a fan-out socket needs one at all, and why /ingest does not: a dashboard
 * watching a device that has stopped sending receives nothing, indefinitely.
 * That is the ordinary case rather than the broken one — device disconnect is
 * the first failure mode in docs/ARCHITECTURE.md — and a socket carrying no
 * bytes is what every intermediary between the two ends calls dead. An AWS
 * load balancer's idle timeout defaults to 60 seconds and nginx's
 * `proxy_read_timeout` to the same, so an idle dashboard loses its connection
 * on a timer and reconnects on the next one, forever. The ingest socket is
 * driven by a device that is either sending or genuinely gone.
 *
 * 25 seconds, so that two pings fit inside the smallest of those defaults and
 * one lost ping does not close a healthy connection. It is the server's stated
 * maximum silence on a /stream socket, which is the number any proxy in front
 * of this server has to beat — infra/cdk asserts exactly that against the load
 * balancer it synthesizes, reading this value rather than restating it.
 */
export const STREAM_HEARTBEAT_MS_DEFAULT = 25_000;

export interface StreamPluginOptions {
  broadcaster: DeviceBroadcaster;
  /** Frames the store keeps per device; sent in `ready` so a client knows the
   *  largest window a reconnect could possibly recover. */
  ringCapacity: number;
  /** Silence allowed on a subscriber socket before a ping; see
   *  STREAM_HEARTBEAT_MS_DEFAULT for the number and the reasoning. */
  heartbeatMs: number;
}

/** WS fan-out at GET /devices/:deviceId/stream. */
export const streamPlugin: FastifyPluginAsync<StreamPluginOptions> = async (app, opts) => {
  const { broadcaster, ringCapacity, heartbeatMs } = opts;

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

      // Set by the drop below so nothing sends into a socket already being
      // closed.
      let dropped = false;
      // Assigned once `subscribe` returns, and declared here rather than as a
      // `const` below: the `ready` greeting is sent before this subscribes, so
      // the drop path has to be callable from a line that runs first. Left
      // undefined rather than given a no-op, so the one case where there is
      // nothing to unsubscribe is a value the reader can see instead of a
      // function nothing ever calls.
      let unsubscribe: (() => void) | undefined;

      /**
       * Deliberately not `unref()`d.
       *
       * An unref'd timer cannot hold the event loop open, which sounds like
       * the safe choice and would cost the only test that can see this timer
       * at all. src/lifecycle.ts is explicit about what it buys — "a ref'd
       * handle left by anything else, a stray interval, an unclosed server,
       * hangs the stop visibly rather than being papered over by an
       * unconditional exit" — so a heartbeat that outlived its socket would
       * turn a clean SIGTERM into a hung process, which is a failure with a
       * test rather than a leak without one. The correctness requirement is
       * therefore that `stop` runs on every path out of this socket, and
       * src/stream.heartbeat.test.ts spawns a real server and asserts it
       * still exits.
       *
       * There is no `readyState` check around the ping, and that is checked
       * rather than assumed. One was written here first, on the theory that
       * pinging a CLOSING socket raises; it does not. `ws` routes a ping off
       * OPEN into `sendAfterClose`, which with no payload and no callback
       * increments nothing, emits nothing and throws nothing — verified
       * against ws 8.18 with a peer that ignores its close frame. A guard no
       * test can tell from its absence is noise, so it was deleted instead of
       * kept for appearances. CONNECTING is the one state that does raise, and
       * this interval is armed inside `wsHandler`, after the upgrade.
       */
      const heartbeat = setInterval(() => socket.ping(), heartbeatMs);

      /** Every exit from this socket runs through here; see `heartbeat`. */
      const stop = () => {
        clearInterval(heartbeat);
        unsubscribe?.();
      };

      /**
       * Publish one message, unless this subscriber is already too far behind.
       *
       * The check is before the write rather than after it, so the queue
       * exceeds the bound by at most the one message that crossed it. Dropping
       * the subscriber is the whole response: dropping individual messages
       * instead would keep the socket open and lose frames with no signal on
       * it, and a dashboard cannot draw a gap it was never told about. A close
       * it can see — apps/web retries with capped backoff and re-reads the ring
       * over REST on every re-open (src/api/stream.ts), and apps/ios follows
       * the same rules — so the loss becomes a gap the chart renders rather
       * than a line drawn across missing data.
       */
      const send = (message: StreamMessage) => {
        if (dropped) return;
        if (socket.bufferedAmount > STREAM_MAX_BUFFERED_BYTES) {
          dropped = true;
          broadcaster.stats.slowSubscribersDropped += 1;
          stop();
          // At warn: a caregiver dashboard that cannot keep up is an
          // operational fact, and the C11 version of this was memory growth
          // that nothing counted and nothing said anything about.
          request.log.warn(
            { deviceId, bufferedBytes: socket.bufferedAmount, limit: STREAM_MAX_BUFFERED_BYTES },
            "dropping stream subscriber that fell behind the send buffer limit",
          );
          socket.close(STREAM_SLOW_SUBSCRIBER_CLOSE, "stream buffer limit exceeded");
          return;
        }
        socket.send(JSON.stringify(message));
      };

      send({
        type: "ready",
        deviceId,
        serverTimeMs: Date.now(),
        ringCapacity,
      });

      unsubscribe = broadcaster.subscribe(deviceId, send);
      request.log.info({ deviceId }, "stream subscriber attached");

      socket.on("close", () => {
        stop();
        request.log.info({ deviceId }, "stream subscriber detached");
      });
    },
  });
};
