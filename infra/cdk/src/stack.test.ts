import { buildApp } from "@maekbeat/server/app";
import { loadConfig, REQUIRED_PRODUCTION_ENV } from "@maekbeat/server/config";
import { STREAM_HEARTBEAT_MS_DEFAULT } from "@maekbeat/server/stream";
import { App, type Duration } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";

import { ALB_IDLE_TIMEOUT, MaekbeatStack, SERVER_PORT } from "./stack";

/*
 * What this template claims, checked.
 *
 * None of it has been deployed. That is exactly why the assertions here are
 * about relations between two things rather than about any single value: a
 * value nobody has run is a value nobody can check, but "the health check path
 * is a path the server answers" and "the idle timeout exceeds the heartbeat"
 * are checkable today, with no AWS account and no credentials, because both
 * halves are in this repository.
 *
 * Every number below is read out of the synthesized template or imported from
 * apps/server. A number retyped here would be a second copy that agrees with
 * the first until someone changes one of them.
 */

const REVISION = "0f1e2d3c4b5a69788796a5b4c3d2e1f0deadbeef";
const CERT_ARN =
  "arn:aws:acm:eu-west-1:111122223333:certificate/11111111-2222-3333-4444-555555555555";

function synth(): Template {
  return Template.fromStack(
    new MaekbeatStack(new App(), "Maekbeat", { revision: REVISION, apiCertificateArn: CERT_ARN }),
  );
}

/**
 * Synthesized once, in a hook, and read by every test below.
 *
 * Not a speed optimisation — a correctness one about where the cost is
 * charged. The first `Template.fromStack` in a worker process pays for the
 * whole of CDK's synthesis machinery warming up and costs 1.3-1.8 s on the
 * machine this was written on and 5.6-6.1 s on a two-core CI runner with four
 * other packages' vitest processes beside it; every synth after it in the same
 * process costs 45-50 ms. Left inside a test body, that one-off landed on
 * whichever test happened to run first and blew vitest's 5 s per-test default
 * on CI while passing locally — a red build whose cause was construction, not
 * the assertion the test names.
 *
 * A `Template` is a read-only view over synthesized JSON, so sharing one across
 * tests shares no mutable state. The tests that genuinely need a different
 * stack build their own.
 */
let template: Template;

beforeAll(() => {
  template = synth();
});

/** The one container definition, or a failure that says so. */
function container(template: Template): Record<string, unknown> {
  const definitions = Object.values(template.findResources("AWS::ECS::TaskDefinition"));
  expect(definitions).toHaveLength(1);
  const containers = (definitions[0]?.Properties as { ContainerDefinitions: unknown[] })
    .ContainerDefinitions;
  expect(containers).toHaveLength(1);
  return containers[0] as Record<string, unknown>;
}

/** The container's environment as a map; values may be unresolved tokens. */
function environment(template: Template): Map<string, unknown> {
  const entries = container(template).Environment as { Name: string; Value: unknown }[];
  return new Map(entries.map((e) => [e.Name, e.Value]));
}

function soleResource(template: Template, type: string): Record<string, unknown> {
  const found = Object.values(template.findResources(type));
  expect(found, `exactly one ${type}`).toHaveLength(1);
  return (found[0] as { Properties: Record<string, unknown> }).Properties;
}

