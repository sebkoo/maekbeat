import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /*
     * A budget for one cold CDK synthesis, and the measurements it comes from.
     *
     * The first `Template.fromStack` in a worker process pays for the whole of
     * CDK's synthesis machinery warming up. Every synth after it in the same
     * process is 45-50 ms. Measured, per worker, first synth only:
     *
     *   this machine (M3 Pro, 4 other packages' vitest beside it)   1.34-1.82 s
     *   ubuntu-latest, 2 cores, 4 other packages' vitest beside it  2.39-6.14 s
     *
     * The CI numbers are the durations vitest reported for the three tests it
     * killed at the 5 s default, and they exceed 5 s precisely because the work
     * is synchronous: vitest cannot interrupt it, so the reported time is very
     * nearly the real cost.
     *
     * 15 s is 2.4x the worst of those. The factor is for runner variance rather
     * than for comfort — docs/DECISIONS.md #24 already records that a shared
     * runner's throughput depends on what else is on the host, and a budget
     * that fires on a noisy neighbour is a flake generator. It is deliberately
     * not larger: nothing in this package waits on a socket, a process or a
     * clock, so the only failure this can mask is a runaway synchronous loop,
     * and 15 s still fails the job promptly rather than running to its limit.
     *
     * One number for both, because a cold synth can legitimately sit in a hook
     * or in a test body and the budget should not depend on which. As of this
     * commit every one of them is in a `beforeAll`, so `hookTimeout` is the
     * load-bearing half and `testTimeout` is the backstop for the next file
     * somebody writes.
     */
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: {
      // Same rule as apps/server: everything in src/ except the tests, with
      // the entry point left in the denominator. src/main.ts is the CDK app
      // entry `cdk synth` runs, and excluding it would be excluding the one
      // file that decides what gets synthesized at all.
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text", "lcov"],
      // Ratchet, not aspiration (CLAUDE.md): set in this package's scaffold
      // commit under the measured floor, and they only ever move up.
      // Measured 100 across at the scaffold commit, gated three points under
      // it by the convention this repository has used since C9 — headroom
      // enough that a legitimate refactor moving coverage by a rounding margin
      // does not redden the build, while a real regression still does.
      thresholds: {
        statements: 97,
        branches: 97,
        functions: 98,
        lines: 97,
      },
    },
  },
});
