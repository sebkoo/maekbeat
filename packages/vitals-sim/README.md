# @maekbeat/vitals-sim

Deterministic synthetic vitals generator: the fake wearable at the head of the Maekbeat pipeline. It emits `VitalsFrame` objects typed by [@maekbeat/protocol](../protocol/README.md) — this package is the contract's first workspace consumer, and every emitted frame parses under `vitalsFrameSchema` (proven in `src/generator.test.ts`).

The scenario shapes below are plausibility heuristics for a demo, not clinical models. They exist so the alert engine (planned — C7) and dashboard (planned — C11) receive signal shaped like a wearable's output; no diagnostic claim is made anywhere in this repo (see [DISCLAIMER.md](../../DISCLAIMER.md)).

## Determinism

Same options and seed → byte-identical frame sequence, verified across runs by `src/generator.test.ts`; the cross-platform half of the guarantee rests on the three rules below and gets pinned as a regression gate by the C3 golden files (planned — docs/ROADMAP.md). The rules, in `src/prng.ts` and `src/generator.ts`:

- The only randomness source is mulberry32, a pure 32-bit PRNG seeded from `seed`; `Math.random` is never consulted.
- Time is simulated, never read: `capturedAtMs = startAtMs + seq * tickMs`, with `startAtMs` defaulting to a fixed constant — `Date.now` appears nowhere in generation.
- Noise uses only bit-exact IEEE 754 arithmetic: the gaussian approximation is a rescaled sum of three uniforms (Irwin–Hall) instead of Box–Muller, because `Math.log`/`Math.cos` may round differently across JS engines.

The generator also refuses (with a `RangeError`) to emit any frame whose `capturedAtMs` would pass `Number.MAX_SAFE_INTEGER`, so every frame it does emit parses under the protocol's integer bound.

## Scenarios

All parameters live in `src/scenarios.ts`; the tables below list the defining ones.

### rest

| Signal      | Shape                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------- |
| HR          | 62 bpm baseline + AR(1) wander (persistence 0.98, clamp ±5 bpm) + per-tick jitter (σ 0.8 bpm) |
| SpO2        | 97.5% baseline, small wander, clamped 96–99                                                   |
| Respiration | 14 rpm baseline, small wander, clamped 12–16                                                  |
| Motion      | near zero; brief fidgets up to 0.08 (probability 0.02/tick)                                   |

Rationale: resting heart rate drifts on a scale of tens of seconds with small beat-to-beat differences on top, so the model is a slow autocorrelated wander plus per-tick jitter — not independent draws, which would read as white noise on a chart.

### motion

| Signal      | Shape                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------ |
| Motion      | activity bursts (amplitude 0.4–0.9, 10–29 ticks), envelope rises at gain 0.5 and decays at 0.12  |
| HR          | chases `62 + 45·activity` — onset gain 0.25, recovery gain 0.05; read-noise σ `0.8 + 6·activity` |
| SpO2        | rest baseline + extra read noise scaled by activity, floor 94                                    |
| Respiration | `14 + 7·activity` with wander                                                                    |

Rationale: heart rate climbs quickly when exertion starts and returns more slowly during recovery, hence the asymmetric gains; optical wrist sensors also get noisier while the wearer moves, hence HR read noise coupled to motion amplitude.

### anomaly

| Parameter               | Default | Meaning                                                 |
| ----------------------- | ------- | ------------------------------------------------------- |
| `anomaly.startTick`     | 60      | first tick of the scripted cardiorespiratory event      |
| `anomaly.durationTicks` | 40      | event length                                            |
| `anomaly.spo2LagTicks`  | 12      | ticks before SpO2 starts falling; minimum 1, enforced   |
| `anomaly.hrExcursion`   | "spike" | `"spike"` (+45 bpm target) or `"suppression"` (−25 bpm) |

During the window: HR moves fast toward its excursion target and recovers slowly after; respiration turns irregular (σ 3 rpm) around a suppressed 9 rpm target. SpO2 begins a gradual fall toward 88% only after `spo2LagTicks`; its desaturation window mirrors the event length shifted by the lag (so it is never empty), and recovery back to baseline is slower than the fall.

Rationale: blood-oxygen reserves keep SpO2 up for a while after breathing or circulation falters, so desaturation lags the event rather than dropping in the same tick — which is why `spo2LagTicks >= 1` is enforced by a thrown `RangeError`, not merely defaulted.

## API

```ts
import { generateVitals, takeFrames } from "@maekbeat/vitals-sim";

const frames = takeFrames({ scenario: "anomaly", seed: 42 }, 200);

for (const frame of generateVitals({ scenario: "rest", seed: 7 })) {
  // infinite stream; frame is a @maekbeat/protocol VitalsFrame
}
```

`SimOptions` also accepts `deviceId`, `startAtMs`, `tickMs`, and `anomaly` overrides — see `src/generator.ts` for the validation rules on each.

## Commands

```sh
pnpm --filter @maekbeat/vitals-sim test
pnpm --filter @maekbeat/vitals-sim typecheck
```
