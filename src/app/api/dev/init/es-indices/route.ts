/**
 * POST /api/dev/init/es-indices
 * Creates or ensures all Elasticsearch index mappings exist. Idempotent.
 */
import { NextResponse } from 'next/server';
import { ensureIndicesExist } from '@/lib/es-index-mappings';

export async function POST() {
  try {
    await ensureIndicesExist();
    return NextResponse.json({ success: true, message: 'ES indices ensured' });
  } catch (error) {
    console.error('[/api/dev/init/es-indices] Failed:', error);
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}
