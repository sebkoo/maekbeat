// First runnable pipeline (C6): vitals-sim frames -> real WebSocket client ->
// apps/server ingest -> ring buffer -> REST reads. Run with:
//   pnpm --filter @maekbeat/server demo
import type { AddressInfo } from "node:net";

import { takeFrames } from "@maekbeat/vitals-sim";
import WebSocket from "ws";

import { DEFAULT_ALERT_RULES } from "../src/alerts";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";

const FRAME_COUNT = 130;
const DEVICE_ID = "demo-001";

// Demo time runs 40x: one 1 s device tick every 25 ms of wall time. Alert
// windows advance on receivedAtMs (server receive time — the clock policy), so
// the rule windows are scaled by the same factor; the mechanics are unchanged.
const TIME_SCALE = 40;
const TICK_SPACING_MS = 1_000 / TIME_SCALE;
const demoRules = DEFAULT_ALERT_RULES.map((rule) => ({
  ...rule,
  windowMs: rule.windowMs / TIME_SCALE,
  cooldownMs: rule.cooldownMs / TIME_SCALE,
}));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const app = await buildApp(loadConfig({ ...process.env, LOG_LEVEL: "warn" }), {
  alertRules: demoRules,
});
await app.listen({ host: "127.0.0.1", port: 0 });
const port = (app.server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

// A recent startAtMs makes the printed drift read in ms instead of ~1 year.
// The wall clock is consulted HERE, in demo config — never inside generation,
// so the golden fixtures are untouched (they pin their own startAtMs).
const frames = takeFrames(
  {
    scenario: "anomaly",
    seed: 7,
    deviceId: DEVICE_ID,
    startAtMs: Date.now() - FRAME_COUNT * 1_000,
    anomaly: { startTick: 10, durationTicks: 30 },
  },
  FRAME_COUNT,
);

const ws = new WebSocket(`ws://127.0.0.1:${port}/ingest`);
await new Promise<void>((resolve, reject) => {
  ws.once("open", () => resolve());
  ws.once("error", reject);
});

// A dashboard subscriber (C11 fan-out), standing in for apps/web: it receives
// what the browser receives, over the same route and the same contract.
const dashboard = new WebSocket(`ws://127.0.0.1:${port}/devices/${DEVICE_ID}/stream`);
const pushed = { frames: 0, alerts: 0, ringCapacity: 0 };
dashboard.on("message", (data) => {
  const message = JSON.parse(String(data)) as { type: string; [key: string]: unknown };
  if (message.type === "ready") pushed.ringCapacity = message.ringCapacity as number;
  if (message.type === "frame") pushed.frames += 1;
  if (message.type === "alert") pushed.alerts += 1;
});
await new Promise<void>((resolve, reject) => {
  dashboard.once("open", () => resolve());
  dashboard.once("error", reject);
});

function sendAndAwaitReply(payload: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once("message", (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
    ws.send(payload);
  });
}

console.log(`demo: streaming ${FRAME_COUNT} anomaly-scenario frames as ${DEVICE_ID}`);
console.log(
  `demo: demo time runs ${TIME_SCALE}x (1 s tick per ${TICK_SPACING_MS} ms), alert windows scaled to match`,
);
console.log("demo: anomaly window ticks 10-40; SpO2 desaturation lags by 12 ticks");
let acked = 0;
const seqByReceivedAtMs = new Map<number, number>();
for (const frame of frames) {
  const reply = await sendAndAwaitReply(JSON.stringify(frame));
  if (reply.type === "ack") {
    acked += 1;
    seqByReceivedAtMs.set(reply.receivedAtMs as number, reply.seq as number);
  }
  await sleep(TICK_SPACING_MS);
}
console.log(`demo: ${acked}/${FRAME_COUNT} frames acked`);

const duplicate = await sendAndAwaitReply(JSON.stringify(frames[FRAME_COUNT - 1]));
console.log(
  `demo: retransmit of seq ${FRAME_COUNT - 1} -> ${duplicate.type} (${String(duplicate.reason)})`,
);

const invalid = await sendAndAwaitReply(JSON.stringify({ hello: "world" }));
console.log(`demo: malformed frame -> ${invalid.type} (${String(invalid.reason)})`);

const reboot = await sendAndAwaitReply(JSON.stringify(frames[0]));
console.log(
  `demo: seq 0 after seq ${FRAME_COUNT - 1} -> ${reboot.type}, session epoch ` +
    `${String(reboot.sessionEpoch)} (reboot semantics, docs/DECISIONS.md #11)`,
);

const devices = (await (await fetch(`${base}/devices`)).json()) as {
  ingest: Record<string, number>;
  devices: { deviceId: string; frameCount: number; sessionEpoch: number }[];
};
console.log("demo: GET /devices ->", JSON.stringify(devices.ingest));

const read = (await (
  await fetch(`${base}/devices/${DEVICE_ID}/frames?limit=${FRAME_COUNT + 10}`)
).json()) as {
  count: number;
  frames: { seq: number; capturedAtMs: number; receivedAtMs: number; heartRateBpm: number }[];
};
const first = read.frames[0];
const last = read.frames[read.frames.length - 1];
console.log(
  `demo: GET /devices/${DEVICE_ID}/frames -> ${read.count} frames (${FRAME_COUNT} streamed + 1 reboot replay)`,
);
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

const alertsRead = (await (await fetch(`${base}/devices/${DEVICE_ID}/alerts`)).json()) as {
  counters: { raised: number; resolved: number; suppressed: number };
  alerts: {
    alertId: string;
    metric: string;
    direction: string;
    state: string;
    raisedAtMs: number;
    resolvedAtMs?: number;
    windowStats: { minValue: number };
  }[];
};
console.log(
  `demo: GET /devices/${DEVICE_ID}/alerts -> counters ${JSON.stringify(alertsRead.counters)}`,
);
const tickFor = (ms: number | undefined): string => {
  if (ms === undefined) return "?";
  const seq = seqByReceivedAtMs.get(ms);
  return seq === undefined ? "?" : String(seq);
};
for (const alert of alertsRead.alerts) {
  console.log(
    `demo: alert ${alert.metric}-${alert.direction} raised near tick ${tickFor(alert.raisedAtMs)} ` +
      `(expected ~40, once SpO2 sustains below 90), ` +
      `${alert.state} near tick ${tickFor(alert.resolvedAtMs)} (expected ~93, after recovery); ` +
      `recovery-window min ${alert.windowStats.minValue}`,
  );
}

console.log(
  `demo: dashboard socket received ${pushed.frames} frames and ${pushed.alerts} alert ` +
    `transitions (ring capacity ${pushed.ringCapacity}); duplicates and rejects never reach it`,
);

dashboard.close();
ws.close();
await app.close();
console.log("demo: done — pipeline round trip complete");
