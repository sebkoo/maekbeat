import { SILENCE_RULE_ID, type DeviceSilenceEvent } from "@maekbeat/protocol";
import type { FastifyPluginAsync } from "fastify";

import { alertIdFor } from "./alerts";
import type { DeviceBroadcaster } from "./stream";

/**
 * The alarm for the absence of data (C20a).
 *
 * Every other alert in this system is computed when a frame arrives, which
 * makes the engine driven BY INPUT — and silence has no input to drive it.
 * `apps/server/src/alerts.ts` says so in its own header: "transitions happen
 * only while frames arrive — silence moves nothing". So this is not another
 * threshold on the same path; it is the one thing here that runs when nothing
 * is happening.
 *
 * Found by writing docs/regulatory/hazard-analysis.md rather than by a test.
 * No test could have found it, because a test asserts that something happens;
 * the hazard row asked what happens when nothing does, and the answer was that
 * a device which stops sending is visible as `lastReceivedAtMs` on
 * `GET /devices` and nowhere else — a field a dashboard renders, not a rule
 * anything alarms on.
 */

/**
 * How long a device may send nothing before that is an alarm, in ms.
 *
 * The number, and why this one. Detection is easy; choosing when silence
 * becomes an alarm is the whole problem, and getting it wrong produces alarm
 * fatigue — which is H7 in the same hazard table this row comes from. Too low
 * and every ordinary Bluetooth reconnect raises an alarm, which is worse than
 * the defect it fixes; too high and monitoring stops for as long as the
 * threshold before anyone is told.
 *
 * So the floor is the longest gap a REPAIR THAT WORKS can put in front of this
 * server, taken from the numbers the gateway actually runs on
 * (`LinkTiming`, apps/ios/MaekbeatKit/Sources/MaekbeatKit/BLE/LinkState.swift):
 *
 *     streamStallMs      15 000   the phone re-arms this on every notification,
 *                                 so it notices at most 15 s after the last one
 *     retryBaseMs         1 000   the first backoff
 *     connectTimeoutMs   10 000   how long one connect attempt may take
 *     discoveryTimeoutMs 10 000   and then service discovery
 *                        ------
 *                        36 000   a reconnect that succeeds on its first try
 *
 * 45 000 clears that by 9 s — a quarter of the bound — and the margin is not
 * decoration: those four are the phone's deadlines on the phone's clock, while
 * this threshold is measured on the server's receive clock with an uplink hop
 * in between. At the simulator's declared 1 Hz cadence (`SIM_DEFAULTS.tickMs`,
 * packages/vitals-sim/src/generator.ts) it is also 45 consecutive frames a
 * device said it would send and did not.
 *
 * It sits deliberately above `STREAM_HEARTBEAT_MS` (25 s, src/stream.ts).
 * Those two measure different things — the ping proves the socket, this judges
 * the sensor — and a threshold below the heartbeat would let the server report
 * a device dead while it was still successfully pinging a dashboard about it.
 *
 * The arithmetic is pinned against the Swift constants themselves in
 * src/silence.test.ts, so raising the gateway's stall deadline turns this
 * default red rather than quietly making it wrong.
 */
export const DEVICE_SILENCE_MS_DEFAULT = 45_000;

/**
 * The sweep runs this fraction of the threshold, so detection lands somewhere
 * in [threshold, threshold × 1.1) rather than at an unbounded delay. It is
 * derived rather than configured because it is not an independent judgement:
 * a second variable would only ever be set wrong relative to the first.
 */
export const SILENCE_SWEEP_DIVISOR = 10;

/** No sweep faster than this, whatever the threshold is set to. */
export const SILENCE_SWEEP_MIN_MS = 1_000;

/** Sweep period for a threshold; see SILENCE_SWEEP_DIVISOR. */
export function sweepIntervalFor(silenceMs: number): number {
  return Math.max(SILENCE_SWEEP_MIN_MS, Math.floor(silenceMs / SILENCE_SWEEP_DIVISOR));
}

/**
 * Silence episodes kept per device. Matched to `ALERT_HISTORY_LIMIT` because
 * there is no basis on which to make them differ; what does differ, and what
 * matters, is which one leaves — see `evictOne` below.
 */
