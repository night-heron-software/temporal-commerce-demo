/**
 * GET/POST /api/auth/shopper/address
 *
 * GET: Returns saved addresses for the current shopper.
 * POST: Saves or updates a shipping address for the current shopper.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createErrorResponse } from '@/lib/api-utils';
import { cookies } from 'next/headers';
import { randomUUID } from 'crypto';
import { AddressRepository } from '@/temporal/identity';
import { executeStandaloneActivity } from '@/lib/temporal-client';
import { IDENTITY_TASK_QUEUE, DEMO_STORE_ID } from '@/temporal/contracts/constants';
import { SAVE_SHOPPER_ADDRESS_ACTIVITY } from '@/temporal/contracts/identity';
import { buildActivityTypedSearchAttributes } from '@/temporal/contracts/activity-tagging';

const SHOPPER_COOKIE = 'shopperId';
const addressRepo = new AddressRepository();

export async function GET() {
  const cookieStore = await cookies();
  const shopperId = cookieStore.get(SHOPPER_COOKIE)?.value;

  if (!shopperId) {
    return NextResponse.json({ addresses: [] });
  }

  const addresses = await addressRepo.getByUserId(shopperId);
  return NextResponse.json({ addresses });
}

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const shopperId = cookieStore.get(SHOPPER_COOKIE)?.value;

  if (!shopperId) {
    return createErrorResponse(401, 'Not signed in');
  }

  const body = await request.json();

  // Check if there's an existing default address to update
  const existing = await addressRepo.getByUserId(shopperId);
  const defaultAddr = existing.find((a) => a.isDefault);

  const address = {
    addressId: defaultAddr?.addressId || randomUUID(),
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

  // STANDALONE activity on identity-queue (ADR-0006): worker execution + Temporal
  // retries + its own history for a single logical write; no wrapper workflow.
  await executeStandaloneActivity(SAVE_SHOPPER_ADDRESS_ACTIVITY, {
    taskQueue: IDENTITY_TASK_QUEUE,
    activityId: `shopper-address-save-${shopperId}-${address.addressId}`,
    args: [shopperId, address],
    typedSearchAttributes: buildActivityTypedSearchAttributes({
      storeId: DEMO_STORE_ID,
      domain: 'identity',
    }),
  });

  return NextResponse.json({ ok: true, address });
}
