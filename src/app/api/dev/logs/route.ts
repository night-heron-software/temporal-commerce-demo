import { NextRequest, NextResponse } from 'next/server';
import { querySystemLogs, DEFAULT_PAGE_SIZE, type LogLevelName } from '@/app/dev/logs/logs-service';

/**
 * GET /api/dev/logs — query and page through structured log lines across log files
 *
 * NOTE: this route deliberately does NOT use `createErrorResponse` from `@/lib/api-utils`.
 * Hand-roll error responses here to avoid recursive logger loops if log operations fail.
 */

const VALID_LEVELS = new Set<LogLevelName>(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

function parseParams(searchParams: URLSearchParams) {
  const service = searchParams.get('service')?.trim() || undefined;
  const q = searchParams.get('q')?.trim() || undefined;

  const rawLevel = searchParams.get('level')?.trim()?.toLowerCase();
  const level: LogLevelName | undefined =
    rawLevel && VALID_LEVELS.has(rawLevel as LogLevelName) ? (rawLevel as LogLevelName) : undefined;

  const since = searchParams.get('since')?.trim() || undefined;
  const page = Number(searchParams.get('page')) || 1;
  const pageSize = Number(searchParams.get('pageSize')) || DEFAULT_PAGE_SIZE;

  return { service, level, since, q, page, pageSize };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  try {
    const result = await querySystemLogs(parseParams(searchParams));
    return NextResponse.json(result);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error('[system-logs] Log file query failed:', detail);
    return NextResponse.json({ error: 'Failed to query system logs', detail }, { status: 500 });
  }
}
