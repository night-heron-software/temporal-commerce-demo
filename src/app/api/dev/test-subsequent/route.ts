import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { v4 as uuidv4 } from 'uuid';
import { executeCql } from '@/lib/cassandra-client';
import {
  getOrCreateCartId,
  addItemToCart,
  setShippingAddress,
  setPaymentMethod,
  submitOrder,
  getCartId
} from '@/app/shop/cart-actions';

export async function GET() {
  const steps: string[] = [];
  try {
    steps.push('Starting subsequent order test API');

    // 1. Fetch a variant
    const variants = await executeCql<{ id: any }>('SELECT id FROM catalog.variants LIMIT 1');
    if (variants.length === 0) {
      throw new Error('No variants found in database');
    }
    const variantId = variants[0].id.toString();
    steps.push(`Fetched variant ID: ${variantId}`);

    // 2. Clear old cookies to ensure clean run
    const cookieStore = await cookies();
    cookieStore.delete('cartId');
    steps.push('Cleared cartId cookie');

    // 3. First order
    steps.push('--- First Order Start ---');
    const cartId1 = await getOrCreateCartId();
    steps.push(`First order getOrCreateCartId returned: ${cartId1}`);

    const cart1 = await addItemToCart(cartId1, variantId, 1, 1599);
    steps.push(`First order addItemToCart status: ${cart1?.status}, items: ${cart1?.items?.length}`);

    const address = {
      firstName: 'Subsequent',
      lastName: 'Tester',
      address1: '123 Validation St',
      address2: '',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'US',
      phone: '555-123-4567',
      email: 'test-subsequent@example.com'
    };

    const shipState1 = await setShippingAddress(cartId1, address);
    steps.push(`First order setShippingAddress step: ${shipState1?.step}, error: ${shipState1?.error}`);

    const payState1 = await setPaymentMethod(cartId1, { type: 'mock', token: 'valid' });
    steps.push(`First order setPaymentMethod step: ${payState1?.step}, error: ${payState1?.error}`);

    const submitState1 = await submitOrder(cartId1);
    steps.push(`First order submitOrder step: ${submitState1?.step}, orderId: ${submitState1?.order?.orderId}`);

    // Check if cookie was deleted
    const cookieAfterSubmit = cookieStore.get('cartId')?.value;
    steps.push(`cartId cookie after submit: ${cookieAfterSubmit || 'DELETED'}`);

    // 4. Second order
    steps.push('--- Second Order Start ---');
    const cartId2 = await getOrCreateCartId();
    steps.push(`Second order getOrCreateCartId returned: ${cartId2}`);

    const cart2 = await addItemToCart(cartId2, variantId, 1, 1599);
    steps.push(`Second order addItemToCart status: ${cart2?.status}, items: ${cart2?.items?.length}`);

    const shipState2 = await setShippingAddress(cartId2, address);
    steps.push(`Second order setShippingAddress step: ${shipState2?.step}, error: ${shipState2?.error}`);

    return NextResponse.json({
      success: true,
      steps,
      finalState: shipState2
    });
  } catch (error: any) {
    console.error('Test API failed:', error);
    return NextResponse.json({
      success: false,
      error: error?.message || String(error),
      stack: error?.stack,
      steps
    }, { status: 500 });
  }
}
