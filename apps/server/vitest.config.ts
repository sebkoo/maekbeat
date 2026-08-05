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
      // Ratchet, not aspiration (CLAUDE.md): set just under the C8 measured
      // floor — 92.88% statements / 94.64% branches / 91.66% functions /
      // 92.79% lines. These numbers only move up, each raise its own commit;
      // lowering one to make a build pass is forbidden.
      thresholds: {
        statements: 90,
        branches: 92,
        functions: 89,
        lines: 90,
      },
    },
  },
});
