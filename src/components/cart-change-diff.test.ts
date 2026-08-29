import { describe, it, expect } from 'vitest';
import type { Cart } from '@/temporal/contracts';
import {
  approvedCartSnapshotKey,
  buildApprovedCartSnapshot,
  computeCartDiff,
  type ApprovedCartSnapshot,
} from './cart-change-diff';

const usd = (amount: number): number => amount;

function item(overrides: Partial<Cart.CartItem> & Pick<Cart.CartItem, 'lineItemId'>) {
  return {
    variantId: `variant-${overrides.lineItemId}`,
    sku: `sku-${overrides.lineItemId}`,
    quantity: 1,
    price: usd(2500),
    productTitle: 'Champion Hoodie',
    variantTitle: 'S / White',
    ...overrides,
  } as Cart.CartItem;
}

/** A cart+checkout pair priced so the headline total is easy to assert. */
function cartWith(items: Cart.CartItem[], subtotalCents: number) {
  return {
    cart: {
      items,
      subtotalPrice: usd(subtotalCents),
      totalDiscounts: usd(500),
    },
    checkout: { shippingCost: usd(1000), tax: usd(300) },
  };
}

function snap(items: Cart.CartItem[], subtotalCents: number): ApprovedCartSnapshot {
  const { cart, checkout } = cartWith(items, subtotalCents);
  return buildApprovedCartSnapshot(cart, checkout);
}

describe('buildApprovedCartSnapshot', () => {
  it('captures display identity, quantity, and line total per line', () => {
    const snapshot = snap([item({ lineItemId: 'L1', quantity: 2, price: usd(2500) })], 5000);
    expect(snapshot.lines).toEqual([
      {
        lineItemId: 'L1',
        variantId: 'variant-L1',
        productTitle: 'Champion Hoodie',
        variantTitle: 'S / White',
        quantity: 2,
        lineTotal: 5000,
      },
    ]);
  });

  it('totals through computeCheckoutTotal (subtotal − discounts + live shipping + tax), never cart.totalPrice', () => {
    // 5000 − 500 + 1000 + 300
    expect(snap([item({ lineItemId: 'L1' })], 5000).total).toEqual(usd(5800));
  });

  it('omits blank display fields rather than storing empty strings', () => {
    const snapshot = snap(
      [item({ lineItemId: 'L1', productTitle: '', variantTitle: undefined })],
      2500,
    );
    expect(snapshot.lines[0]).not.toHaveProperty('productTitle');
    expect(snapshot.lines[0]).not.toHaveProperty('variantTitle');
  });
});

describe('computeCartDiff', () => {
  it('returns null when there is no snapshot (first fire degrades to the generic copy)', () => {
    expect(computeCartDiff(null, snap([item({ lineItemId: 'L1' })], 2500))).toBeNull();
    expect(computeCartDiff(undefined, snap([item({ lineItemId: 'L1' })], 2500))).toBeNull();
  });

  it('names an added line with its quantity', () => {
    const before = snap([item({ lineItemId: 'L1' })], 2500);
    const after = snap(
      [
        item({ lineItemId: 'L1' }),
        item({
          lineItemId: 'L2',
          productTitle: 'Bald Eagle Portrait',
          variantTitle: 'M / Royal Blue',
          quantity: 2,
        }),
      ],
      7500,
    );
    expect(computeCartDiff(before, after)!.changes).toEqual([
      'Bald Eagle Portrait — M / Royal Blue: added (× 2)',
    ]);
  });

  it('names a removed line', () => {
    const before = snap(
      [item({ lineItemId: 'L1' }), item({ lineItemId: 'L2', productTitle: 'Trail Mug' })],
      5000,
    );
    const after = snap([item({ lineItemId: 'L1' })], 2500);
    expect(computeCartDiff(before, after)!.changes).toEqual(['Trail Mug — S / White: removed']);
  });

  it('names a quantity change as "<title> — <variant>: quantity a → b"', () => {
    const before = snap([item({ lineItemId: 'L1', quantity: 1 })], 2500);
    const after = snap([item({ lineItemId: 'L1', quantity: 2 })], 5000);
    expect(computeCartDiff(before, after)!.changes).toEqual([
      'Champion Hoodie — S / White: quantity 1 → 2',
    ]);
  });

  it('uses the labelled-id fallback for lines that predate the display snapshot', () => {
    const before = snap([], 0);
    const after = snap(
      [item({ lineItemId: 'L1', productTitle: undefined, variantTitle: undefined })],
      2500,
    );
    expect(computeCartDiff(before, after)!.changes).toEqual(['Variant variant-L1: added (× 1)']);
  });

  it('reports old → new totals and flags whether they moved', () => {
    const before = snap([item({ lineItemId: 'L1', quantity: 1 })], 2500);
    const after = snap([item({ lineItemId: 'L1', quantity: 2 })], 5000);
    const diff = computeCartDiff(before, after)!;
    expect(diff.previousTotal).toEqual(usd(3300)); // 2500 − 500 + 1000 + 300
    expect(diff.currentTotal).toEqual(usd(5800)); // 5000 − 500 + 1000 + 300
    expect(diff.totalChanged).toBe(true);
  });

  it('reports an unchanged cart as no changes with totals intact', () => {
    const before = snap([item({ lineItemId: 'L1' })], 2500);
    const after = snap([item({ lineItemId: 'L1' })], 2500);
    const diff = computeCartDiff(before, after)!;
    expect(diff.changes).toEqual([]);
    expect(diff.totalChanged).toBe(false);
    expect(diff.currentTotal).toEqual(diff.previousTotal);
  });

  it('collects added, changed, and removed lines together, removals last', () => {
    const before = snap(
      [
        item({ lineItemId: 'L1', quantity: 1 }),
        item({ lineItemId: 'L2', productTitle: 'Trail Mug', variantTitle: undefined }),
      ],
      5000,
    );
    const after = snap(
      [
        item({ lineItemId: 'L1', quantity: 3 }),
        item({ lineItemId: 'L3', productTitle: 'Sticker Pack', variantTitle: undefined }),
      ],
      10000,
    );
    expect(computeCartDiff(before, after)!.changes).toEqual([
      'Champion Hoodie — S / White: quantity 1 → 3',
      'Sticker Pack: added (× 1)',
      'Trail Mug: removed',
    ]);
  });
});

describe('approvedCartSnapshotKey', () => {
  it('is scoped per cart', () => {
    expect(approvedCartSnapshotKey('cart-a')).not.toBe(approvedCartSnapshotKey('cart-b'));
  });
});
