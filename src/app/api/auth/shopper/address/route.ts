/**
 * GET/POST /api/auth/shopper/address
 *
 * GET: Returns saved addresses for the current shopper.
 * POST: Saves or updates a shipping address for the current shopper.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { v4 as uuidv4 } from 'uuid';
import { AddressRepository } from '@/temporal/identity';

const SHOPPER_COOKIE = 'shopperId';
const addressRepo = new AddressRepository();

export async function GET() {
  const cookieStore = await cookies();
  const shopperId = cookieStore.get(SHOPPER_COOKIE)?.value;

  if (!shopperId) {
    return NextResponse.json({ addresses: [] });
  }

  const addresses = await addressRepo.getByUserId('demo', shopperId);
  return NextResponse.json({ addresses });
}

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const shopperId = cookieStore.get(SHOPPER_COOKIE)?.value;

  if (!shopperId) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const body = await request.json();

  // Check if there's an existing default address to update
  const existing = await addressRepo.getByUserId('demo', shopperId);
  const defaultAddr = existing.find((a) => a.isDefault);

  const address = {
    addressId: defaultAddr?.addressId || uuidv4(),
    label: body.label || 'Default',
    firstName: body.firstName,
    lastName: body.lastName,
    address1: body.address1,
    address2: body.address2 || '',
    city: body.city,
    state: body.state,
    postalCode: body.postalCode,
    country: body.country || 'US',
    phone: body.phone || '',
    email: body.email,
    isDefault: true,
  };

  await addressRepo.save('demo', shopperId, address);

  return NextResponse.json({ ok: true, address });
}