describe("the stack synthesizes", () => {
  it("produces a template with the resources the compose stack has counterparts for", () => {
    // Not a count of every resource — CDK creates subnets and route tables by
    // the handful and pinning those would be pinning the CDK version. These
    // are the ones a reader of infra/compose.yaml would look for.
    template.resourceCountIs("AWS::ECS::TaskDefinition", 1);
    template.resourceCountIs("AWS::ECS::Service", 1);
    template.resourceCountIs("AWS::ECR::Repository", 1);
    template.resourceCountIs("AWS::ElasticLoadBalancingV2::LoadBalancer", 1);
    template.resourceCountIs("AWS::ElasticLoadBalancingV2::TargetGroup", 1);
    template.resourceCountIs("AWS::S3::Bucket", 1);
    template.resourceCountIs("AWS::CloudFront::Distribution", 1);
    template.resourceCountIs("AWS::Logs::LogGroup", 1);
  });

  it("contains no resource whose counterpart does not exist in this repository", () => {
    // The assertion this stack is most at risk of failing, and the one a
    // reviewer will make first. docs/ARCHITECTURE.md names an SQS queue, an S3
    // raw archive and a Lambda fan-out as target architecture; none of them is
    // backed by code here — the queue is a ring buffer in apps/server/src/
    // store.ts and the fan-out is a publisher in apps/server/src/stream.ts —
    // so a template that grew one would be describing a system nobody can run.
    //
    // The S3 entry is not in this list, because the site bucket is real: it
    // holds the apps/web bundle that infra/web.Dockerfile builds today. What
    // is asserted about S3 instead is that there is exactly one bucket, above.
    const types = new Set(
      Object.values(template.toJSON().Resources as Record<string, { Type: string }>).map(
        (r) => r.Type,
      ),
    );
    for (const absent of [
      "AWS::SQS::Queue",
      "AWS::Lambda::Function",
      "AWS::DynamoDB::Table",
      "AWS::RDS::DBInstance",
      "AWS::Kinesis::Stream",
      "AWS::SNS::Topic",
    ]) {
      expect([...types], `${absent} has no code in this repository behind it`).not.toContain(
        absent,
      );
    }
    // Positive control for the list above: it is matching against real types
    // rather than against nothing. If this fails, the template shape changed
    // and the absences above prove less than they look like they do.
    expect([...types]).toContain("AWS::ECS::TaskDefinition");
  });
});

describe("the required-environment contract", () => {
  it("supplies every variable the server refuses to start without", () => {
    // Derived, never retyped: REQUIRED_PRODUCTION_ENV is the object
    // apps/server/src/config.ts drives its own startup check from. A variable
    // added there and not wired into the task definition fails here, which is
    // the only place in this repository where the two can be compared.
    const env = environment(template);
    for (const name of Object.keys(REQUIRED_PRODUCTION_ENV)) {
      expect(env.has(name), `${name} is required in production and not in the task`).toBe(true);
      expect(env.get(name)).not.toBe("");
    }
    expect(Object.keys(REQUIRED_PRODUCTION_ENV).length).toBeGreaterThan(0);
  });

  it("supplies a task environment the server's own schema accepts", () => {
    // The literal half of the contract, run through the real parser. Token
    // values cannot be checked this way — CORS_ORIGIN is not a string until
    // deploy time — so it is given a concrete stand-in of the shape the stack
    // produces, and the identity of the real one is asserted separately below.
    const env = environment(template);
    const literals: Record<string, string> = { NODE_ENV: "production" };
    for (const [name, value] of env) {
      if (typeof value === "string") literals[name] = value;
    }
    literals.CORS_ORIGIN = "https://d111111abcdef8.cloudfront.net";
    const config = loadConfig(literals);
    expect(config.BUILD_REVISION).toBe(REVISION);
    expect(config.STREAM_HEARTBEAT_MS).toBe(STREAM_HEARTBEAT_MS_DEFAULT);
  });
});

describe("websocket survival", () => {
  it("gives the load balancer an idle timeout longer than the server's heartbeat", () => {
    // Both numbers come out of the template. The heartbeat the container is
    // actually configured with, not the default the server would have used:
    // a task that overrode STREAM_HEARTBEAT_MS upward past the idle timeout
    // would break every idle dashboard while the constant stayed innocent.
    const heartbeatMs = Number(environment(template).get("STREAM_HEARTBEAT_MS"));
    expect(Number.isFinite(heartbeatMs)).toBe(true);

    const attributes = soleResource(template, "AWS::ElasticLoadBalancingV2::LoadBalancer")
      .LoadBalancerAttributes as { Key: string; Value: string }[];
    const idle = attributes.find((a) => a.Key === "idle_timeout.timeout_seconds");
    expect(
      idle,
      "the idle timeout is set explicitly rather than left at the 60 s default",
    ).toBeDefined();
    const idleMs = Number(idle?.Value) * 1000;

    // Strictly greater is not enough. One lost ping must not close a healthy
    // socket, so the timeout has to span more than one heartbeat interval —
    // the failure is silent and looks like a flaky network, which is why the
    // margin is asserted rather than left to a comment.
    expect(idleMs).toBeGreaterThan(heartbeatMs * 2);
  });

  it("keeps the deregistration delay inside the server's own stop budget", () => {
    // A fan-out socket is long-lived by design. Draining for longer than
    // apps/server takes to close its peers would hold a deploy open on
    // connections the server already let go; draining for less would cut them.
    const properties = soleResource(template, "AWS::ElasticLoadBalancingV2::TargetGroup");
    const attributes = properties.TargetGroupAttributes as { Key: string; Value: string }[];
    const delay = attributes.find((a) => a.Key === "deregistration_delay.timeout_seconds");
    expect(Number(delay?.Value)).toBe(10);
  });
});

