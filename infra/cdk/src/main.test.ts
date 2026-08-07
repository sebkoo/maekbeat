import { Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { beforeAll, describe, expect, it } from "vitest";

import { ACKNOWLEDGED } from "./suppressions";

/*
 * What the entry point actually wires.
 *
 * Every other suite in this package builds its own App, its own stack and its
 * own rule pack, and would stay green if src/main.ts registered nothing at all.
 * That is the shape of five defects this repository has already paid for — a
 * retention policy never called from buildApp (C12a), a dashboard that had
 * never crossed an origin (C12), a RootView that never called start() (C17) —
 * and it is why this file exists.
 */

const REVISION = "0f1e2d3c4b5a69788796a5b4c3d2e1f0deadbeef";
const CERT_ARN =
  "arn:aws:acm:eu-west-1:111122223333:certificate/11111111-2222-3333-4444-555555555555";

const ENV = { BUILD_REVISION: REVISION, API_CERTIFICATE_ARN: CERT_ARN };

let buildCdkApp: (env?: NodeJS.ProcessEnv) => import("aws-cdk-lib").App;
/**
 * The one synthesis this file needs, done in the hook with the import.
 *
 * The first `Template.fromStack` in a worker process pays for CDK's synthesis
 * machinery warming up — 1.3-1.8 s on the machine this was written on, 5.6-6.1 s
 * on a two-core CI runner — while every one after it costs 45-50 ms. Charged to
 * a test body it timed out against the per-test budget on CI and passed here;
 * src/stack.test.ts carries the measurements.
 */
let template: Template;

beforeAll(async () => {
  // The module calls buildCdkApp() at its top level, because that call is what
  // `cdk synth` executes. Importing it therefore runs it, so the environment
  // has to be satisfied before the import rather than inside the test.
  process.env.BUILD_REVISION = REVISION;
  process.env.API_CERTIFICATE_ARN = CERT_ARN;
  ({ buildCdkApp } = await import("./main"));
  template = Template.fromStack(stackOf(buildCdkApp(ENV)));
});

/** The one stack an app built here holds, or a failure that says otherwise. */
function stackOf(app: import("aws-cdk-lib").App): never {
  const stacks = app.node.children.filter((c) => c.node.id === "Maekbeat");
  expect(stacks).toHaveLength(1);
  return stacks[0] as never;
}

describe("buildCdkApp", () => {
  it("refuses to synthesize without a revision, naming it", () => {
    // The same refusal infra/server.Dockerfile makes: a default would produce
    // a template naming an image tag nobody built.
    expect(() => buildCdkApp({ API_CERTIFICATE_ARN: CERT_ARN })).toThrow(/BUILD_REVISION/);
    expect(() => buildCdkApp({ ...ENV, BUILD_REVISION: "   " })).toThrow(/BUILD_REVISION/);
  });

  it("refuses to synthesize without an API certificate, and says why", () => {
    expect(() => buildCdkApp({ BUILD_REVISION: REVISION })).toThrow(/API_CERTIFICATE_ARN/);
    expect(() => buildCdkApp({ BUILD_REVISION: REVISION })).toThrow(/mixed content/);
    expect(() => buildCdkApp({ ...ENV, API_CERTIFICATE_ARN: "" })).toThrow(/API_CERTIFICATE_ARN/);
  });

  it("builds one stack, from the values it was given", () => {
    const containers = Object.values(template.findResources("AWS::ECS::TaskDefinition")).flatMap(
      (d) =>
        (
          d.Properties as {
            ContainerDefinitions: { Environment: { Name: string; Value: unknown }[] }[];
          }
        ).ContainerDefinitions,
    );
    const revision = containers[0]?.Environment.find((e) => e.Name === "BUILD_REVISION");
    expect(revision?.Value).toBe(REVISION);
  });

  it("registers the rule pack on the app cdk synth runs", () => {
    // Not "a rule pack exists somewhere" — this one. Without it the whole
    // cdk-nag suite would be asserting the properties of an object nothing
    // downstream ever sees, and `cdk synth` would emit a template no rule had
    // read.
    const app = buildCdkApp(ENV);
    // RESIDUAL, and the reason it is written here rather than fixed: this read
    // is the only public one, and it is deprecated.
    //
    // src/main.ts REGISTERS through the current API — `Validations.of(app)
    // .addPlugins(...)` — so the security gate itself is not at risk. What is
    // deprecated is asking which plugins are registered. `Validations` has no
    // read side at all (aws-cdk-lib 2.263.0 exposes only addPlugins,
    // acknowledge, addWarning and addError), so the only public way to ask is
    // `Stage#policyValidationBeta1`, which prints "This API will be removed in
    // the next major release" on every run of this file.
    //
    // Its own deprecation notice names `Validations.of(stage).plugins` as the
    // replacement, and that accessor does not exist in 2.263.0 — absent from
    // both the type definitions and the runtime, checked rather than assumed.
    // So there is currently no supported way to write this assertion.
    //
    // What breaks on aws-cdk-lib v3 is therefore this test, not the gate: the
    // pack would still be registered and would still fail synth, and the only
    // thing lost is the proof that src/main.ts wires it — which is exactly the
    // C17-shaped hole this test exists to close. The two options on that day
    // are `Validations.of(stage).plugins` if it has shipped by then, or
    // replacing the read with a behavioural check that synthesizes a stack with
    // the acknowledgements withheld and asserts the synth fails.
    //
    // Matched on the pack's own `name` rather than with `instanceof`: CDK
    // stores plugins through a jsii boundary that hands back a structural
    // proxy, so the identity check silently fails on the right object. The
    // expected name is read off a fresh pack instead of typed, so renaming the
    // pack cannot leave this passing against a string.
    const plugins = (app as unknown as { policyValidationBeta1: { name: string }[] })
      .policyValidationBeta1;
    expect(plugins.map((p) => p.name)).toContain(new AwsSolutionsChecks().name);
  });

  it("applies every acknowledgement to the stack it built", () => {
    // The other half: a rule pack wired to a stack with no acknowledgements
    // fails synth on ten findings, and one wired to acknowledgements that were
    // never applied passes on none of them.
    const app = buildCdkApp(ENV);
    const report = new AwsSolutionsChecks(app, {}).validateScope(stackOf(app));
    expect(report.violations.map((v) => v.ruleName)).toEqual([]);
    expect(ACKNOWLEDGED.length).toBeGreaterThan(0);
  });
});
