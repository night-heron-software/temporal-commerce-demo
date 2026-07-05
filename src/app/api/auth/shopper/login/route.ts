/**
 * POST /api/auth/shopper/login
 *
 * Email-only shopper authentication for demo.
 * If the email exists → sign in. If not → auto-create account.
 * Sets a shopperId cookie for session persistence.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createErrorResponse } from '@/lib/api-utils';
import { createLogger } from '@/lib/logger';
import { cookies } from 'next/headers';
import { v4 as uuidv4 } from 'uuid';
import { ShopperRepository, AddressRepository } from '@/temporal/identity';

const log = createLogger('api-auth-login');

const SHOPPER_COOKIE = 'shopperId';
const shopperRepo = new ShopperRepository();
const addressRepo = new AddressRepository();

export async function POST(request: NextRequest) {
  const body = await request.json();
  const email = body.email?.trim()?.toLowerCase();

  if (!email) {
    return createErrorResponse(400, 'Email is required');
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
    return createErrorResponse(500, 'Failed to create account');
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

  // Cart-User Linking: Recover active cart or link current guest cart
  try {
    const { getElasticsearchClient } = await import('@/lib/es-client');
    const { ES_INDICES } = await import('@/temporal/contracts/elasticsearch');
    const esClient = getElasticsearchClient();

    // Query ES for an active cart belonging to this email
    const esResponse = await esClient.search<{ cartId: string }>({
      index: ES_INDICES.carts,
      body: {
        query: {
          bool: {
            must: [{ term: { email: shopper.email } }, { term: { status: 'active' } }],
          },
        },
        sort: [{ updatedAt: 'desc' }],
        size: 1,
      },
    });

    const hits = esResponse.hits?.hits ?? [];

    if (hits.length > 0 && hits[0]._source) {
      // 1. Recover existing active cart
      const recoveredCartId = hits[0]._source.cartId;
      log.info({ cartId: recoveredCartId, email: shopper.email }, 'Recovered active cart');

      // Overwrite the guest cart ID with the recovered cart ID
      cookieStore.set('cartId', recoveredCartId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60,
        path: '/',
      });
    } else {
      // 2. Link current guest cart (if any) to the user
      const currentCartId = cookieStore.get('cartId')?.value;
      if (currentCartId) {
        const { executeCartUpdate } = await import('@/app/shop/cart-actions');

        log.info({ cartId: currentCartId, email: shopper.email }, 'Linking guest cart to user');
        await executeCartUpdate(currentCartId, 'cartUpdate', [
          { type: 'linkUser', email: shopper.email, userId: shopper.id },
        ]);
      }
    }
  } catch (error) {
    log.error({ err: error }, 'Failed to link cart during login');
    // Non-fatal error, continue login process
  }

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
