/**
 * POST /api/auth/shopper/login
 *
 * Email-only shopper authentication for demo.
 * If the email exists → sign in. If not → auto-create account.
 * Sets a shopperId cookie for session persistence.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { v4 as uuidv4 } from 'uuid';
import { ShopperRepository, AddressRepository } from '@/temporal/identity';

const SHOPPER_COOKIE = 'shopperId';
const shopperRepo = new ShopperRepository();
const addressRepo = new AddressRepository();

export async function POST(request: NextRequest) {
  const body = await request.json();
  const email = body.email?.trim()?.toLowerCase();

  if (!email) {
    return NextResponse.json({ error: 'Email is required' }, { status: 400 });
  }

  let shopper = await shopperRepo.getShopperByEmail(email);

  if (!shopper) {
    // Auto-create shopper (email-only, no password for demo)
    const id = uuidv4();
    const name = email.split('@')[0]; // derive display name from email
    await shopperRepo.createShopper({
      id,
      email,
      passwordHash: 'demo-no-password',
      name,
    });
    shopper = await shopperRepo.getShopperByEmail(email);
  }

  if (!shopper) {
    return NextResponse.json({ error: 'Failed to create account' }, { status: 500 });
  }

  // Set session cookie
  const cookieStore = await cookies();
  cookieStore.set(SHOPPER_COOKIE, shopper.id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60, // 30 days
    path: '/',
  });

  // Load saved address
  const addresses = await addressRepo.getByUserId(shopper.id);
  const defaultAddress = addresses.find((a) => a.isDefault) || addresses[0] || null;

  return NextResponse.json({
    shopper: {
      id: shopper.id,
      email: shopper.email,
      name: shopper.name,
    },
    savedAddress: defaultAddress,
  });
}
