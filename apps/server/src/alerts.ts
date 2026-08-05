import type { AlertEvent, AlertMetric } from "@maekbeat/protocol";

import type { StoredVitalsFrame } from "./store";

/**
 * One sliding-window rule. Hysteresis is structural: the enter and exit
 * thresholds differ, and both must be sustained (N breaching / M recovered
 * samples inside the window) before the state moves. All window arithmetic
 * runs on receivedAtMs — server receive time, injected via the frame; the
 * engine never reads a clock (docs/ARCHITECTURE.md: drift shifts charts,
 * never alerts).
 */
export interface AlertRuleConfig {
  /** Unique rule id, embedded in alertId — e.g. "spo2-low". */
  id: string;
  metric: AlertMetric;
  direction: "low" | "high";
  /** low: breach when value < enterThreshold; high: value > enterThreshold. */
  enterThreshold: number;
  /** low: recovered when value >= exitThreshold; high: value <= exitThreshold. */
  exitThreshold: number;
  /** Breaching samples inside the window required to raise. */
  enterCount: number;
  /** Recovered samples inside the window required to resolve. */
  exitCount: number;
  /** Window span over receivedAtMs. */
  windowMs: number;
  /** After a resolve, a new episode inside this span is suppressed (counted). */
  cooldownMs: number;
}

/**
 * Default rules — DEMO HEURISTICS for a notification demo of the kind used in
 * monitoring research, not clinical rules and not diagnosis. Numbers chosen to
 * exercise the vitals-sim scenarios; override the set via buildApp options or
 * the AlertEngine constructor.
 */
export const DEFAULT_ALERT_RULES: readonly AlertRuleConfig[] = [
  {
    id: "spo2-low",
    metric: "spo2Pct",
    direction: "low",
    enterThreshold: 90,
    exitThreshold: 93,
    enterCount: 5,
    exitCount: 8,
    windowMs: 15_000,
    cooldownMs: 60_000,
  },
  {
    id: "hr-low",
    metric: "heartRateBpm",
    direction: "low",
    enterThreshold: 40,
    exitThreshold: 50,
    enterCount: 5,
    exitCount: 8,
    windowMs: 15_000,
    cooldownMs: 60_000,
  },
  {
    id: "hr-high",
    metric: "heartRateBpm",
    direction: "high",
    enterThreshold: 150,
    exitThreshold: 130,
    enterCount: 5,
    exitCount: 8,
    windowMs: 15_000,
    cooldownMs: 60_000,
  },
];

/** Alerts kept per device; the oldest are evicted beyond this. */
export const ALERT_HISTORY_LIMIT = 100;

/** Defensive cap on window samples, independent of windowMs. */
const MAX_WINDOW_SAMPLES = 512;

export interface AlertCounters {
  raised: number;
  resolved: number;
  suppressed: number;
}

interface WindowSample {
  receivedAtMs: number;
  value: number;
}

type Phase = "inactive" | "active" | "cooldown-latched";

interface RuleState {
  window: WindowSample[];
  phase: Phase;
  activeAlert?: AlertEvent;
  lastResolvedAtMs?: number;
  /** Monotonic window clock: max receivedAtMs seen. A server clock step back
   * cannot unsort the window or date a resolve before its raise; a step
   * forward freezes expiry until stamps catch up (bounded by the sample cap). */
  clockMs?: number;
}

interface DeviceAlertState {
  rules: Map<string, RuleState>;
  alerts: AlertEvent[];
  counters: AlertCounters;
}

function validateRule(rule: AlertRuleConfig): void {
  const hysteresisOk =
    rule.direction === "low"
      ? rule.exitThreshold > rule.enterThreshold
      : rule.exitThreshold < rule.enterThreshold;
  if (!hysteresisOk) {
    throw new RangeError(
      `rule ${rule.id}: exitThreshold must sit on the recovered side of enterThreshold`,
    );
  }
  if (rule.enterCount < 1 || rule.exitCount < 1 || rule.windowMs < 1 || rule.cooldownMs < 0) {
    throw new RangeError(`rule ${rule.id}: counts and windowMs must be >= 1, cooldownMs >= 0`);
  }
}

/**
 * Frame-driven sliding-window alert engine. Transitions happen only while
 * frames arrive — silence moves nothing; a silent device is surfaced by the
 * lastReceivedAtMs staleness signal on GET /devices, not by this engine.
 * Session epochs are ignored deliberately: values are judged as they arrive,
 * whatever session they belong to.
 */
export class AlertEngine {
  private readonly rules: readonly AlertRuleConfig[];
  private readonly devices = new Map<string, DeviceAlertState>();
  readonly stats: AlertCounters = { raised: 0, resolved: 0, suppressed: 0 };

  constructor(rules: readonly AlertRuleConfig[] = DEFAULT_ALERT_RULES) {
    const ids = new Set<string>();
    for (const rule of rules) {
      validateRule(rule);
      if (ids.has(rule.id)) {
        throw new RangeError(`duplicate rule id: ${rule.id}`);
      }
      ids.add(rule.id);
    }
    this.rules = rules;
  }

