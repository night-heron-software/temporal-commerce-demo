import { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from './logger';

const log = createLogger('api');

export interface ApiErrorResponse {
  error: string;
  correlationId: string;
}

/**
 * Creates a standardized error response object with a correlationId for tracing.
 */
export function createErrorResponse(
  status: number,
  message: string,
  error?: unknown,
  correlationId?: string,
): NextResponse {
  const cid = correlationId || uuidv4();

  log.error({ correlationId: cid, status, err: error }, message);

  const payload: ApiErrorResponse = {
    error: message,
    correlationId: cid,
  };

  return NextResponse.json(payload, { status });
}
