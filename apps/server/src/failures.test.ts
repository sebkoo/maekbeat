import type { AddressInfo } from "node:net";

import type { VitalsFrame } from "@maekbeat/protocol";
import { takeFrames } from "@maekbeat/vitals-sim";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { buildApp } from "./app";
import { loadConfig } from "./config";

// Failure paths the happy-path suites skirt: a socket dying mid-stream, a
// garbage burst sharing a socket with good frames, and life after the one
// transport-level kill (the 16 KiB / close-1009 limit in src/ingest.ts).
const DEVICE_ID = "fail-dev";

let app: Awaited<ReturnType<typeof buildApp>> | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets) socket.close();
  sockets.length = 0;
  await app?.close();
  app = undefined;
});

async function startApp(): Promise<number> {
  app = await buildApp(loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }));
  await app.listen({ host: "127.0.0.1", port: 0 });
  return (app.server.address() as AddressInfo).port;
}

async function openSocket(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ingest`);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return socket;
}

function sendAndAwaitReply(socket: WebSocket, payload: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: unknown): void => {
      cleanup();
      resolve(JSON.parse(String(data)) as Record<string, unknown>);
    };
    const onClose = (code: number): void => {
      cleanup();
      reject(new Error(`socket closed (${code}) while awaiting a reply`));
    };
    const cleanup = (): void => {
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };
    socket.once("message", onMessage);
    socket.once("close", onClose);
    socket.send(payload);
  });
}

function frame(overrides: Partial<VitalsFrame> = {}): VitalsFrame {
  return {
    v: 1,
    deviceId: DEVICE_ID,
    seq: 0,
    capturedAtMs: 1_000,
    heartRateBpm: 70,
    spo2Pct: 98,
    respirationRpm: 15,
    motion: 0.02,
    ...overrides,
  };
}

describe("socket drop and reconnect", () => {
  it("resumes the same session epoch and an alert lifecycle spans the gap", async () => {
    const port = await startApp();
    const frames = takeFrames({ scenario: "anomaly", seed: 7, deviceId: DEVICE_ID }, 220);

    // Stream through the raise (seq 89), then kill the socket without a
    // close handshake — the mid-stream drop, not a polite disconnect.
    const first = await openSocket(port);
    for (const f of frames.slice(0, 100)) {
      expect((await sendAndAwaitReply(first, JSON.stringify(f))).type).toBe("ack");
    }
    first.terminate();

    // Reconnect on a fresh socket and continue the same seq run: the session
    // is server-side per-device state, so epoch 1 resumes — no reboot.
    const second = await openSocket(port);
    const resumeAck = await sendAndAwaitReply(second, JSON.stringify(frames[100]));
    expect(resumeAck).toMatchObject({
      type: "ack",
      seq: 100,
      sessionEpoch: 1,
      newSession: false,
    });
    for (const f of frames.slice(101)) {
      expect((await sendAndAwaitReply(second, JSON.stringify(f))).type).toBe("ack");
    }

    // The alert raised before the drop (seq 89) and resolved after the
    // reconnect (seq 152): one lifecycle across two sockets.
    const alerts = await app?.inject({ method: "GET", url: `/devices/${DEVICE_ID}/alerts` });
    const body = alerts?.json<{ counters: unknown; alerts: { state: string }[] }>();
    expect(body?.counters).toEqual({ raised: 1, resolved: 1, suppressed: 0 });
    expect(body?.alerts[0]?.state).toBe("resolved");

    const devices = await app?.inject({ method: "GET", url: "/devices" });
    expect(devices?.json<{ ingest: Record<string, number> }>().ingest).toMatchObject({
      accepted: 220,
      sessionsStarted: 1,
    });
  });
});

describe("malformed burst on a live socket", () => {
  it("rejects each bad message by kind and keeps acking good frames between them", async () => {
    const port = await startApp();
    const socket = await openSocket(port);

    const ack0 = await sendAndAwaitReply(socket, JSON.stringify(frame({ seq: 0 })));
    expect(ack0).toMatchObject({ type: "ack", seq: 0 });

    // The burst: broken JSON, non-UTF8 binary, valid JSON that is not a
    // frame, a schema-violating frame, a retransmit — then a good frame.
    const badJson = await sendAndAwaitReply(socket, '{"v":1,');
    expect(badJson).toEqual({ type: "rejected", reason: "invalid_json" });

    const binary = await new Promise<Record<string, unknown>>((resolve) => {
      socket.once("message", (data) => resolve(JSON.parse(String(data))));
      socket.send(Buffer.from([0xff, 0xfe, 0x00, 0x9c]));
    });
    expect(binary).toEqual({ type: "rejected", reason: "invalid_json" });

    const notAFrame = await sendAndAwaitReply(socket, JSON.stringify({ hello: "world" }));
    expect(notAFrame).toMatchObject({ type: "rejected", reason: "invalid_frame" });

    const outOfBounds = await sendAndAwaitReply(
      socket,
      JSON.stringify(frame({ seq: 1, spo2Pct: 101 })),
    );
    expect(outOfBounds).toMatchObject({ type: "rejected", reason: "invalid_frame" });

    const retransmit = await sendAndAwaitReply(socket, JSON.stringify(frame({ seq: 0 })));
    expect(retransmit).toMatchObject({ type: "rejected", reason: "duplicate" });

    const ack1 = await sendAndAwaitReply(socket, JSON.stringify(frame({ seq: 1 })));
    expect(ack1).toMatchObject({ type: "ack", seq: 1, sessionEpoch: 1 });

    // The ledger balances: 7 messages in, 2 stored, 4 rejected, 1 duplicate.
    const devices = await app?.inject({ method: "GET", url: "/devices" });
    expect(devices?.json<{ ingest: Record<string, number> }>().ingest).toEqual({
      received: 7,
      accepted: 2,
      rejectedInvalid: 4,
      duplicatesDropped: 1,
      sessionsStarted: 1,
    });
  });
});

describe("over-limit close aftermath", () => {
  it("keeps device state and counters intact through a 1009 kill and reconnect", async () => {
    const port = await startApp();
    const first = await openSocket(port);
    await sendAndAwaitReply(first, JSON.stringify(frame({ seq: 0 })));

    const closeCode = await new Promise<number>((resolve) => {
      first.once("close", (code) => resolve(code));
      first.send(JSON.stringify({ padding: "x".repeat(20 * 1024) }));
    });
    expect(closeCode).toBe(1009);

    // The oversized message died at the transport: no counter moved, and the
    // frame stored before the kill is still there.
    const devices = await app?.inject({ method: "GET", url: "/devices" });
    expect(devices?.json<{ ingest: Record<string, number> }>().ingest).toEqual({
      received: 1,
      accepted: 1,
      rejectedInvalid: 0,
      duplicatesDropped: 0,
      sessionsStarted: 1,
    });

    // A reconnect resumes the same session, exactly like the mid-stream drop.
    const second = await openSocket(port);
    const ack = await sendAndAwaitReply(second, JSON.stringify(frame({ seq: 1 })));
    expect(ack).toMatchObject({ type: "ack", seq: 1, sessionEpoch: 1, newSession: false });

    const read = await app?.inject({ method: "GET", url: `/devices/${DEVICE_ID}/frames` });
    expect(read?.json<{ count: number }>().count).toBe(2);
  });
});
