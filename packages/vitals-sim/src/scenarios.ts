// Scenario parameter tables. Every number here is a plausibility heuristic for a demo,
// not a clinical model — the README documents each scenario's shape and rationale.

export type ScenarioName = "rest" | "motion" | "anomaly";

/**
 * rest — quiet wear, e.g. sleep. HR is a slow AR(1) wander plus small per-tick jitter
 * (smooth drift, not white noise); SpO2 and respiration hold narrow stable bands;
 * motion is near zero with occasional brief fidgets.
 */
export const REST_PARAMS = {
  hrBaselineBpm: 62,
  /** AR(1) coefficient — closer to 1 means smoother, slower drift. */
  hrWanderPersistence: 0.98,
  hrWanderSigmaBpm: 0.35,
  hrWanderClampBpm: 5,
  hrJitterSigmaBpm: 0.8,
  spo2BaselinePct: 97.5,
  spo2WanderPersistence: 0.95,
  spo2WanderSigmaPct: 0.08,
  spo2FloorPct: 96,
  spo2CeilPct: 99,
  respBaselineRpm: 14,
  respWanderPersistence: 0.97,
  respWanderSigmaRpm: 0.15,
  respFloorRpm: 12,
  respCeilRpm: 16,
  /** Chance per tick of starting a brief fidget while idle. */
  fidgetProbability: 0.02,
  fidgetMaxExtraTicks: 3,
  fidgetAmplitude: 0.08,
} as const;

/**
 * motion — activity bursts. The motion channel follows a burst envelope; HR tracks a
 * target coupled to activity with a faster onset gain than recovery gain, and HR read
 * noise scales with motion amplitude (optical-sensor artifact shape).
 */
export const MOTION_PARAMS = {
  /** Chance per idle tick of starting an activity burst. */
  burstStartProbability: 0.04,
  burstMinTicks: 10,
  burstMaxExtraTicks: 20,
  burstAmplitudeMin: 0.4,
  burstAmplitudeSpan: 0.5,
  idleActivity: 0.03,
  activityOnsetGain: 0.5,
  activityDecayGain: 0.12,
  motionNoiseSigma: 0.02,
  /** HR target rises this many bpm per unit of activity (0–1). */
  hrCouplingBpm: 45,
  hrOnsetGain: 0.25,
  hrRecoveryGain: 0.05,
  hrNoiseBaseSigmaBpm: 0.8,
  /** Extra HR read-noise sigma per unit of activity — artifact coupling. */
  hrNoiseMotionSigmaBpm: 6,
  hrFloorBpm: 40,
  hrCeilBpm: 190,
  respCouplingRpm: 7,
  respWanderSigmaRpm: 0.3,
  respFloorRpm: 10,
  respCeilRpm: 32,
  /** Extra SpO2 read-noise sigma per unit of activity. */
  spo2MotionNoiseSigmaPct: 0.5,
  spo2FloorPct: 94,
} as const;

/** Scripted anomaly window — user-overridable via SimOptions.anomaly. */
export interface AnomalyOptions {
  /** First tick of the cardiorespiratory event. */
  startTick: number;
  /** Event length in ticks. */
  durationTicks: number;
  /**
   * Ticks between event start and the first tick the SpO2 target begins falling.
   * Must be >= 1: desaturation lags the event and never drops in the same tick.
   */
  spo2LagTicks: number;
  /** Shape of the HR excursion during the event window. */
  hrExcursion: "spike" | "suppression";
}

export const ANOMALY_DEFAULTS: AnomalyOptions = {
  startTick: 60,
  durationTicks: 40,
  spo2LagTicks: 12,
  hrExcursion: "spike",
};

/**
 * anomaly — rest baseline with a scripted event window: an HR spike (or suppression),
 * then a delayed SpO2 desaturation toward a trough with slow recovery, and irregular
 * suppressed respiration during the window.
 */
export const ANOMALY_PARAMS = {
  hrSpikeDeltaBpm: 45,
  hrSuppressionDeltaBpm: -25,
  hrOnsetGain: 0.35,
  hrRecoveryGain: 0.06,
  hrFloorBpm: 20,
  hrCeilBpm: 190,
  spo2TroughPct: 88,
  /** Approach gain toward the trough while desaturating — a gradual fall, not a step. */
  spo2DesatGain: 0.1,
  /** Approach gain back toward baseline — recovery is slower than the fall. */
  spo2RecoveryGain: 0.03,
  /** The desat window (lag-shifted mirror of the event) persists this long past its end. */
  spo2RecoveryLagTicks: 8,
  spo2FloorPct: 80,
  respEventTargetRpm: 9,
  respEventSigmaRpm: 3,
  respQuietSigmaRpm: 0.4,
  respEventGain: 0.2,
  respRecoveryGain: 0.05,
  respFloorRpm: 4,
  respCeilRpm: 40,
} as const;
