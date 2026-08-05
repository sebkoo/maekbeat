/*
 * Formatting for numbers a caregiver reads at a glance. Timestamps render in
 * UTC on purpose: every stamp in the pipeline is epoch milliseconds
 * (capturedAtMs from the device clock, receivedAtMs from the server clock),
 * and a locale-shifted rendering would make two stamps look comparable when
 * they came from different clocks — the drift signal of docs/ARCHITECTURE.md.
 */

/** The ECMAScript time-value limit; Date rejects anything beyond it. */
const MAX_TIME_VALUE = 8.64e15;

/**
 * Epoch milliseconds as `YYYY-MM-DD HH:MM:SSZ`. A stamp outside the Date range
 * renders as a dash: the wire contract bounds `capturedAtMs` only by
 * `z.int().positive()`, so a gateway emitting microseconds is a legal frame,
 * and it must not throw a caregiver's screen away.
 */
export function formatInstant(epochMs: number): string {
  if (!Number.isFinite(epochMs) || Math.abs(epochMs) > MAX_TIME_VALUE) return "—";
  return `${new Date(epochMs).toISOString().slice(0, 19).replace("T", " ")}Z`;
}

/** Fixed-width decimal; NaN and Infinity render as an em dash, never as "NaN". */
export function formatNumber(value: number, digits = 0): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "—";
}

/** Signed millisecond delta, for `receivedAtMs − capturedAtMs`. */
export function formatDelta(deltaMs: number): string {
  const sign = deltaMs >= 0 ? "+" : "−";
  return `${sign}${Math.abs(Math.round(deltaMs))} ms`;
}
