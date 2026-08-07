import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";

import type { StreamMessage, VitalsFrame } from "@maekbeat/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { buildApp } from "./app";
import { loadConfig } from "./config";

/*
 * A mechanism that changes the answers it observes is a defect.
 *
 * C18 held tracing to this rule and proved it by replaying the same fixture
 * traced and untraced and comparing the alerts. The silence detector runs on
 * the same server as the alert engine it must not touch, so it is held to the
 * same rule here — and the comparison is worth more than a code review, since
 * "it only reads the store" is exactly the kind of claim that stays true until
 * somebody adds a hook to make detection sharper.
 *
 * The oracle is packages/vitals-sim/golden/anomaly.ndjson, the same bytes the
 * TypeScript golden gate, the Swift decode tests and src/tracing.shape.test.ts
 * read, replayed through a real /ingest socket into a real server.
 *
 * What "on" and "off" mean here, precisely. The detector's only entry point is
 * `sweep()`: it holds nothing on the ingest path, so there is no third state
 * between sweeping and not. The ON run sweeps after every single frame with a
 * clock that puts the device far past a 5 s threshold, which makes it flap —
 * raise, resolve, raise — roughly once per frame. That is the maximum
 * interference this feature can produce, not a token one.
 */

const GOLDEN = new URL("../../../packages/vitals-sim/golden/anomaly.ndjson", import.meta.url);
const DEVICE_ID = "sim-001";

/** Deliberately near the config floor, so silence is easy to provoke. */
const SILENCE_MS = 5_000;
/** How far ahead of the newest receive stamp each manual sweep looks. */
const SWEEP_LOOKAHEAD_MS = 60_000;

function goldenFrames(): VitalsFrame[] {
  return readFileSync(GOLDEN, "utf8")
    .split("\n")
    .slice(1, -1)
    .map((line) => JSON.parse(line) as VitalsFrame);
}

/** One tick per frame, matching the simulator's cadence (C18's rule). */
function fixedClock(): { now: () => number; current: () => number } {
  let ms = 1_754_265_600_000;
  return { now: () => (ms += 1_000), current: () => ms };
}

function awaitOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

function sendAndAwaitReply(socket: WebSocket, payload: string): Promise<{ type: string }> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: unknown): void => {
      socket.off("close", onClose);
      resolve(JSON.parse(String(data)) as { type: string });
    };
    const onClose = (code: number): void => {
      socket.off("message", onMessage);
      reject(new Error(`socket closed (${code}) while awaiting a reply`));
    };
    socket.once("message", onMessage);
    socket.once("close", onClose);
    socket.send(payload);
  });
}

interface Run {
  /** Every `alert` message the dashboard received, in order. */
  fanoutAlerts: StreamMessage[];
  /** The alert history exactly as REST serves it. */
  alerts: unknown[];
  /** The three value-based counters, which silence must not touch. */
  alertCounters: Record<string, number>;
  /** How many silence transitions the run produced — the non-vacuity check. */
  silenceTransitions: number;
  close: () => Promise<void>;
}

/**
 * Replays the fixture through a real server, sweeping after every frame or
 * never, and reports what the ALERT engine did.
 */
async function replay(frames: VitalsFrame[], sweeping: boolean): Promise<Run> {
  const clock = fixedClock();
  const app = await buildApp(
    loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DEVICE_SILENCE_MS: String(SILENCE_MS),
    }),
    // The timer is left unarmed in BOTH runs, so the only difference between
    // them is the sweeping below rather than how a real timer happened to
    // interleave with the replay.
    { now: clock.now, armSilenceSweep: false },
  );
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as AddressInfo).port;

  const dashboard = new WebSocket(`ws://127.0.0.1:${port}/devices/${DEVICE_ID}/stream`);
  const received: StreamMessage[] = [];
  dashboard.on("message", (data) => received.push(JSON.parse(String(data)) as StreamMessage));
  await awaitOpen(dashboard);

  const ingest = new WebSocket(`ws://127.0.0.1:${port}/ingest`);
  await awaitOpen(ingest);

  let silenceTransitions = 0;
  for (const frame of frames) {
    await sendAndAwaitReply(ingest, JSON.stringify(frame));
    if (!sweeping) continue;
    // Look far enough past the newest receive stamp that the device is always
    // over the threshold, so the episode flaps against every arriving frame.
    for (const event of app.silenceDetector.sweep(clock.current() + SWEEP_LOOKAHEAD_MS)) {
      silenceTransitions += 1;
      app.deviceBroadcaster.publishSilence(event);
    }
  }

  // The dashboard's socket is a real one; give the last publishes a turn of the
  // event loop to land before reading what arrived.
  await new Promise((resolve) => setImmediate(resolve));

  const body = (await app.inject({ method: "GET", url: `/devices/${DEVICE_ID}/alerts` })).json<{
    counters: Record<string, number>;
    alerts: unknown[];
  }>();

  return {
    fanoutAlerts: received.filter((message) => message.type === "alert"),
    alerts: body.alerts,
    alertCounters: {
      raised: body.counters.raised ?? 0,
      resolved: body.counters.resolved ?? 0,
      suppressed: body.counters.suppressed ?? 0,
    },
    silenceTransitions,
    close: async () => {
      dashboard.close();
      ingest.close();
      await app.close();
    },
  };
}

describe("the silence detector does not change the alerts it runs beside", () => {
  const frames = goldenFrames();
  let on: Run;
  let off: Run;

  beforeAll(async () => {
    on = await replay(frames, true);
    off = await replay(frames, false);
  }, 60_000);

  afterAll(async () => {
    await on.close();
    await off.close();
  });

  /**
   * Without this the comparison below is vacuous, and would stay green if the
   * detector had been deleted. This repository has shipped that mistake twice
   * (docs/ai/mutation-log.md), so the positive control comes first.
   */
  it("makes the ON run actually detect silence, repeatedly", () => {
    expect(on.silenceTransitions).toBeGreaterThan(frames.length / 4);
    expect(off.silenceTransitions).toBe(0);
  });

  it("replays into the alert episode the fixture is known to produce", () => {
    // The same two transitions src/tracing.shape.test.ts pins on these bytes.
    expect(off.alertCounters).toEqual({ raised: 1, resolved: 1, suppressed: 0 });
  });

  it("serves a byte-identical alert history with the detector on and off", () => {
    expect(JSON.stringify(on.alerts)).toBe(JSON.stringify(off.alerts));
  });

  it("fans out the identical alert messages, in the identical order", () => {
    expect(JSON.stringify(on.fanoutAlerts)).toBe(JSON.stringify(off.fanoutAlerts));
    expect(on.fanoutAlerts).toHaveLength(2);
  });

  it("leaves the raised, resolved and suppressed counters untouched", () => {
    expect(on.alertCounters).toEqual(off.alertCounters);
  });
});
