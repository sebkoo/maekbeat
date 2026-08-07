import type { FullConfig, FullResult, Reporter, Suite } from "@playwright/test/reporter";

/*
 * How many tests are allowed to skip, asserted instead of read.
 *
 * Every CI run of the smoke job since C19 has printed "1 skipped, 5 passed",
 * and the line is true: e2e/identity.spec.ts has nothing to compare against
 * unless something tells it which revision to expect, so it skips. What was
 * missing is any statement that ONE is the right number. A second skip — a tag
 * that went stale, an environment guard that stopped matching, a test parked
 * under test.skip() and forgotten — prints "2 skipped, 4 passed" into a job
 * that stays green, and nothing in this repository objects.
 *
 * So the budget is declared in playwright.config.ts and checked here after the
 * run. It is exact in both directions, which is the half that does more work:
 * under infra/compose-smoke.sh the budget is zero, and that is the only thing
 * in the repo asserting identity.spec.ts actually runs there rather than
 * skipping its way through the one place it was written for.
 *
 * The run has to be the whole suite. A filtered local run (`playwright test
 * journey.spec.ts`) skips nothing and fails here. That is deliberate: an
 * exemption for "I only ran part of it" is an exemption a CI command could
 * take, and the suite is six tests.
 */
export default class SkipBudget implements Reporter {
  private readonly expected: number;
  private root: Suite | undefined;

  constructor(options: { expected: number }) {
    this.expected = options.expected;
  }

  onBegin(_config: FullConfig, suite: Suite): void {
    this.root = suite;
  }

  // Async because Reporter#onEnd is declared to return a promise; the body has
  // nothing to await, and the return value is what changes the run's verdict.
  async onEnd(result: FullResult): Promise<{ status: FullResult["status"] } | undefined> {
    // A run that already failed is not clarified by a second verdict, and a
    // test never reached because an earlier one failed reports as skipped —
    // counting those would turn one real failure into two, one of them false.
    if (result.status !== "passed") return undefined;

    const skipped = (this.root?.allTests() ?? []).filter((test) => test.outcome() === "skipped");
    if (skipped.length === this.expected) return undefined;

    // Named rather than counted, because "2 skipped" sends a reader to the
    // reporter output and a title sends them to the test.
    console.error(
      [
        "",
        `skip budget: ${String(skipped.length)} test(s) skipped, ${String(this.expected)} expected.`,
        ...skipped.map((test) => `  skipped: ${test.titlePath().filter(Boolean).join(" › ")}`),
        "  A skip nobody declared is a test that looks present and proves nothing.",
        "  Fix the skip, or change EXPECTED_SKIPS in playwright.config.ts and say why.",
        "  (Running a subset of the suite fails here too — run all of it.)",
        "",
      ].join("\n"),
    );
    return { status: "failed" };
  }
}
