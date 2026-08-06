import type { EventEmitter } from "node:events";

import type { FastifyBaseLogger } from "fastify";

/** A WebSocket peer, reduced to the one thing a shutdown does to it. */
export interface DestroyablePeer {
  terminate: () => void;
}

/** The part of a Fastify instance a shutdown needs. */
export interface ClosableServer {
  close: () => Promise<void>;
  log: FastifyBaseLogger;
  /**
   * The live WebSocket peers, present once @fastify/websocket is registered
   * (src/app.ts). Optional and read through `?.` because the shutdown sequence
   * is also driven by tests that build no socket server, and because a server
   * that has none is not a server that stops differently.
   */
  websocketServer?: { clients: Iterable<DestroyablePeer> };
}

/**
 * How long a peer is given to answer the close frame before it is destroyed.
 *
 * Long enough that a client on a slow link finishes its own handshake, and
 * short enough to leave the rest of a ten-second container grace period for
 * the tracing flush that follows — the `stop_grace_period` the C19 compose
 * stack sets.
 */
export const PEER_CLOSE_GRACE_MS = 1_000;

/** The part of a TracingHandle a shutdown needs. */
export interface FlushableTracing {
  shutdown: () => Promise<void>;
}

/** Signals an orchestrator uses to ask for a stop. */
export const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT"] as const;

/**
 * Stops the server, then flushes tracing — in that order, and never the other
 * way round.
 *
 * `app.close()` stops accepting connections and lets in-flight requests
 * finish, and those requests are the ones still opening spans. Flushing first
 * would export a batch and then generate spans nothing will ever send, which
 * is worse than not tracing: the trace would end mid-request and an operator
 * would read a truncated trace as a truncated request.
 *
 * Asking politely is the first move and cannot be the only one.
 * `app.close()` has @fastify/websocket send every peer a close frame and then
 * wait for each to answer, and a peer is under no obligation to. A phone that
 * lost signal mid-episode never will, and `ws` waits thirty seconds before
 * destroying it — three times a typical container grace period, so the
 * orchestrator's SIGKILL arrives first and takes the tracing flush, the
 * shutdown log line and the exit code with it. So a sweep is armed alongside
 * the close: whoever has not left after PEER_CLOSE_GRACE_MS is destroyed.
 */
export async function shutdown(
  app: ClosableServer,
  tracing: FlushableTracing,
  signal: string,
): Promise<void> {
  app.log.info({ signal }, "shutting down");
  // Armed before the close rather than after it: `await app.close()` is
  // exactly what an unanswered close frame blocks, so a sweep sequenced after
  // it would be scheduled by a line that never runs.
  const sweep = setTimeout(() => {
    const lingering = [...(app.websocketServer?.clients ?? [])];
    if (lingering.length === 0) return;
    // At warn, because a peer that ignored its close frame is an operational
    // fact about the fleet — one that would otherwise be visible only as a
    // shutdown that is slower than it should be.
    app.log.warn(
      { peers: lingering.length, graceMs: PEER_CLOSE_GRACE_MS },
      "destroying websocket peers that did not answer the close frame",
    );
    for (const peer of lingering) peer.terminate();
  }, PEER_CLOSE_GRACE_MS);
  try {
    await app.close();
  } finally {
    // Unconditional: a close that throws must not leave a live timer holding
    // the event loop open, which would turn a failed stop into a hung one.
    clearTimeout(sweep);
  }
  // A flush that cannot reach its collector is not a broken stop, and must not
  // become one. Letting it decide the exit code inverts the signal exactly:
  // a server that carried traffic has spans to flush and would exit non-zero
  // on every deploy while the collector was down, and an idle server with
  // nothing buffered would exit clean. Telemetry failing is logged; the stop
  // itself succeeded.
  try {
    await tracing.shutdown();
  } catch (err: unknown) {
    app.log.error({ err }, "tracing flush failed during shutdown");
  }
}

/**
 * Wires SIGTERM and SIGINT to `shutdown`.
 *
 * There is deliberately no `process.exit(0)` on the successful path: the
 * process ends when the event loop drains, so it exits by itself if and only
 * if nothing is left holding it. A failed close does exit non-zero, because an
 * orchestrator has to be able to tell a clean stop from a broken one.
 *
 * What that does and does not buy, stated precisely, because the obvious claim
 * is wrong: it does NOT make a leaked exporter timer observable.
 * `BatchSpanProcessor` calls `unref()` on its timer, and an unref'd handle
 * never holds the loop open and never appears in
 * `process.getActiveResourcesInfo()` — so that particular leak is unobservable
 * this way whether tracing is on or off, and src/tracing.ts checks the
 * provider's processor list instead. What it does buy is real and narrower: a
 * ref'd handle left by anything else — a stray interval, an unclosed server —
 * hangs the stop visibly rather than being papered over by an unconditional
 * exit.
 *
 * The residual C18 named here — an uncooperative peer keeping the process
 * alive until the orchestrator's SIGKILL — is closed by the sweep in
 * `shutdown` above, and both cases are now asserted against a real spawned
 * server: a polite client stops it in milliseconds, and one that answers
 * nothing is destroyed after the grace (src/tracing.lifecycle.test.ts).
 *
 * `target` and `exit` are parameters rather than defaults so the wiring is
 * testable without a test emitting real signals into its own runner — and so
 * that what this function touches is stated at the one call site that touches
 * it (src/main.ts) instead of hidden in a default nothing exercises.
 */
export function installShutdownHandlers(
  app: ClosableServer,
  tracing: FlushableTracing,
  target: EventEmitter,
  exit: (code: number) => void,
): void {
  for (const signal of SHUTDOWN_SIGNALS) {
    target.once(signal, () => {
      shutdown(app, tracing, signal).catch((err: unknown) => {
        app.log.error({ err }, "shutdown failed");
        exit(1);
      });
    });
  }
}
