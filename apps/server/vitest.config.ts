import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      // v8 provider over everything in src/ except the tests themselves —
      // main.ts (the process entry) stays in the denominator on purpose, so
      // the reported number is the honest floor the thresholds ratchet. No
      // other exclusions: excluding a file from here is a G3 event, not a
      // convenience. One thing sits outside src/ by design: scripts/demo.ts,
      // the demo wiring, is presentation code and not part of the gate.
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text", "lcov"],
      // Ratchet, not aspiration (CLAUDE.md): these numbers only move up, each
      // raise its own commit, and lowering one to make a build pass is
      // forbidden.
      //
      // Convention, unchanged since C9: each threshold is the greatest integer
      // leaving two to three points of headroom under the measurement. The
      // headroom is not slack — it is what keeps a legitimate refactor that
      // moves coverage by a rounding margin from reddening the build, while a
      // real regression, which moves it further, still does.
      //
      // Raised here against a measured 95.16% statements / 95.10% branches /
      // 95.58% functions / 95.45% lines, with the untested process entry
      // main.ts counted against every one of them. Previous floor: the C8
      // measurement of 92.88 / 94.64 / 91.66 / 92.79, gated at 90 / 92 / 89 / 90.
      thresholds: {
        statements: 93,
        branches: 93,
        functions: 93,
        lines: 93,
      },
    },
  },
});
