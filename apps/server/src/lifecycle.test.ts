import { EventEmitter } from "node:events";

import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  PEER_CLOSE_GRACE_MS,
  SHUTDOWN_SIGNALS,
  installShutdownHandlers,
  shutdown,
} from "./lifecycle";

function silentLog(): FastifyBaseLogger {
  const log = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    level: "silent",
  };
  return { ...log, child: () => log } as unknown as FastifyBaseLogger;
}

/** Records the order the two stages ran in. */
function stages(options: { closeFails?: boolean; flushFails?: boolean } = {}) {
  const order: string[] = [];
  const app = {
    log: silentLog(),
    close: async () => {
      if (options.closeFails === true) throw new Error("close failed");
      order.push("app.close");
    },
  };
  const tracing = {
    shutdown: async () => {
      if (options.flushFails === true) throw new Error("ECONNREFUSED");
      order.push("tracing.shutdown");
    },
  };
  return { app, tracing, order };
}

describe("shutdown", () => {
  it("closes the server before flushing tracing", async () => {
    const { app, tracing, order } = stages();
    await shutdown(app, tracing, "SIGTERM");
    // Order, not merely presence: in-flight requests are still opening spans
    // while app.close() drains them, so a flush that ran first would export a
    // batch and leave the last spans unsent.
    expect(order).toEqual(["app.close", "tracing.shutdown"]);
  });

  it("treats an unreachable collector as a successful stop", async () => {
    const { app, tracing } = stages({ flushFails: true });
    // The signal would otherwise be exactly inverted: a server that carried
    // traffic has spans buffered and would fail its stop on every deploy while
    // the collector was down, while an idle one with nothing to flush would
    // stop clean. Telemetry that cannot be delivered is logged, not promoted
    // into the exit code.
    await expect(shutdown(app, tracing, "SIGTERM")).resolves.toBeUndefined();
    expect(app.log.error).toHaveBeenCalled();
  });

  it("does not flush when the server fails to close", async () => {
    const { app, tracing, order } = stages({ closeFails: true });
    await expect(shutdown(app, tracing, "SIGTERM")).rejects.toThrow("close failed");
    expect(order).toEqual([]);
  });
});

describe("shutdown, with a peer that ignores its close frame", () => {
  /**
   * A server whose `close()` resolves only once every peer is gone — which is
   * what @fastify/websocket's does, and the reason an unanswered close frame
   * blocks a stop rather than slowing it.
   */
  function serverBlockedByPeers(count: number) {
    const peers = Array.from({ length: count }, () => ({ terminate: vi.fn() }));
    const live = new Set(peers);
    for (const peer of peers) {
      peer.terminate.mockImplementation(() => live.delete(peer));
    }
    const app = {
      log: silentLog(),
      websocketServer: { clients: live },
      close: async () => {
        while (live.size > 0) await new Promise((resolve) => setTimeout(resolve, 5));
      },
    };
    return { app, peers };
  }

  const tracing = { shutdown: async () => {} };

  it("destroys the peer, so the stop finishes instead of waiting for SIGKILL", async () => {
    const { app, peers } = serverBlockedByPeers(2);

    // No fake timers: the assertion is that this resolves at all. With the
    // sweep removed the promise never settles and the test fails on vitest's
    // own timeout, which is the same failure mode a container shows as a
    // 137 — a stop that had to be ended by something other than the server.
    await shutdown(app, tracing, "SIGTERM");

    for (const peer of peers) expect(peer.terminate).toHaveBeenCalledTimes(1);
    expect(app.log.warn).toHaveBeenCalled();
  });

  it("leaves a peer that answers in time alone", async () => {
    // The control that keeps the rule honest. Destroying every peer on every
    // stop would pass the test above and would cut off the close handshake of
    // clients that were leaving properly — a fix that breaks the polite case
    // is not a fix.
    //
    // The polite peer takes 150 ms to leave, because a close handshake is a
    // round trip and not a synchronous delete. An earlier version of this test
    // had it leave immediately, and that version passed with the grace set to
    // zero: `close()` resolved on a microtask and cancelled the sweep before a
    // 0 ms timer could fire, so it asserted only that `terminate` is not called
    // synchronously. The delay is what makes the grace a number this test can
    // be wrong about.
    const peer = { terminate: vi.fn() };
    const live = new Set([peer]);
    const app = {
      log: silentLog(),
      websocketServer: { clients: live },
      close: () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            live.delete(peer);
            resolve();
          }, 150),
        ),
    };

    await shutdown(app, tracing, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, PEER_CLOSE_GRACE_MS + 50));

    expect(peer.terminate).not.toHaveBeenCalled();
    expect(app.log.warn).not.toHaveBeenCalled();
  });

  it("says nothing when a slow close has no peers left to destroy", async () => {
    // A stop can outlast the grace for reasons that have nothing to do with
    // sockets — a long in-flight request, a loaded machine. The sweep still
    // fires, and it must find nothing to say: a warn line on every slow but
    // healthy shutdown would train an operator to ignore the one that matters.
    for (const app of [
      { log: silentLog(), websocketServer: { clients: new Set<{ terminate: () => void }>() } },
      // And a server built without @fastify/websocket at all, which is what
      // the optional property exists for.
      { log: silentLog() },
    ]) {
      const slow = {
        ...app,
        close: () => new Promise<void>((resolve) => setTimeout(resolve, PEER_CLOSE_GRACE_MS + 50)),
      };
      await shutdown(slow, tracing, "SIGTERM");
      expect(slow.log.warn).not.toHaveBeenCalled();
    }
  }, 10_000);

  it("cancels the sweep when the close fails, leaving no timer behind", async () => {
    const peer = { terminate: vi.fn() };
    const app = {
      log: silentLog(),
      websocketServer: { clients: new Set([peer]) },
      close: async () => {
        throw new Error("close failed");
      },
    };

    await expect(shutdown(app, tracing, "SIGTERM")).rejects.toThrow("close failed");
    await new Promise((resolve) => setTimeout(resolve, PEER_CLOSE_GRACE_MS + 50));

    // A failed stop must not also become a hung one: a live timer would hold
    // the event loop open past the error that ended the shutdown.
    expect(peer.terminate).not.toHaveBeenCalled();
  });
});

