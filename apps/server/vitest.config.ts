import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      // v8 provider over everything in src/ except the tests themselves —
      // main.ts (the process entry) stays in the denominator on purpose, so
      // the reported number is the honest floor the C9 gate will ratchet.
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text"],
    },
  },
});
