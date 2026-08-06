import { EventEmitter } from "node:events";

import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { SHUTDOWN_SIGNALS, installShutdownHandlers, shutdown } from "./lifecycle";

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