  /** Evaluate one accepted frame; returns the transitions it caused. */
  process(frame: StoredVitalsFrame): AlertEvent[] {
    const device = this.deviceState(frame.deviceId);
    const transitions: AlertEvent[] = [];

    for (const rule of this.rules) {
      const state = this.ruleState(device, rule.id);
      const now =
        state.clockMs === undefined
          ? frame.receivedAtMs
          : Math.max(state.clockMs, frame.receivedAtMs);
      state.clockMs = now;

      state.window.push({ receivedAtMs: now, value: frame[rule.metric] });
      while (
        state.window.length > MAX_WINDOW_SAMPLES ||
        (state.window[0] !== undefined && state.window[0].receivedAtMs < now - rule.windowMs)
      ) {
        state.window.shift();
      }

      let breachCount = 0;
      let recoveredCount = 0;
      for (const sample of state.window) {
        if (
          rule.direction === "low"
            ? sample.value < rule.enterThreshold
            : sample.value > rule.enterThreshold
        ) {
          breachCount += 1;
        }
        if (
          rule.direction === "low"
            ? sample.value >= rule.exitThreshold
            : sample.value <= rule.exitThreshold
        ) {
          recoveredCount += 1;
        }
      }

      if (state.phase === "inactive") {
        if (breachCount >= rule.enterCount) {
          const inCooldown =
            state.lastResolvedAtMs !== undefined && now - state.lastResolvedAtMs < rule.cooldownMs;
          if (inCooldown) {
            state.phase = "cooldown-latched";
            // Fresh window per episode (see resolve): the latch must count
            // only samples it sees itself, or old breaches re-latch and old
            // recoveries un-latch, inflating the suppressed counter.
            state.window = [];
            device.counters.suppressed += 1;
            this.stats.suppressed += 1;
          } else {
            transitions.push(this.raise(frame.deviceId, rule, state, device, now, breachCount));
          }
        }
      } else if (state.phase === "active") {
        const alert = state.activeAlert;
        if (alert === undefined) {
          throw new Error(`rule ${rule.id}: active phase without an active alert`);
        }
        if (recoveredCount >= rule.exitCount) {
          alert.state = "resolved";
          alert.resolvedAtMs = now;
          alert.windowStats = this.windowStats(rule, state.window, breachCount);
          state.phase = "inactive";
          state.activeAlert = undefined;
          state.lastResolvedAtMs = now;
          // Fresh window per episode: samples from before the resolve must not
          // seed the next episode's counts or flap the cooldown latch.
          state.window = [];
          device.counters.resolved += 1;
          this.stats.resolved += 1;
          transitions.push({ ...alert });
        } else {
          alert.state = "ongoing";
          alert.windowStats = this.windowStats(rule, state.window, breachCount);
        }
      } else {
        // cooldown-latched: the suppressed episode ends on recovery; if the
        // breach outlives the cooldown, it raises then — persistent conditions
        // are delayed by the cooldown, never silenced forever.
        if (recoveredCount >= rule.exitCount) {
          state.phase = "inactive";
          state.window = [];
        } else if (
          state.lastResolvedAtMs !== undefined &&
          now - state.lastResolvedAtMs >= rule.cooldownMs &&
          breachCount >= rule.enterCount
        ) {
          transitions.push(this.raise(frame.deviceId, rule, state, device, now, breachCount));
        }
      }
    }

    return transitions;
  }

  /** Alert history for one device, oldest first; empty for unknown devices. */
  listAlerts(deviceId: string): AlertEvent[] {
    const device = this.devices.get(deviceId);
    return device === undefined ? [] : device.alerts.map((alert) => ({ ...alert }));
  }

  countersFor(deviceId: string): AlertCounters {
    const device = this.devices.get(deviceId);
    return device === undefined
      ? { raised: 0, resolved: 0, suppressed: 0 }
      : { ...device.counters };
  }

  private raise(
    deviceId: string,
    rule: AlertRuleConfig,
    state: RuleState,
    device: DeviceAlertState,
    now: number,
    breachCount: number,
  ): AlertEvent {
    const alert: AlertEvent = {
      // The trailing ordinal (per-device raise count) keeps ids unique even if
      // two raises land on the same monotonic millisecond.
      alertId: `${deviceId}:${rule.id}:${now}:${device.counters.raised + 1}`,
      deviceId,
      metric: rule.metric,
      direction: rule.direction,
      state: "raised",
      raisedAtMs: now,
      windowStats: this.windowStats(rule, state.window, breachCount),
    };
    state.phase = "active";
    state.activeAlert = alert;
    // Fresh window for the active phase: resolving requires exitCount
    // recoveries observed AFTER the raise, not stale pre-raise samples.
    state.window = [];
    device.alerts.push(alert);
    if (device.alerts.length > ALERT_HISTORY_LIMIT) {
      device.alerts.shift();
    }
    device.counters.raised += 1;
    this.stats.raised += 1;
    return { ...alert };
  }

  private deviceState(deviceId: string): DeviceAlertState {
    let device = this.devices.get(deviceId);
    if (device === undefined) {
      device = {
        rules: new Map(),
        alerts: [],
        counters: { raised: 0, resolved: 0, suppressed: 0 },
      };
      this.devices.set(deviceId, device);
    }
    return device;
  }

  private ruleState(device: DeviceAlertState, ruleId: string): RuleState {
    let state = device.rules.get(ruleId);
    if (state === undefined) {
      state = { window: [], phase: "inactive" };
      device.rules.set(ruleId, state);
    }
    return state;
  }

  private windowStats(
    rule: AlertRuleConfig,
    window: WindowSample[],
    breachCount: number,
  ): AlertEvent["windowStats"] {
    let minValue = Infinity;
    let maxValue = -Infinity;
    for (const sample of window) {
      minValue = Math.min(minValue, sample.value);
      maxValue = Math.max(maxValue, sample.value);
    }
    return {
      windowMs: rule.windowMs,
      sampleCount: window.length,
      breachCount,
      minValue,
      maxValue,
    };
  }
}
