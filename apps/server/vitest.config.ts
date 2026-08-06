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
      // Raised at C18 against a measured 97.05% statements / 95.00% branches /
      // 100% functions / 97.14% lines, with the untested process entry main.ts
      // counted against every one of them. Previous floor: the C17 measurement
      // of 95.16 / 95.10 / 95.58 / 95.45, gated at 93 across.
      //
      // Branches stays at 93 rather than rising with the others: 95.00 leaves
      // room for 93 under the two-point convention and no more, and inventing
      // headroom that is not there would make the next legitimate refactor red.
      // A threshold that does not move is the ratchet working, not a lapse —
      // the rule is that it never moves down.
      //
      // C18 raised three of the four by extracting the shutdown sequence out
      // of main.ts into src/lifecycle.ts, where it is tested: the tracer flush
      // has an order that matters, and ordering logic sitting in the one file
      // no test loads is how it would have gone unproven.
      thresholds: {
        statements: 95,
        branches: 93,
        functions: 98,
        lines: 95,
      },
    },
  },
});
