# infra/cdk — the AWS stack, synthesized and asserted

**Nothing here has been deployed.** This package generates a CloudFormation
template and a test suite asserts against it. It has never been applied to an
AWS account, no stack has ever been created from it, and no number anywhere in
this repository was measured on AWS. Everything below runs with no credentials.

The claim it does make is narrow: this is how the system you can already run
with `docker compose -f infra/compose.yaml up` would run on AWS. Every resource
has a counterpart in the system that exists today, and the ones that do not have
one are absent — see [What is not here](#what-is-not-here).

## Running it

Both variables are required and neither has a default, so a synth that cannot
name what it is building fails instead of producing a template that looks fine.

```sh
pnpm install

# The assertion suite. No AWS account, no credentials, no network.
pnpm --filter @maekbeat/infra-cdk test

# The template itself, written to infra/cdk/cdk.out/Maekbeat.template.json.
BUILD_REVISION="$(git rev-parse HEAD)" \
API_CERTIFICATE_ARN="arn:aws:acm:eu-west-1:111122223333:certificate/11111111-2222-3333-4444-555555555555" \
  pnpm --filter @maekbeat/infra-cdk synth
```

`API_CERTIFICATE_ARN` is a certificate the stack imports rather than creates,
because issuing one needs a domain and this repository owns none. Synthesis does
not contact AWS, so any well-formed ARN produces a template; a deployment would
need a real one in the stack's own region.

`BUILD_REVISION` is the commit being deployed. It becomes both the container
image tag and the `BUILD_REVISION` the server reports on `/healthz`, from one
value — the identity relation [infra/compose-smoke.sh](../compose-smoke.sh)
already checks against `git rev-parse HEAD` one layer down.

## What each resource is for

Every row names the thing in this repository it serves. That is the rule this
stack is held to: a resource that cannot name one is cut.

| Resource                                | What it is the AWS form of                                                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `AWS::ECR::Repository`                  | the image [infra/server.Dockerfile](../server.Dockerfile) builds, which compose tags `maekbeat-server:compose`                       |
| `AWS::EC2::VPC` and its subnets         | the compose network                                                                                                                  |
| `AWS::ECS::TaskDefinition`, `::Service` | the `server` service in [infra/compose.yaml](../compose.yaml): its environment block and its `stop_grace_period`                     |
| `AWS::Logs::LogGroup`                   | the pino stream [apps/server/src/app.ts](../../apps/server/src/app.ts) writes to stdout, read under compose with `docker logs`       |
| `AWS::ElasticLoadBalancingV2::*`        | the published port `127.0.0.1:3000:3000`, and the healthcheck infra/server.Dockerfile declares                                       |
| `AWS::S3::Bucket`, `AWS::CloudFront::*` | the `web` service: the apps/web bundle [infra/web.Dockerfile](../web.Dockerfile) builds and [infra/nginx.conf](../nginx.conf) serves |

## What is not here

[docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) names an SQS event queue
(stage 4), an S3 raw archive (stage 6) and a Lambda fan-out (stage 7) as target
architecture. None of the three is in this stack, because no code in this
repository produces to a queue, writes an archive object, or would run inside
that Lambda: the queue is an in-process ring buffer
([apps/server/src/store.ts](../../apps/server/src/store.ts)) and the fan-out is
an in-process publisher
([apps/server/src/stream.ts](../../apps/server/src/stream.ts)).

An undeployed CDK app is the easiest place in a repository to write fiction,
because CloudFormation will synthesize a system that does not exist and the
template looks identical either way. A Lambda with no handler reads as
competence until somebody looks for the handler.
`src/stack.test.ts` asserts the absence of all six resource types rather than
leaving it to this paragraph.

Also absent, and for the same reason: the S3 buckets that would satisfy
cdk-nag's access-logging rules for the site bucket, the load balancer and the
distribution. Nothing in this repository reads an access log. Those findings are
acknowledged with that written reason in `src/suppressions.ts`.

## What the assertions prove

`src/stack.test.ts` is deliberately made of relations between two things rather
than of values. A value nobody has run is a value nobody can check; a relation
between two halves that both live in this repository is checkable today.

| Assertion                 | How it is checked                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| the required-env contract | iterates `REQUIRED_PRODUCTION_ENV`, imported from apps/server, over the synthesized task definition — never a retyped list  |
| websocket survival        | the ALB idle timeout, read from the template, must exceed twice the `STREAM_HEARTBEAT_MS` also read from the template       |
| the health check path     | taken out of the template and requested against a real `buildApp()` instance, asserting the status code the matcher expects |
| the dashboard origin      | `CORS_ORIGIN` must be an `Fn::GetAtt` on the distribution this stack creates, not a literal that agrees with it today       |
| no mixed content          | CloudFront redirects viewers to HTTPS, so the API listener is HTTPS and there is no port-80 listener                        |
| the image                 | built from this stack's own ECR repository, tagged with the same revision the container reports as `BUILD_REVISION`         |
| the OTLP implication      | if the task ever sets an OTLP endpoint, some container in it must listen on 4317 or 4318                                    |

`src/snapshot.test.ts` pins the whole template in addition, because the property
assertions above would pass on a stack that grew a resource nobody meant to add.
Regenerate it deliberately with `pnpm --filter @maekbeat/infra-cdk test -u`, and
read the diff.

`src/main.test.ts` asserts what the entry point wires, because every other suite
here builds its own app and rule pack and would stay green if `cdk synth`
registered neither. That is the shape of the C12a, C12 and C17 defects, three
times over. It carries one named residual: the registration uses the current
`Validations.of(app).addPlugins()` API, but asking which plugins are registered
has no supported read — `Stage#policyValidationBeta1` is the only public one and
is deprecated, and the `Validations.of(stage).plugins` its notice names does not
exist in aws-cdk-lib 2.263.0. On v3 the gate keeps working and this proof of its
wiring is what breaks; the alternatives are recorded beside the assertion.

Every cold synthesis in this package happens in a `beforeAll`, and
`vitest.config.ts` carries a measured timeout budget beside the numbers it was
derived from. Both exist because the first `Template.fromStack` in a worker
process costs 1.3-1.8 s here and up to 6.1 s on a two-core CI runner, while
every synth after it costs 45-50 ms.

## cdk-nag

`AwsSolutionsChecks` runs at synth time, registered on the app `cdk synth`
executes rather than inside a test, so a violation fails the synth.

**Counted: 11 before remediation, 1 fixed, 10 raised against the stack as it
stands, 10 acknowledged, 0 left.**

The one fixed is `AwsSolutions-ECS4` (Container Insights), because it is a
property on a resource that already exists rather than a new resource. The ten
acknowledged are each something this stack would have to invent to satisfy — an
access-log bucket, a WAF WebACL, a flow-log destination — or a control it cannot
apply: `AwsSolutions-CFR4` wants a TLS floor that CloudFront only honours behind
a custom domain, and this repository owns none.

Two of the ten are worth reading rather than counting. `AwsSolutions-ECS2` asks
for Secrets Manager, and the task definition holds a log level, a public origin,
a keepalive interval and a git SHA — every one of them documented in a
checked-in `.env.example` precisely because none is sensitive.
`AwsSolutions-IAM5` asks for evidence, and gets it: the only `Resource: "*"`
statement is `ecr:GetAuthorizationToken`, an API that accepts no resource, which
`src/nag.test.ts` asserts rather than takes on trust.

cdk-nag 3 acknowledges findings one at a time — no prefix match, no pack-wide
off switch — so nothing here can be a blanket suppression even by accident.

`src/nag.test.ts` asserts the count before acknowledgement as well as after: a
finding that appears and is acknowledged in one edit leaves "0 unacknowledged"
looking exactly like a finding that never existed.

## Not verified in CI

Every command above has run on one laptop and none has run in CI, because
GitHub Actions has been in outage since 15:22 UTC on 2026-08-06. The job wiring
is in place — `infra/cdk` is a workspace package, so `pnpm -r test:coverage` and
`pnpm -r typecheck` pick it up unchanged — but it has never executed there.
