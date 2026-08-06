/*
 * Waiting for a condition instead of for the clock.
 *
 * The bug this file exists to stop: src/stream.test.ts asserted that a
 * dashboard had received 110 fan-out messages after a fixed 40 ms wait. Fan-out
 * is asynchronous, so the number that has arrived by any given millisecond is a
 * property of the machine, not of the server. On a loaded CI runner 76 had
 * arrived and the build went red; on every developer machine it passed, which
 * is worse — the local gate's guarantee was environment-dependent, and had been
 * since C11.
 *
 * Nothing here weakens an assertion. A server that genuinely drops a frame
 * still fails: the wait expires and the test asserts the real count, which is
 * the same assertion it made before, made at a defensible moment.
 *
 * It sits beside the configs rather than in src/ for the reason
 * apps/web/vitest.setup.ts does: it is test scaffolding, not app code, and the
 * coverage denominator is src/ — which stays exactly as wide as it was. This is
 * not an exclude entry (CLAUDE.md forbids those); the include glob is untouched.
 */

/**
 * How long a condition gets before the wait is called a failure.
 *
 * Deliberately under vitest's own 5 s `testTimeout`: whichever fires first
 * writes the failure message, and "timed out waiting for 110 frame messages;
 * received 76" is a bug report, where "Test timed out in 5000ms" is a shrug.
 * Three seconds is seventy-five times the fixed pause this replaced.
 */
export const DEFAULT_WAIT_MS = 3_000;

/**
 * Resolves once `condition` holds. Generous by default, because the timeout is
 * not the assertion — it is the point at which waiting longer would only make a
 * red build slower.
 *
 * @throws when the condition never holds, naming what was awaited and what the
 * observed value was, so a timeout reads like the failure it is rather than
 * like a mystery.
 */
export async function waitFor(
  condition: () => boolean,
  describe: () => string,
  timeoutMs: number = DEFAULT_WAIT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (condition()) return;
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${describe()}`);
}

/**
 * A fixed pause, for the one thing a condition cannot express: that nothing
 * *else* is going to arrive.
 *
 * Waiting on an absence is not solvable by polling — no amount of looking proves
 * a message will never come — so a negative assertion needs a grace period, and
 * saying so is better than pretending otherwise. Use it only after a positive
 * condition has already been awaited, so the grace covers the gap between the
 * message that should arrive and the one that should not, never the whole
 * delivery.
 */
export async function graceForAbsence(ms = 50): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
