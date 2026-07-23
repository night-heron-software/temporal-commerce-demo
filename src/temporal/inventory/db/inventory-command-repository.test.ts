import { describe, it, expect } from 'vitest';
import {
  computeTotalAvailable,
  computeExpectedReserved,
  groupItemsByBlankSku,
  historyInsert,
  planRenewal,
  selectPreemptibleReservations,
  PLATFORM_CORRELATION_ID,
  UNLIMITED_STOCK,
  type HistoryEvent,
  type HistoryOperation,
  type RenewalExistingHold,
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

describe('planRenewal', () => {
  const cartId = 'cart-123';

  const hold = (over: Partial<RenewalExistingHold> = {}): RenewalExistingHold => ({
    reservationId: buildReservationId(cartId, over.variantId ?? 'v1'),
    variantId: 'v1',
    blankSku: 'TEE',
    quantity: 2,
    status: 'TEMPORARY',
    ...over,
  });

  const item = (variantId: string, blankSku = 'TEE', quantity = 2) => ({
    variantId,
    blankSku,
    quantity,
  });

  it('renews a live TEMPORARY hold with an unchanged quantity — no other buckets touched', () => {
    const plan = planRenewal([hold()], [item('v1')], cartId);
    expect(plan.renew).toEqual([
      { reservationId: 'cart-123-v1', variantId: 'v1', blankSku: 'TEE', quantity: 2 },
    ]);
    expect(plan.adjust).toEqual([]);
    expect(plan.reserveFresh).toEqual([]);
    expect(plan.releaseExtras).toEqual([]);
  });

  it('adjusts a live TEMPORARY hold whose quantity changed, with a signed delta', () => {
    const up = planRenewal([hold({ quantity: 2 })], [item('v1', 'TEE', 5)], cartId);
    expect(up.adjust).toEqual([
      {
        reservationId: 'cart-123-v1',
        variantId: 'v1',
        blankSku: 'TEE',
        quantity: 5,
        quantityDelta: 3,
      },
    ]);
    expect(up.renew).toEqual([]);

    const down = planRenewal([hold({ quantity: 4 })], [item('v1', 'TEE', 1)], cartId);
    expect(down.adjust[0].quantityDelta).toBe(-3);
    expect(down.adjust[0].quantity).toBe(1);
  });

  it('reserves fresh when no hold exists, with priorStatus null and the derived reservation ID', () => {
    const plan = planRenewal([], [item('v1')], cartId);
    expect(plan.reserveFresh).toEqual([
      {
        reservationId: buildReservationId(cartId, 'v1'),
        variantId: 'v1',
        blankSku: 'TEE',
        quantity: 2,
        priorStatus: null,
      },
    ]);
    expect(plan.renew).toEqual([]);
    expect(plan.adjust).toEqual([]);
    expect(plan.releaseExtras).toEqual([]);
  });

  it('reserves fresh when the hold is in a terminal status, carrying priorStatus for the warning', () => {
    for (const status of ['RELEASED', 'CANCELLED', 'FULFILLED']) {
      const plan = planRenewal([hold({ status })], [item('v1')], cartId);
      expect(plan.reserveFresh).toHaveLength(1);
      expect(plan.reserveFresh[0].priorStatus).toBe(status);
      expect(plan.renew).toEqual([]);
      expect(plan.adjust).toEqual([]);
    }
  });

  it('releases TEMPORARY holds for variants no longer in the cart', () => {
    const plan = planRenewal([hold(), hold({ variantId: 'v-gone' })], [item('v1')], cartId);
    expect(plan.releaseExtras).toEqual(['cart-123-v-gone']);
    expect(plan.renew).toHaveLength(1);
  });

  it('does NOT release non-TEMPORARY extras — terminal rows hold no stock', () => {
    const plan = planRenewal([hold({ variantId: 'v-gone', status: 'RELEASED' })], [], cartId);
    expect(plan.releaseExtras).toEqual([]);
  });

  it('uses the EXISTING hold blankSku for renew/adjust (counter attribution), the item blankSku for fresh', () => {
    const plan = planRenewal(
      [hold({ blankSku: 'TEE-OLD' }), hold({ variantId: 'v2', blankSku: 'MUG-OLD', quantity: 1 })],
      [item('v1', 'TEE-NEW', 2), item('v2', 'MUG-NEW', 3), item('v3', 'HAT', 1)],
      cartId,
    );
    expect(plan.renew[0].blankSku).toBe('TEE-OLD');
    expect(plan.adjust[0].blankSku).toBe('MUG-OLD');
    expect(plan.reserveFresh[0].blankSku).toBe('HAT');
  });

  it('classifies a mixed cart into all four buckets at once', () => {
    const existing = [
      hold({ variantId: 'v-same', quantity: 2 }),
      hold({ variantId: 'v-changed', quantity: 1 }),
      hold({ variantId: 'v-expired', status: 'RELEASED' }),
      hold({ variantId: 'v-removed', quantity: 4 }),
    ];
    const items = [
      item('v-same', 'TEE', 2),
      item('v-changed', 'TEE', 3),
      item('v-expired', 'TEE', 1),
      item('v-brand-new', 'MUG', 2),
    ];
    const plan = planRenewal(existing, items, cartId);

    expect(plan.renew.map((r) => r.variantId)).toEqual(['v-same']);
    expect(plan.adjust).toEqual([
      {
        reservationId: 'cart-123-v-changed',
        variantId: 'v-changed',
        blankSku: 'TEE',
        quantity: 3,
        quantityDelta: 2,
      },
    ]);
    expect(plan.reserveFresh.map((r) => [r.variantId, r.priorStatus])).toEqual([
      ['v-expired', 'RELEASED'],
      ['v-brand-new', null],
    ]);
    expect(plan.releaseExtras).toEqual(['cart-123-v-removed']);
  });

  it('is all-fresh for a cart with no history and all-extras for an emptied cart', () => {
    const allFresh = planRenewal([], [item('v1'), item('v2', 'MUG')], cartId);
    expect(allFresh.reserveFresh).toHaveLength(2);
    expect(allFresh.renew).toEqual([]);
    expect(allFresh.releaseExtras).toEqual([]);

    const allExtras = planRenewal([hold(), hold({ variantId: 'v2' })], [], cartId);
    expect(allExtras.releaseExtras).toEqual(['cart-123-v1', 'cart-123-v2']);
    expect(allExtras.reserveFresh).toEqual([]);
  });

  it('fresh reservation IDs match the shared buildReservationId derivation (regression: PR #17)', () => {
    const plan = planRenewal([], [item('v1'), item('v2', 'MUG')], cartId);
    for (const entry of plan.reserveFresh) {
      expect(entry.reservationId).toBe(buildReservationId(cartId, entry.variantId));
    }
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

describe('historyInsert', () => {
  const AT = new Date('2026-07-21T12:00:00Z');

  // Param positions in the built INSERT (columns in declaration order).
  const P = {
    correlationId: 0,
    at: 1,
    seq: 2,
    operation: 3,
    reservationId: 4,
    blankSku: 5,
    variantId: 6,
    fulfillerId: 7,
    quantity: 8,
    priorStatus: 9,
    newStatus: 10,
    referenceId: 11,
    actor: 12,
    details: 13,
  } as const;

  const event = (over: Partial<HistoryEvent> = {}): HistoryEvent => ({
    correlationId: 'cart-1',
    operation: 'RESERVE',
    reservationId: 'cart-1-v1',
    blankSku: 'TEE',
    variantId: 'v1',
    fulfillerId: 'f1',
    quantity: 2,
    priorStatus: null,
    newStatus: 'TEMPORARY',
    referenceId: 'checkout-cart-1',
    actor: 'demo.checkout.cart-1',
    at: AT,
    ...over,
  });

  it('targets inventory_history with all 14 columns bound in declaration order', () => {
    const stmt = historyInsert(event());
    expect(stmt.query).toContain('INSERT INTO inventory_history');
    expect(stmt.params).toHaveLength(14);
    expect(stmt.params[P.correlationId]).toBe('cart-1');
    expect(stmt.params[P.at]).toBe(AT);
    expect(stmt.params[P.operation]).toBe('RESERVE');
    expect(stmt.params[P.reservationId]).toBe('cart-1-v1');
    expect(stmt.params[P.blankSku]).toBe('TEE');
    expect(stmt.params[P.variantId]).toBe('v1');
    expect(stmt.params[P.fulfillerId]).toBe('f1');
    expect(stmt.params[P.quantity]).toBe(2);
    expect(stmt.params[P.priorStatus]).toBeNull();
    expect(stmt.params[P.newStatus]).toBe('TEMPORARY');
    expect(stmt.params[P.referenceId]).toBe('checkout-cart-1');
    expect(stmt.params[P.actor]).toBe('demo.checkout.cart-1');
  });

  it('builds one well-formed statement per operation type', () => {
    const operations: HistoryOperation[] = [
      'RESERVE',
      'RESERVE_FAILED',
      'RENEW',
      'CONFIRM',
      'RELEASE',
      'CANCEL',
      'FULFILL',
      'TRANSFER',
      'DRIFT_CORRECTION',
    ];
    for (const operation of operations) {
      const stmt = historyInsert(event({ operation }));
      expect(stmt.query).toContain('INSERT INTO inventory_history');
      expect(stmt.params[P.operation]).toBe(operation);
      expect(stmt.params).toHaveLength(14);
    }
  });

  it('null-fills every omitted optional column (a DRIFT_CORRECTION-shaped minimal event)', () => {
    const stmt = historyInsert({
      correlationId: PLATFORM_CORRELATION_ID,
      operation: 'DRIFT_CORRECTION',
      actor: 'reconciler',
    });
    expect(stmt.params[P.correlationId]).toBe(PLATFORM_CORRELATION_ID);
    for (const idx of [
      P.reservationId,
      P.blankSku,
      P.variantId,
      P.fulfillerId,
      P.quantity,
      P.priorStatus,
      P.newStatus,
      P.referenceId,
      P.details,
    ]) {
      expect(stmt.params[idx]).toBeNull();
    }
    expect(stmt.params[P.at]).toBeInstanceOf(Date); // defaults to now
  });

  it('round-trips details through the JSON TEXT column', () => {
    const details = {
      counterBefore: 3,
      counterAfter: 5,
      error: 'Insufficient stock. Requested: 2, Available: 0',
      contention: false,
      forCart: 'cart-2',
    };
    const stmt = historyInsert(event({ details }));
    expect(typeof stmt.params[P.details]).toBe('string');
    expect(JSON.parse(stmt.params[P.details] as string)).toEqual(details);
  });

  it('assigns strictly increasing seq across consecutive builds (same-timestamp tiebreak)', () => {
    const seqs = [1, 2, 3].map(() => historyInsert(event()).params[P.seq] as number);
    expect(seqs[1]).toBe(seqs[0] + 1);
    expect(seqs[2]).toBe(seqs[1] + 1);
  });

  it("falls back to the 'api' actor outside an activity context", () => {
    // No Temporal activity context exists in this test process, so resolveActor()'s
    // Context.current() path throws and the seed-route fallback applies.
    const stmt = historyInsert(event({ actor: undefined }));
    expect(stmt.params[P.actor]).toBe('api');
  });
});
