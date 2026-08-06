import { Validations } from "aws-cdk-lib";
import type { IConstruct } from "constructs";

/*
 * Every cdk-nag AwsSolutions finding this stack does not fix, and why.
 *
 * The ratio is the first thing worth reading and it is not flattering on its
 * face: one finding fixed, ten acknowledged. The reason is a rule this stack
 * is held to rather than a shortage of effort — every resource in src/stack.ts
 * has to name something in this repository that it serves, and seven of these
 * ten findings are remediated by creating a resource that serves nothing here.
 * An access-log bucket that no code in this repository reads is the same
 * category of fiction as a Lambda with no handler; it is just a category cdk-nag
 * rewards. So they are acknowledged with the reason written down, which is a
 * decision a reviewer can disagree with, rather than fixed into a template that
 * would look more compliant and mean less.
 *
 * cdk-nag 3 acknowledges findings one at a time — there is no prefix match and
 * no pack-wide off switch — so nothing here can be a blanket suppression even
 * by accident. src/nag.test.ts fails on any finding that is not on this list,
 * including a new one, and on any entry here that no longer matches a finding.
 */

/** Resolves a construct by its path below the stack, e.g. `Alb/SecurityGroup`. */
function at(scope: IConstruct, path: string): IConstruct {
  return path.split("/").reduce<IConstruct>((node, part) => {
    const child = node.node.tryFindChild(part);
    if (child === undefined) {
      throw new Error(
        `no construct at ${path} — an acknowledgement is pointing at a resource ` +
          `that no longer exists, which means it is silencing nothing`,
      );
    }
    return child;
  }, scope);
}

/** Every acknowledgement, as data, so src/nag.test.ts can read the same list. */
export const ACKNOWLEDGED = [
  {
    path: "SiteBucket",
    id: "AwsSolutions-S1",
    reason:
      "Server access logging writes to a second S3 bucket that nothing in this repository reads. " +
      "The compose stack's equivalent is a container writing to stdout, and this stack keeps that " +
      "equivalence where it exists — the server's pino output has a CloudWatch log group — rather " +
      "than inventing a log estate for the edge. A deployment with an operator behind it turns this " +
      "on and points it at whatever already receives its logs.",
  },
  {
    path: "SiteDistribution",
    id: "AwsSolutions-CFR1",
    reason:
      "Geo restriction is a policy control, and this repository has no policy to encode: the " +
      "dashboard renders synthetic data from a simulator and serves no jurisdiction (DISCLAIMER.md). " +
      "Adding a country list here would be stating a distribution decision nobody has made.",
  },
  {
    path: "SiteDistribution",
    id: "AwsSolutions-CFR2",
    reason:
      "A WAF WebACL is a resource with no counterpart in the running system and a rule set nobody " +
      "here has written. The dashboard is a static bundle with no forms, no credentials and no " +
      "server-side rendering; the attack surface a WebACL would protect is the API, which sits " +
      "behind the load balancer and not behind this distribution.",
  },
  {
    path: "SiteDistribution",
    id: "AwsSolutions-CFR3",
    reason:
      "Access logging writes to an S3 bucket nothing in this repository reads — see AwsSolutions-S1.",
  },
  {
    path: "SiteDistribution",
    id: "AwsSolutions-CFR4",
    reason:
      "Not fixable in this stack, rather than declined. CloudFront pins MinimumProtocolVersion to " +
      "TLSv1 whenever the default *.cloudfront.net certificate is in use, and raising it requires a " +
      "custom domain and an ACM certificate in us-east-1 — a domain this repository does not own. " +
      "The dashboard is still served only over HTTPS: viewerProtocolPolicy is REDIRECT_TO_HTTPS. " +
      "The API listener, which does take a certificate, is on SslPolicy.RECOMMENDED_TLS.",
  },
  {
    path: "Vpc",
    id: "AwsSolutions-VPC7",
    reason:
      "A flow log writes to a destination nothing in this repository reads, and there is no incident " +
      "process here to read it — see AwsSolutions-S1. It is the first thing to turn on for a " +
      "deployment that has one.",
  },
  {
    path: "ServerTask",
    id: "AwsSolutions-ECS2",
    reason:
      "The rule asks for Secrets Manager or SSM, and this task definition holds no secret to put " +
      "there. Its four variables are LOG_LEVEL, CORS_ORIGIN, STREAM_HEARTBEAT_MS and " +
      "BUILD_REVISION: a log level, a public origin, a keepalive interval and a git SHA. The server " +
      "authenticates nobody and stores synthetic data (SECURITY.md), and every variable in the " +
      "contract is documented in a checked-in apps/server/.env.example precisely because none is " +
      "sensitive. Moving a git SHA into a secret store would make the deployment harder to audit, " +
      "not easier.",
  },
  {
    path: "ServerTask/ExecutionRole/DefaultPolicy",
    id: "AwsSolutions-IAM5[Resource::*]",
    reason:
      "The evidence, since this rule asks for it: the only statement in this policy with Resource '*' " +
      "is ecr:GetAuthorizationToken, and that API accepts no resource — the wildcard is the only " +
      "form AWS allows. Every other statement is scoped: the image pull to this stack's own ECR " +
      "repository ARN, and the log writes to this stack's own log group ARN. src/nag.test.ts " +
      "asserts that, so a future statement that widens to '*' is not covered by this acknowledgement.",
  },
  {
    path: "Alb",
    id: "AwsSolutions-ELB2",
    reason:
      "Access logging writes to an S3 bucket nothing in this repository reads — see AwsSolutions-S1.",
  },
  {
    path: "Alb/SecurityGroup",
    id: "AwsSolutions-EC23",
    reason:
      "This is the design rather than an oversight: the load balancer is internetFacing, because a " +
      "caregiver dashboard on the public internet has to reach the API from a browser. Inbound is " +
      "443 only and the listener terminates TLS with an ACM certificate; the tasks behind it accept " +
      "traffic from this security group and from nothing else. What the open port genuinely exposes " +
      "is that the server authenticates nobody, which is a stated limit of this repository " +
      "(SECURITY.md) and is not a thing a security group can fix.",
  },
] as const;

/** Applies every acknowledgement above to `stack`. */
export function suppressions(stack: IConstruct): void {
  for (const { path, id, reason } of ACKNOWLEDGED) {
    Validations.of(at(stack, path)).acknowledge({ id, reason });
  }
}
