import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      // v8 provider over all of src/ except tests; no other exclusions —
      // excluding a file from the denominator is a G3 event, not a
      // convenience (the apps/server main.ts precedent).
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text", "lcov"],
      // Ratchet, not aspiration (CLAUDE.md): set just under the C9 measured
      // floor — 98.57% statements / 97.36% branches / 100% functions /
      // 98.52% lines. Thresholds only move up, each raise its own commit;
      // lowering one to make a build pass is forbidden.
      thresholds: {
        statements: 96,
        branches: 95,
        functions: 97,
        lines: 96,
      },
    },
  },
});
