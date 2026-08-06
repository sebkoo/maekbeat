import { App, Validations } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";

import { MaekbeatStack } from "./stack";
import { suppressions } from "./suppressions";

/*
 * The CDK app entry — `cdk synth` runs this file (cdk.json).
 *
 * The composition is here and nowhere else, which is why it is a function
 * rather than a script. src/nag.test.ts builds its own pack and its own app to
 * count findings, and would keep passing if this file stopped registering the
 * rule pack entirely; src/stack.test.ts builds its own stack, and would keep
 * passing if this file stopped applying the acknowledgements. That gap — every
 * unit green while the thing that actually ships is unwired — is the defect
 * C17 found in apps/ios and C12a found in apps/server, twice each. So the
 * wiring is a function with a return value, and src/main.test.ts asserts what
 * it wired.
 */

/**
 * Reads the deployment's two inputs from the environment and returns the app
 * `cdk synth` will write.
 *
 * Neither input has a default. A default revision would produce a template
 * that synthesizes cleanly and names an image tag nobody built, which is the
 * failure infra/server.Dockerfile's argument-with-no-default already refuses;
 * a default certificate ARN would produce a stack whose dashboard cannot call
 * its own API, since a page served over HTTPS may not read an http:// origin.
 */
export function buildCdkApp(env: NodeJS.ProcessEnv = process.env): App {
  const revision = env.BUILD_REVISION?.trim();
  if (revision === undefined || revision === "") {
    throw new Error(
      "BUILD_REVISION is required — set it to the commit being synthesized, e.g. " +
        'BUILD_REVISION="$(git rev-parse HEAD)" pnpm --filter @maekbeat/infra-cdk synth',
    );
  }
  const apiCertificateArn = env.API_CERTIFICATE_ARN?.trim();
  if (apiCertificateArn === undefined || apiCertificateArn === "") {
    throw new Error(
      "API_CERTIFICATE_ARN is required — the dashboard is served over HTTPS, so the API " +
        "listener needs a certificate or the browser blocks every call to it as mixed content. " +
        "Nothing here is deployed, so any well-formed ARN synthesizes (infra/cdk/README.md).",
    );
  }

  const app = new App();
  const stack = new MaekbeatStack(app, "Maekbeat", {
    revision,
    apiCertificateArn,
    description:
      "Maekbeat: synthesized and asserted, never deployed. Educational demo, not a medical device.",
  });

  // Registered on the app rather than run inside a test, so the findings are
  // about the template `cdk synth` writes and a violation fails the synth.
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  suppressions(stack);
  return app;
}

buildCdkApp();
