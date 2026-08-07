import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { deviceSilenceEventSchema, SILENCE_RULE_ID } from "@maekbeat/protocol";
import { describe, expect, it } from "vitest";

import { parseAlertId } from "./alerts";
import {
  DEVICE_SILENCE_MS_DEFAULT,
  SILENCE_HISTORY_LIMIT,
  SILENCE_SWEEP_DIVISOR,
  SILENCE_SWEEP_MIN_MS,
  SilenceDetector,
  sweepIntervalFor,
  type SilenceSource,
} from "./silence";

/**
 * A fleet the test moves by hand: the store reduced to the three fields the
 * detector reads, so a silence test never has to open a socket to make a
 * device stop sending.
 */
class Fleet implements SilenceSource {
  private readonly devices = new Map<
    string,
    { deviceId: string; sessionEpoch: number; lastReceivedAtMs: number }
  >();

  /** One frame arriving at `receivedAtMs`, in the given session epoch. */
  frame(deviceId: string, receivedAtMs: number, sessionEpoch = 1): void {
    this.devices.set(deviceId, { deviceId, sessionEpoch, lastReceivedAtMs: receivedAtMs });
  }

  listDevices() {
    return [...this.devices.values()];
  }
}

const T0 = 1_754_265_600_000;

function detectorOver(fleet: Fleet, silenceMs = DEVICE_SILENCE_MS_DEFAULT, extras = {}) {
  return new SilenceDetector({ source: fleet, silenceMs, ...extras });
}

/** Sweep from `fromMs` to `toMs` at the detector's own period, as the plugin does. */
function sweepThrough(detector: SilenceDetector, fromMs: number, toMs: number) {
  const step = sweepIntervalFor(detector.silenceMs);
  const events = [];
  for (let t = fromMs; t <= toMs; t += step) events.push(...detector.sweep(t));
  return events;
}

/*
 * ---------------------------------------------------------------------------
 * The threshold. This is the judgement in the whole feature; detection is not.
 * ---------------------------------------------------------------------------
 */