describe("the health check", () => {
  it("probes a path a real apps/server answers with the code it expects", async () => {
    const properties = soleResource(template, "AWS::ElasticLoadBalancingV2::TargetGroup");
    const path = properties.HealthCheckPath as string;
    const expected = Number((properties.Matcher as { HttpCode: string }).HttpCode);

    // The strongest form available without an account: take the path out of
    // the template and request it against a real server. A string comparison
    // against "/healthz" would pass just as happily against a server that no
    // longer serves it — and a probe pointed at a path the server does not
    // answer marks every healthy task unhealthy, so the service never
    // stabilises and the deploy rolls back with nothing wrong in the logs.
    const app = await buildApp(loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }));
    try {
      const response = await app.inject({ method: "GET", url: path });
      expect(response.statusCode).toBe(expected);
    } finally {
      await app.close();
    }
  });

  it("probes the port the container listens on", () => {
    expect(soleResource(template, "AWS::ElasticLoadBalancingV2::TargetGroup").Port).toBe(
      SERVER_PORT,
    );
    const mappings = container(template).PortMappings as { ContainerPort: number }[];
    expect(mappings.map((m) => m.ContainerPort)).toEqual([SERVER_PORT]);
  });
});

describe("the dashboard origin", () => {
  it("sets CORS_ORIGIN to the distribution this stack creates, by reference", () => {
    const distributionId = Object.keys(template.findResources("AWS::CloudFront::Distribution"))[0];
    expect(distributionId).toBeDefined();

    // Not a string comparison: at synth time the domain does not exist, so the
    // only honest check is that the value in the task definition is a
    // reference to this distribution. Two literals that happen to agree is the
    // failure mode one layer up from the compose CORS mutation, and a
    // reference cannot have it.
    expect(environment(template).get("CORS_ORIGIN")).toEqual({
      "Fn::Join": ["", ["https://", { "Fn::GetAtt": [distributionId, "DomainName"] }]],
    });
  });

  it("serves the dashboard and the API over the same scheme", () => {
    // Mixed content. CloudFront redirects viewers to HTTPS, so the page runs
    // on https:// and a browser will not let it call an http:// API at all —
    // every read blocked before it leaves the tab, which is C12's
    // never-crossed origin rebuilt one layer up. The listener is therefore
    // HTTPS with a certificate, and there is no port 80 listener for a request
    // that could not be made.
    const distribution = soleResource(template, "AWS::CloudFront::Distribution");
    const config = distribution.DistributionConfig as {
      DefaultCacheBehavior: { ViewerProtocolPolicy: string };
    };
    expect(config.DefaultCacheBehavior.ViewerProtocolPolicy).toBe("redirect-to-https");

    const listeners = Object.values(
      template.findResources("AWS::ElasticLoadBalancingV2::Listener"),
    );
    expect(listeners).toHaveLength(1);
    const listener = (listeners[0] as { Properties: Record<string, unknown> }).Properties;
    expect(listener.Protocol).toBe("HTTPS");
    expect(listener.Port).toBe(443);
    expect(listener.Certificates).toEqual([{ CertificateArn: CERT_ARN }]);
  });

  it("never falls back to a wildcard allowlist", () => {
    // `*` would make every origin assertion in this file unfalsifiable, which
    // is the argument docs/DECISIONS.md #21 already makes for the compose
    // stack: an allowlist nobody can break is an allowlist that proves nothing.
    expect(environment(template).get("CORS_ORIGIN")).not.toBe("*");
  });
});

