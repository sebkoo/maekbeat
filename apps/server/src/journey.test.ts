import type { AddressInfo } from "node:net";

import { alertEventSchema, vitalsFrameSchema } from "@maekbeat/protocol";
import { takeFrames } from "@maekbeat/vitals-sim";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { buildApp } from "./app";
import { loadConfig } from "./config";

// The demo's rigorous sibling (apps/server/scripts/demo.ts): the same
// sim -> WS -> ingest -> engine -> REST journey, but with DEFAULT_ALERT_RULES
// unscaled and no pacing tricks. Frames stream back-to-back at real wall
// time; because the anomaly's breaches (seq 85-127) and recoveries are
// contiguous runs, the 5th sub-90 sample is seq 89 and the 8th >=93 recovery
// after the raise is seq 152 under any pacing that keeps those runs inside
// the 15 s window — back-to-back here, 1 s ticks in the alerts.test.ts
// goldens — so this pins the same frames the goldens name.
const DEVICE_ID = "journey-001";
const FRAME_COUNT = 220;
const RAISE_SEQ = 89;
const RESOLVE_SEQ = 152;

interface Ack {
  type: string;
  seq: number;
  sessionEpoch: number;
  receivedAtMs: number;
  newSession: boolean;
}

let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let ws: WebSocket | undefined;

afterEach(async () => {
  ws?.close();
  ws = undefined;
  await app?.close();
  app = undefined;
});

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

describe("full journey: vitals-sim -> WS -> ingest -> engine -> REST", () => {
  it("carries the anomaly from synthetic frames to one resolved alert", async () => {
    app = await buildApp(loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }));
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    ws = new WebSocket(`ws://127.0.0.1:${port}/ingest`);
    await new Promise<void>((resolve, reject) => {
      ws?.once("open", () => resolve());
      ws?.once("error", reject);
    });

    const frames = takeFrames({ scenario: "anomaly", seed: 7, deviceId: DEVICE_ID }, FRAME_COUNT);
    const acks: Ack[] = [];
    for (const frame of frames) {
      const reply = await sendAndAwaitReply(ws, JSON.stringify(frame));
      expect(reply.type).toBe("ack");
      acks.push(reply as unknown as Ack);
    }

    // Every frame accepted into one session; only the first opens it.
    expect(acks).toHaveLength(FRAME_COUNT);
    expect(acks.every((a) => a.sessionEpoch === 1)).toBe(true);
    expect(acks.filter((a) => a.newSession).map((a) => a.seq)).toEqual([0]);

    // REST /devices: process-lifetime counters for exactly this stream.
    const devices = await app.inject({ method: "GET", url: "/devices" });
    expect(devices.json<{ ingest: Record<string, number> }>().ingest).toEqual({
      received: FRAME_COUNT,
      accepted: FRAME_COUNT,
      rejectedInvalid: 0,
      duplicatesDropped: 0,
      sessionsStarted: 1,
    });

    // REST frames: all 220 back in capture order, each carrying the exact
    // receive stamp its ack reported, each still a valid wire frame.
    const read = await app.inject({
      method: "GET",
      url: `/devices/${DEVICE_ID}/frames?limit=1000`,
    });
    const body = read.json<{ count: number; frames: Record<string, unknown>[] }>();
    expect(body.count).toBe(FRAME_COUNT);
    const ackStampBySeq = new Map(acks.map((a) => [a.seq, a.receivedAtMs]));
    body.frames.forEach((stored, index) => {
      expect(stored.seq).toBe(index);
      expect(stored.receivedAtMs).toBe(ackStampBySeq.get(index));
      const { receivedAtMs: _r, sessionEpoch: _s, ...wire } = stored;
      expect(vitalsFrameSchema.safeParse(wire).success).toBe(true);
    });

    // REST alerts: the journey's destination. One spo2-low pair, nothing else
    // — no hr alert (seed 7 spike tops out at 110 bpm), no second episode.
    const alertsRead = await app.inject({ method: "GET", url: `/devices/${DEVICE_ID}/alerts` });
    const alerts = alertsRead.json<{
      counters: Record<string, number>;
      alerts: Record<string, unknown>[];
    }>();
    expect(alerts.counters).toEqual({ raised: 1, resolved: 1, suppressed: 0 });
    expect(alerts.alerts).toHaveLength(1);
    const alert = alerts.alerts[0] as {
      metric: string;
      direction: string;
      state: string;
      raisedAtMs: number;
      resolvedAtMs: number;
      windowStats: { breachCount: number; minValue: number; sampleCount: number };
    };
    expect(alertEventSchema.safeParse(alert).success).toBe(true);
    expect(alert).toMatchObject({ metric: "spo2Pct", direction: "low", state: "resolved" });

    // The engine's window clock is the running max of WS receive stamps, so
    // the raise is dated max(stamps through seq 89) and the resolve
    // max(stamps through seq 152). Exact under backwards clock steps (the
    // running max absorbs them); the one residual is a >15 s stall landing
    // inside a breach or recovery run, which would shift the pinned seq.
    const maxStampThrough = (seq: number): number =>
      Math.max(...acks.filter((a) => a.seq <= seq).map((a) => a.receivedAtMs));
    expect(alert.raisedAtMs).toBe(maxStampThrough(RAISE_SEQ));
    expect(alert.resolvedAtMs).toBe(maxStampThrough(RESOLVE_SEQ));
    expect(alert.resolvedAtMs).toBeGreaterThanOrEqual(alert.raisedAtMs);

    // The stats on the record are resolve-time: a window opened fresh at the
    // raise, holding at least the 8 recoveries that closed the alert.
    expect(alert.windowStats.sampleCount).toBeGreaterThanOrEqual(8);
  });
});
