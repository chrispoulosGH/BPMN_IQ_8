/**
 * OpenTelemetry setup, one SDK per service process. Must run before express /
 * http are required so the auto-instrumentation can patch them.
 *
 * Exports to an OTLP/HTTP (protobuf) collector — OTEL_EXPORTER_OTLP_ENDPOINT,
 * default http://localhost:4318. The collector forwards to Observe.
 */
const os = require('os');
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { CompositePropagator, W3CTraceContextPropagator, W3CBaggagePropagator } = require('@opentelemetry/core');
// OTLP/HTTP protobuf by default; OTEL_EXPORTER_OTLP_PROTOCOL=http/json switches to JSON.
const useJson = String(process.env.OTEL_EXPORTER_OTLP_PROTOCOL || '').toLowerCase() === 'http/json';
const { OTLPTraceExporter } = useJson ? require('@opentelemetry/exporter-trace-otlp-http') : require('@opentelemetry/exporter-trace-otlp-proto');
const { OTLPMetricExporter } = useJson ? require('@opentelemetry/exporter-metrics-otlp-http') : require('@opentelemetry/exporter-metrics-otlp-proto');
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');
const { UndiciInstrumentation } = require('@opentelemetry/instrumentation-undici');
const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = require('@opentelemetry/semantic-conventions');
const api = require('@opentelemetry/api');
const A = require('./attributes');

/** Copies bpmn.* / business.* baggage entries onto every span at start. */
class BaggageAttributeSpanProcessor {
  onStart(span, parentContext) {
    const baggage = api.propagation.getBaggage(parentContext || api.context.active());
    if (!baggage) return;
    for (const [key, entry] of baggage.getAllEntries()) {
      if (A.BAGGAGE_PREFIXES.some((prefix) => key.startsWith(prefix))) span.setAttribute(key, entry.value);
    }
  }
  onEnd() {}
  forceFlush() { return Promise.resolve(); }
  shutdown() { return Promise.resolve(); }
}

let sdk = null;

/**
 * @param {object} options
 * @param {string} options.serviceName  service.name (the application acronym, or the engine)
 * @param {object} [options.attributes] extra resource attributes (app.id, host.name, ...)
 */
function initTelemetry({ serviceName, attributes = {} }) {
  if (sdk) return sdk;
  // No log signal is produced; don't let the SDK create a default OTLP logs exporter.
  if (!process.env.OTEL_LOGS_EXPORTER) process.env.OTEL_LOGS_EXPORTER = 'none';
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: process.env.SERVICE_VERSION || '1.0.0',
    'service.namespace': process.env.SERVICE_NAMESPACE || 'bpmn-iq',
    'service.instance.id': `${serviceName}-${process.pid}`,
    'deployment.environment.name': process.env.DEPLOYMENT_ENVIRONMENT || 'mock-production',
    'telemetry.source': 'bpmn-iq-mockprod',
    'host.name': os.hostname(),
    ...attributes,
  });

  sdk = new NodeSDK({
    resource,
    autoDetectResources: false,
    textMapPropagator: new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()] }),
    spanProcessors: [
      new BaggageAttributeSpanProcessor(),
      new BatchSpanProcessor({ exporter: new OTLPTraceExporter(), maxExportBatchSize: 256, scheduledDelayMillis: 2000 }),
    ],
    // NodeSDK reads `metricReaders` (array); a singular `metricReader` is ignored
    // in this version and the SDK falls back to its env-based 60 s reader.
    metricReaders: [new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis: Number(process.env.METRIC_EXPORT_INTERVAL_MS || 15000),
      exportTimeoutMillis: Math.min(Number(process.env.METRIC_EXPORT_INTERVAL_MS || 15000), 10000),
    })],
    instrumentations: [
      new HttpInstrumentation({
        // Don't trace the launcher's health probes.
        ignoreIncomingRequestHook: (req) => req.url === '/healthz',
      }),
      // Route handlers only; per-middleware spans are noise here.
      new ExpressInstrumentation({ ignoreLayersType: ['middleware'] }),
      // Node's global fetch() (undici): client spans + traceparent/baggage headers.
      new UndiciInstrumentation(),
    ],
  });
  sdk.start();

  const shutdown = async () => {
    try { await sdk.shutdown(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return sdk;
}

module.exports = { initTelemetry };
