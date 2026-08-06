import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";

import { TraceFlags } from "@opentelemetry/api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { loadConfig } from "./config";
import { SPAN_NAMES, startTracing } from "./tracing";

/*
 * Off means off, and a stop means a stop.
 *
 * Two failures this file exists to make impossible. The first is an SDK that
 * is "disabled" and still opens a socket or arms a batch timer — invisible
 * until an operator asks why a server with tracing switched off is talking to
 * a collector. The second is the leaked handle: a provider that never releases
 * its timer keeps the process alive after SIGTERM, the orchestrator waits out
 * its grace period and SIGKILLs, and the spans of the last frames — the ones
 * worth having after an unplanned stop — are lost in exactly the incident they
 * were collected for.
 */

const SERVER_DIR = fileURLToPath(new URL("..", import.meta.url));

/** A minimal OTLP/HTTP collector: records every trace payload posted to it. */
/** A span as it appears in the OTLP JSON payload. */
interface WireSpan {
  name?: string;
  spanId?: string;
  parentSpanId?: string;
  traceId?: string;
}

interface Collector {
  url: string;
  payloads: unknown[];
  /** Every span that actually reached the wire, with its parentage intact. */
  spans: () => WireSpan[];
  close: () => Promise<void>;
}

async function startCollector(): Promise<Collector> {
  const payloads: unknown[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        payloads.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        payloads.push({ unparseable: true });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/v1/traces`,
    payloads,
    // @opentelemetry/exporter-trace-otlp-http posts OTLP JSON, so the wire
    // payload is readable here — the assertion is about what actually left the
    // process, not about what an in-memory exporter was handed.
    spans: () => {
      const out: WireSpan[] = [];
      for (const payload of payloads) {
        const resourceSpans =
          (payload as { resourceSpans?: { scopeSpans?: { spans?: WireSpan[] }[] }[] })
            .resourceSpans ?? [];
        for (const rs of resourceSpans) {
          for (const ss of rs.scopeSpans ?? []) {
            for (const span of ss.spans ?? []) out.push(span);
          }
        }
      }
      return out;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface SpawnedServer {
  child: ChildProcess;
  port: number;
  stderr: () => string;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/**
 * Starts the real process entry (src/main.ts) and waits until it reports the
 * port it bound.
 *
 * Retried, because choosing a port for another process is inherently racy:
 * `freePort` binds one, closes it, and hands over the number, and anything on
 * the machine may take it in between. That is not theoretical — this suite ran
 * green in isolation and failed about one run in four once the whole workspace
 * ran four packages' vitest processes at once. A lost race makes the child exit
 * non-zero immediately, which is a retryable condition and nothing else;
 * `PORT=0` would remove the race outright but the environment contract
 * deliberately rejects it (src/config.test.ts), and a test is not a reason to
 * widen a production contract.
 *
 * Readiness is the child's own `started` log line rather than a health poll,
 * so what is awaited is the server saying it is listening.
 */
async function startServer(env: Record<string, string>, attempt = 0): Promise<SpawnedServer> {
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      LOG_LEVEL: "info",
      HOST: "127.0.0.1",
      PORT: String(port),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));

  const started = (): boolean => stdout.includes('"started"');

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (started()) return { child, port, stderr: () => stderr };
    if (child.exitCode !== null) {
      if (attempt < 4) return startServer(env, attempt + 1);
      throw new Error(`server exited early (${String(child.exitCode)}): ${stderr}`);
    }
    if (Date.now() > deadline) throw new Error(`server never reported started: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** One valid frame, enough to open a trace. */
function frame(seq: number): string {
  return JSON.stringify({
    v: 1,
    deviceId: "lifecycle-001",
    seq,
    capturedAtMs: 1_754_265_600_000 + seq * 1_000,
    heartRateBpm: 62,
    spo2Pct: 97.5,
    respirationRpm: 14,
    motion: 0.01,
  });
}

/**
 * Sends `count` frames over one /ingest socket.
 *
 * `keepOpen` leaves the client connected, which is the case that matters:
 * a real gateway and a real dashboard hold their sockets open, and a server
 * that only stops once every client has politely disconnected is a server an
 * orchestrator has to SIGKILL.
 */
async function sendFrames(port: number, count: number, keepOpen = false): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ingest`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  for (let seq = 0; seq < count; seq++) {
    await new Promise<void>((resolve) => {
      ws.once("message", () => resolve());
      ws.send(frame(seq));
    });
  }
  if (!keepOpen) ws.close();
  return ws;
}

/**
 * Opens a WebSocket by hand and then stops co-operating.
 *
 * Written against `node:net` rather than with the `ws` client because `ws` is
 * polite by construction: its receiver answers a close frame automatically, and
 * there is no option that turns that off. A client that cannot be rude cannot
 * test what happens when one is.
 */
async function attachRudePeer(
  port: number,
): Promise<{ socket: Socket; readonly destroyed: boolean }> {
  const socket = connect(port, "127.0.0.1");
  const state = { destroyed: false };
  socket.on("close", () => (state.destroyed = true));

  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(
        [
          "GET /ingest HTTP/1.1",
          `Host: 127.0.0.1:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.once("data", (chunk: Buffer) => {
      const status = chunk.toString("latin1").split("\r\n")[0] ?? "";
      // Read and discard everything after the upgrade, the close frame
      // included. Pausing the socket instead would fill the server's send
      // buffer and make this a backpressure test, which is a different fault.
      if (status.startsWith("HTTP/1.1 101")) {
        socket.on("data", () => {});
        resolve();
      } else {
        reject(new Error(`handshake refused: ${status}`));
      }
    });
  });

  return {
    socket,
    get destroyed() {
      return state.destroyed;
    },
  };
}

