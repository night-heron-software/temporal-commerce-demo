/**
 * Pure-function tests for the projection lifecycle helpers: the reservation close doc
 * (delete-replacement in the activity impls) and the reindex status derivation.
 */
import { describe, expect, it } from 'vitest';
import { reservationClosedDoc } from './inventory';
import { deriveLifecycleFromStatus } from './elasticsearch';

const AT = '2026-07-24T12:00:00.000Z';

describe('reservationClosedDoc', () => {
  it('FULFILLED is the happy-path close', () => {
    expect(reservationClosedDoc('FULFILLED', AT)).toEqual({
      status: 'FULFILLED',
      workflowStatus: 'completed',
      workflowOutcome: 'completed',
      workflowClosedAt: AT,
    });
  });

  it('RELEASED and CANCELLED close as canceled', () => {
    expect(reservationClosedDoc('RELEASED', AT).workflowOutcome).toBe('canceled');
    expect(reservationClosedDoc('CANCELLED', AT).workflowOutcome).toBe('canceled');
    expect(reservationClosedDoc('RELEASED', AT).status).toBe('RELEASED');
  });
});

describe('deriveLifecycleFromStatus', () => {
  it('derives completed for terminal order statuses', () => {
    for (const status of ['cancelled', 'refunded', 'returned', 'complete']) {
      expect(deriveLifecycleFromStatus('orders', status, AT)).toEqual({
        workflowStatus: 'completed',
        workflowOutcome: 'completed',
        workflowClosedAt: AT,
      });
    }
  });

  it('delivered is NOT terminal for orders (still open for feedback/returns)', () => {
    expect(deriveLifecycleFromStatus('orders', 'delivered', AT)).toEqual({});
  });

  it('derives fulfiller order terminals', () => {
    expect(deriveLifecycleFromStatus('fulfiller_orders', 'delivered', AT).workflowStatus).toBe(
      'completed',
    );
    expect(deriveLifecycleFromStatus('fulfiller_orders', 'rejected', AT).workflowStatus).toBe(
      'completed',
    );
    expect(deriveLifecycleFromStatus('fulfiller_orders', 'shipped', AT)).toEqual({});
  });

  it('derives reservation terminals with per-status outcomes', () => {
    expect(deriveLifecycleFromStatus('reservations', 'FULFILLED').workflowOutcome).toBe(
      'completed',
    );
    expect(deriveLifecycleFromStatus('reservations', 'RELEASED').workflowOutcome).toBe('canceled');
    expect(deriveLifecycleFromStatus('reservations', 'CANCELLED').workflowOutcome).toBe('canceled');
    expect(deriveLifecycleFromStatus('reservations', 'TEMPORARY')).toEqual({});
    expect(deriveLifecycleFromStatus('reservations', 'CONFIRMED')).toEqual({});
  });

  it('treats null/undefined status as live', () => {
    expect(deriveLifecycleFromStatus('orders', null)).toEqual({});
    expect(deriveLifecycleFromStatus('orders', undefined)).toEqual({});
  });
});
