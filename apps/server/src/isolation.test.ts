import type { AddressInfo } from "node:net";

import { takeFrames } from "@maekbeat/vitals-sim";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { buildApp } from "./app";
import { loadConfig } from "./config";

// Multi-device isolation: two live sockets, frame-by-frame interleaved
// arrivals, one device deep in an anomaly while the other rests. Any
// cross-device bleed — shared windows, shared session state, shared counters
// — turns up as a raise on the resting device or a corrupted summary.
const ANOMALY_ID = "iso-anomaly";
const REST_ID = "iso-rest";
const FRAME_COUNT = 160; // past the anomaly's resolve frame (seq 152)

let app: Awaited<ReturnType<typeof buildApp>> | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets) socket.close();
  sockets.length = 0;
  await app?.close();
  app = undefined;
});

async function openSocket(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ingest`);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return socket;
}

function sendAndAwaitReply(socket: WebSocket, payload: unknown): Promise<Record<string, unknown>> {
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
    socket.send(JSON.stringify(payload));
  });
}

describe("multi-device isolation over parallel sockets", () => {
  it("keeps windows, sessions, and counters per device under interleaving", async () => {
    app = await buildApp(loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }));
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const anomalySocket = await openSocket(port);
    const restSocket = await openSocket(port);

    const anomalyFrames = takeFrames(
      { scenario: "anomaly", seed: 7, deviceId: ANOMALY_ID },
      FRAME_COUNT,
    );
    const restFrames = takeFrames({ scenario: "rest", seed: 1, deviceId: REST_ID }, FRAME_COUNT);

    // Strict alternation: every anomaly arrival is followed by a rest arrival.
    for (let i = 0; i < FRAME_COUNT; i++) {
      const anomalyAck = await sendAndAwaitReply(anomalySocket, anomalyFrames[i]);
      const restAck = await sendAndAwaitReply(restSocket, restFrames[i]);
      expect(anomalyAck).toMatchObject({ type: "ack", sessionEpoch: 1 });
      expect(restAck).toMatchObject({ type: "ack", sessionEpoch: 1 });
    }

    // The anomaly device completed its lifecycle; the resting device, whose
    // frames interleaved 1:1 with 43 sub-90 breaches, fired NOTHING.
    const anomalyAlerts = await app.inject({
      method: "GET",
      url: `/devices/${ANOMALY_ID}/alerts`,
    });
    expect(anomalyAlerts.json<{ counters: unknown }>().counters).toEqual({
      raised: 1,
      resolved: 1,
      suppressed: 0,
      acknowledged: 0,
      dismissed: 0,
    });
    const restAlerts = await app.inject({ method: "GET", url: `/devices/${REST_ID}/alerts` });
    expect(restAlerts.json()).toEqual({
      deviceId: REST_ID,
      counters: { raised: 0, resolved: 0, suppressed: 0, acknowledged: 0, dismissed: 0 },
      alerts: [],
      decisions: [],
    });

    // Frame stores never mixed: correct counts, correct owner on every frame.
    const restRead = await app.inject({
      method: "GET",
      url: `/devices/${REST_ID}/frames?limit=1000`,
    });
    const restBody = restRead.json<{ count: number; frames: { deviceId: string }[] }>();
    expect(restBody.count).toBe(FRAME_COUNT);
    expect(restBody.frames.every((f) => f.deviceId === REST_ID)).toBe(true);

    // Dedupe is keyed by device, not by socket: a retransmit of the anomaly
    // device's last frame sent over the OTHER socket is still a duplicate,
    // and the duplicate lands on the anomaly device's counter alone.
    const crossDuplicate = await sendAndAwaitReply(
      restSocket,
      anomalyFrames[FRAME_COUNT - 1] as object,
    );
    expect(crossDuplicate).toMatchObject({
      type: "rejected",
      reason: "duplicate",
      deviceId: ANOMALY_ID,
      sessionEpoch: 1,
    });

    // Session state is per device too: replaying the anomaly device's seq 0
    // (a regression past the reorder window) reboots ITS session only.
    const reboot = await sendAndAwaitReply(restSocket, anomalyFrames[0] as object);
    expect(reboot).toMatchObject({ type: "ack", sessionEpoch: 2, newSession: true });

    const devices = await app.inject({ method: "GET", url: "/devices" });
    const summaries = devices.json<{ devices: Record<string, unknown>[] }>().devices;
    expect(summaries).toContainEqual(
      expect.objectContaining({
        deviceId: ANOMALY_ID,
        sessionEpoch: 2,
        duplicatesDropped: 1,
        frameCount: FRAME_COUNT + 1,
      }),
    );
    expect(summaries).toContainEqual(
      expect.objectContaining({
        deviceId: REST_ID,
        sessionEpoch: 1,
        duplicatesDropped: 0,
        frameCount: FRAME_COUNT,
      }),
    );
  });
});
