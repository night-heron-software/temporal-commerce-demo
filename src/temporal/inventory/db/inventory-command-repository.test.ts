import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock the Cassandra/signal edges so the repository operations (confirm/resurrect/
// fulfill/transfer) can be exercised against controlled rows. The pure-function suites
// below never touch these mocks.
const db = vi.hoisted(() => ({
  executeCql: vi.fn(),
  executeBatch: vi.fn(),
  clientExecute: vi.fn(),
  signalInventoryChanged: vi.fn(),
}));

vi.mock('../../../lib', () => ({
  executeCql: db.executeCql,
  executeBatch: db.executeBatch,
  getCassandraClient: vi.fn(async () => ({ execute: db.clientExecute })),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../lib/correlation-context', () => ({
  currentCorrelationId: vi.fn(() => undefined),
}));

vi.mock('../inventory-signal', () => ({
  signalInventoryChanged: db.signalInventoryChanged,
}));

import { currentCorrelationId } from '../../../lib/correlation-context';
import {
  computeTotalAvailable,
  computeExpectedReserved,
  groupItemsByBlankSku,
  historyInsert,
  planRenewal,
  selectPreemptibleReservations,
  InventoryCommandRepository,
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

// ============================================================
// Repository operations against mocked Cassandra (issue #34)
// ============================================================

/** A full inventory_reservations_w row as the mocked SELECT returns it. */
const reservationRow = (over: Partial<Record<string, unknown>> = {}) => ({
  reservation_id: 'cart-1-v1',
  blank_sku: 'TEE',
  cart_id: 'cart-1',
  correlation_id: null, // legacy default — rows predating the column; tests override
  variant_id: 'v1',
  fulfiller_id: 'f1',
  quantity: 2,
  reference_id: 'checkout-cart-1',
  status: 'TEMPORARY',
  expires_at: new Date('2026-07-01T12:00:00Z'),
  created_at: new Date('2026-07-01T11:00:00Z'),
  updated_at: new Date('2026-07-01T11:00:00Z'),
  ...over,
});

/** Route the two SELECT shapes the operations issue; journal INSERTs fall through to []. */
function primeReads(opts: {
  reservation: ReturnType<typeof reservationRow> | null;
  stock?: Record<string, unknown> | null;
}) {
  db.executeCql.mockImplementation(async (query: string) => {
    if (query.includes('FROM inventory_reservations_w')) {
      return opts.reservation ? [opts.reservation] : [];
    }
    if (query.includes('FROM inventory_stock_w')) {
      return opts.stock ? [opts.stock] : [];
    }
    return [];
  });
}

const batchStatements = (call = 0) =>
  db.executeBatch.mock.calls[call][0] as Array<{ query: string; params: unknown[] }>;

/** History-insert param positions (columns in declaration order) — see historyInsert. */
const H = {
  correlationId: 0,
  operation: 3,
  priorStatus: 9,
  newStatus: 10,
  actor: 12,
  details: 13,
} as const;

const journalCalls = () =>
  db.executeCql.mock.calls.filter(([query]) =>
    (query as string).includes('INSERT INTO inventory_history'),
  );

beforeEach(() => {
  db.executeCql.mockReset();
  db.executeBatch.mockReset().mockResolvedValue(undefined);
  db.clientExecute.mockReset().mockResolvedValue({ rows: [{ '[applied]': true }] });
  db.signalInventoryChanged.mockReset().mockResolvedValue(undefined);
  vi.mocked(currentCorrelationId).mockReset(); // back to no ambient correlation scope
});

describe('confirm() outcome mapping', () => {
  it("returns 'missing' when no row exists (nothing to confirm)", async () => {
    primeReads({ reservation: null });
    await expect(InventoryCommandRepository.confirm('cart-1-v1')).resolves.toBe('missing');
    expect(db.executeBatch).not.toHaveBeenCalled();
  });

  it("returns 'already-confirmed' for a CONFIRMED row without re-running the batch", async () => {
    primeReads({ reservation: reservationRow({ status: 'CONFIRMED', expires_at: null }) });
    await expect(InventoryCommandRepository.confirm('cart-1-v1')).resolves.toBe(
      'already-confirmed',
    );
    expect(db.executeBatch).not.toHaveBeenCalled();
  });

  it("returns 'lost' for terminal rows — never resurrects via confirm", async () => {
    for (const status of ['RELEASED', 'CANCELLED', 'FULFILLED']) {
      primeReads({ reservation: reservationRow({ status }) });
      await expect(InventoryCommandRepository.confirm('cart-1-v1')).resolves.toBe('lost');
    }
    expect(db.executeBatch).not.toHaveBeenCalled();
  });

  it("returns 'confirmed' after the TEMPORARY → CONFIRMED batch", async () => {
    primeReads({ reservation: reservationRow() });
    await expect(InventoryCommandRepository.confirm('cart-1-v1')).resolves.toBe('confirmed');

    const statements = batchStatements();
    expect(statements.some((s) => s.query.includes("SET status = 'CONFIRMED'"))).toBe(true);
    const history = statements.find((s) => s.query.includes('INSERT INTO inventory_history'))!;
    expect(history.params[H.operation]).toBe('CONFIRM');
    expect(db.signalInventoryChanged).toHaveBeenCalledWith(['TEE']);
  });
});

describe('resurrect()', () => {
  it("passes live holds through as 'active' without touching stock", async () => {
    for (const status of ['TEMPORARY', 'CONFIRMED']) {
      primeReads({ reservation: reservationRow({ status }) });
      await expect(InventoryCommandRepository.resurrect('cart-1-v1')).resolves.toBe('active');
    }
    expect(db.clientExecute).not.toHaveBeenCalled();
    expect(db.executeBatch).not.toHaveBeenCalled();
  });

  it("is 'unavailable' for a missing row", async () => {
    primeReads({ reservation: null });
    await expect(InventoryCommandRepository.resurrect('cart-1-v1')).resolves.toBe('unavailable');
    expect(db.clientExecute).not.toHaveBeenCalled();
  });

  it("never resurrects CANCELLED/FULFILLED — real end states stay 'unavailable'", async () => {
    for (const status of ['CANCELLED', 'FULFILLED']) {
      primeReads({ reservation: reservationRow({ status }) });
      await expect(InventoryCommandRepository.resurrect('cart-1-v1')).resolves.toBe('unavailable');
    }
    expect(db.clientExecute).not.toHaveBeenCalled();
    expect(db.executeBatch).not.toHaveBeenCalled();
  });

  it("RELEASED with insufficient stock → 'unavailable' and a RESERVE_FAILED journal entry", async () => {
    // available = 4 − 3 = 1 < quantity 2: the freed units were resold while the hold was dead.
    primeReads({
      reservation: reservationRow({ status: 'RELEASED', expires_at: null }),
      stock: { total_stock: 4, reserved_stock: 3 },
    });

    await expect(InventoryCommandRepository.resurrect('cart-1-v1')).resolves.toBe('unavailable');
    expect(db.clientExecute).not.toHaveBeenCalled(); // no LWT attempted
    expect(db.executeBatch).not.toHaveBeenCalled(); // no row restoration

    const [, params] = journalCalls()[0];
    expect((params as unknown[])[H.operation]).toBe('RESERVE_FAILED');
    expect(JSON.parse((params as unknown[])[H.details] as string)).toEqual({
      reason: 'post-expiry-resurrect',
      available: 1,
      requested: 2,
    });
  });

  it('RELEASED with stock → re-acquires the counter and restores the hold as TEMPORARY', async () => {
    primeReads({
      reservation: reservationRow({ status: 'RELEASED', expires_at: null }),
      stock: { total_stock: 10, reserved_stock: 3 },
    });

    const before = Date.now();
    await expect(InventoryCommandRepository.resurrect('cart-1-v1')).resolves.toBe('resurrected');

    // Counter CAS on the ORIGINAL fulfiller row: reserved 3 → 5, conditioned on 3.
    expect(db.clientExecute).toHaveBeenCalledTimes(1);
    expect(db.clientExecute.mock.calls[0][1]).toEqual([5, 'TEE', 'f1', 3]);

    const statements = batchStatements();
    // Main row back to TEMPORARY with a fresh 15-minute checkout TTL.
    const main = statements.find((s) => s.query.includes("SET status = 'TEMPORARY'"))!;
    const expiresAt = main.params[0] as Date;
    expect(expiresAt.getTime() - before).toBeGreaterThanOrEqual(15 * 60 * 1000 - 1000);
    expect(expiresAt.getTime() - before).toBeLessThanOrEqual(15 * 60 * 1000 + 5000);
    // The by_cart lookup row and active-registry mirror release() removed come back.
    expect(
      statements.some((s) => s.query.includes('INSERT INTO inventory_reservations_by_cart_w')),
    ).toBe(true);
    expect(
      statements.some((s) => s.query.includes('INSERT INTO inventory_reservations_by_status_w')),
    ).toBe(true);
    // Journaled as a RESERVE with the resurrect provenance.
    const history = statements.find((s) => s.query.includes('INSERT INTO inventory_history'))!;
    expect(history.params[H.operation]).toBe('RESERVE');
    expect(history.params[H.priorStatus]).toBe('RELEASED');
    expect(history.params[H.newStatus]).toBe('TEMPORARY');
    expect(JSON.parse(history.params[H.details] as string)).toEqual({
      reason: 'post-expiry-resurrect',
    });
    expect(db.signalInventoryChanged).toHaveBeenCalledWith(['TEE']);
  });
});

describe('fulfill() RELEASED backstop', () => {
  it('decrements total_stock only, flips to FULFILLED, and journals {unreserved: true}', async () => {
    primeReads({
      reservation: reservationRow({ status: 'RELEASED', expires_at: null }),
      stock: { total_stock: 10, reserved_stock: 3 },
    });

    await InventoryCommandRepository.fulfill('cart-1-v1');

    // Status flip + history only — release() already cleaned by_cart and the registry.
    const statements = batchStatements();
    expect(statements).toHaveLength(2);
    expect(statements[0].query).toContain("SET status = 'FULFILLED'");
    expect(statements.some((s) => s.query.includes('by_cart'))).toBe(false);
    expect(statements.some((s) => s.query.includes('by_status'))).toBe(false);
    const history = statements.find((s) => s.query.includes('INSERT INTO inventory_history'))!;
    expect(history.params[H.operation]).toBe('FULFILL');
    expect(history.params[H.priorStatus]).toBe('RELEASED');
    expect(history.params[H.newStatus]).toBe('FULFILLED');
    expect(JSON.parse(history.params[H.details] as string)).toEqual({ unreserved: true });

    // Counter CAS: reserved untouched (3 → 3, no active hold), total 10 → 8.
    expect(db.clientExecute).toHaveBeenCalledTimes(1);
    expect(db.clientExecute.mock.calls[0][1]).toEqual([3, 8, 'TEE', 'f1', 3]);
    expect(db.signalInventoryChanged).toHaveBeenCalledWith(['TEE']);
  });

  it('a retried fulfill hits the FULFILLED terminal guard — no double-decrement', async () => {
    primeReads({ reservation: reservationRow({ status: 'FULFILLED', expires_at: null }) });
    await InventoryCommandRepository.fulfill('cart-1-v1');
    expect(db.executeBatch).not.toHaveBeenCalled();
    expect(db.clientExecute).not.toHaveBeenCalled();
  });
});

describe('transferToFulfiller() terminal early-return', () => {
  it('skips terminal reservations before any row mutation or journal write', async () => {
    for (const status of ['RELEASED', 'CANCELLED', 'FULFILLED']) {
      primeReads({ reservation: reservationRow({ status, expires_at: null }) });
      await InventoryCommandRepository.transferToFulfiller('cart-1-v1', 'f2', 2);
    }
    expect(db.executeBatch).not.toHaveBeenCalled();
    expect(db.clientExecute).not.toHaveBeenCalled();
    expect(db.signalInventoryChanged).not.toHaveBeenCalled();
  });
});

// ============================================================
// Journey correlation on reservation rows (validation run 003)
// ============================================================

/** The main-table INSERT binds correlation_id 4th (after reservation_id, blank_sku, cart_id). */
const MAIN_ROW_CORRELATION_PARAM = 3;

const mainRowInsert = () =>
  batchStatements().find((s) => s.query.includes('INSERT INTO inventory_reservations_w'))!;

const batchHistoryInsert = () =>
  batchStatements().find((s) => s.query.includes('INSERT INTO inventory_history'))!;

describe('reserveGroup() stores the journey correlationId on the main row', () => {
  const reserve = () =>
    InventoryCommandRepository.reserveGroup(
      'TEE',
      'cart-1',
      [{ reservationId: 'cart-1-v1', variantId: 'v1', quantity: 2 }],
      'checkout-cart-1',
      900,
    );

  it('binds the ambient correlationId into the main-row INSERT and the RESERVE journal entry', async () => {
    vi.mocked(currentCorrelationId).mockReturnValue('corr-1');
    primeReads({
      reservation: null,
      stock: { fulfiller_id: 'f1', total_stock: 10, reserved_stock: 0 },
    });

    await expect(reserve()).resolves.toEqual({ success: true });

    expect(mainRowInsert().params[MAIN_ROW_CORRELATION_PARAM]).toBe('corr-1');
    expect(batchHistoryInsert().params[H.correlationId]).toBe('corr-1');
  });

  it('stores null — never the cartId — outside a correlation scope (null = legacy/unknown)', async () => {
    primeReads({
      reservation: null,
      stock: { fulfiller_id: 'f1', total_stock: 10, reserved_stock: 0 },
    });

    await expect(reserve()).resolves.toEqual({ success: true });

    // A cartId stand-in here would masquerade as a real journey key; the fallback
    // belongs at journal time (rowJournalKey), where legacy rows resolve to cart_id.
    expect(mainRowInsert().params[MAIN_ROW_CORRELATION_PARAM]).toBeNull();
    expect(batchHistoryInsert().params[H.correlationId]).toBe('cart-1');
  });
});

describe('release() journal key for system-initiated releases', () => {
  it("journals under the row's stored journey correlationId when present", async () => {
    primeReads({
      reservation: reservationRow({ correlation_id: 'corr-1' }),
      stock: { total_stock: 10, reserved_stock: 3 },
    });

    await InventoryCommandRepository.release('cart-1-v1', 'expiry-sweep');

    const history = batchHistoryInsert();
    expect(history.params[H.correlationId]).toBe('corr-1');
    expect(history.params[H.actor]).toBe('expiry-sweep');
    expect(history.params[H.operation]).toBe('RELEASE');
  });

  it('falls back to cart_id for legacy rows that predate the correlation_id column', async () => {
    primeReads({
      reservation: reservationRow(), // correlation_id: null
      stock: { total_stock: 10, reserved_stock: 3 },
    });

    await InventoryCommandRepository.release('cart-1-v1', 'expiry-sweep');

    expect(batchHistoryInsert().params[H.correlationId]).toBe('cart-1');
  });

  it("never uses the ambient correlationId for a reasoned release — a preemption runs inside ANOTHER cart's reserve activity", async () => {
    vi.mocked(currentCorrelationId).mockReturnValue('corr-other-cart');
    primeReads({
      reservation: reservationRow({ correlation_id: 'corr-1' }),
      stock: { total_stock: 10, reserved_stock: 3 },
    });

    await InventoryCommandRepository.release('cart-1-v1', 'preemption', { forCart: 'cart-2' });
    expect(batchHistoryInsert().params[H.correlationId]).toBe('corr-1');

    // Legacy row under the same ambient scope: still the row's OWN cart linkage.
    db.executeBatch.mockClear();
    primeReads({ reservation: reservationRow(), stock: { total_stock: 10, reserved_stock: 3 } });
    await InventoryCommandRepository.release('cart-1-v1', 'preemption', { forCart: 'cart-2' });
    expect(batchHistoryInsert().params[H.correlationId]).toBe('cart-1');
  });
});
