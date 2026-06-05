/**
 * OpenTelemetry Tracing Bootstrap
 *
 * Initializes the OTel Node.js SDK with OTLP HTTP exporter targeting Jaeger.
 * Must be called BEFORE any other imports that should be auto-instrumented.
 *
 * Gated by OTEL_ENABLED=true. When disabled, this module is a complete no-op —
 * no SDK is loaded, no exporter connections are attempted, zero overhead.
 *
 * Usage (top of entry point, before other imports):
 *   import { initTracing } from '../lib/tracing';
 *   initTracing('demo-workers');
 *
 * Configuration:
 *   OTEL_ENABLED                  — 'true' to activate (default: disabled)
 *   OTEL_EXPORTER_OTLP_ENDPOINT   — OTLP HTTP endpoint (default: http://localhost:4318)
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

import { createLogger } from './logger';

const logger = createLogger('tracing');

let sdk: NodeSDK | null = null;

/**
 * Initialize OpenTelemetry tracing for the current process.
 * No-op when OTEL_ENABLED !== 'true'.
 */
export function initTracing(serviceName: string): void {
  if (process.env.OTEL_ENABLED !== 'true') return;

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';

  logger.info({ serviceName, endpoint }, 'Initializing OpenTelemetry tracing');

  sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: serviceName,
    }),
    traceExporter: new OTLPTraceExporter({
      url: `${endpoint}/v1/traces`,
    }),
    instrumentations: [
      // Auto-instrumentations cover: cassandra-driver, @elastic/elasticsearch,
      // http, dns, net, express, and many more.
      getNodeAutoInstrumentations({
        // Filesystem instrumentation is extremely noisy — disable it
        '@opentelemetry/instrumentation-fs': { enabled: false },
        // Winston instrumentation is not needed (we use Pino) — disable to
        // prevent module resolution warnings for @opentelemetry/winston-transport
        '@opentelemetry/instrumentation-winston': { enabled: false },
      }),
    ],
  });

  sdk.start();
  logger.info('OpenTelemetry tracing initialized');
}

/**
 * Gracefully shutdown the OTel SDK, flushing any pending spans.
 * Call this during application shutdown.
 */
export async function shutdownTracing(): Promise<void> {
  if (sdk) {
    logger.info('Shutting down OpenTelemetry tracing');
    await sdk.shutdown();
    sdk = null;
  }
}