/**
 * SIGTERM, then wait for the process to end by itself.
 *
 * Nothing here sends SIGKILL. src/main.ts does not call `process.exit` on the
 * successful path, so the process ends only when the event loop is empty — a
 * leaked timer or an unclosed socket hangs here and the test fails on its own
 * timeout, which is the point.
 */
function stopAndAwaitExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: string | null }> {
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  child.kill("SIGTERM");
  return exited;
}

describe("tracing off by default", () => {
  it("wires no span processor, and therefore no batch timer or exporter", async () => {
    const config = loadConfig({});
    expect(config.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBeUndefined();

    const off = startTracing(config);
    // The positive control points at a live collector rather than a dead port:
    // its shutdown flushes, and an exporter flushing into nothing retries with
    // backoff and stalls the test instead of finishing it.
    const collector = await startCollector();
    const on = startTracing(loadConfig({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: collector.url }));
    try {
      expect(off.enabled).toBe(false);

      // Asked of the SDK, not of our own intent: the provider reports the
      // processors it actually holds. No processor means no batch queue, no
      // batch timer and no exporter, because those are the things a processor
      // owns.
      //
      // An earlier version of this test compared `process.getActiveResourcesInfo()`
      // before and after. That was vacuous: BatchSpanProcessor calls `unref()`
      // on its timer, so an unref'd handle never appears in that list whether
      // tracing is on or off, and both sides of the comparison were empty. The
      // enabled handle below is the positive control that would have caught it.
      const processorsOf = (handle: { provider: unknown }): string =>
        inspect(handle.provider, { depth: 4 });
      expect(processorsOf(off)).toContain("spanProcessors: []");
      expect(processorsOf(on)).toContain("BatchSpanProcessor");

      const span = off.tracer.startSpan(SPAN_NAMES.ingest);
      span.setAttribute("probe", 1);
      span.end();

      // A non-recording span: nothing is stored and nothing can be exported.
      // The span context is still a valid, well-formed one — the specification
      // requires that, so an unsampled trace can still be propagated to a
      // downstream service — so the honest test of "off" is the sampled flag
      // and isRecording(), not an all-zero id. Asserting zeros here passed
      // nothing and would have been a test of a mistaken belief.
      expect(span.isRecording()).toBe(false);
      expect(span.spanContext().traceFlags).toBe(TraceFlags.NONE);

      // The positive control again, on the discriminator that matters most.
      const recorded = on.tracer.startSpan(SPAN_NAMES.ingest);
      expect(recorded.isRecording()).toBe(true);
      expect(recorded.spanContext().traceFlags).toBe(TraceFlags.SAMPLED);
      recorded.end();
    } finally {
      await off.shutdown();
      await on.shutdown();
      await collector.close();
    }
  }, 30_000);

  it("exits on its own with a client socket still open", async () => {
    // The case that decides whether removing process.exit(0) was safe. A
    // gateway and a dashboard both hold their sockets open indefinitely, so if
    // app.close() did not destroy live WebSocket connections the event loop
    // would never drain and the container would hang until it was SIGKILLed —
    // trading a masked leak for a real one. Nothing here closes the client.
    const server = await startServer({});
    const ws = await sendFrames(server.port, 3, true);
    expect(ws.readyState).toBe(WebSocket.OPEN);

    const exit = await stopAndAwaitExit(server.child);
    expect(exit).toEqual({ code: 0, signal: null });
    ws.terminate();
  }, 60_000);

  it("exits on its own with a peer that never answers the close frame", async () => {
    // The test above passes partly on the client's good manners: `ws` answers
    // the server's close frame, so the connection ends because both sides
    // agreed to end it. This one takes that away.
    //
    // The peer here speaks the opening handshake over a raw socket and then
    // sends nothing else — no close frame, no FIN — which is what a phone that
    // lost signal mid-episode looks like from the server. Without the sweep in
    // shutdown(), `ws` waits thirty seconds before destroying it and this test
    // fails on its timeout, exactly as a container fails with exit 137.
    const server = await startServer({});
    const peer = await attachRudePeer(server.port);
    try {
      const started = Date.now();
      const exit = await stopAndAwaitExit(server.child);
      expect(exit).toEqual({ code: 0, signal: null });
      // Under the grace plus the flush, and nowhere near `ws`'s own 30 s
      // close timeout — the number that would otherwise decide this.
      expect(Date.now() - started).toBeLessThan(10_000);
      // The server ended it, rather than the peer being outlived.
      expect(peer.destroyed).toBe(true);
    } finally {
      peer.socket.destroy();
    }
  }, 60_000);

  it("posts nothing to a reachable collector while switched off", async () => {
    const collector = await startCollector();
    const server = await startServer({});
    try {
      await sendFrames(server.port, 5);
      const exit = await stopAndAwaitExit(server.child);
      expect(exit).toEqual({ code: 0, signal: null });
      // The collector was up and reachable the whole time. Nothing was sent
      // because nothing was configured to send it.
      expect(collector.payloads).toEqual([]);
    } finally {
      await collector.close();
    }
  }, 60_000);
});

describe("the configured exporter", () => {
  it("exports on shutdown and reports itself enabled", async () => {
    const collector = await startCollector();
    const handle = startTracing(
      loadConfig({
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: collector.url,
        OTEL_SERVICE_NAME: "maekbeat-server-test",
      }),
    );
    try {
      expect(handle.enabled).toBe(true);

      const span = handle.tracer.startSpan(SPAN_NAMES.ingest);
      expect(span.isRecording()).toBe(true);
      expect(span.spanContext().traceFlags).toBe(TraceFlags.SAMPLED);
      span.end();

      // Nothing waits for the batch interval. shutdown() is the flush, which
      // is the whole reason the process entry awaits it before returning.
      await handle.shutdown();
      expect(collector.spans().map((sp) => sp.name)).toEqual([SPAN_NAMES.ingest]);

      // The resource carries the configured service name, so a span can be
      // attributed to a service rather than to an anonymous process.
      const attrs = (
        collector.payloads[0] as {
          resourceSpans: {
            resource: { attributes: { key: string; value: { stringValue: string } }[] };
          }[];
        }
      ).resourceSpans[0]?.resource.attributes;
      expect(attrs?.find((a) => a.key === "service.name")?.value.stringValue).toBe(
        "maekbeat-server-test",
      );
    } finally {
      await collector.close();
    }
  }, 30_000);

  it("is safe to shut down twice", async () => {
    const collector = await startCollector();
    const handle = startTracing(loadConfig({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: collector.url }));
    try {
      await handle.shutdown();
      await expect(handle.shutdown()).resolves.toBeUndefined();
    } finally {
      await collector.close();
    }
  }, 30_000);
});

describe("tracing on", () => {
  let collector: Collector;
  let server: SpawnedServer;

  beforeAll(async () => {
    collector = await startCollector();
    server = await startServer({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: collector.url });
  }, 60_000);

  afterAll(async () => {
    if (server.child.exitCode === null) server.child.kill("SIGKILL");
    await collector.close();
  });

  it("flushes the spans of in-flight frames on SIGTERM and exits on its own", async () => {
    await sendFrames(server.port, 5);

    // Nothing has been exported yet. Without this the test could not tell a
    // working shutdown flush from the batch processor's own 5 s interval
    // firing first on a slow machine — which would leave a completely broken
    // flush green.
    expect(collector.payloads).toEqual([]);

    // No sleep and no flush interval waited out: the frames are sent, then the
    // signal. Anything the batch processor is still holding has to survive the
    // shutdown path, which is the only reason those spans exist.
    const exit = await stopAndAwaitExit(server.child);
    expect(exit).toEqual({ code: 0, signal: null });

    const wire = collector.spans();
    const names = wire.map((sp) => sp.name);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names)).toEqual(
      new Set([
        SPAN_NAMES.ingest,
        SPAN_NAMES.validate,
        SPAN_NAMES.store,
        SPAN_NAMES.evaluate,
        SPAN_NAMES.fanout,
      ]),
    );
    expect(names.filter((n) => n === SPAN_NAMES.ingest)).toHaveLength(5);

    // The SHAPE reaches the wire, not merely the names. Asserting names alone
    // would accept 25 correctly-named roots — the exact failure the in-memory
    // shape suite exists to reject — so parentage is read from the OTLP
    // payload's own parentSpanId: five roots, one per frame, and every other
    // span pointing at a span in the same batch.
    const roots = wire.filter((sp) => sp.parentSpanId === undefined || sp.parentSpanId === "");
    expect(roots).toHaveLength(5);
    expect(roots.every((sp) => sp.name === SPAN_NAMES.ingest)).toBe(true);
    expect(new Set(wire.map((sp) => sp.traceId)).size).toBe(5);

    const ids = new Set(wire.map((sp) => sp.spanId));
    for (const sp of wire) {
      if (sp.parentSpanId === undefined || sp.parentSpanId === "") continue;
      expect(ids.has(sp.parentSpanId)).toBe(true);
    }
  }, 60_000);
});
