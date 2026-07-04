import { describe, it, expect } from 'vitest';
import {
  computeTotalAvailable,
  selectPreemptibleReservations,
  UNLIMITED_STOCK,
  MIN_HOLD_MS,
} from './inventory-command-repository';

describe('computeTotalAvailable', () => {
  it('sums available stock (total − reserved) across suppliers', () => {
    expect(
      computeTotalAvailable([
        { total_stock: 10, reserved_stock: 3 },
        { total_stock: 5, reserved_stock: 5 },
      ]),
    ).toBe(7);
  });

  it('returns effectively-infinite when any supplier is UNLIMITED_STOCK', () => {
    expect(
      computeTotalAvailable([
        { total_stock: UNLIMITED_STOCK, reserved_stock: 2 },
        { total_stock: 4, reserved_stock: 0 },
      ]),
    ).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('is zero for no suppliers', () => {
    expect(computeTotalAvailable([])).toBe(0);
  });
});

describe('selectPreemptibleReservations', () => {
  const NOW = Date.parse('2026-07-01T12:00:00Z');
  const heldFor = (ms: number) => new Date(NOW - ms);
  const expiring = new Date(NOW + 60_000);

  const reservation = (over: Partial<{ cart_id: string; quantity: number; created_at: Date; expires_at: Date | null }> = {}) => ({
    cart_id: 'other-cart',
    quantity: 2,
    created_at: heldFor(MIN_HOLD_MS + 60_000),
    expires_at: expiring,
    ...over,
  });

  const opts = (over: Partial<{ totalAvailable: number; quantityNeeded: number; requestingCartId: string; nowMs: number }> = {}) => ({
    totalAvailable: 0,
    quantityNeeded: 2,
    requestingCartId: 'my-cart',
    nowMs: NOW,
    ...over,
  });

  it('preempts a stale reservation to make room', () => {
    const r = reservation();
    expect(selectPreemptibleReservations([r], opts())).toEqual([r]);
  });

  it('never preempts reservations still inside MIN_HOLD_MS', () => {
    const fresh = reservation({ created_at: heldFor(MIN_HOLD_MS - 1_000) });
    expect(selectPreemptibleReservations([fresh], opts())).toEqual([]);
  });

  it('never preempts the requesting cart\'s own reservation', () => {
    const mine = reservation({ cart_id: 'my-cart' });
    expect(selectPreemptibleReservations([mine], opts())).toEqual([]);
  });

  it('ignores reservations without an expiry (non-TTL holds)', () => {
    const permanent = reservation({ expires_at: null });
    expect(selectPreemptibleReservations([permanent], opts())).toEqual([]);
  });

  it('preempts oldest-first and stops once enough stock is freed', () => {
    const oldest = reservation({ quantity: 2, created_at: heldFor(MIN_HOLD_MS + 3_000) });
    const middle = reservation({ quantity: 2, created_at: heldFor(MIN_HOLD_MS + 2_000) });
    const newest = reservation({ quantity: 2, created_at: heldFor(MIN_HOLD_MS + 1_000) });
    const picked = selectPreemptibleReservations([newest, oldest, middle], opts({ quantityNeeded: 3 }));
    expect(picked).toEqual([oldest, middle]);
  });

  it('selects nothing when availability already suffices', () => {
    expect(selectPreemptibleReservations([reservation()], opts({ totalAvailable: 5 }))).toEqual([]);
  });
});
