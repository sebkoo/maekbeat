import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
