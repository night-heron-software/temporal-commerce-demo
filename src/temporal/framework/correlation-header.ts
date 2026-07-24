/**
 * Correlation header codec — shared by the workflow-outbound injector
 * (`activity-capture.ts`) and the worker's activity-inbound interceptor
 * (`src/lib/worker-otel.ts`).
 *
 * Workflow-safe: imports only `@temporalio/common`. Pure encode/decode over the default
 * payload converter so both sides agree on the wire shape and the round-trip is unit
 * testable without a worker.
 */
import { defaultPayloadConverter, type Payload } from '@temporalio/common';

/** Header key carrying the correlationId payload on scheduled activities. */
export const CORRELATION_ID_HEADER = 'correlationId';

/** Encode a correlationId for an activity header. */
export function encodeCorrelationHeader(correlationId: string): Payload {
  return defaultPayloadConverter.toPayload(correlationId);
}

/** Decode a correlation header payload; undefined when absent or not a string. */
export function decodeCorrelationHeader(payload: Payload | undefined): string | undefined {
  if (!payload) return undefined;
  try {
    const value = defaultPayloadConverter.fromPayload(payload);
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}
