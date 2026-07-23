/**
 * Ambient correlation context for activities (Node side — NOT workflow-sandbox-safe).
 *
 * The worker's activity-inbound interceptor (see `worker-otel.ts`) decodes the
 * `correlationId` header injected by the workflow-outbound interceptor
 * (`src/temporal/framework/activity-capture.ts`) and runs every activity inside
 * `runWithCorrelationId`, so any code on the activity's async path — including the pino
 * mixin in `logger.ts` — can read the correlationId without threading it as a parameter.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<string>();

/** Run `fn` (and everything on its async path) with `correlationId` as ambient context. */
export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  return storage.run(correlationId, fn);
}

/** The ambient correlationId, or undefined outside any `runWithCorrelationId` scope. */
export function currentCorrelationId(): string | undefined {
  return storage.getStore();
}
