import type { EventEmitter } from "node:events";

import type { FastifyBaseLogger } from "fastify";

/** The part of a Fastify instance a shutdown needs. */
export interface ClosableServer {
  close: () => Promise<void>;
  log: FastifyBaseLogger;
}

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
 */
export async function shutdown(
  app: ClosableServer,
  tracing: FlushableTracing,
  signal: string,
): Promise<void> {
  app.log.info({ signal }, "shutting down");
  await app.close();
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
 * Residual, unfixed and pre-dating this commit: `app.close()` asks
 * @fastify/websocket to close its clients but does not destroy an uncooperative
 * one, so a peer that completes the handshake and then ignores the close frame
 * keeps the process alive until the orchestrator's SIGKILL. A polite client
 * stops it in milliseconds (src/tracing.lifecycle.test.ts).
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
