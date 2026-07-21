import { NextRequest, NextResponse } from 'next/server';
import {
  clearSystemErrors,
  querySystemErrors,
  DEFAULT_PAGE_SIZE,
  type ErrorLevel,
} from '@/app/dev/system-errors/errors-service';

/**
 * GET  /api/dev/system-errors — page through error/fatal log lines from the `system_errors` index
 * DELETE /api/dev/system-errors — empty the index
 *
 * NOTE: this route deliberately does NOT use `createErrorResponse` from `@/lib/api-utils`.
 * That helper logs at error level, which feeds the very Elasticsearch index this route reads —
 * so if ES is down, every failed page load would queue another error write. Hand-roll the
 * responses here and log to the console instead. This is the one place that exception applies.
 */

/** Hand-rolled param parsing — no zod dep, matching api/dev/order-trace/route.ts. */
function parseParams(searchParams: URLSearchParams) {
  const q = searchParams.get('q')?.trim() || undefined;

  const rawLevel = searchParams.get('level');
  const level: ErrorLevel | undefined =
    rawLevel === 'error' || rawLevel === 'fatal' ? rawLevel : undefined;

  const since = searchParams.get('since')?.trim() || undefined;
  const page = Number(searchParams.get('page')) || 1;
  const pageSize = Number(searchParams.get('pageSize')) || DEFAULT_PAGE_SIZE;

  return { q, level, since, page, pageSize };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  try {
    const result = await querySystemErrors(parseParams(searchParams));
    return NextResponse.json(result);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error('[system-errors] Elasticsearch query failed:', detail);
    return NextResponse.json({ error: 'Failed to query system errors', detail }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const deleted = await clearSystemErrors();
    return NextResponse.json({ success: true, deleted });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error('[system-errors] Elasticsearch delete failed:', detail);
    return NextResponse.json({ error: 'Failed to clear system errors', detail }, { status: 500 });
  }
}
