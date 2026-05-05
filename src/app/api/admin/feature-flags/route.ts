/**
 * GET/PUT /api/admin/feature-flags
 * Read and update feature flags from the admin panel.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAllFlags, setFlag } from '@/lib/feature-flags';

export async function GET() {
  return NextResponse.json(getAllFlags());
}

export async function PUT(request: NextRequest) {
  const body = await request.json();
  const { name, value } = body;

  if (typeof name !== 'string' || typeof value !== 'boolean') {
    return NextResponse.json(
      { error: 'Invalid request. Expected { name: string, value: boolean }' },
      { status: 400 }
    );
  }

  setFlag(name, value);
  return NextResponse.json({ success: true, flags: getAllFlags() });
}
