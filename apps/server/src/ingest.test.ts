import type { AddressInfo } from "node:net";

import type { VitalsFrame } from "@maekbeat/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { buildApp } from "./app";
import { loadConfig } from "./config";
import { SEQ_REORDER_WINDOW } from "./store";

type Reply = Record<string, unknown>;

function frame(overrides: Partial<VitalsFrame> = {}): VitalsFrame {
  return {
    v: 1,
    deviceId: "ws-dev",
    seq: 0,
    capturedAtMs: 1_000,
    heartRateBpm: 70,
    spo2Pct: 98,
    respirationRpm: 15,
    motion: 0.02,
    ...overrides,
  };
}

let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let ws: WebSocket | undefined;

afterEach(async () => {
  ws?.close();
  ws = undefined;
  await app?.close();
  app = undefined;
});

async function startAppWithSocket(): Promise<{ socket: WebSocket }> {
  app = await buildApp(loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }));
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  ws = new WebSocket(`ws://127.0.0.1:${port}/ingest`);
  await new Promise<void>((resolve, reject) => {
    ws?.once("open", () => resolve());
    ws?.once("error", reject);
  });
  return { socket: ws };
}

function sendAndAwaitReply(socket: WebSocket, payload: string): Promise<Reply> {
  return new Promise((resolve) => {
    socket.once("message", (data) => resolve(JSON.parse(String(data)) as Reply));
    socket.send(payload);
  });
}

describe("WS ingest", () => {
  it("acks a valid frame with sessionEpoch and a server receivedAtMs", async () => {
    const { socket } = await startAppWithSocket();
    const before = Date.now();
    const reply = await sendAndAwaitReply(socket, JSON.stringify(frame()));

    expect(reply).toMatchObject({
      type: "ack",
      deviceId: "ws-dev",
      seq: 0,
      sessionEpoch: 1,
      newSession: true,
    });
    expect(reply.receivedAtMs).toBeGreaterThanOrEqual(before);

    // The stamp is stored alongside the frame and comes back over REST.
    const read = await app?.inject({ method: "GET", url: "/devices/ws-dev/frames" });
    const body = read?.json<{ frames: { receivedAtMs: number }[] }>();
    expect(body?.frames[0]?.receivedAtMs).toBe(reply.receivedAtMs);
  });

  it("rejects malformed JSON without closing the socket", async () => {
    const { socket } = await startAppWithSocket();
    const rejected = await sendAndAwaitReply(socket, "this is not json {");
    expect(rejected).toEqual({ type: "rejected", reason: "invalid_json" });

    // The stream carries on: the next valid frame is acked on the same socket.
    const ack = await sendAndAwaitReply(socket, JSON.stringify(frame()));
    expect(ack).toMatchObject({ type: "ack", seq: 0 });
  });

  it("rejects a schema-invalid frame with named issues, socket still open", async () => {
    const { socket } = await startAppWithSocket();
    const rejected = await sendAndAwaitReply(socket, JSON.stringify(frame({ heartRateBpm: 400 })));

    expect(rejected).toMatchObject({ type: "rejected", reason: "invalid_frame" });
    expect(JSON.stringify(rejected.issues)).toContain("heartRateBpm");

    const ack = await sendAndAwaitReply(socket, JSON.stringify(frame()));
    expect(ack).toMatchObject({ type: "ack", seq: 0 });
  });

  it("rejects a duplicate frameKey as duplicate and stores one copy", async () => {
    const { socket } = await startAppWithSocket();
    await sendAndAwaitReply(socket, JSON.stringify(frame({ seq: 5 })));
    const duplicate = await sendAndAwaitReply(socket, JSON.stringify(frame({ seq: 5 })));

    expect(duplicate).toMatchObject({
      type: "rejected",
      reason: "duplicate",
      deviceId: "ws-dev",
      seq: 5,
      sessionEpoch: 1,
    });

    const read = await app?.inject({ method: "GET", url: "/devices/ws-dev/frames" });
    expect(read?.json<{ count: number }>().count).toBe(1);
  });

  it("starts session epoch 2 when seq regresses past the reorder window", async () => {
    const { socket } = await startAppWithSocket();
    const high = SEQ_REORDER_WINDOW + 50;
    await sendAndAwaitReply(socket, JSON.stringify(frame({ seq: high, capturedAtMs: 9_000 })));
    const reboot = await sendAndAwaitReply(
      socket,
      JSON.stringify(frame({ seq: 0, capturedAtMs: 10_000 })),
    );

    expect(reboot).toMatchObject({ type: "ack", seq: 0, sessionEpoch: 2, newSession: true });
  });

  it("counts ingest outcomes in the /devices listing", async () => {
    const { socket } = await startAppWithSocket();
    await sendAndAwaitReply(socket, JSON.stringify(frame({ seq: 0 })));
    await sendAndAwaitReply(socket, JSON.stringify(frame({ seq: 0 })));
    await sendAndAwaitReply(socket, "garbage");

    const listing = await app?.inject({ method: "GET", url: "/devices" });
    expect(listing?.json<{ ingest: Record<string, number> }>().ingest).toEqual({
      received: 3,
      accepted: 1,
      rejectedInvalid: 1,
      duplicatesDropped: 1,
      sessionsStarted: 1,
    });
  });

  it("answers plain HTTP on /ingest with 426", async () => {
    app = await buildApp(loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }));
    const response = await app.inject({ method: "GET", url: "/ingest" });
    expect(response.statusCode).toBe(426);
    expect(response.json()).toEqual({
      statusCode: 426,
      message: "WebSocket upgrade required on /ingest",
    });
  });

  it("closes the connection with 1009 only for an over-limit payload", async () => {
    const { socket } = await startAppWithSocket();
    const oversized = JSON.stringify({ padding: "x".repeat(20 * 1024) });

    const code = await new Promise<number>((resolve) => {
      socket.once("close", (closeCode) => resolve(closeCode));
      socket.send(oversized);
    });
    expect(code).toBe(1009);
  });
});
