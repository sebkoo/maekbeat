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
        // Ratchet, not aspiration (CLAUDE.md): set just under this package's C10
        // measured floor — 94.81% statements / 93.87% branches / 97.72%
        // functions / 95.04% lines, with the untested browser entry main.tsx
        // counted against it. Thresholds only move up, each raise its own
        // commit; lowering one to make a build pass is forbidden.
        thresholds: {
          statements: 92,
          branches: 91,
          functions: 95,
          lines: 93,
        },
      },
    },
  }),
);
