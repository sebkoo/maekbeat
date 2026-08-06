import { REQUIRED_PRODUCTION_ENV } from "@maekbeat/server/config";
import { STREAM_HEARTBEAT_MS_DEFAULT } from "@maekbeat/server/stream";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";

/*
 * The compose stack's counterpart on AWS.
 *
 * NOTHING HERE HAS BEEN DEPLOYED. This file generates a CloudFormation
 * template and src/stack.test.ts asserts against that template. It has never
 * been applied to an account, no stack has ever been created from it, and no
 * number anywhere in this repository was measured on AWS.
 *
 * The claim it does make is narrow and checkable: this is how the system you
 * can already run with `docker compose -f infra/compose.yaml up` would run on
 * AWS. Every resource below has a counterpart in the system that exists today,
 * and that mapping is the reason each one is here:
 *
 *   ECR repository         the image infra/server.Dockerfile builds, which
 *                          compose tags maekbeat-server:compose
 *   VPC and subnets        the compose network
 *   ECS cluster, task      the `server` service in infra/compose.yaml: its
 *   and service            environment block and its stop_grace_period
 *   CloudWatch log group   the pino stream the server writes to stdout
 *                          (apps/server/src/app.ts), read under compose with
 *                          `docker logs`
 *   ALB, listener and      the published port `127.0.0.1:3000:3000` — the only
 *   target group           way a browser reaches the API — and the container
 *                          healthcheck infra/server.Dockerfile declares
 *   S3 bucket, CloudFront  the `web` service: the apps/web bundle that
 *                          infra/web.Dockerfile builds and infra/nginx.conf
 *                          serves, including its index.html fallback
 *
 * What is deliberately absent is the more interesting half of the target
 * architecture. docs/ARCHITECTURE.md names an SQS event queue (stage 4), an S3
 * raw archive (stage 6) and a Lambda fan-out (stage 7); none of the three is
 * here, because no code in this repository produces to a queue, writes an
 * archive object, or would run inside that Lambda. The queue is an in-process
 * ring buffer (apps/server/src/store.ts) and the fan-out is an in-process
 * publisher (apps/server/src/stream.ts). A resource with no counterpart is a
 * lie with a CloudFormation type, and it reads as competence for exactly as
 * long as nobody looks for the handler. They land when the code does.
 */

export interface MaekbeatStackProps extends StackProps {
  /**
   * The commit being deployed. It is both the container image tag and the
   * `BUILD_REVISION` the server reports on /healthz, from one value — the
   * identity check infra/compose-smoke.sh makes against `git rev-parse HEAD`,
   * which is what catches a service still running a previous image while every
   * functional probe stays green.
   */
  readonly revision: string;
  /**
   * ACM certificate for the API listener, in this stack's region.
   *
   * Required rather than optional, and that is a correctness constraint rather
   * than a preference. CloudFront serves the dashboard over HTTPS and redirects
   * anything else, so a browser holding that page cannot call an `http://` API
   * at all — every request would be mixed content and blocked before it left
   * the tab. An optional certificate would make the default synth a stack whose
   * dashboard cannot reach its own server, which is the C12 defect (a dashboard
   * that could not cross an origin) rebuilt one layer up. src/stack.test.ts
   * asserts the two schemes match rather than trusting this comment.
   *
   * It is imported, never created: issuing a certificate needs a domain, and
   * this repository owns none.
   */
  readonly apiCertificateArn: string;
}

/**
 * Idle timeout on the load balancer.
 *
 * This is the composition failure this stack is most likely to have, and both
 * halves are individually correct. A dashboard watching a quiet device
 * receives nothing for as long as the device stays quiet — device disconnect
 * is the first failure mode in docs/ARCHITECTURE.md — and an ALB's 60-second
 * default calls a socket carrying no bytes dead, so every idle dashboard is
 * disconnected on a timer. apps/server pings each fan-out socket every
 * STREAM_HEARTBEAT_MS for exactly this reason, so this number is not a taste:
 * it has to exceed the server's stated maximum silence with room for a lost
 * ping. Four heartbeats. src/stack.test.ts asserts the relation against the
 * value it reads back out of the synthesized task definition rather than
 * against a number retyped in the test.
 */
export const ALB_IDLE_TIMEOUT = Duration.seconds((STREAM_HEARTBEAT_MS_DEFAULT / 1000) * 4);

