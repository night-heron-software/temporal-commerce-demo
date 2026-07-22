import { describe, it, expect } from 'vitest';
import {
  computeTotalAvailable,
  computeExpectedReserved,
  groupItemsByBlankSku,
  selectPreemptibleReservations,
  UNLIMITED_STOCK,
} from './inventory-command-repository';
import { buildReservationId } from '../../contracts/inventory';

describe('computeTotalAvailable', () => {
  it('sums available stock (total − reserved) across fulfillers', () => {
    expect(
      computeTotalAvailable([
        { total_stock: 10, reserved_stock: 3 },
        { total_stock: 5, reserved_stock: 5 },
      ]),
    ).toBe(7);
  });

  it('returns effectively-infinite when any fulfiller is UNLIMITED_STOCK', () => {
    expect(
      computeTotalAvailable([
        { total_stock: UNLIMITED_STOCK, reserved_stock: 2 },
        { total_stock: 4, reserved_stock: 0 },
      ]),
    ).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('is zero for no fulfillers', () => {
    expect(computeTotalAvailable([])).toBe(0);
  });
});

describe('selectPreemptibleReservations', () => {
  const NOW = Date.parse('2026-07-01T12:00:00Z');
  const expiredAt = (msAgo: number) => new Date(NOW - msAgo);
  const liveUntil = (msAhead: number) => new Date(NOW + msAhead);

  const reservation = (
    over: Partial<{
      quantity: number;
      created_at: Date;
      expires_at: Date | null;
    }> = {},
  ) => ({
    quantity: 2,
    created_at: new Date(NOW - 60 * 60 * 1000),
    expires_at: expiredAt(60_000),
    ...over,
  });

  const opts = (
    over: Partial<{
      totalAvailable: number;
      quantityNeeded: number;
      nowMs: number;
    }> = {},
  ) => ({
    totalAvailable: 0,
    quantityNeeded: 2,
    nowMs: NOW,
    ...over,
  });

  it('preempts an expired reservation to make room', () => {
    const r = reservation();
    expect(selectPreemptibleReservations([r], opts())).toEqual([r]);
  });

  it('never preempts a live (unexpired) hold, regardless of age', () => {
    // Old by wall clock but renewed: created long ago, expires in the future.
    const renewed = reservation({
      created_at: new Date(NOW - 2 * 60 * 60 * 1000),
      expires_at: liveUntil(60_000),
    });
    expect(selectPreemptibleReservations([renewed], opts())).toEqual([]);
  });

  it('ignores reservations without an expiry (non-TTL holds)', () => {
    const permanent = reservation({ expires_at: null });
    expect(selectPreemptibleReservations([permanent], opts())).toEqual([]);
  });

  it('preempts oldest-first and stops once enough stock is freed', () => {
    const oldest = reservation({ created_at: new Date(NOW - 3_000_000) });
    const middle = reservation({ created_at: new Date(NOW - 2_000_000) });
    const newest = reservation({ created_at: new Date(NOW - 1_000_000) });
    const picked = selectPreemptibleReservations(
      [newest, oldest, middle],
      opts({ quantityNeeded: 3 }),
    );
    expect(picked).toEqual([oldest, middle]);
  });

  it('selects nothing when availability already suffices', () => {
    expect(selectPreemptibleReservations([reservation()], opts({ totalAvailable: 5 }))).toEqual([]);
  });
});

describe('groupItemsByBlankSku', () => {
  const cartId = 'cart-123';

  it('groups variants sharing a blank_sku into one group (one CAS per partition)', () => {
    const groups = groupItemsByBlankSku(cartId, [
      { variantId: 'v1', blankSku: 'TEE', quantity: 2 },
      { variantId: 'v2', blankSku: 'TEE', quantity: 1 },
      { variantId: 'v3', blankSku: 'MUG', quantity: 4 },
    ]);

    expect([...groups.keys()].sort()).toEqual(['MUG', 'TEE']);
    expect(groups.get('TEE')).toHaveLength(2);
    expect(groups.get('MUG')).toHaveLength(1);
  });

  it('keeps per-variant quantities — consolidation is per-CAS, not per-row', () => {
    const groups = groupItemsByBlankSku(cartId, [
      { variantId: 'v1', blankSku: 'TEE', quantity: 2 },
      { variantId: 'v2', blankSku: 'TEE', quantity: 5 },
    ]);
    expect(groups.get('TEE')!.map((e) => e.quantity)).toEqual([2, 5]);
  });

  it('reservation IDs match the derivation used by fulfillment and cart (regression: PR #17)', () => {
    // PR #17 briefly keyed checkout reservations `${cartId}-${blankSku}` while fulfillment
    // still derived `${cartId}-${variantId}` — silently no-oping transfer/fulfill/release.
    // This pins every created row to the shared buildReservationId scheme.
    const groups = groupItemsByBlankSku(cartId, [
      { variantId: 'v1', blankSku: 'TEE', quantity: 2 },
      { variantId: 'v2', blankSku: 'TEE', quantity: 1 },
    ]);

    for (const entry of groups.get('TEE')!) {
      expect(entry.reservationId).toBe(buildReservationId(cartId, entry.variantId));
    }
    expect(groups.get('TEE')!.map((e) => e.reservationId)).toEqual(['cart-123-v1', 'cart-123-v2']);
  });
});

describe('computeExpectedReserved', () => {
  it('sums active quantities per (blank_sku, fulfiller_id)', () => {
    const expected = computeExpectedReserved([
      { blank_sku: 'TEE', fulfiller_id: 'f1', quantity: 2 },
      { blank_sku: 'TEE', fulfiller_id: 'f1', quantity: 3 },
      { blank_sku: 'TEE', fulfiller_id: 'f2', quantity: 1 },
      { blank_sku: 'MUG', fulfiller_id: 'f1', quantity: 4 },
    ]);

    expect(expected.get('TEE|f1')).toBe(5);
    expect(expected.get('TEE|f2')).toBe(1);
    expect(expected.get('MUG|f1')).toBe(4);
  });

  it('skips rows without fulfiller attribution (cannot map to a counter)', () => {
    const expected = computeExpectedReserved([
      { blank_sku: 'TEE', fulfiller_id: null, quantity: 2 },
      { blank_sku: 'TEE', fulfiller_id: 'f1', quantity: 3 },
    ]);
    expect(expected.get('TEE|f1')).toBe(3);
    expect(expected.size).toBe(1);
  });

  it('is empty for no active reservations — reconciler then drives counters to zero', () => {
    expect(computeExpectedReserved([]).size).toBe(0);
  });
});
