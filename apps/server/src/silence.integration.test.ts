import type { DeviceSilenceEvent, VitalsFrame } from "@maekbeat/protocol";
import { fastify } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";

import { SILENCE_HISTORY_LIMIT, SilenceDetector, silencePlugin } from "./silence";
import {
  Closers,
  graceForAbsence,
  openSocket,
  restFrame,
  startInProcess,
  waitFor,
  watch,
} from "../test-support";

/*
 * The alarm, through the path that ships.
 *
 * src/silence.test.ts drives the detector by hand, which proves the judgement
 * and nothing about the wiring — and the wiring is where this repository keeps
 * finding its defects: C12a's retention was unreachable from buildApp with
 * every unit test green, and C17's iOS root view rendered a gateway it never
 * started. So this file arms nothing itself. It builds the server the way
 * src/main.ts does, lets the plugin's own timer fire, and waits for the alarm
 * to arrive on a real socket.
 *
 * That costs real seconds — DEVICE_SILENCE_MS is set to its configured floor,
 * 5 s, and the sweep derives a 1 s period from it — and the seconds are the
 * price of the only test here that can tell an armed timer from a disarmed one.
 */

const DEVICE_ID = "quiet-001";
/** The config floor (src/config.ts): the fastest honest alarm available. */
const SILENCE_MS = "5000";
/** Threshold plus one sweep period, plus room for a loaded runner. */
const ALARM_WAIT_MS = 15_000;

/*
 * Set here rather than as a third argument to the one slow `it` below, so that
 * its declaration stays on one line. scripts/check-hazard-tests.sh resolves a
 * cited test by finding its title and requiring the same line to be an `it(`,
 * and a hazard row cites this file — a formatter-driven line break would make
 * the citation stop resolving, which is the guard erring toward a false alarm
 * exactly as its own comments say it should.
 */
vi.setConfig({ testTimeout: 45_000 });

const closers = new Closers();
afterEach(async () => {
  await closers.closeAll();
});

function silenceMessages(messages: readonly { type: string }[]): DeviceSilenceEvent[] {
  return messages
    .filter((message): message is { type: "silence"; silence: DeviceSilenceEvent } =>
      Object.hasOwn(message, "silence"),
    )
    .map((message) => message.silence);
}

async function sendFrame(socket: WebSocket, seq: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once("message", () => resolve());
    socket.once("error", reject);
    socket.send(restFrame(DEVICE_ID, seq));
  });
}

