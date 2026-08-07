import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { beforeAll, describe, expect, it } from "vitest";

import { MaekbeatStack } from "./stack";
import { ACKNOWLEDGED, suppressions } from "./suppressions";

/*
 * cdk-nag, and what is left after it.
 *
 * The count before remediation is asserted as well as the count after, because
 * only the second number is easy to keep at zero: a finding that appears and is
 * acknowledged in the same edit leaves "0 unacknowledged" looking exactly like
 * a finding that never existed. The before-count moving is the signal.
 */

const REVISION = "0f1e2d3c4b5a69788796a5b4c3d2e1f0deadbeef";
const CERT_ARN =
  "arn:aws:acm:eu-west-1:111122223333:certificate/11111111-2222-3333-4444-555555555555";

/**
 * Every synthesis this file needs, done once in a hook.
 *
 * The first `Template.fromStack` in a worker process pays for CDK's synthesis
 * machinery warming up — 1.3-1.8 s here, 5.6-6.1 s on a two-core CI runner —
 * and every one after it in the same process costs 45-50 ms. Charged to a test
 * body it lands on whichever test reaches it first, which in this file was the
 * IAM5 evidence check and not the four tests above it, and it timed out on CI
 * against a per-test budget while passing locally. See src/stack.test.ts for
 * the same note and the numbers behind it.
 */
let raised: string[];
let unacknowledged: string[];
let template: Template;

beforeAll(() => {
  raised = findings(false);
  unacknowledged = findings(true);
  template = Template.fromStack(
    new MaekbeatStack(new App(), "Maekbeat", {
      revision: REVISION,
      apiCertificateArn: CERT_ARN,
    }),
  );
});

function findings(acknowledge: boolean): string[] {
  const app = new App();
  const stack = new MaekbeatStack(app, "Maekbeat", {
    revision: REVISION,
    apiCertificateArn: CERT_ARN,
  });
  if (acknowledge) suppressions(stack);
  const report = new AwsSolutionsChecks(app, {}).validateScope(stack);
  return report.violations.map((v) => v.ruleName);
}

describe("AwsSolutions checks", () => {
  it("leaves nothing unacknowledged", () => {
    expect(unacknowledged).toEqual([]);
  });

  it("still raises the findings the acknowledgements answer", () => {
    // The positive control for the test above. Without it, deleting the whole
    // rule pack would read as a clean stack, and so would a remediation that
    // silently stopped applying.
    expect(raised.length).toBeGreaterThan(0);
    expect([...raised].sort()).toEqual([...ACKNOWLEDGED.map((a) => a.id)].sort());
  });

  it("has one acknowledgement per finding, and no acknowledgement without one", () => {
    // A dead acknowledgement is worse than none: it reads as a considered
    // exception and silences nothing, so the day the finding comes back under
    // a different construct path nobody hears about it.
    for (const entry of ACKNOWLEDGED) {
      expect(raised, `${entry.id} is acknowledged but never raised`).toContain(entry.id);
    }
    expect(new Set(ACKNOWLEDGED.map((a) => `${a.path}|${a.id}`)).size).toBe(ACKNOWLEDGED.length);
  });

  it("gives every acknowledgement a reason that says something", () => {
    for (const { id, reason } of ACKNOWLEDGED) {
      // Not a length check for its own sake. The failure this catches is the
      // one-word reason — "not applicable", "by design" — which is a blanket
      // suppression with extra steps.
      expect(reason.length, `${id} has a reason too short to be one`).toBeGreaterThan(80);
      expect(reason, `${id} restates the rule instead of answering it`).not.toMatch(
        /^(not applicable|by design|n\/a|accepted)\.?$/i,
      );
    }
  });
});

describe("an acknowledgement that points at nothing", () => {
  it("fails loudly instead of silencing nothing", () => {
    // The quiet failure this prevents: a construct renamed in src/stack.ts
    // leaves its acknowledgement attached to a path that no longer exists, so
    // the finding comes back, the reason is still written down, and the
    // template stops synthesizing for a reason nobody connects to the rename.
    // `suppressions` refuses rather than shrugging, and the message names the
    // path it could not find.
    expect(() => suppressions(new Stack(new App(), "Empty"))).toThrow(/no construct at SiteBucket/);
  });
});

describe("the IAM5 acknowledgement's evidence", () => {
  it("is true: the only wildcard resource is the one the ECR API requires", () => {
    // The acknowledgement claims that the single Resource '*' statement is
    // ecr:GetAuthorizationToken, an API that accepts no resource. That claim is
    // checked here rather than trusted, so a future statement widening to '*'
    // is not quietly covered by a reason written about a different one.
    const statements = Object.values(template.findResources("AWS::IAM::Policy")).flatMap(
      (policy) =>
        (policy.Properties as { PolicyDocument: { Statement: Record<string, unknown>[] } })
          .PolicyDocument.Statement,
    );
    const wildcards = statements.filter((s) => s.Resource === "*");
    expect(wildcards).toHaveLength(1);
    expect(wildcards[0]?.Action).toBe("ecr:GetAuthorizationToken");

    // And the rest really are scoped, so "every other statement is scoped" in
    // the written reason is a checked sentence rather than a hopeful one.
    for (const statement of statements) {
      if (statement.Resource === "*") continue;
      expect(JSON.stringify(statement.Resource)).toMatch(/Fn::GetAtt|Fn::Join|Ref/);
    }
  });
});
