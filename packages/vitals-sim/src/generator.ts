import { PROTOCOL_VERSION, type VitalsFrame } from "@maekbeat/protocol";
import { gaussian, mulberry32 } from "./prng";
import {
  ANOMALY_DEFAULTS,
  ANOMALY_PARAMS,
  MOTION_PARAMS,
  REST_PARAMS,
  type AnomalyOptions,
  type ScenarioName,
} from "./scenarios";

/** Options for one simulated device run — a run is reproducible from these alone. */
export interface SimOptions {
  scenario: ScenarioName;
  /** Integer PRNG seed (used modulo 2^32) — the only source of variation between runs. */
  seed: number;
  /** 1–64 characters, per the protocol bound. Default "sim-001". */
  deviceId?: string;
  /** Epoch ms of seq 0. Defaults to a fixed constant — wall clock is never consulted. */
  startAtMs?: number;
  /** Simulated ms between frames; capturedAtMs advances by exactly this per frame. */
  tickMs?: number;
  /** anomaly-scenario overrides; ignored by the other scenarios. */
  anomaly?: Partial<AnomalyOptions>;
}

export const SIM_DEFAULTS = {
  deviceId: "sim-001",
  // 2025-08-04T00:00:00Z — an arbitrary fixed epoch so default runs are reproducible.
  startAtMs: 1_754_265_600_000,
  tickMs: 1_000,
} as const;

type Sample = Pick<VitalsFrame, "heartRateBpm" | "spo2Pct" | "respirationRpm" | "motion">;
type ScenarioStep = (tick: number) => Sample;

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

// Wire precision: 1 decimal for SpO2/respiration, 3 for motion. Math.round is
// spec-defined, so rounding stays deterministic across engines.
const round1 = (x: number): number => Math.round(x * 10) / 10;
const round3 = (x: number): number => Math.round(x * 1000) / 1000;

