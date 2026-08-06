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
