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
      // Ratchet, not aspiration (CLAUDE.md): measured 100% across all four
      // axes at C9. The package is 9 statements of schema wiring, so any
      // uncovered statement drops below 95 and fails — in practice this
      // gate demands full coverage. Thresholds only move up.
      thresholds: {
        statements: 95,
        branches: 95,
        functions: 95,
        lines: 95,
      },
    },
  },
});
