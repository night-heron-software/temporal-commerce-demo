/**
 * GET/PUT /api/admin/feature-flags
 * Read and update feature flags from the admin panel.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAllFlags, setFlag, KNOWN_FLAG_NAMES } from '@/lib/feature-flags';

export async function GET() {
  return NextResponse.json(getAllFlags());
}

export async function PUT(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request. Body must be JSON.' }, { status: 400 });
  }
  const { name, value } = (body ?? {}) as { name?: unknown; value?: unknown };

  if (typeof name !== 'string' || typeof value !== 'boolean') {
    return NextResponse.json(
      { error: 'Invalid request. Expected { name: string, value: boolean }' },
      { status: 400 },
    );
  }
  if (!KNOWN_FLAG_NAMES.includes(name)) {
    return NextResponse.json(
      { error: `Unknown flag '${name}'. Known flags: ${KNOWN_FLAG_NAMES.join(', ')}` },
      { status: 400 },
    );
  }

  setFlag(name, value);
  return NextResponse.json({ success: true, flags: getAllFlags() });
}
