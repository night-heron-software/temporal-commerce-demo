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

  // Two partition-key reads: id -> email (immutable mapping), then email -> profile
  const idRows = await executeCql<{ email: string }>(
    `SELECT email FROM shoppers_by_id WHERE id = ?`,
    [shopperId],
  );
  const rows =
    idRows.length === 0
      ? []
      : await executeCql<{
          id: types.Uuid;
          email: string;
          name: string;
        }>(`SELECT id, email, name FROM shoppers WHERE email = ?`, [idRows[0].email]);

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
