/**
 * POST /api/dev/init/es-indices
 * Creates or ensures all Elasticsearch index mappings exist. Idempotent.
 */
import { NextResponse } from 'next/server';
import { ensureIndicesExist } from '@/lib/es-index-mappings';
import { createErrorResponse } from '@/lib/api-utils';

export async function POST() {
  try {
    await ensureIndicesExist();
    return NextResponse.json({ success: true, message: 'ES indices ensured' });
  } catch (error) {
    return createErrorResponse(500, 'Failed to ensure ES indices', error);
  }
}