describe("installShutdownHandlers", () => {
  it.each(SHUTDOWN_SIGNALS)("runs the full sequence on %s", async (signal) => {
    const { app, tracing, order } = stages();
    const target = new EventEmitter();
    const exit = vi.fn();

    installShutdownHandlers(app, tracing, target, exit);
    target.emit(signal);
    await vi.waitFor(() => expect(order).toEqual(["app.close", "tracing.shutdown"]));

    // The successful path never exits explicitly: the process is meant to end
    // by draining its event loop, so that a leaked handle hangs visibly
    // instead of being papered over by process.exit(0).
    expect(exit).not.toHaveBeenCalled();
  });

  it("does not exit non-zero when only the tracing flush fails", async () => {
    const { app, tracing, order } = stages({ flushFails: true });
    const target = new EventEmitter();
    const exit = vi.fn();

    installShutdownHandlers(app, tracing, target, exit);
    target.emit("SIGTERM");
    await vi.waitFor(() => expect(order).toEqual(["app.close"]));

    // The end-to-end form of the rule above: an unreachable collector is a
    // logged telemetry failure, and the process still stops cleanly.
    expect(exit).not.toHaveBeenCalled();
  });

  it("exits non-zero when the shutdown sequence fails", async () => {
    const { app, tracing } = stages({ closeFails: true });
    const target = new EventEmitter();
    const exit = vi.fn();

    installShutdownHandlers(app, tracing, target, exit);
    target.emit("SIGTERM");

    // An orchestrator has to be able to tell a clean stop from a broken one.
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(app.log.error).toHaveBeenCalled();
  });

  it("handles each signal once, so a repeated signal cannot re-enter", async () => {
    const { app, tracing, order } = stages();
    const target = new EventEmitter();

    installShutdownHandlers(app, tracing, target, vi.fn());
    target.emit("SIGTERM");
    target.emit("SIGTERM");
    await vi.waitFor(() => expect(order).toEqual(["app.close", "tracing.shutdown"]));

    // A second SIGTERM while the first is draining must not start a second
    // close-then-flush: the exporter would be shut down twice and the second
    // flush would race the first.
    expect(order).toEqual(["app.close", "tracing.shutdown"]);
  });
});