export const SILENCE_HISTORY_LIMIT = 100;

/**
 * What the detector needs to know about the fleet, and nothing else. Narrow on
 * purpose: `VitalsStore` satisfies it structurally, so the detector never
 * imports the store and cannot reach anything on the ingest path.
 */
export interface SilenceSource {
  listDevices(): readonly {
    deviceId: string;
    sessionEpoch: number;
    lastReceivedAtMs: number;
  }[];
}

export interface SilenceCounters {
  raised: number;
  resolved: number;
  /** Closed episodes dropped because the history was full of undecided ones. */
  forcedEvictions: number;
}

export interface SilenceDetectorOptions {
  /** Where the fleet's last-seen stamps come from; in the server, the store. */
  source: SilenceSource;
  /** Silence longer than this is an alarm; DEVICE_SILENCE_MS_DEFAULT if unset. */
  silenceMs?: number;
  /** Whether an episode has been triaged — injected exactly as AlertEngine does. */
  isDecided?: (deviceId: string, alertId: string) => boolean;
  /** Called when a closed episode had to be dropped with nothing decided. */
  onForcedEviction?: (info: { deviceId: string; alertId: string }) => void;
}

interface DeviceSilenceState {
  /** The live episode. At most one: a device is either quiet or it is not. */
  open?: DeviceSilenceEvent;
  episodes: DeviceSilenceEvent[];
  counters: SilenceCounters;
}

/**
 * Sweeps the fleet's last-seen stamps and raises an episode for any device
 * that has been quiet too long.
 *
 * A sweep rather than a timer per device, and the rejected alternative is the
 * decision (docs/DECISIONS.md #29). A per-device timer detects at the instant
 * the threshold passes and costs one live handle per device forever, because
 * `VitalsStore` never forgets a device — so the leak is not hypothetical, it
 * is the shape of the store. One sweep holds one handle whatever the fleet
 * size, and pays for it in coarseness bounded by `sweepIntervalFor`.
 *
 * It reads the store and touches nothing on the ingest path, which is what
 * makes the golden-fixture equality check in src/silence.golden.test.ts
 * meaningful rather than aspirational: there is no line of this file that a
 * frame can execute.
 */
export class SilenceDetector {
  private readonly source: SilenceSource;
  private readonly isDecided: (deviceId: string, alertId: string) => boolean;
  private readonly onForcedEviction: (info: { deviceId: string; alertId: string }) => void;
  private readonly devices = new Map<string, DeviceSilenceState>();
  /**
   * Monotonic sweep clock, the policy `AlertEngine` already applies to its
   * windows: a server clock step back must not date a resolve before its raise
   * or un-raise an episode that was correctly raised.
   */
  private clockMs?: number;

  readonly silenceMs: number;
  readonly stats: SilenceCounters = { raised: 0, resolved: 0, forcedEvictions: 0 };

  constructor(options: SilenceDetectorOptions) {
    const silenceMs = options.silenceMs ?? DEVICE_SILENCE_MS_DEFAULT;
    if (!Number.isSafeInteger(silenceMs) || silenceMs < 1) {
      throw new RangeError(`silenceMs must be a positive integer, got ${silenceMs}`);
    }
    this.source = options.source;
    this.silenceMs = silenceMs;
    this.isDecided = options.isDecided ?? (() => false);
    this.onForcedEviction = options.onForcedEviction ?? (() => {});
  }