describe("the default threshold", () => {
  /**
   * The derivation, read from the source of the numbers rather than copied out
   * of it. apps/ios owns the gateway's reconnect deadlines; if somebody raises
   * the stall deadline to a minute, the longest routine reconnect grows past
   * this default and this test says so — which is the only mechanism that can,
   * because the two files are in different languages and neither imports the
   * other.
   */
  it("clears the longest reconnect that WORKS, computed from apps/ios LinkTiming", () => {
    const swift = readFileSync(
      resolve(import.meta.dirname, "../../ios/MaekbeatKit/Sources/MaekbeatKit/BLE/LinkState.swift"),
      "utf8",
    );

    const constant = (name: string): number => {
      const match = new RegExp(`static let ${name} = ([0-9_]+)`).exec(swift);
      if (match?.[1] === undefined) {
        throw new Error(
          `LinkTiming.${name} not found in LinkState.swift — the gateway's reconnect ` +
            `deadlines moved, and the derivation of DEVICE_SILENCE_MS_DEFAULT with them`,
        );
      }
      return Number(match[1].replaceAll("_", ""));
    };

    // The phone re-arms the stall deadline on every notification, tries again
    // after the first backoff, then spends a connect and a discovery deadline
    // on the attempt that succeeds.
    const longestWorkingReconnectMs =
      constant("streamStallMs") +
      constant("retryBaseMs") +
      constant("connectTimeoutMs") +
      constant("discoveryTimeoutMs");

    expect(longestWorkingReconnectMs).toBe(36_000);
    expect(DEVICE_SILENCE_MS_DEFAULT).toBeGreaterThan(longestWorkingReconnectMs);
    // And by a margin, not by a millisecond: those are the phone's deadlines on
    // the phone's clock, and this threshold is measured on the server's.
    expect(DEVICE_SILENCE_MS_DEFAULT - longestWorkingReconnectMs).toBeGreaterThanOrEqual(
      longestWorkingReconnectMs / 4,
    );
  });

  /**
   * THE NEGATIVE CASE. If a normal drop-and-resume trips this alarm, the
   * feature is worse than the defect it fixes: it manufactures H7 (alarm
   * fatigue) to close H4.
   */
  it("does not fire on a routine BLE reconnect at its worst", () => {
    const fleet = new Fleet();
    const detector = detectorOver(fleet);
    fleet.frame("dev-a", T0);

    // 36 s quiet — the whole reconnect — then the link is back and frames
    // resume at the simulator's 1 Hz.
    const events = sweepThrough(detector, T0, T0 + 36_000);
    for (let t = T0 + 36_000; t <= T0 + 60_000; t += 1_000) {
      fleet.frame("dev-a", t);
      events.push(...detector.sweep(t));
    }

    expect(events).toEqual([]);
    expect(detector.listEpisodes("dev-a")).toEqual([]);
  });

  it("fires on silence past the threshold, sampled within a tenth of it", () => {
    const fleet = new Fleet();
    const detector = detectorOver(fleet);
    fleet.frame("dev-a", T0);

    const events = sweepThrough(detector, T0, T0 + 2 * DEVICE_SILENCE_MS_DEFAULT);
    expect(events).toHaveLength(1);

    const [raised] = events;
    expect(raised?.state).toBe("raised");
    // Detection lands inside one sweep period of the threshold, which is what
    // the sweep buys instead of a timer per device.
    expect((raised?.raisedAtMs ?? 0) - T0).toBeGreaterThan(DEVICE_SILENCE_MS_DEFAULT);
    expect((raised?.raisedAtMs ?? 0) - T0).toBeLessThanOrEqual(
      DEVICE_SILENCE_MS_DEFAULT + sweepIntervalFor(DEVICE_SILENCE_MS_DEFAULT),
    );
  });

  it("derives its sweep period from the threshold, with a floor", () => {
    expect(sweepIntervalFor(DEVICE_SILENCE_MS_DEFAULT)).toBe(
      DEVICE_SILENCE_MS_DEFAULT / SILENCE_SWEEP_DIVISOR,
    );
    // The configured floor (config.ts min) must not produce a sweep per event
    // loop turn.
    expect(sweepIntervalFor(5_000)).toBe(SILENCE_SWEEP_MIN_MS);
  });

  it("refuses a nonsense threshold rather than running on one", () => {
    const fleet = new Fleet();
    expect(() => detectorOver(fleet, 0)).toThrow(RangeError);
    expect(() => detectorOver(fleet, -1)).toThrow(RangeError);
    expect(() => detectorOver(fleet, 1.5)).toThrow(RangeError);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Lifecycle: dedupe, clearing, and the ordering that was not chosen.
 * ---------------------------------------------------------------------------
 */

describe("the episode lifecycle", () => {
  it("raises once for an hour of silence, not once per sweep", () => {
    const fleet = new Fleet();
    const detector = detectorOver(fleet);
    fleet.frame("dev-a", T0);

    const events = sweepThrough(detector, T0, T0 + 3_600_000);
    const sweeps = Math.floor(3_600_000 / sweepIntervalFor(DEVICE_SILENCE_MS_DEFAULT));

    // The sweep ran hundreds of times and the caregiver hears about it once.
    expect(sweeps).toBeGreaterThan(700);
    expect(events).toHaveLength(1);
    expect(detector.countersFor("dev-a")).toEqual({
      raised: 1,
      resolved: 0,
      forcedEvictions: 0,
    });

    // The record keeps growing even though nothing is published: a dashboard
    // that connects mid-episode reads how long this has been going on.
    const [episode] = detector.listEpisodes("dev-a");
    expect(episode?.state).toBe("ongoing");
    expect(episode?.silentForMs).toBeGreaterThan(3_500_000);
  });

  /**
   * The clearing rule, and the ordering it was chosen over.
   *
   * A reconnect can produce a frame in the SAME session epoch (the store's
   * 64-frame reorder window absorbs it, docs/DECISIONS.md #11) or in a NEW one
   * (a reboot). Clearing on the epoch would have been the natural-looking rule
   * and it fails the first of those outright — so both are driven here, and
   * the one that would have broken is the one this asserts hardest.
   */
  it("clears on the first frame of the SAME session — the epoch rule would not have", () => {
    const fleet = new Fleet();
    const detector = detectorOver(fleet);
    fleet.frame("dev-a", T0, 1);

    sweepThrough(detector, T0, T0 + 90_000);
    expect(detector.listEpisodes("dev-a")[0]?.state).toBe("ongoing");

    // Same epoch, exactly what an in-window reconnect produces.
    const backAt = T0 + 95_000;
    fleet.frame("dev-a", backAt, 1);
    const events = detector.sweep(backAt + 100);

    expect(events).toHaveLength(1);
    expect(events[0]?.state).toBe("resolved");
    expect(events[0]?.resolvedAtMs).toBe(backAt);
    expect(events[0]?.silentForMs).toBe(backAt - T0);
  });

  it("clears on a reboot too — a new session epoch is a frame like any other", () => {
    const fleet = new Fleet();
    const detector = detectorOver(fleet);
    fleet.frame("dev-a", T0, 4);

    sweepThrough(detector, T0, T0 + 90_000);
    fleet.frame("dev-a", T0 + 95_000, 5);
    const events = detector.sweep(T0 + 96_000);

    expect(events).toHaveLength(1);
    expect(events[0]?.state).toBe("resolved");
    // The episode is stamped with the epoch that went quiet, not the one that
    // came back: it is a record of what stopped.
    expect(events[0]?.sessionEpoch).toBe(4);
  });

  it("raises a second, separate episode when the device falls quiet again", () => {
    const fleet = new Fleet();
    const detector = detectorOver(fleet);
    fleet.frame("dev-a", T0);
    sweepThrough(detector, T0, T0 + 90_000);
    fleet.frame("dev-a", T0 + 95_000);
    detector.sweep(T0 + 96_000);

    const again = sweepThrough(detector, T0 + 96_000, T0 + 200_000);
    expect(again).toHaveLength(1);
    expect(again[0]?.state).toBe("raised");

    const episodes = detector.listEpisodes("dev-a");
    expect(episodes).toHaveLength(2);
    expect(new Set(episodes.map((e) => e.alertId)).size).toBe(2);
  });

  it("never dates a resolve before its raise, even if the clock steps back", () => {
    const fleet = new Fleet();
    const detector = detectorOver(fleet);
    fleet.frame("dev-a", T0);
    sweepThrough(detector, T0, T0 + 90_000);

    // The clock jumps backwards — an NTP correction mid-episode.
    const raisedAtMs = detector.listEpisodes("dev-a")[0]?.raisedAtMs ?? 0;
    fleet.frame("dev-a", raisedAtMs - 30_000);
    const events = detector.sweep(T0 + 10_000);

    expect(events).toHaveLength(1);
    expect(events[0]?.resolvedAtMs).toBeGreaterThanOrEqual(raisedAtMs);
    expect(deviceSilenceEventSchema.safeParse(events[0]).success).toBe(true);
  });

  /**
   * A displayed duration that goes backwards is how a caregiver learns not to
   * trust the display. An NTP correction mid-episode is the ordinary way that
   * happens, and the monotonic sweep clock is the whole defence — the first
   * two clock tests here passed with it deleted, which is how this one came to
   * be written (docs/ai/mutation-log.md).
   */
  it("never lets an open episode's reported silence shrink under a clock correction", () => {
    const fleet = new Fleet();
    const detector = detectorOver(fleet);
    fleet.frame("dev-a", T0);
    sweepThrough(detector, T0, T0 + 90_000);
    const before = detector.listEpisodes("dev-a")[0]?.silentForMs ?? 0;
    expect(before).toBeGreaterThanOrEqual(90_000);

    // The clock jumps forty seconds backwards.
    detector.sweep(T0 + 50_000);

    expect(detector.listEpisodes("dev-a")[0]?.silentForMs).toBeGreaterThanOrEqual(before);
  });

  it("does not un-raise an episode because the clock went backwards", () => {
    const fleet = new Fleet();
    const detector = detectorOver(fleet);
    fleet.frame("dev-a", T0);
    const raised = sweepThrough(detector, T0, T0 + 90_000);
    expect(raised).toHaveLength(1);

    // A sweep with an older clock must not resolve, re-raise, or duplicate.
    expect(detector.sweep(T0 + 1_000)).toEqual([]);
    expect(detector.listEpisodes("dev-a")).toHaveLength(1);
  });

  it("watches every device, and only the quiet ones", () => {
    const fleet = new Fleet();
    const detector = detectorOver(fleet);
    fleet.frame("quiet-1", T0);
    fleet.frame("quiet-2", T0);
    fleet.frame("busy", T0);

    const events = [];
    for (let t = T0; t <= T0 + 90_000; t += sweepIntervalFor(DEVICE_SILENCE_MS_DEFAULT)) {
      fleet.frame("busy", t);
      events.push(...detector.sweep(t));
    }

    expect(events.map((e) => e.deviceId).sort()).toEqual(["quiet-1", "quiet-2"]);
    expect(detector.listEpisodes("busy")).toEqual([]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The record, and the handle a caregiver acknowledges it by.
 * ---------------------------------------------------------------------------
 */

describe("the silence record", () => {
  it("satisfies the wire contract and explains itself", () => {
    const fleet = new Fleet();
    const detector = detectorOver(fleet);
    fleet.frame("dev-a", T0, 3);
    const [event] = sweepThrough(detector, T0, T0 + 90_000);

    expect(deviceSilenceEventSchema.safeParse(event).success).toBe(true);
    expect(event).toMatchObject({
      deviceId: "dev-a",
      kind: "silence",
      state: "raised",
      lastFrameAtMs: T0,
      thresholdMs: DEVICE_SILENCE_MS_DEFAULT,
      sessionEpoch: 3,
    });
    // The threshold travels with the record, so a reader six months later can
    // tell whether the alarm was raised under today's setting.
    expect(event?.silentForMs).toBe((event?.raisedAtMs ?? 0) - T0);
  });

  it("mints an alertId the decision route can parse and attribute", () => {
    const fleet = new Fleet();
    const detector = detectorOver(fleet);
    fleet.frame("dev:with:colons", T0);
    const [event] = sweepThrough(detector, T0, T0 + 90_000);

    const parsed = parseAlertId(event?.alertId ?? "");
    expect(parsed).toMatchObject({
      deviceId: "dev:with:colons",
      ruleId: SILENCE_RULE_ID,
      ordinal: 1,
    });
    expect(detector.hasRule(SILENCE_RULE_ID)).toBe(true);
    expect(detector.hasRule("spo2-low")).toBe(false);
  });

  it("counts raise ordinals per device, so two devices cannot share a handle", () => {
    const fleet = new Fleet();
    const detector = detectorOver(fleet);
    fleet.frame("dev-a", T0);
    fleet.frame("dev-b", T0);
    const events = sweepThrough(detector, T0, T0 + 90_000);

    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(parseAlertId(event.alertId)?.ordinal).toBe(1);
    }
    expect(new Set(events.map((e) => e.alertId)).size).toBe(2);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Retention. The brief for this commit said to CHECK the interaction with the
 * decided-before-undecided rule rather than assume it holds — and it does not
 * hold as written, because silence has a state alerts do not: still running.
 * ---------------------------------------------------------------------------
 */

describe("retention", () => {
  /** Flap a device until it holds `episodes` closed episodes and one open one. */
  function flap(detector: SilenceDetector, fleet: Fleet, episodes: number) {
    let t = T0;
    for (let i = 0; i < episodes; i += 1) {
      fleet.frame("dev-a", t);
      sweepThrough(detector, t, t + 90_000);
      t += 95_000;
      fleet.frame("dev-a", t);
      detector.sweep(t + 100);
    }
    // One more that stays open.
    sweepThrough(detector, t, t + 90_000);
  }

  /**
   * The open episode survives the bound, and the reason is an invariant rather
   * than a branch: episodes sit in raise order, at most one is open, so the
   * open one is always the newest — and eviction only ever drops the oldest or
   * a decided one. `evictOne` used to carry an explicit clause for this and a
   * mutation deleting it changed nothing, which is how the invariant was
   * found. This is what stands in for that clause.
   */
  it("never evicts the open episode — the one that says nobody is watching now", () => {
    const fleet = new Fleet();
    const detector = detectorOver(fleet);
    flap(detector, fleet, SILENCE_HISTORY_LIMIT + 20);

    const episodes = detector.listEpisodes("dev-a");
    expect(episodes).toHaveLength(SILENCE_HISTORY_LIMIT);
    const open = episodes.filter((episode) => episode.resolvedAtMs === undefined);
    expect(open).toHaveLength(1);
    expect(open[0]?.state).toBe("ongoing");
    // Newest, which is the invariant doing the work — an eviction that dropped
    // from the wrong end would take exactly this one.
    expect(episodes[episodes.length - 1]?.alertId).toBe(open[0]?.alertId);
    // The bound bit, and it bit the closed ones.
    expect(detector.countersFor("dev-a").forcedEvictions).toBeGreaterThan(0);
  });

  /**
   * The consequence that matters, driven end to end: after the bound has
   * evicted twenty times, the running episode is still THERE to be resolved.
   * Dropping it would leave `state.open` pointing outside the history, and the
   * resolve would mutate a record no reader can see — a silent device that
   * came back and never said so.
   */
  it("still resolves the open episode after the bound has been evicting", () => {
    const fleet = new Fleet();
    const detector = detectorOver(fleet);
    flap(detector, fleet, SILENCE_HISTORY_LIMIT + 20);
    const open = detector.listEpisodes("dev-a").at(-1);

    const backAt = T0 + 100_000_000;
    fleet.frame("dev-a", backAt);
    const events = detector.sweep(backAt + 1_000);

    expect(events).toHaveLength(1);
    expect(events[0]?.alertId).toBe(open?.alertId);
    const stored = detector.listEpisodes("dev-a").find((e) => e.alertId === open?.alertId);
    expect(stored?.state).toBe("resolved");
  });

  it("drops a triaged episode before an untriaged one, and counts what it forces", () => {
    const fleet = new Fleet();
    const decided = new Set<string>();
    const forced: string[] = [];
    const detector = detectorOver(fleet, DEVICE_SILENCE_MS_DEFAULT, {
      isDecided: (_deviceId: string, alertId: string) => decided.has(alertId),
      onForcedEviction: ({ alertId }: { alertId: string }) => forced.push(alertId),
    });

    // Exactly full and nothing evicted yet: the next raise is the one that has
    // to choose, so what it chooses is this test's whole subject.
    flap(detector, fleet, SILENCE_HISTORY_LIMIT - 1);
    const before = detector.listEpisodes("dev-a");
    expect(before).toHaveLength(SILENCE_HISTORY_LIMIT);
    expect(detector.countersFor("dev-a").forcedEvictions).toBe(0);
    // Triage something in the middle: not the oldest, so "decided first" and
    // "oldest first" cannot both be satisfied by the same drop.
    const triaged = before[40]?.alertId ?? "";
    decided.add(triaged);

    fleet.frame("dev-a", T0 + 10_000_000);
    detector.sweep(T0 + 10_000_100);
    sweepThrough(detector, T0 + 10_000_100, T0 + 10_100_000);

    const after = detector.listEpisodes("dev-a").map((episode) => episode.alertId);
    expect(after).not.toContain(triaged);
    expect(after).toContain(before[0]?.alertId);
    // Nothing was forced: there was a decided episode to spend.
    expect(forced).toEqual([]);
    expect(detector.countersFor("dev-a").forcedEvictions).toBe(0);
  });
});