function assertPositiveInt(value: number, name: string): void {
  // Safe integers only: capturedAtMs = startAtMs + seq * tickMs must stay exactly
  // representable, or frames drift and the protocol's z.int() rejects them.
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer, got ${value}`);
  }
}

function resolveOptions(options: SimOptions) {
  if (!Number.isInteger(options.seed)) {
    throw new RangeError(`seed must be an integer, got ${options.seed}`);
  }
  const deviceId = options.deviceId ?? SIM_DEFAULTS.deviceId;
  if (deviceId.length < 1 || deviceId.length > 64) {
    throw new RangeError(`deviceId must be 1-64 characters, got length ${deviceId.length}`);
  }
  const startAtMs = options.startAtMs ?? SIM_DEFAULTS.startAtMs;
  assertPositiveInt(startAtMs, "startAtMs");
  const tickMs = options.tickMs ?? SIM_DEFAULTS.tickMs;
  assertPositiveInt(tickMs, "tickMs");
  const anomaly: AnomalyOptions = { ...ANOMALY_DEFAULTS, ...options.anomaly };
  if (!Number.isInteger(anomaly.startTick) || anomaly.startTick < 0) {
    throw new RangeError(
      `anomaly.startTick must be a non-negative integer, got ${anomaly.startTick}`,
    );
  }
  assertPositiveInt(anomaly.durationTicks, "anomaly.durationTicks");
  // >= 1 is a hard rule, not a default: desaturation must lag the event, never share its tick.
  assertPositiveInt(anomaly.spo2LagTicks, "anomaly.spo2LagTicks");
  if (anomaly.hrExcursion !== "spike" && anomaly.hrExcursion !== "suppression") {
    throw new RangeError(`anomaly.hrExcursion must be "spike" or "suppression"`);
  }
  return { scenario: options.scenario, seed: options.seed, deviceId, startAtMs, tickMs, anomaly };
}

function createRestStep(rng: () => number): ScenarioStep {
  const p = REST_PARAMS;
  let hrWander = 0;
  let spo2Wander = 0;
  let respWander = 0;
  let fidgetTicksLeft = 0;
  return () => {
    // Smooth wander + small jitter — resting HR drifts, it is not white noise.
    hrWander = clamp(
      hrWander * p.hrWanderPersistence + gaussian(rng) * p.hrWanderSigmaBpm,
      -p.hrWanderClampBpm,
      p.hrWanderClampBpm,
    );
    const heartRateBpm = Math.round(
      p.hrBaselineBpm + hrWander + gaussian(rng) * p.hrJitterSigmaBpm,
    );

    spo2Wander = spo2Wander * p.spo2WanderPersistence + gaussian(rng) * p.spo2WanderSigmaPct;
    const spo2Pct = clamp(round1(p.spo2BaselinePct + spo2Wander), p.spo2FloorPct, p.spo2CeilPct);

    respWander = respWander * p.respWanderPersistence + gaussian(rng) * p.respWanderSigmaRpm;
    const respirationRpm = clamp(
      round1(p.respBaselineRpm + respWander),
      p.respFloorRpm,
      p.respCeilRpm,
    );

    if (fidgetTicksLeft > 0) {
      fidgetTicksLeft -= 1;
    } else if (rng() < p.fidgetProbability) {
      fidgetTicksLeft = 1 + Math.floor(rng() * p.fidgetMaxExtraTicks);
    }
    const motionLevel = fidgetTicksLeft > 0 ? p.fidgetAmplitude * rng() : 0.005 * rng();
    const motion = clamp(round3(motionLevel), 0, 1);

    return { heartRateBpm, spo2Pct, respirationRpm, motion };
  };
}

function createMotionStep(rng: () => number): ScenarioStep {
  const m = MOTION_PARAMS;
  const r = REST_PARAMS;
  let activity = 0;
  let burstTicksLeft = 0;
  let burstAmplitude = 0;
  let hrLevel = r.hrBaselineBpm;
  let spo2Wander = 0;
  let respWander = 0;
  return () => {
    if (burstTicksLeft > 0) {
      burstTicksLeft -= 1;
    } else if (rng() < m.burstStartProbability) {
      burstTicksLeft = m.burstMinTicks + Math.floor(rng() * m.burstMaxExtraTicks);
      burstAmplitude = m.burstAmplitudeMin + rng() * m.burstAmplitudeSpan;
    }
    const activityTarget = burstTicksLeft > 0 ? burstAmplitude : m.idleActivity;
    // The envelope itself is asymmetric: activity ramps up faster than it decays.
    activity +=
      (activityTarget - activity) *
      (activityTarget > activity ? m.activityOnsetGain : m.activityDecayGain);
    const motion = clamp(round3(activity + gaussian(rng) * m.motionNoiseSigma), 0, 1);

    // HR chases an activity-coupled target — onset gain > recovery gain.
    const hrTarget = r.hrBaselineBpm + m.hrCouplingBpm * activity;
    hrLevel += (hrTarget - hrLevel) * (hrTarget > hrLevel ? m.hrOnsetGain : m.hrRecoveryGain);
    // Read noise grows with motion amplitude — the optical-artifact coupling.
    const hrSigma = m.hrNoiseBaseSigmaBpm + m.hrNoiseMotionSigmaBpm * activity;
    const heartRateBpm = clamp(
      Math.round(hrLevel + gaussian(rng) * hrSigma),
      m.hrFloorBpm,
      m.hrCeilBpm,
    );

    spo2Wander = spo2Wander * r.spo2WanderPersistence + gaussian(rng) * r.spo2WanderSigmaPct;
    const spo2Pct = clamp(
      round1(r.spo2BaselinePct + spo2Wander + gaussian(rng) * m.spo2MotionNoiseSigmaPct * activity),
      m.spo2FloorPct,
      r.spo2CeilPct,
    );

    respWander = respWander * r.respWanderPersistence + gaussian(rng) * m.respWanderSigmaRpm;
    const respirationRpm = clamp(
      round1(r.respBaselineRpm + m.respCouplingRpm * activity + respWander),
      m.respFloorRpm,
      m.respCeilRpm,
    );

    return { heartRateBpm, spo2Pct, respirationRpm, motion };
  };
}

function createAnomalyStep(rng: () => number, a: AnomalyOptions): ScenarioStep {
  const p = ANOMALY_PARAMS;
  const r = REST_PARAMS;
  const eventEndTick = a.startTick + a.durationTicks;
  const desatStartTick = a.startTick + a.spo2LagTicks;
  // The desat window mirrors the event length, shifted by the lag, so it is never empty
  // regardless of how the lag compares to the event duration.
  const desatEndTick = desatStartTick + a.durationTicks + p.spo2RecoveryLagTicks;
  const hrDeltaBpm = a.hrExcursion === "spike" ? p.hrSpikeDeltaBpm : p.hrSuppressionDeltaBpm;
  let hrLevel: number = r.hrBaselineBpm;
  let hrWander = 0;
  let spo2Level: number = r.spo2BaselinePct;
  let spo2Wander = 0;
  let respLevel: number = r.respBaselineRpm;
  let fidgetTicksLeft = 0;
  return (tick) => {
    const inEvent = tick >= a.startTick && tick < eventEndTick;

    const hrTarget = inEvent ? r.hrBaselineBpm + hrDeltaBpm : r.hrBaselineBpm;
    hrLevel += (hrTarget - hrLevel) * (inEvent ? p.hrOnsetGain : p.hrRecoveryGain);
    hrWander = clamp(
      hrWander * r.hrWanderPersistence + gaussian(rng) * r.hrWanderSigmaBpm,
      -r.hrWanderClampBpm,
      r.hrWanderClampBpm,
    );
    const heartRateBpm = clamp(
      Math.round(hrLevel + hrWander + gaussian(rng) * r.hrJitterSigmaBpm),
      p.hrFloorBpm,
      p.hrCeilBpm,
    );

    // SpO2 target switches only at desatStartTick (= startTick + spo2LagTicks, lag >= 1
    // enforced), so the desaturation never begins on the event's first tick.
    const desatActive = tick >= desatStartTick && tick < desatEndTick;
    const spo2Target = desatActive ? p.spo2TroughPct : r.spo2BaselinePct;
    spo2Level +=
      (spo2Target - spo2Level) * (spo2Target < spo2Level ? p.spo2DesatGain : p.spo2RecoveryGain);
    spo2Wander = spo2Wander * r.spo2WanderPersistence + gaussian(rng) * r.spo2WanderSigmaPct;
    const spo2Pct = clamp(round1(spo2Level + spo2Wander), p.spo2FloorPct, r.spo2CeilPct);

    const respTarget = inEvent ? p.respEventTargetRpm : r.respBaselineRpm;
    respLevel += (respTarget - respLevel) * (inEvent ? p.respEventGain : p.respRecoveryGain);
    const respSigma = inEvent ? p.respEventSigmaRpm : p.respQuietSigmaRpm;
    const respirationRpm = clamp(
      round1(respLevel + gaussian(rng) * respSigma),
      p.respFloorRpm,
      p.respCeilRpm,
    );

    // Motion stays rest-like: the event is cardiorespiratory, not movement.
    if (fidgetTicksLeft > 0) {
      fidgetTicksLeft -= 1;
    } else if (rng() < r.fidgetProbability) {
      fidgetTicksLeft = 1 + Math.floor(rng() * r.fidgetMaxExtraTicks);
    }
    const motionLevel = fidgetTicksLeft > 0 ? r.fidgetAmplitude * rng() : 0.005 * rng();
    const motion = clamp(round3(motionLevel), 0, 1);

    return { heartRateBpm, spo2Pct, respirationRpm, motion };
  };
}

function createScenarioStep(
  scenario: ScenarioName,
  anomaly: AnomalyOptions,
  rng: () => number,
): ScenarioStep {
  switch (scenario) {
    case "rest":
      return createRestStep(rng);
    case "motion":
      return createMotionStep(rng);
    case "anomaly":
      return createAnomalyStep(rng, anomaly);
    default:
      // Unreachable under TypeScript; guards plain-JS callers passing an unknown scenario.
      throw new RangeError(`unknown scenario: ${String(scenario)}`);
  }
}

/**
 * Infinite deterministic frame stream. Same options (including seed) yield a
 * byte-identical sequence: the PRNG is pure, and capturedAtMs is startAtMs + seq * tickMs
 * — Math.random and Date.now are never consulted.
 */
export function* generateVitals(options: SimOptions): Generator<VitalsFrame, never, void> {
  const cfg = resolveOptions(options);
  const rng = mulberry32(cfg.seed);
  const step = createScenarioStep(cfg.scenario, cfg.anomaly, rng);
  for (let seq = 0; ; seq++) {
    const capturedAtMs = cfg.startAtMs + seq * cfg.tickMs;
    if (!Number.isSafeInteger(capturedAtMs)) {
      // Past 2^53 the timestamp would silently lose precision and fail the protocol's
      // z.int(); refusing keeps "every emitted frame parses" true unconditionally.
      throw new RangeError(`capturedAtMs exceeded Number.MAX_SAFE_INTEGER at seq ${seq}`);
    }
    const sample = step(seq);
    yield {
      v: PROTOCOL_VERSION,
      deviceId: cfg.deviceId,
      seq,
      capturedAtMs,
      heartRateBpm: sample.heartRateBpm,
      spo2Pct: sample.spo2Pct,
      respirationRpm: sample.respirationRpm,
      motion: sample.motion,
    };
  }
}

/** First `count` frames of the stream, as an array. */
export function takeFrames(options: SimOptions, count: number): VitalsFrame[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`count must be a non-negative integer, got ${count}`);
  }
  const generator = generateVitals(options);
  const frames: VitalsFrame[] = [];
  for (let i = 0; i < count; i++) {
    frames.push(generator.next().value);
  }
  return frames;
}
