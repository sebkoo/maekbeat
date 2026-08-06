/*
 * Test scaffolding: waiting on conditions, and driving a real server process.
 *
 * Part one — waiting for a condition instead of for the clock.
 *
 * The bug this file exists to stop: src/stream.test.ts asserted that a
 * dashboard had received 110 fan-out messages after a fixed 40 ms wait. Fan-out
 * is asynchronous, so the number that has arrived by any given millisecond is a
 * property of the machine, not of the server. On a loaded CI runner 76 had
 * arrived and the build went red; on every developer machine it passed, which
 * is worse — the local gate's guarantee was environment-dependent, and had been
 * since C11.
 *
 * Nothing here weakens an assertion. A server that genuinely drops a frame
 * still fails: the wait expires and the test asserts the real count, which is
 * the same assertion it made before, made at a defensible moment.
 *
 * Part two — the process harness below (`startSpawnedServer`, `stopAndAwaitExit`,
 * `startCollector`). It began inside src/tracing.lifecycle.test.ts and moved
 * here at C19 when the load suite needed the same three things: an exit code is
 * only assertable against a real process, and a second copy of a racy
 * port-picking retry loop is a copy that drifts.
 *
 * It sits beside the configs rather than in src/ for the reason
 * apps/web/vitest.setup.ts does: it is test scaffolding, not app code, and the
 * coverage denominator is src/ — which stays exactly as wide as it was. This is
 * not an exclude entry (CLAUDE.md forbids those); the include glob is untouched.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { streamMessageSchema, type StreamMessage } from "@maekbeat/protocol";
import WebSocket from "ws";

import { buildApp } from "./src/app";
import { loadConfig } from "./src/config";

/**
 * How long a condition gets before the wait is called a failure.
 *
 * Deliberately under vitest's own 5 s `testTimeout`: whichever fires first
 * writes the failure message, and "timed out waiting for 110 frame messages;
 * received 76" is a bug report, where "Test timed out in 5000ms" is a shrug.
 * Three seconds is seventy-five times the fixed pause this replaced.
 */
export const DEFAULT_WAIT_MS = 3_000;

/**
 * Resolves once `condition` holds. Generous by default, because the timeout is
 * not the assertion — it is the point at which waiting longer would only make a
 * red build slower.
 *
 * @throws when the condition never holds, naming what was awaited and what the
 * observed value was, so a timeout reads like the failure it is rather than
 * like a mystery.
 */