/** The port the container listens on; infra/server.Dockerfile EXPOSEs it. */
export const SERVER_PORT = 3000;

export class MaekbeatStack extends Stack {
  /** Exposed so assertions can name constructs rather than logical ids. */
  readonly imageRepository: ecr.Repository;
  readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: MaekbeatStackProps) {
    super(scope, id, props);
    const { revision, apiCertificateArn } = props;

    // -----------------------------------------------------------------------
    // The dashboard: infra/web.Dockerfile's bundle, without the nginx.
    //
    // The web container says in its own header that it is not a deployment
    // artifact, and docs/ARCHITECTURE.md names the target as an S3 origin
    // behind a CDN. So the bundle crosses over and the server serving it does
    // not.
    // -----------------------------------------------------------------------
    const siteBucket = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.distribution = new cloudfront.Distribution(this, "SiteDistribution", {
      defaultRootObject: "index.html",
      defaultBehavior: {
        // Origin Access Control, so the bucket stays private and CloudFront is
        // its only reader. Compose has no equivalent because there the files
        // are inside the nginx image.
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      // react-router owns every path that is not a file, which is the rule
      // infra/nginx.conf states as `try_files $uri $uri/ /index.html`. 403 as
      // well as 404, because a private S3 origin answers a missing key with
      // AccessDenied rather than NoSuchKey.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html" },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html" },
      ],
    });

    /**
     * The dashboard's origin, and the value the API's CORS allowlist is set to
     * — one expression used twice rather than two strings that agree today.
     *
     * At synth time this is an unresolved CloudFormation attribute, so the
     * template carries a reference to this distribution in both places and
     * cannot carry two different domains. infra/compose.yaml states the same
     * relation in literals because it knows both ports; here the domain does
     * not exist until deploy time, which makes the reference mandatory rather
     * than merely tidier (docs/DECISIONS.md #21).
     */
    const siteOrigin = `https://${this.distribution.distributionDomainName}`;

    // -----------------------------------------------------------------------
    // The API: the `server` compose service.
    // -----------------------------------------------------------------------
    this.imageRepository = new ecr.Repository(this, "ServerImages", {
      imageScanOnPush: true,
      // A tag that can be moved is a tag that cannot answer "which commit is
      // this", which is the whole of the C19 identity proof.
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      // One NAT gateway, not one per zone. Named here because the alternative
      // is silence about a deliberate single point of failure: a zone-redundant
      // NAT is a cost decision this repository has no basis on which to make,
      // and one gateway is the smaller claim.
      natGateways: 1,
    });

    const logGroup = new logs.LogGroup(this, "ServerLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, "ServerTask", {
      cpu: 512,
      memoryLimitMiB: 1024,
    });

    taskDefinition.addContainer("server", {
      // Derived from the repository this stack owns and the revision it was
      // synthesized for; neither half is a literal. A hard-coded registry
      // string is how a task ends up pulling an image nobody in this repository
      // builds, and a floating tag is how it ends up running an image nobody
      // can name.
      image: ecs.ContainerImage.fromEcrRepository(this.imageRepository, revision),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "server", logGroup }),
      portMappings: [{ containerPort: SERVER_PORT, protocol: ecs.Protocol.TCP }],
      environment: {
        // The image already sets NODE_ENV, HOST and PORT; what is here is what
        // a deployment decides — the same split infra/compose.yaml makes.
        LOG_LEVEL: "info",
        CORS_ORIGIN: siteOrigin,
        STREAM_HEARTBEAT_MS: String(STREAM_HEARTBEAT_MS_DEFAULT),
        // Every variable the server refuses to start without under
        // NODE_ENV=production, read from the server rather than retyped
        // (apps/server/src/config.ts). A required variable added there and not
        // wired here fails src/stack.test.ts and, before that, the type below.
        ...requiredProductionEnv({ BUILD_REVISION: revision }),
      },
      // There is deliberately no OTEL_EXPORTER_OTLP_TRACES_ENDPOINT. C18's
      // tracing is off unless that variable is set, and nothing in this stack
      // terminates OTLP — no collector sidecar, no X-Ray daemon, nothing
      // listening on 4318. An endpoint pointing at nothing is worse than
      // tracing switched off, because it looks configured and an operator
      // spends the incident looking for the spans. src/stack.test.ts enforces
      // the implication rather than the absence: set it, and the stack must
      // contain something that receives it.
    });

    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      // Fixed rather than acknowledged, because it is a property on a resource
      // that already exists rather than a new resource with no counterpart.
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    const service = new ecs.FargateService(this, "ServerService", {
      cluster,
      taskDefinition,
      // ONE TASK, and this is the most important number in the file.
      //
      // apps/server keeps everything in process: the frame ring
      // (src/store.ts), the alert engine and its history (src/alerts.ts), the
      // decision log (src/acks.ts) and the fan-out registry (src/stream.ts).
      // None of them is shared, so a second task is not more capacity — it is a
      // second system holding a different half of the truth. A device's ingest
      // socket lands on one task and its frames exist only there; a dashboard
      // subscribing to that device may land on the other and receive nothing,
      // ever, while its REST reads alternate between a full history and an
      // empty one. That is not a load-balancer setting to tune, it is what
      // stage 4 of docs/ARCHITECTURE.md is for — a shared queue and a shared
      // store — and neither has code behind it.
      //
      // So the deployment states the limit that the code has rather than the
      // one an architecture diagram would like, and src/stack.test.ts asserts
      // it: raising this number is a deliberate act that breaks a test with the
      // reason attached, not a slider somebody nudges during an incident.
      desiredCount: 1,
      circuitBreaker: { rollback: true },
      // Stop the old task before starting the new one, which is the opposite
      // of the usual advice and follows from the line above. A rolling
      // replacement would run two tasks at once for the length of a deploy,
      // which is exactly the split state that count forbids. The cost is a gap
      // in service on every deploy, and it is affordable here precisely
      // because both clients already treat any close as reconnect-and-back-fill
      // (apps/web/src/api/stream.ts, apps/ios) — the same property the C19
      // slow-subscriber drop relies on.
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
    });

    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc,
      internetFacing: true,
      idleTimeout: ALB_IDLE_TIMEOUT,
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, "ServerTargets", {
      vpc,
      port: SERVER_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      targets: [service],
      // /healthz is a route apps/server actually serves, and src/stack.test.ts
      // proves it by taking this string out of the synthesized template and
      // requesting it against a real buildApp() instance. A probe pointed at a
      // path the server does not answer marks every healthy task unhealthy and
      // the deployment never stabilises.
      healthCheck: {
        path: "/healthz",
        healthyHttpCodes: "200",
        interval: Duration.seconds(15),
        timeout: Duration.seconds(5),
      },
      // A fan-out socket is long-lived by design, so a deregistration delay
      // shorter than the server's own stop is a deploy that cuts connections
      // the shutdown was about to close politely. Ten seconds matches the
      // stop_grace_period in infra/compose.yaml and the budget
      // apps/server/src/lifecycle.ts closes peers and flushes tracing in.
      deregistrationDelay: Duration.seconds(10),
    });

    // HTTPS only, and no port 80 at all. The dashboard is served over HTTPS by
    // CloudFront, so a browser holding that page cannot call an http:// API —
    // there is no listener here for a request that could never be made.
    this.loadBalancer.addListener("Api", {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [acm.Certificate.fromCertificateArn(this, "ApiCert", apiCertificateArn)],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      defaultTargetGroups: [targetGroup],
    });

    service.connections.allowFrom(this.loadBalancer, ec2.Port.tcp(SERVER_PORT));

    // The two addresses a deploy would need, and the one step this stack does
    // not perform. apps/web compiles its API address into the bundle at build
    // time (infra/web.Dockerfile, apps/web/.env.example), so the bundle that
    // goes into SiteBucket has to be built with the value below — and nothing
    // here builds or uploads it. Stated as an output rather than left for
    // someone to discover from a blank dashboard.
    new CfnOutput(this, "ApiBaseUrl", {
      value: `https://${this.loadBalancer.loadBalancerDnsName}`,
      description: "VITE_API_BASE_URL for the apps/web build that is uploaded to SiteBucket",
    });
    new CfnOutput(this, "DashboardUrl", {
      value: siteOrigin,
      description: "The dashboard origin, and the server's CORS_ORIGIN",
    });
  }
}

/**
 * Types the required-variable wiring, so a variable added to
 * REQUIRED_PRODUCTION_ENV and not supplied here is a compile error before it
 * is a test failure, and so this stack cannot supply one the server does not
 * require under that name.
 */
function requiredProductionEnv(
  values: Record<keyof typeof REQUIRED_PRODUCTION_ENV, string>,
): Record<string, string> {
  return values;
}
