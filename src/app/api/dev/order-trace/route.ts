import { NextRequest, NextResponse } from 'next/server';
import { createErrorResponse } from '@/lib/api-utils';
import { buildOrderTrace, resolveOrderId } from '@/app/dev/order-trace/trace-service';

/**
 * GET /api/dev/order-trace
 *
 * Read-only cross-domain order trace for the developer tools. Look up an order by one
 * of `orderId`, `confirmation`, or `email` — searched against the Elasticsearch orders
 * index.
 *
 * An email that matches multiple orders returns `{ candidates }` for the caller to
 * disambiguate.
 */
interface TraceQueryParams {
  orderId?: string;
  confirmation?: string;
  email?: string;
}

/** Trim the three lookup params; at least one must be non-empty (hand-rolled — no zod dep). */
function parseQueryParams(searchParams: URLSearchParams): TraceQueryParams | null {
  const pick = (name: string): string | undefined => {
    const v = searchParams.get(name)?.trim();
    return v ? v : undefined;
  };
  const params: TraceQueryParams = {
    orderId: pick('orderId'),
    confirmation: pick('confirmation'),
    email: pick('email'),
  };
  if (!params.orderId && !params.confirmation && !params.email) return null;
  return params;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const params = parseQueryParams(searchParams);
  if (!params) {
    return createErrorResponse(400, 'Provide one of orderId, confirmation, or email');
  }

  try {
    const resolved = await resolveOrderId(params);

    if (resolved.candidates) {
      return NextResponse.json({ candidates: resolved.candidates });
    }
    if (!resolved.orderId || !resolved.storeId) {
      return createErrorResponse(404, 'No order matched the lookup');
    }

    const trace = await buildOrderTrace(resolved.storeId, resolved.orderId);
    return NextResponse.json({ trace });
  } catch (error) {
    return createErrorResponse(500, 'Failed to build order trace', error);
  }
}
