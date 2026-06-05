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

  // Cart-User Linking: Recover active cart or link current guest cart
  try {
    const { getElasticsearchClient } = await import('@/lib/es-client');
    const { ES_INDICES } = await import('@/temporal/contracts');
    const esClient = getElasticsearchClient();

    // Query ES for an active cart belonging to this email
    const esResponse = await esClient.search({
      index: ES_INDICES.carts,
      body: {
        query: {
          bool: {
            must: [
              { term: { 'email': shopper.email } },
              { term: { 'status': 'active' } }
            ]
          }
        },
        sort: [{ updatedAt: 'desc' }],
        size: 1
      }
    });

    const hits = (esResponse as any).hits?.hits || [];
    
    if (hits.length > 0) {
      // 1. Recover existing active cart
      const recoveredCartId = hits[0]._source.cartId;
      console.log(`Recovered active cart ${recoveredCartId} for user ${shopper.email}`);
      
      // Overwrite the guest cart ID with the recovered cart ID
      cookieStore.set('cartId', recoveredCartId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60,
        path: '/'
      });
    } else {
      // 2. Link current guest cart (if any) to the user
      const currentCartId = cookieStore.get('cartId')?.value;
      if (currentCartId) {
        const { executeCartUpdate } = await import('@/app/shop/cart-actions');
        
        console.log(`Linking guest cart ${currentCartId} to user ${shopper.email}`);
        await executeCartUpdate(
          currentCartId,
          'cartUpdate',
          [{ type: 'linkUser', email: shopper.email, userId: shopper.id }]
        );
      }
    }
  } catch (error) {
    console.error('Failed to link cart during login:', error);
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
