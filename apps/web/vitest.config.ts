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
        // Ratchet, not aspiration (CLAUDE.md): raised at C11 against a measured
        // 96.95% statements / 92.10% branches / 98.19% functions / 98.46% lines,
        // with the untested browser entry main.tsx counted against it.
        //
        // Branches is the one that did not move: C10 measured 93.87% and C11
        // measures 92.10%, because the live path adds branchier code than it
        // adds covered branches. The threshold therefore stays at 91 — a
        // threshold never follows a measurement downwards.
        thresholds: {
          statements: 95,
          branches: 91,
          functions: 96,
          lines: 96,
        },
      },
    },
  }),
);
