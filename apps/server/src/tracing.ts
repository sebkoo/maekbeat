import type { Tracer } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import { AlwaysOffSampler, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

import type { ServerConfig } from "./config";
import { packageVersion } from "./version";

/**
 * Span attribute keys, defined once because two tests read this list rather
 * than a copy of it: the privacy gate asserts that every attribute a replay
 * produces appears here, and the shape test asserts the ones it names are
 * present. A new attribute that is not added here fails the privacy gate,
 * which is the intended friction — adding a span attribute to this server is
 * a decision about what leaves the process (docs/DECISIONS.md #20).
 *
 * The line these keys hold is "never a measured value", not "identifiers
 * only" — the looser claim would be untrue. `deviceId` and `seq` address a
 * frame, but `alertId` embeds the rule that fired (`spo2-low`) and
 * `alertMetric` names it outright, so an alert span does say that a device had
 * a low-SpO2 episode at a time. That is the alert, and a span about an alert
 * that will not say which alert is useless. What never appears is the reading:
 * heart rate, SpO2, respiration and motion are the data, and no attribute here
 * carries one (docs/DECISIONS.md #20).
 */
export const SPAN_ATTRIBUTES = {
  deviceId: "maekbeat.device.id",
  seq: "maekbeat.frame.seq",
  duplicate: "maekbeat.frame.duplicate",
  outOfOrder: "maekbeat.frame.out_of_order",
  newSession: "maekbeat.frame.new_session",
  sessionEpoch: "maekbeat.frame.session_epoch",
  ingestOutcome: "maekbeat.ingest.outcome",
  validateResult: "maekbeat.validate.result",
  storeResult: "maekbeat.store.result",
  transitionCount: "maekbeat.alert.transition_count",
  alertId: "maekbeat.alert.id",
  alertState: "maekbeat.alert.state",
  alertMetric: "maekbeat.alert.metric",
  alertDirection: "maekbeat.alert.direction",
  subscriberCount: "maekbeat.stream.subscriber_count",
  messageCount: "maekbeat.stream.message_count",
} as const;

/** Span names, in the order the ingest path opens them. */
export const SPAN_NAMES = {
  ingest: "ingest.frame",
  validate: "ingest.validate",
  store: "store.ingest",
  evaluate: "alert.evaluate",
  transition: "alert.transition",
  fanout: "stream.fanout",
} as const;

/** The tracer plus the lifecycle the process entry has to drive. */
export interface TracingHandle {
  /** Whether spans are recorded and exported at all. */
  enabled: boolean;
  tracer: Tracer;
  /**
   * The SDK provider, exposed so a test can ask what was actually wired rather
   * than trust what this module intended to wire. "Off" has to mean no span
   * processor and therefore no batch timer, and the only way to check that is
   * to look at the provider — a `process.getActiveResourcesInfo()` delta
   * cannot, because the batch processor calls `unref()` on its timer and an
   * unref'd handle never appears there whether tracing is on or off.
   */
  provider: NodeTracerProvider;
  /** Flushes pending spans and releases the exporter. Safe to call twice. */
  shutdown: () => Promise<void>;
}

const INSTRUMENTATION_SCOPE = "@maekbeat/server";

/**
 * A tracer that records nothing.
 *
 * Built from an explicit provider with `AlwaysOffSampler` rather than taken
 * from the global API, because the global is process-wide: one server turning
 * tracing on would turn it on for every other server in the process, and the
 * on-versus-off comparison in tracing.shape.test.ts — the proof that
 * instrumentation does not move an alert — would be comparing a thing to
 * itself. Off is a value here, not a global mode.
 *
 * `AlwaysOffSampler` returns NOT_RECORD, so each span is a `NonRecordingSpan`:
 * no attribute storage, no processor, no exporter, no timer.
 */
function disabledProvider(): NodeTracerProvider {
  return new NodeTracerProvider({ sampler: new AlwaysOffSampler() });
}

export function disabledTracer(): Tracer {
  return disabledProvider().getTracer(INSTRUMENTATION_SCOPE);
}

/**
 * Wires tracing from configuration alone.
 *
 * Deliberately not `provider.register()`: registering installs this provider
 * and a context manager as process-wide globals, and nothing here needs the
 * ambient context — every parent in this server is passed explicitly
 * (src/ingest.ts), so the causal structure is a property of the code rather
 * than of whichever async hook happened to be installed.
 */
export function startTracing(config: ServerConfig): TracingHandle {
  const endpoint = config.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (endpoint === undefined) {
    const provider = disabledProvider();
    return {
      enabled: false,
      tracer: provider.getTracer(INSTRUMENTATION_SCOPE),
      provider,
      shutdown: () => provider.shutdown(),
    };
  }

  const provider = new NodeTracerProvider({
    // Merged onto the default resource, not substituted for it. Passing a bare
    // `resourceFromAttributes` replaces the SDK's defaults outright, and the
    // spans then ship without telemetry.sdk.* and without anything the operator
    // set in OTEL_RESOURCE_ATTRIBUTES — deployment.environment among them,
    // which is the attribute most likely to be the one they need.
    resource: defaultResource().merge(
      resourceFromAttributes({
        [ATTR_SERVICE_NAME]: config.OTEL_SERVICE_NAME,
        [ATTR_SERVICE_VERSION]: packageVersion,
      }),
    ),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint }))],
  });

  return {
    enabled: true,
    tracer: provider.getTracer(INSTRUMENTATION_SCOPE),
    provider,
    // provider.shutdown() flushes the batch processor before releasing it, so
    // the spans of the last frames before a SIGTERM are exported rather than
    // dropped — the ones an operator most wants after an unplanned stop.
    shutdown: () => provider.shutdown(),
  };
}