describe("a device that stops sending", () => {
  it("raises an alarm on the dashboard socket, and clears it when frames resume", async () => {
    const { app, port } = await startInProcess(closers, { DEVICE_SILENCE_MS: SILENCE_MS });
    const dashboard = await watch(port, DEVICE_ID, closers);
    const ingest = await openSocket(`ws://127.0.0.1:${port}/ingest`, closers);

    // Three resting frames: in range for every rule, so nothing this test
    // sees afterwards can be a threshold alert wearing a disguise.
    for (const seq of [0, 1, 2]) await sendFrame(ingest, seq);
    await waitFor(
      () => dashboard.frames().length === 3,
      () => `3 frames on the fan-out; saw ${dashboard.frames().length}`,
    );
    expect(silenceMessages(dashboard.messages)).toEqual([]);

    // Now the device goes away. Nobody tells the server; that is the hazard.
    await waitFor(
      () => silenceMessages(dashboard.messages).length >= 1,
      () => "a silence alarm on the fan-out socket",
      ALARM_WAIT_MS,
    );

    const [raised] = silenceMessages(dashboard.messages);
    expect(raised).toMatchObject({
      deviceId: DEVICE_ID,
      kind: "silence",
      state: "raised",
      thresholdMs: 5_000,
      sessionEpoch: 1,
    });

    // Dedupe over the real timer, not a simulated one: the sweep has run
    // several times by now and the caregiver has been told once.
    await graceForAbsence(2_500);
    expect(silenceMessages(dashboard.messages)).toHaveLength(1);

    // REST agrees with the socket — the record outlives the message, which
    // is what lets a dashboard that was closed at the time still find it.
    const readAlarm = await app.inject({ method: "GET", url: `/devices/${DEVICE_ID}/alerts` });
    const body = readAlarm.json<{
      counters: Record<string, number>;
      alerts: unknown[];
      silence: DeviceSilenceEvent[];
    }>();
    expect(body.silence).toHaveLength(1);
    expect(body.silence[0]?.state).toBe("ongoing");
    expect(body.counters.silenceRaised).toBe(1);
    expect(body.counters.silenceResolved).toBe(0);
    // The engine judged nothing, because no frame arrived to judge.
    expect(body.alerts).toEqual([]);
    expect(body.counters.raised).toBe(0);

    // A caregiver acknowledges it through the route they already use.
    const decided = await app.inject({
      method: "POST",
      url: `/devices/${DEVICE_ID}/alerts/${raised?.alertId ?? ""}/decisions`,
      payload: { decision: "acknowledged", actor: "test-caregiver" },
    });
    expect(decided.statusCode).toBe(201);

    // The device comes back.
    await sendFrame(ingest, 3);
    await waitFor(
      () => silenceMessages(dashboard.messages).length >= 2,
      () => "the silence alarm clearing on the fan-out socket",
      ALARM_WAIT_MS,
    );

    const cleared = silenceMessages(dashboard.messages)[1];
    expect(cleared?.alertId).toBe(raised?.alertId);
    expect(cleared?.state).toBe("resolved");
    expect(cleared?.silentForMs).toBeGreaterThanOrEqual(5_000);

    const readCleared = await app.inject({
      method: "GET",
      url: `/devices/${DEVICE_ID}/alerts`,
    });
    const after = readCleared.json<{
      counters: Record<string, number>;
      silence: DeviceSilenceEvent[];
      decisions: { alertId: string }[];
    }>();
    expect(after.silence).toHaveLength(1);
    expect(after.silence[0]?.state).toBe("resolved");
    expect(after.counters.silenceResolved).toBe(1);
    expect(after.counters.acknowledged).toBe(1);
    expect(after.decisions[0]?.alertId).toBe(raised?.alertId);
  });

  /**
   * The bound, wired rather than unit-tested.
   *
   * C12a shipped exactly this feature for alerts and its whole retention
   * behaviour could be left unconnected in `buildApp` with every server test
   * green, which is why src/retention.integration.test.ts exists. The silence
   * history has its own bound, its own counter and its own warn line, and none
   * of the three is proven by driving the detector directly.
   */
  it("counts and announces a forced silence eviction, through buildApp", async () => {
    const { app } = await startInProcess(closers);
    const warned = vi.spyOn(app.log, "warn");

    // One flap per iteration: a frame, a sweep that clears the open episode,
    // then a sweep far enough ahead to raise a new one. SILENCE_HISTORY_LIMIT
    // + 1 raises is what makes the bound choose.
    for (let seq = 0; seq <= SILENCE_HISTORY_LIMIT; seq += 1) {
      const at = 1_754_265_600_000 + seq * 1_000_000;
      app.vitalsStore.ingest(JSON.parse(restFrame(DEVICE_ID, seq)) as VitalsFrame, at);
      app.silenceDetector.sweep(at + 100);
      app.silenceDetector.sweep(at + 500_000);
    }

    const body = (await app.inject({ method: "GET", url: `/devices/${DEVICE_ID}/alerts` })).json<{
      counters: Record<string, number>;
      silence: DeviceSilenceEvent[];
    }>();

    expect(body.counters.silenceRaised).toBe(SILENCE_HISTORY_LIMIT + 1);
    expect(body.silence).toHaveLength(SILENCE_HISTORY_LIMIT);
    expect(body.counters.silenceForcedEvicted).toBe(1);
    // Counted AND said out loud: a history full of episodes nobody triaged is
    // an operational fact, and C12a's rule was that such a loss is never silent.
    expect(
      warned.mock.calls.some(([, message]) =>
        String(message).includes("silence history full of undecided episodes"),
      ),
    ).toBe(true);

    // And recorded, not only warned. The warn reaches stdout and nothing here
    // reads stdout back; src/audit.ts is where a later read path would find it
    // (C22). Asserted here because this is the only place a silence eviction
    // is forced through buildApp — without it the seam was covered but
    // unproven, and deleting the record call left all 214 tests green.
    const audited = app.auditLog.list().filter((event) => event.kind === "silence.evicted");
    expect(audited).toHaveLength(1);
    expect(audited[0]?.deviceId).toBe(DEVICE_ID);
    expect(audited[0]?.detail).toContain("silence history full of undecided episodes");
  });

  it("rejects a decision on a silence episode this device never had", async () => {
    const { app, port } = await startInProcess(closers, { DEVICE_SILENCE_MS: SILENCE_MS });
    const ingest = await openSocket(`ws://127.0.0.1:${port}/ingest`, closers);
    await sendFrame(ingest, 0);

    // Well formed, owned, and this server's own rule id — but an ordinal no
    // sweep has ever reached for this device. The decision log is append-only,
    // so an entry judging an episode that never existed can never be taken out.
    const response = await app.inject({
      method: "POST",
      url: `/devices/${DEVICE_ID}/alerts/${DEVICE_ID}:device-silent:1754265600000:7/decisions`,
      payload: { decision: "dismissed", actor: "test-caregiver" },
    });
    expect(response.statusCode).toBe(404);
  });

  /**
   * The sweep runs inside a timer callback, where an uncaught throw is not a
   * failed request — it is an unhandled exception with no request to fail, and
   * Node ends the process. A monitoring server dying because its watchdog
   * tripped is the failure mode inverted, so the throw is caught, logged, and
   * left for the next tick.
   */
  it("survives a sweep that throws instead of taking the server down with it", async () => {
    const app = fastify({ logger: false });
    const detector = new SilenceDetector({
      source: {
        listDevices: () => {
          throw new Error("the fleet could not be read");
        },
      },
    });
    const logged = vi.spyOn(app.log, "error");
    await app.register(silencePlugin, { detector, intervalMs: 10 });

    // Twice, not once: the point is that the sweep keeps running afterwards.
    await waitFor(
      () => logged.mock.calls.length >= 2,
      () => `two logged sweep failures; saw ${logged.mock.calls.length}`,
    );
    await app.close();
  });

  it("stops sweeping when the server does — no handle outlives the process", async () => {
    // The interval is ref'd on purpose (src/silence.ts), so a sweep that
    // outlived its server would hang a SIGTERM rather than leak quietly. The
    // observable form of that here is that close() resolves at all.
    const { app } = await startInProcess(closers, { DEVICE_SILENCE_MS: SILENCE_MS });
    await expect(app.close()).resolves.toBeUndefined();
  });
});
