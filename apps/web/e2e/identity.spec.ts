import { expect, test } from "@playwright/test";

import { API_URL } from "../playwright.config";

/*
 * Which build is answering.
 *
 * Every assertion in journey.spec.ts is about behaviour, and behaviour is
 * exactly what a stale layer preserves: a container built from last week's
 * source streams frames, raises the alert and honours the acknowledgement, and
 * passes the entire suite while being the wrong software. C13 learned this one
 * layer up, where a cached `dist/` served a bundle nobody had built.
 *
 * So the identity is asserted separately from the behaviour, against a value
 * that comes from outside the stack: infra/compose-smoke.sh reads
 * `git rev-parse HEAD`, passes it into the build as BUILD_REVISION, and puts it
 * here as E2E_EXPECTED_REVISION. The image carries it as
 * org.opencontainers.image.revision and the process serves it on /healthz — one
 * value, three places, and a compose cache hit that skips a rebuild makes them
 * disagree.
 *
 * Unset, the test skips rather than passing: there is nothing to compare
 * against when the suite runs against `pnpm start` from a working tree, and a
 * green tick for a comparison that did not happen is the failure mode this
 * whole file is about.
 *
 * Where that leaves it, and this paragraph is rewritten by the commit that
 * changed it: the `compose` job in .github/workflows/ci.yml stands the stack up
 * and runs infra/compose-smoke.sh, so this test now runs in CI on every push and
 * every pull request. Before that job existed it ran on a developer's machine
 * and nowhere else — not because anything was hard, but because no job invoked
 * the script.
 *
 * It still skips in the `smoke` job, which drives a locally built bundle and a
 * spawned server and has no revision to compare against. That is two runs of
 * these six tests with two different skip budgets, and both are checked:
 * playwright.config.ts sets the budget from the environment and
 * e2e/skip-budget.ts enforces it, while scripts/check-e2e-skips.sh pins the
 * number from outside the suite in each job — 1 in `smoke`, 0 in `compose`.
 * The outside check is what notices if E2E_EXPECTED_REVISION ever stops
 * reaching the suite, which would make this test skip while the budget agreed.
 */
const expected = process.env.E2E_EXPECTED_REVISION;

test.describe("the running stack is this commit", () => {
  test.skip(
    expected === undefined,
    "E2E_EXPECTED_REVISION is unset: no build identity to compare against",
  );

  test("serves the revision it was built from", async ({ request }) => {
    const response = await request.get(`${API_URL}/healthz`);
    expect(response.ok()).toBe(true);

    const body = (await response.json()) as { revision?: string };
    // Named rather than compared bare, so a failure reads as two SHAs that
    // differ instead of as `undefined !== "a1b2c3"`.
    expect(body.revision, "revision served by /healthz").toBe(expected);
  });
});
