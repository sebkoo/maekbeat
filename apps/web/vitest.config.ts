import { defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config";

// Merged with vite.config.ts rather than redeclared: the tests must run through
// the same transform pipeline as the app, or a passing suite would prove
// nothing about the bundle the browser gets.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      // Test-harness wiring only (Testing Library auto-cleanup); it sits beside
      // the configs at the package root, not in src/, because it is not app code.
      setupFiles: ["./vitest.setup.ts"],
      coverage: {
        // v8 over all of src/ except the tests themselves. main.tsx (the browser
        // entry) stays in the denominator on purpose — the apps/server main.ts
        // precedent: excluding a file from here is a G3 event, not a convenience.
        provider: "v8",
        include: ["src/**/*.{ts,tsx}"],
        exclude: ["src/**/*.test.{ts,tsx}"],
        reporter: ["text", "lcov"],
        // Ratchet, not aspiration (CLAUDE.md): raised again at C12 against a
        // measured 97.11% statements / 92.61% branches / 97.05% functions /
        // 98.72% lines, with the untested browser entry main.tsx counted
        // against it. Functions holds at 96 rather than following its C11
        // measurement (98.19%) down — a threshold never moves with a dip.
        thresholds: {
          statements: 96,
          branches: 92,
          functions: 96,
          lines: 97,
        },
      },
    },
  }),
);
