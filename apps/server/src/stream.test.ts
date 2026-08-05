import { streamMessageSchema, type StreamMessage } from "@maekbeat/protocol";
import { takeFrames } from "@maekbeat/vitals-sim";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { buildApp } from "./app";
import { loadConfig } from "./config";
import { DeviceBroadcaster } from "./stream";

const STORED = {
  v: 1 as const,
  deviceId: "dev-1",
  seq: 3,
  capturedAtMs: 1_754_000_003_000,
  heartRateBpm: 71,
  spo2Pct: 97.1,
  respirationRpm: 14,
  motion: 0.1,
  receivedAtMs: 1_754_000_003_200,
  sessionEpoch: 1,
};

describe("DeviceBroadcaster", () => {
  it("delivers a device's frames only to that device's subscribers", () => {
    const broadcaster = new DeviceBroadcaster();
    const one: StreamMessage[] = [];
    const other: StreamMessage[] = [];
    broadcaster.subscribe("dev-1", (message) => one.push(message));
    broadcaster.subscribe("dev-2", (message) => other.push(message));

    broadcaster.publishFrame(STORED);

    expect(one).toEqual([{ type: "frame", frame: STORED }]);
    expect(other).toEqual([]);
  });

  it("stops delivering after unsubscribe and forgets the device", () => {
    const broadcaster = new DeviceBroadcaster();
    const received: StreamMessage[] = [];
    const unsubscribe = broadcaster.subscribe("dev-1", (message) => received.push(message));

    broadcaster.publishFrame(STORED);
    unsubscribe();
    broadcaster.publishFrame({ ...STORED, seq: 4 });

    expect(received).toHaveLength(1);
    expect(broadcaster.subscriberCount("dev-1")).toBe(0);
    expect(broadcaster.subscriberCount()).toBe(0);
  });

  it("keeps one broken subscriber from breaking ingest for the others", () => {
    const broadcaster = new DeviceBroadcaster();
    const survived: StreamMessage[] = [];
    broadcaster.subscribe("dev-1", () => {
      throw new Error("socket already closed");
    });
    broadcaster.subscribe("dev-1", (message) => survived.push(message));

    expect(() => broadcaster.publishFrame(STORED)).not.toThrow();
    expect(survived).toHaveLength(1);
  });

  it("fans one frame out to every dashboard watching that device", () => {
    const broadcaster = new DeviceBroadcaster();
    const first: StreamMessage[] = [];
    const second: StreamMessage[] = [];
    const dropFirst = broadcaster.subscribe("dev-1", (message) => first.push(message));
    broadcaster.subscribe("dev-1", (message) => second.push(message));
    expect(broadcaster.subscriberCount("dev-1")).toBe(2);

    broadcaster.publishFrame(STORED);
    dropFirst();
    broadcaster.publishFrame({ ...STORED, seq: 4 });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
    expect(broadcaster.subscriberCount("dev-1")).toBe(1);
  });

  it("publishing to a device nobody watches is a no-op", () => {
    const broadcaster = new DeviceBroadcaster();
    expect(() => broadcaster.publishFrame(STORED)).not.toThrow();
    expect(broadcaster.subscriberCount("dev-1")).toBe(0);
  });
});

describe("GET /devices/:deviceId/stream", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  async function startServer() {
    const app = await buildApp(loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }));
    await app.listen({ host: "127.0.0.1", port: 0 });
    closers.push(async () => {
      await app.close();
    });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    return { app, base: `127.0.0.1:${address.port}` };
  }

  function connect(base: string, path: string) {
    const socket = new WebSocket(`ws://${base}${path}`);
    const messages: StreamMessage[] = [];
    socket.on("message", (data) => {
      // Every message the dashboard receives is validated against the shared
      // contract here, so a server-side drift fails this suite, not the browser.
      messages.push(streamMessageSchema.parse(JSON.parse(data.toString())));
    });
    closers.push(async () => {
      socket.close();
    });
    return { socket, messages };
  }

  const opened = (socket: WebSocket) =>
    new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

  it("greets a subscriber with the ring capacity it could back-fill from", async () => {
    const { base } = await startServer();
    const dash = connect(base, "/devices/dev-1/stream");
    await opened(dash.socket);
    await settle();

    expect(dash.messages[0]).toEqual({
      type: "ready",
      deviceId: "dev-1",
      serverTimeMs: expect.any(Number),
      ringCapacity: 1024,
    });
  });

  it("pushes accepted frames and alert transitions, frame before its alert", async () => {
    const { base } = await startServer();
    const dash = connect(base, "/devices/sim-anomaly/stream");
    await opened(dash.socket);

    const ingest = new WebSocket(`ws://${base}/ingest`);
    closers.push(async () => {
      ingest.close();
    });
    await opened(ingest);

    // Seed 7 desaturates below the spo2-low threshold from seq 85; 110 frames
    // carry enough breaching samples for DEFAULT_ALERT_RULES to raise.
    const frames = takeFrames({ scenario: "anomaly", seed: 7, deviceId: "sim-anomaly" }, 110);
    for (const frame of frames) {
      ingest.send(JSON.stringify(frame));
    }
    await settle();

    const kinds = dash.messages.map((message) => message.type);
    expect(kinds[0]).toBe("ready");
    expect(kinds.filter((kind) => kind === "frame")).toHaveLength(110);

    const firstAlertAt = kinds.indexOf("alert");
    expect(firstAlertAt).toBeGreaterThan(0);
    // The frame that raised the alert must already have been delivered.
    expect(kinds.slice(0, firstAlertAt).filter((kind) => kind === "frame").length).toBeGreaterThan(
      0,
    );
    const alert = dash.messages[firstAlertAt];
    expect(alert?.type === "alert" && alert.alert.deviceId).toBe("sim-anomaly");
  });

  it("never pushes a duplicate — dedupe happens before fan-out", async () => {
    const { base } = await startServer();
    const dash = connect(base, "/devices/dev-dup/stream");
    await opened(dash.socket);

    const ingest = new WebSocket(`ws://${base}/ingest`);
    closers.push(async () => {
      ingest.close();
    });
    await opened(ingest);

    const frame = { ...STORED, deviceId: "dev-dup" };
    const wire = {
      v: frame.v,
      deviceId: frame.deviceId,
      seq: frame.seq,
      capturedAtMs: frame.capturedAtMs,
      heartRateBpm: frame.heartRateBpm,
      spo2Pct: frame.spo2Pct,
      respirationRpm: frame.respirationRpm,
      motion: frame.motion,
    };
    ingest.send(JSON.stringify(wire));
    ingest.send(JSON.stringify(wire));
    await settle();

    expect(dash.messages.filter((message) => message.type === "frame")).toHaveLength(1);
  });

  it("detaches the subscriber when the dashboard socket closes", async () => {
    const { app, base } = await startServer();
    const dash = connect(base, "/devices/dev-1/stream");
    await opened(dash.socket);
    await settle();
    expect(app.deviceBroadcaster.subscriberCount("dev-1")).toBe(1);

    dash.socket.close();
    await settle();
    expect(app.deviceBroadcaster.subscriberCount()).toBe(0);
  });

  it("answers a plain HTTP request with 426 instead of hanging", async () => {
    const app = await buildApp(loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }));
    const response = await app.inject({ method: "GET", url: "/devices/dev-1/stream" });
    expect(response.statusCode).toBe(426);
    expect(response.json()).toEqual({
      statusCode: 426,
      message: "WebSocket upgrade required on /devices/dev-1/stream",
    });
    await app.close();
  });
});
