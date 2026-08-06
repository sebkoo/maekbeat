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

beforeAll(async () => {
  // The module calls buildCdkApp() at its top level, because that call is what
  // `cdk synth` executes. Importing it therefore runs it, so the environment
  // has to be satisfied before the import rather than inside the test.
  process.env.BUILD_REVISION = REVISION;
  process.env.API_CERTIFICATE_ARN = CERT_ARN;
  ({ buildCdkApp } = await import("./main"));
});

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
    const app = buildCdkApp(ENV);
    const stacks = app.node.children.filter((c) => c.node.id === "Maekbeat");
    expect(stacks).toHaveLength(1);
    const template = Template.fromStack(stacks[0] as never);
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
    // `Validations` has no read side — addPlugins only writes — so the
    // registered set is read through Stage's older accessor, which is the one
    // public way to ask. Deprecated, and used here rather than reaching into a
    // private field, because a test that reads `_policyValidation` breaks
    // silently the day CDK renames it.
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
    const stack = app.node.children.find((c) => c.node.id === "Maekbeat");
    const report = new AwsSolutionsChecks(app, {}).validateScope(stack as never);
    expect(report.violations.map((v) => v.ruleName)).toEqual([]);
    expect(ACKNOWLEDGED.length).toBeGreaterThan(0);
  });
});
