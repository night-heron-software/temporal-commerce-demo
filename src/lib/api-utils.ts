import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { createLogger } from './logger';

const log = createLogger('api');

export interface ApiErrorResponse {
  error: string;
  correlationId: string;
}

/**
 * Creates a standardized error response object with a correlationId for tracing.
 * `context` is merged into the error log line (e.g. the target ES index) — it is never
 * sent to the client.
 */
export function createErrorResponse(
  status: number,
  message: string,
  error?: unknown,
  correlationId?: string,
  context?: Record<string, unknown>,
): NextResponse {
  const cid = correlationId || randomUUID();

  // 4xx responses are user-input/informational (bad lookups, unknown indices, guard
  // rejections) — warn keeps them out of the system_errors index, which is reserved for
  // genuine server-side failures (5xx stays error).
  const logFn = status >= 500 ? log.error : log.warn;
  logFn.call(log, { ...context, correlationId: cid, status, err: error }, message);

  const payload: ApiErrorResponse = {
    error: message,
    correlationId: cid,
  };

  return NextResponse.json(payload, { status });
}
