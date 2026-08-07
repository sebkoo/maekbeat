import { defineConfig, devices, type ReporterDescription } from "@playwright/test";

/*
 * The smoke suite runs against what a visitor actually gets: a real Chromium,
 * the production bundle from `vite build` served as static files, a real
 * apps/server process, and a real cross-origin request between them.
 *
 * That combination is the point. C12 shipped a dashboard that could not reach
 * its own API from a browser — every suite mocked fetch, so nothing had ever
 * crossed an origin — and C12a shipped a retention rule that could have been
 * left unwired in buildApp with every server test still green. Both are the
 * same disease: nothing verified what the process runs. This file is the
 * mechanical cure for the web tier.
 *
 * Deliberately NOT here: the vite dev server (it proxies and transforms
 * differently from the bundle), any mock, and any fixture that stands in for a
 * real process.
 */

export const API_PORT = 3210;
export const WEB_PORT = 4210;

/*
 * Where the suite points, and the one thing that changes between running it
 * against a developer checkout and running it against the C19 compose stack.
 *
 * The suite itself does not change. A second, container-shaped copy of these
 * tests would prove that the copy passes and nothing about the system — the
 * whole argument for this file is that it drives the real processes, and a
 * fork of it would drive a different real thing and agree with itself.
 *
 * Both variables or neither. Setting one leaves the browser loading the
 * composed dashboard while the fixtures stream frames into a locally spawned
 * server, which fails as a puzzle rather than as a message.
 */
const externalBase = process.env.E2E_BASE_URL;
const externalApi = process.env.E2E_API_URL;
if ((externalBase === undefined) !== (externalApi === undefined)) {
  throw new Error(
    "E2E_BASE_URL and E2E_API_URL must be set together: one alone points the browser " +
      "and the fixtures at different systems (infra/compose-smoke.sh sets both).",
  );
}

/** True when the suite is aimed at something this file did not start. */
export const usesExternalStack = externalBase !== undefined;

export const BASE_URL = externalBase ?? `http://127.0.0.1:${WEB_PORT}`;
export const API_URL = externalApi ?? `http://127.0.0.1:${API_PORT}`;

/*
 * How many of the six tests are expected to skip. One number, checked against
 * the run by e2e/skip-budget.ts, which fails a run that disagrees.
 *
 * e2e/identity.spec.ts is the one, and only while E2E_EXPECTED_REVISION is
 * unset: there is no revision to compare a running stack against when the suite
 * was started from a working tree. infra/compose-smoke.sh sets it, so the
 * budget there is zero — which is what asserts that test does run against the
 * containers instead of skipping in the one place it was written for.
 *
 * Any other skip is unbudgeted and fails, which is the point: "1 skipped" has
 * been printing into a green job since C19 with nothing claiming 1 is correct.
 */
export const EXPECTED_SKIPS = process.env.E2E_EXPECTED_REVISION === undefined ? 1 : 0;

const reporters: ReporterDescription[] = process.env.CI ? [["list"], ["github"]] : [["list"]];
reporters.push(["./e2e/skip-budget.ts", { expected: EXPECTED_SKIPS }]);

export default defineConfig({
  testDir: "./e2e",
  // Smoke, not suite: a handful of tests that must always be worth their
  // runtime. The boundary against unit tests is written down in README.md.
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },

  /*
   * No retries, anywhere, including CI. A smoke test that quietly passes on the
   * second attempt reports a system that works when what it observed was a
   * system that failed and then worked — the same lie as a coverage badge left
   * quietly stale. If retries are ever introduced, `reporter` must be changed
   * with them so that failures-before-pass appear in the output rather than
   * being folded into a green tick.
   */
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: reporters,

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  // Two real processes. The dashboard is built with the API's address baked in,
  // so the browser makes a genuine cross-origin request to a different port —
  // exactly the shape that was broken and undetected until C12.
  //
  // Empty when the stack is already running somewhere else (the compose stack,
  // C19): the two containers are the two processes, built the same way and
  // crossing the same origin boundary, and starting a second pair here would
  // have the suite testing them instead.
  webServer: usesExternalStack
    ? []
    : [
        {
          command: "pnpm --filter @maekbeat/server start",
          env: { PORT: String(API_PORT), LOG_LEVEL: "warn" },
          url: `${API_URL}/healthz`,
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
        {
          command: `pnpm --filter @maekbeat/web build && pnpm --filter @maekbeat/web exec vite preview --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
          env: { VITE_API_BASE_URL: API_URL },
          url: BASE_URL,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      ],
});
