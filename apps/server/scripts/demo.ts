// First runnable pipeline (C6): vitals-sim frames -> real WebSocket client ->
// apps/server ingest -> ring buffer -> REST reads. Run with:
//   pnpm --filter @maekbeat/server demo
import type { AddressInfo } from "node:net";

import { takeFrames } from "@maekbeat/vitals-sim";
import WebSocket from "ws";

import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";

const FRAME_COUNT = 30;
const DEVICE_ID = "demo-001";

const app = await buildApp(loadConfig({ ...process.env, LOG_LEVEL: "warn" }));
await app.listen({ host: "127.0.0.1", port: 0 });
const port = (app.server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

const frames = takeFrames({ scenario: "anomaly", seed: 7, deviceId: DEVICE_ID }, FRAME_COUNT);

const ws = new WebSocket(`ws://127.0.0.1:${port}/ingest`);
await new Promise<void>((resolve, reject) => {
  ws.once("open", () => resolve());
  ws.once("error", reject);
});

function sendAndAwaitReply(payload: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once("message", (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
    ws.send(payload);
  });
}

console.log(`demo: streaming ${FRAME_COUNT} anomaly-scenario frames as ${DEVICE_ID}`);
let acked = 0;
for (const frame of frames) {
  const reply = await sendAndAwaitReply(JSON.stringify(frame));
  if (reply.type === "ack") {
    acked += 1;
  }
}
console.log(`demo: ${acked}/${FRAME_COUNT} frames acked`);

const duplicate = await sendAndAwaitReply(JSON.stringify(frames[0]));
console.log(`demo: retransmit of seq 0 -> ${duplicate.type} (${String(duplicate.reason)})`);

const invalid = await sendAndAwaitReply(JSON.stringify({ hello: "world" }));
console.log(`demo: malformed frame -> ${invalid.type} (${String(invalid.reason)})`);

const devices = (await (await fetch(`${base}/devices`)).json()) as {
  ingest: Record<string, number>;
  devices: { deviceId: string; frameCount: number; sessionEpoch: number }[];
};
console.log("demo: GET /devices ->", JSON.stringify(devices.ingest));

const read = (await (
  await fetch(`${base}/devices/${DEVICE_ID}/frames?limit=${FRAME_COUNT}`)
).json()) as {
  count: number;
  frames: { seq: number; capturedAtMs: number; receivedAtMs: number; heartRateBpm: number }[];
};
const first = read.frames[0];
const last = read.frames[read.frames.length - 1];
console.log(`demo: GET /devices/${DEVICE_ID}/frames -> ${read.count} frames`);
if (first && last) {
  console.log(
    `demo: seq ${first.seq}..${last.seq}, HR ${first.heartRateBpm}->${last.heartRateBpm} bpm`,
  );
  // The simulator clock is a fixed synthetic epoch, so this delta is large by
  // construction — it is the receivedAtMs - capturedAtMs drift signal itself.
  console.log(
    `demo: drift signal (receivedAtMs - capturedAtMs) on last frame: ${last.receivedAtMs - last.capturedAtMs} ms`,
  );
}

ws.close();
await app.close();
console.log("demo: done — pipeline round trip complete");
