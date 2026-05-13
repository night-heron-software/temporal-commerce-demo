/**
 * POST /api/auth/shopper/logout
 *
 * Clears the shopper session cookie.
 */

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

const SHOPPER_COOKIE = 'shopperId';

export async function POST() {
  const cookieStore = await cookies();
  cookieStore.delete(SHOPPER_COOKIE);
  return NextResponse.json({ ok: true });
}