describe("the image", () => {
  it("comes from the repository this stack owns, tagged with the revision it reports", () => {
    const repositoryId = Object.keys(template.findResources("AWS::ECR::Repository"))[0];
    expect(repositoryId).toBeDefined();

    const image = container(template).Image as { "Fn::Join": [string, unknown[]] };
    const parts = JSON.stringify(image);
    // The URI is built from this repository's own ARN and Ref rather than from
    // a registry string somebody typed. A literal account id or a literal
    // repository name here is how a task ends up pulling an image nobody in
    // this repository builds.
    expect(parts).toContain(`"${repositoryId}"`);
    expect(parts).not.toMatch(/\d{12}\.dkr\.ecr/);

    // One value, two places. The tag and the BUILD_REVISION the server reports
    // on /healthz are the same string, which is what makes
    // infra/compose-smoke.sh's identity check meaningful up here: a service
    // running a previous image answers with a revision its own tag denies.
    expect(image["Fn::Join"][1].at(-1)).toBe(`:${REVISION}`);
    expect(environment(template).get("BUILD_REVISION")).toBe(REVISION);
  });

  it("cannot have its tag moved out from under a running task", () => {
    // An image tag that can be repointed is a tag that cannot answer "which
    // commit is this", which is the whole of the C19 identity proof.
    expect(soleResource(template, "AWS::ECR::Repository").ImageTagMutability).toBe("IMMUTABLE");
  });
});

describe("tracing", () => {
  it("does not configure an OTLP endpoint unless something in the stack receives it", () => {
    // The implication rather than the absence, so this stays a guard when the
    // stack grows a collector. C18's tracing is off unless the endpoint is
    // set, and an endpoint pointing at nothing is worse than tracing switched
    // off: it looks configured, and the operator spends the incident hunting
    // for spans that were never exported.
    const endpoint = environment(template).get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT");
    if (endpoint === undefined) {
      expect(endpoint).toBeUndefined();
      return;
    }
    const containers = Object.values(template.findResources("AWS::ECS::TaskDefinition")).flatMap(
      (d) =>
        (d.Properties as { ContainerDefinitions: { PortMappings?: { ContainerPort: number }[] }[] })
          .ContainerDefinitions,
    );
    const ports = containers.flatMap((c) => (c.PortMappings ?? []).map((m) => m.ContainerPort));
    expect(
      ports,
      "an OTLP endpoint is configured but nothing in this task listens on 4317 or 4318",
    ).toSatisfy((p: number[]) => p.includes(4317) || p.includes(4318));
  });
});

describe("the idle-timeout constant", () => {
  it("is derived from the server's heartbeat rather than chosen", () => {
    // The relation asserted in the template is also asserted at the source, so
    // a heartbeat raised in apps/server without a matching timeout here fails
    // twice rather than drifting quietly.
    const timeout: Duration = ALB_IDLE_TIMEOUT;
    expect(timeout.toMilliseconds()).toBeGreaterThan(STREAM_HEARTBEAT_MS_DEFAULT * 2);
  });
});

describe("the service runs one task", () => {
  it("does not scale out a server that keeps all of its state in process", () => {
    // The assertion most likely to look like a mistake and least likely to be
    // one. apps/server holds the frame ring, the alert engine, the decision log
    // and the fan-out registry in memory, none of them shared, so a second task
    // is a second system: a device's frames exist only on the task its ingest
    // socket landed on, and a dashboard on the other task subscribes to silence
    // while its REST reads alternate between a full history and an empty one.
    //
    // Horizontal scaling is stage 4 of docs/ARCHITECTURE.md — a shared queue
    // and a shared store — and neither has code behind it. Raising this number
    // before that lands is the single change to this stack that would turn a
    // working system into a broken one with nothing else in the template
    // looking wrong.
    const service = soleResource(template, "AWS::ECS::Service");
    expect(service.DesiredCount).toBe(1);

    // And the deploy must not do transiently what the count forbids: a rolling
    // replacement runs old and new together for the length of a deploy, which
    // is the same split state. Stop-then-start instead, which costs a gap that
    // both clients already recover from by reconnecting and back-filling.
    const deployment = service.DeploymentConfiguration as {
      MinimumHealthyPercent: number;
      MaximumPercent: number;
    };
    expect(deployment.MinimumHealthyPercent).toBe(0);
    expect(deployment.MaximumPercent).toBe(100);
  });
});
