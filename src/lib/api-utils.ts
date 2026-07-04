import { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';

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
  correlationId?: string
): NextResponse {
  const cid = correlationId || uuidv4();

  if (error instanceof Error) {
    console.error(`[${cid}] API Error (${status}):`, message, error.stack);
  } else {
    console.error(`[${cid}] API Error (${status}):`, message, error);
  }

  const payload: ApiErrorResponse = {
    error: message,
    correlationId: cid,
  };

  return NextResponse.json(payload, { status });
}
