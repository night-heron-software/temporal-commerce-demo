import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Mutable workflowInfo stand-in: tests flip `searchAttributes` to exercise the
 * correlation-header injection ({} = untagged workflow → no header).
 */
const wfState = vi.hoisted(() => ({ searchAttributes: {} as Record<string, unknown> }));

vi.mock('@temporalio/workflow', () => ({
  workflowInfo: vi.fn(() => ({
    workflowId: 'demo.cart.cart-1',
    runId: 'run-1',
    searchAttributes: wfState.searchAttributes,
  })),
}));

import {
  transitionActivityInterceptors,
  beginActivityCapture,
  endActivityCapture,
} from './activity-capture';
import { CORRELATION_ID_HEADER, decodeCorrelationHeader } from './correlation-header';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const outbound = transitionActivityInterceptors().outbound![0] as any;
const schedule = (activityType: string, args?: unknown, result?: unknown) =>
  outbound.scheduleActivity({ activityType, args }, () => Promise.resolve(result));

beforeEach(() => {
  wfState.searchAttributes = {};
  endActivityCapture();
});

describe('transition activity-capture interceptor', () => {
  it('captures each activity name, args, and result in order', async () => {
    const bucket = beginActivityCapture();
    await schedule('reserveCartItem', [{ sku: 'A' }], { reserved: true });
    await schedule('indexCart', ['cart-1'], undefined);
    endActivityCapture();
    expect(bucket).toEqual([
      { name: 'reserveCartItem', args: [{ sku: 'A' }], result: { reserved: true } },
      { name: 'indexCart', args: ['cart-1'], result: undefined },
    ]);
  });

  it('records the error and rethrows when an activity rejects', async () => {
    const bucket = beginActivityCapture();
    await expect(
      outbound.scheduleActivity({ activityType: 'processPayment', args: [1] }, () =>
        Promise.reject(new Error('declined')),
      ),
    ).rejects.toThrow('declined');
    endActivityCapture();
    expect(bucket[0]).toMatchObject({ name: 'processPayment', args: [1], error: 'declined' });
  });

  it('excludes the recorder’s own persist activity', async () => {
    const bucket = beginActivityCapture();
    await schedule('persistWorkflowTransitions', [[]], undefined);
    await schedule('saveOrderToDatabase', [{ id: 1 }], undefined);
    endActivityCapture();
    expect(bucket.map((c: { name: string }) => c.name)).toEqual(['saveOrderToDatabase']);
  });

  it('caps oversized args/results with a truncation marker', async () => {
    const bucket = beginActivityCapture();
    await schedule('bigActivity', undefined, { blob: 'x'.repeat(20_000) });
    endActivityCapture();
    expect(bucket[0].result).toMatchObject({ __truncated: true });
  });

  it('no-ops when no capture is active', async () => {
    endActivityCapture();
    await expect(schedule('orphan')).resolves.toBeUndefined();
    const bucket = beginActivityCapture();
    endActivityCapture();
    await schedule('afterEnd');
    expect(bucket).toEqual([]);
  });
});

describe('correlation-header injection', () => {
  /** Schedule via the interceptor and hand back the input `next` received. */
  const interceptedInput = async (
    method: 'scheduleActivity' | 'scheduleLocalActivity',
    input: Record<string, unknown>,
  ) => {
    let seen: Record<string, unknown> | undefined;
    await outbound[method](input, (i: Record<string, unknown>) => {
      seen = i;
      return Promise.resolve(undefined);
    });
    return seen!;
  };

  it('stamps the correlationId header from the CorrelationId Search Attribute', async () => {
    wfState.searchAttributes = { CorrelationId: ['cart-1'] };
    const input = await interceptedInput('scheduleActivity', {
      activityType: 'indexOrder',
      args: [],
      headers: {},
    });
    const headers = input.headers as Record<string, never>;
    expect(decodeCorrelationHeader(headers[CORRELATION_ID_HEADER])).toBe('cart-1');
  });

  it('stamps local activities too', async () => {
    wfState.searchAttributes = { CorrelationId: ['cart-2'] };
    const input = await interceptedInput('scheduleLocalActivity', {
      activityType: 'localThing',
      args: [],
      headers: {},
    });
    const headers = input.headers as Record<string, never>;
    expect(decodeCorrelationHeader(headers[CORRELATION_ID_HEADER])).toBe('cart-2');
  });

  it('preserves pre-existing headers alongside the injected one', async () => {
    wfState.searchAttributes = { CorrelationId: ['cart-3'] };
    const input = await interceptedInput('scheduleActivity', {
      activityType: 'indexOrder',
      args: [],
      headers: { otel: { data: new Uint8Array() } },
    });
    const headers = input.headers as Record<string, unknown>;
    expect(headers.otel).toBeDefined();
    expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
  });

  it('skips untagged workflows (no CorrelationId Search Attribute)', async () => {
    wfState.searchAttributes = {};
    const input = await interceptedInput('scheduleActivity', {
      activityType: 'inventorySweep',
      args: [],
      headers: {},
    });
    expect(input.headers).toEqual({});
  });

  it('still captures activity calls while injecting', async () => {
    wfState.searchAttributes = { CorrelationId: ['cart-4'] };
    const bucket = beginActivityCapture();
    await schedule('reserveCartItem', [{ sku: 'A' }], { reserved: true });
    endActivityCapture();
    expect(bucket).toEqual([
      { name: 'reserveCartItem', args: [{ sku: 'A' }], result: { reserved: true } },
    ]);
  });
});