  /**
   * One pass over the fleet. Returns the transitions it caused — a raise or a
   * resolve, never an "still silent" repeat.
   *
   * That is the dedupe, and it is the same rule `AlertEngine.process` follows:
   * an episode that is still running mutates its own record and pushes nothing.
   * Without it a device quiet for an hour would emit an event every sweep, 800
   * of them at the default settings, which is a denial of service against the
   * caregiver rather than a feature.
   */
  sweep(nowMs: number): DeviceSilenceEvent[] {
    // Floored once, here: every field below is a schema integer, and a
    // fractional clock would produce a record apps/web drops as malformed.
    const now = Math.max(this.clockMs ?? Math.floor(nowMs), Math.floor(nowMs));
    this.clockMs = now;

    const transitions: DeviceSilenceEvent[] = [];
    for (const device of this.source.listDevices()) {
      const state = this.stateFor(device.deviceId);
      const open = state.open;

      if (open === undefined) {
        // Strictly longer than the threshold: the variable is the maximum
        // silence tolerated, the same reading STREAM_HEARTBEAT_MS has.
        if (now - device.lastReceivedAtMs > this.silenceMs) {
          transitions.push(this.raise(device, now));
        }
        continue;
      }

      if (device.lastReceivedAtMs > open.lastFrameAtMs) {
        transitions.push(this.resolve(state, open, device.lastReceivedAtMs));
        continue;
      }

      // Still quiet. The record grows; nothing is published.
      open.state = "ongoing";
      open.silentForMs = Math.max(0, now - open.lastFrameAtMs);
    }
    return transitions;
  }

  /** Whether a rule id is this detector's — the decision route asks. */
  hasRule(ruleId: string): boolean {
    return ruleId === SILENCE_RULE_ID;
  }

  /** Episodes for one device, oldest first; empty for unknown devices. */
  listEpisodes(deviceId: string): DeviceSilenceEvent[] {
    const state = this.devices.get(deviceId);
    return state === undefined ? [] : state.episodes.map((episode) => ({ ...episode }));
  }

  countersFor(deviceId: string): SilenceCounters {
    const state = this.devices.get(deviceId);
    return state === undefined
      ? { raised: 0, resolved: 0, forcedEvictions: 0 }
      : { ...state.counters };
  }

  private raise(
    device: { deviceId: string; sessionEpoch: number; lastReceivedAtMs: number },
    now: number,
  ): DeviceSilenceEvent {
    const state = this.stateFor(device.deviceId);
    const episode: DeviceSilenceEvent = {
      alertId: alertIdFor(device.deviceId, SILENCE_RULE_ID, now, state.counters.raised + 1),
      deviceId: device.deviceId,
      kind: "silence",
      state: "raised",
      raisedAtMs: now,
      lastFrameAtMs: device.lastReceivedAtMs,
      thresholdMs: this.silenceMs,
      silentForMs: now - device.lastReceivedAtMs,
      sessionEpoch: device.sessionEpoch,
    };
    state.open = episode;
    state.episodes.push(episode);
    // Counters before eviction, for the reason AlertEngine.raise gives: the
    // eviction path calls injected code, and a throw from it must not leave the
    // ordinal unincremented and the next raise minting a duplicate alertId.
    state.counters.raised += 1;
    this.stats.raised += 1;
    if (state.episodes.length > SILENCE_HISTORY_LIMIT) {
      this.evictOne(device.deviceId, state);
    }
    return { ...episode };
  }

  /**
   * Ends the episode on the arrival of a frame — any frame, from any session.
   *
   * The alternative was to clear on a new `sessionEpoch`, and it is wrong in
   * the ordinary case rather than in a corner: a phone that reconnects inside
   * the store's 64-frame reorder window resumes the SAME epoch (C6,
   * docs/DECISIONS.md #11), so an epoch rule would leave that device alarming
   * for as long as it kept sending. Frames are the evidence; the epoch is a
   * detail of how the store labelled them. src/silence.test.ts drives both
   * orderings, including the one not chosen.
   */
  private resolve(
    state: DeviceSilenceState,
    open: DeviceSilenceEvent,
    lastReceivedAtMs: number,
  ): DeviceSilenceEvent {
    open.state = "resolved";
    // The frame's receive time, not the sweep's: the device came back when it
    // came back, not when this happened to look. Clamped because the two
    // stamps are separate reads of one clock, and a resolve dated before its
    // raise is a record no reader can interpret — and one the protocol schema
    // rejects outright.
    open.resolvedAtMs = Math.max(open.raisedAtMs, lastReceivedAtMs);
    open.silentForMs = Math.max(0, open.resolvedAtMs - open.lastFrameAtMs);
    state.open = undefined;
    state.counters.resolved += 1;
    this.stats.resolved += 1;
    return { ...open };
  }

