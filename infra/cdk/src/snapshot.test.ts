import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { MaekbeatStack } from "./stack";

/*
 * The whole template, pinned.
 *
 * This exists alongside src/stack.test.ts rather than instead of it, and the
 * split is the point. The property assertions say what the stack must be true
 * of and would pass just as happily on a template that grew a resource nobody
 * meant to add; this one says what the stack currently is and fails on any
 * change at all, including the ones the properties do not describe — a widened
 * security group, a removal policy flipped to DESTROY, a subnet count changing
 * under a CDK upgrade. Neither is sufficient. A snapshot alone proves nothing
 * about intent, and a reviewer reading an updated one has no way to tell a
 * deliberate change from an accident; the property tests are what make an
 * updated snapshot readable.
 *
 * Regenerate deliberately with `pnpm --filter @maekbeat/infra-cdk test -u`, and
 * read the diff before committing it.
 */

describe("the synthesized template", () => {
  it("matches the pinned snapshot", () => {
    // Fixed inputs, because a snapshot of a template built from `git rev-parse
    // HEAD` would change on every commit and teach everyone to update it
    // without looking.
    const template = Template.fromStack(
      new MaekbeatStack(new App(), "Maekbeat", {
        revision: "0f1e2d3c4b5a69788796a5b4c3d2e1f0deadbeef",
        apiCertificateArn:
          "arn:aws:acm:eu-west-1:111122223333:certificate/11111111-2222-3333-4444-555555555555",
      }),
    );
    expect(template.toJSON()).toMatchSnapshot();
  });
});
