/**
 * GET /api/auth/shopper/me
 *
 * Returns the current shopper profile and default saved address,
 * or { shopper: null } if not signed in.
 */

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { AddressRepository } from '@/temporal/identity';
import { executeCql } from '@/lib/cassandra-client';
import { types } from 'cassandra-driver';

const SHOPPER_COOKIE = 'shopperId';
const addressRepo = new AddressRepository();

export async function GET() {
  const cookieStore = await cookies();
  const shopperId = cookieStore.get(SHOPPER_COOKIE)?.value;

  if (!shopperId) {
    return NextResponse.json({ shopper: null, savedAddress: null });
  }

  // Look up shopper by ID
  const rows = await executeCql<{
    id: types.Uuid;
    email: string;
    name: string;
  }>(
    `SELECT id, email, name FROM shoppers WHERE id = ? ALLOW FILTERING`,
    [shopperId]
  );

  if (rows.length === 0) {
    // Invalid cookie — clear it
    cookieStore.delete(SHOPPER_COOKIE);
    return NextResponse.json({ shopper: null, savedAddress: null });
  }

  const row = rows[0];
  const addresses = await addressRepo.getByUserId(shopperId);
  const defaultAddress = addresses.find((a) => a.isDefault) || addresses[0] || null;

  return NextResponse.json({
    shopper: {
      id: row.id.toString(),
      email: row.email,
      name: row.name,
    },
    savedAddress: defaultAddress,
  });
}