  /**
   * Drops one episode to stay under the bound: a triaged one first, then the
   * oldest.
   *
   * That is C12a's rule for alerts, unchanged — and the point of this comment
   * is that it was CHECKED here rather than assumed to transfer, because
   * silence has a state alerts do not. An episode here can still be RUNNING,
   * and the open one is the live "this device is not being monitored right
   * now" signal: discarding it would delete the record of a condition that
   * still holds and leave `state.open` pointing at an object no reader can
   * reach, so the resolve would land nowhere.
   *
   * The first draft therefore carried an explicit "never the open one" clause,
   * and a mutation removing it broke nothing (docs/ai/mutation-log.md). The
   * clause is unreachable, for two structural reasons rather than by luck.
   * Episodes sit in raise order and at most one is open, so the open one is
   * always the LAST element and never the oldest. And eviction runs at exactly
   * one moment — inside `raise`, on an alertId minted a few statements earlier
   * that no client has had the chance to decide. Neither ordering can select
   * it.
   *
   * So the clause was deleted rather than kept for appearances, the way
   * src/stream.ts deleted a `readyState` check no test could tell from its
   * absence, and the invariant it was guarding is asserted in
   * src/silence.test.ts instead.
   */
  private evictOne(deviceId: string, state: DeviceSilenceState): void {
    const decidedIndex = state.episodes.findIndex((episode) =>
      this.isDecided(deviceId, episode.alertId),
    );
    if (decidedIndex >= 0) {
      state.episodes.splice(decidedIndex, 1);
      return;
    }

    const [dropped] = state.episodes.splice(0, 1);
    state.counters.forcedEvictions += 1;
    this.stats.forcedEvictions += 1;
    if (dropped !== undefined) {
      this.onForcedEviction({ deviceId, alertId: dropped.alertId });
    }
  }

  private stateFor(deviceId: string): DeviceSilenceState {
    let state = this.devices.get(deviceId);
    if (state === undefined) {
      state = { episodes: [], counters: { raised: 0, resolved: 0, forcedEvictions: 0 } };
      this.devices.set(deviceId, state);
    }
    return state;
  }
}

export interface SilencePluginOptions {
  detector: SilenceDetector;
  /** Fan-out, so the episode reaches an open dashboard rather than only REST. */
  broadcaster?: DeviceBroadcaster;
  /** Sweep period; see sweepIntervalFor. */
  intervalMs: number;
  /** The sweep clock; omitted, `Date.now`. */
  now?: () => number;
}

/**
 * Arms the sweep and publishes what it finds.
 *
 * The interval is ref'd and cleared on `onClose`, for the reason
 * src/stream.ts gives about its heartbeat: src/lifecycle.ts is built on a
 * ref'd handle hanging a stop visibly rather than being papered over, so an
 * unref'd timer here would trade a test that can see the leak for one that
 * cannot.
 */
export const silencePlugin: FastifyPluginAsync<SilencePluginOptions> = async (app, opts) => {
  const { detector, broadcaster, intervalMs } = opts;
  const now = opts.now ?? Date.now;

  const timer = setInterval(() => {
    let transitions: DeviceSilenceEvent[];
    try {
      transitions = detector.sweep(now());
    } catch (err: unknown) {
      // A sweep that throws must not take down a monitoring server from inside
      // a timer callback, where nothing is there to catch it. The next tick
      // tries again; the failure is loud in the log rather than in the exit
      // code.
      app.log.error({ err }, "device silence sweep failed");
      return;
    }
    for (const event of transitions) {
      if (event.state === "resolved") {
        app.log.info(
          { deviceId: event.deviceId, alertId: event.alertId, silentForMs: event.silentForMs },
          "device resumed sending",
        );
      } else {
        // At warn: this is the alarm. A device that stopped sending is the
        // hazard docs/regulatory/hazard-analysis.md H4 is about, and it used
        // to be visible only as a timestamp on a listing.
        app.log.warn(
          {
            deviceId: event.deviceId,
            alertId: event.alertId,
            lastFrameAtMs: event.lastFrameAtMs,
            thresholdMs: event.thresholdMs,
          },
          "device silent past the configured threshold",
        );
      }
      broadcaster?.publishSilence(event);
    }
  }, intervalMs);

  app.addHook("onClose", async () => {
    clearInterval(timer);
  });
};