export async function waitFor(
  condition: () => boolean,
  describe: () => string,
  timeoutMs: number = DEFAULT_WAIT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (condition()) return;
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${describe()}`);
}

/**
 * A fixed pause, for the one thing a condition cannot express: that nothing
 * *else* is going to arrive.
 *
 * Waiting on an absence is not solvable by polling — no amount of looking proves
 * a message will never come — so a negative assertion needs a grace period, and
 * saying so is better than pretending otherwise. Use it only after a positive
 * condition has already been awaited, so the grace covers the gap between the
 * message that should arrive and the one that should not, never the whole
 * delivery.
 */
export async function graceForAbsence(ms = 50): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const SERVER_DIR = fileURLToPath(new URL(".", import.meta.url));

/** A span as it appears in the OTLP JSON payload. */
export interface WireSpan {
  name?: string;
  spanId?: string;
  parentSpanId?: string;
  traceId?: string;
}

/** A minimal OTLP/HTTP collector: records every trace payload posted to it. */
export interface Collector {
  url: string;
  payloads: unknown[];
  /** How many export requests arrived, including the ones answered with an error. */
  requests: () => number;
  /** Every span that actually reached the wire, with its parentage intact. */
  spans: () => WireSpan[];
  close: () => Promise<void>;
}

export interface CollectorOptions {
  /**
   * Answer every export with this status instead of 200. Use 400: it is the
   * one failure the OTLP exporter treats as final, so a rejecting collector
   * fails the flush immediately rather than retrying with backoff and turning
   * a test about the exit code into a test about a retry schedule.
   */
  status?: number;
}

export async function startCollector(options: CollectorOptions = {}): Promise<Collector> {
  const status = options.status ?? 200;
  const payloads: unknown[] = [];
  let requests = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests += 1;
      try {
        payloads.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        payloads.push({ unparseable: true });
      }
      res.writeHead(status, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/v1/traces`,
    payloads,
    requests: () => requests,
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

export interface SpawnedServer {
  child: ChildProcess;
  port: number;
  stderr: () => string;
  stdout: () => string;
}

export async function freePort(): Promise<number> {
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
 * the machine may take it in between. That is not theoretical — the tracing
 * suite ran green in isolation and failed about one run in four once the whole
 * workspace ran four packages' vitest processes at once. A lost race makes the
 * child exit non-zero immediately, which is a retryable condition and nothing
 * else; `PORT=0` would remove the race outright but the environment contract
 * deliberately rejects it (src/config.test.ts), and a test is not a reason to
 * widen a production contract.
 *
 * Readiness is the child's own `started` log line rather than a health poll,
 * so what is awaited is the server saying it is listening.
 */
export async function startSpawnedServer(
  env: Record<string, string>,
  attempt = 0,
): Promise<SpawnedServer> {
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
    if (started()) return { child, port, stderr: () => stderr, stdout: () => stdout };
    if (child.exitCode !== null) {
      if (attempt < 4) return startSpawnedServer(env, attempt + 1);
      throw new Error(`server exited early (${String(child.exitCode)}): ${stderr}`);
    }
    if (Date.now() > deadline) throw new Error(`server never reported started: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * SIGTERM, then wait for the process to end by itself.
 *
 * Nothing here sends SIGKILL. src/main.ts does not call `process.exit` on the
 * successful path, so the process ends only when the event loop is empty — a
 * leaked timer or an unclosed socket hangs here and the test fails on its own
 * timeout, which is the point.
 */
export function stopAndAwaitExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: string | null }> {
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  child.kill("SIGTERM");
  return exited;
}

/*
 * Part three — an in-process server and the sockets attached to it.
 *
 * Shared by src/load.test.ts and src/fanout-bound.test.ts — the load suite and
 * the bound it measured — which need the same four things. A second copy would
 * show up as the two files disagreeing about the same server.
 */

/**
 * Teardown in reverse registration order.
 *
 * The order is the whole reason this is a type rather than an array. The app is
 * registered first and has to close last, because `app.close()` waits on
 * WebSocket peers and these suites deliberately attach peers that never answer;
 * closing forwards hangs the hook for the thirty seconds `ws` gives an
 * unresponsive client — the same wait the C19 shutdown sweep exists to cut
 * short, met in a test hook instead of a container.
 */
export class Closers {
  private readonly fns: Array<() => Promise<void>> = [];

  add(fn: () => Promise<void>): void {
    this.fns.push(fn);
  }

  async closeAll(): Promise<void> {
    for (const fn of this.fns.splice(0).reverse()) await fn();
  }
}

/** Yields to the event loop so an in-process server can actually run. */
export const tick = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 0));

/** One valid resting frame: in range for every rule, so it raises nothing. */
export function restFrame(deviceId: string, seq: number): string {
  return JSON.stringify({
    v: 1,
    deviceId,
    seq,
    capturedAtMs: 1_754_265_600_000 + seq * 1_000,
    heartRateBpm: 62,
    spo2Pct: 97.5,
    respirationRpm: 14,
    motion: 0.01,
  });
}

export interface RunningApp {
  app: Awaited<ReturnType<typeof buildApp>>;
  port: number;
}

export async function startInProcess(
  closers: Closers,
  env: Record<string, string> = {},
): Promise<RunningApp> {
  const app = await buildApp(loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent", ...env }));
  await app.listen({ host: "127.0.0.1", port: 0 });
  closers.add(async () => {
    await app.close();
  });
  return { app, port: (app.server.address() as AddressInfo).port };
}

export async function openSocket(url: string, closers: Closers): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  closers.add(async () => {
    socket.terminate();
  });
  return socket;
}

export interface Watcher {
  socket: WebSocket;
  messages: StreamMessage[];
  frames: () => StreamMessage[];
}

/**
 * Subscribes to a device's fan-out and validates every message against the
 * shared contract, so a server-side drift fails here rather than in a browser.
 *
 * The listener is attached before the open is awaited, not after. `ready` is
 * sent the instant the upgrade completes, and a listener registered on the next
 * turn of the loop misses it — which is a lost greeting today and a lost frame
 * the moment ingest is already running. It cost the load suite its first three
 * red runs.
 */
export async function watch(port: number, deviceId: string, closers: Closers): Promise<Watcher> {
  const messages: StreamMessage[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/devices/${deviceId}/stream`);
  socket.on("message", (data: Buffer) => {
    messages.push(streamMessageSchema.parse(JSON.parse(data.toString("utf8"))));
  });
  closers.add(async () => {
    socket.terminate();
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  await waitFor(
    () => messages.length >= 1,
    () => `the ready greeting for ${deviceId}`,
  );
  return { socket, messages, frames: () => messages.filter((m) => m.type === "frame") };
}
