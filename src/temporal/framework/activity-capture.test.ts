import { describe, it, expect } from 'vitest';
import {
  transitionActivityInterceptors,
  beginActivityCapture,
  endActivityCapture,
} from './activity-capture';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const outbound = transitionActivityInterceptors().outbound![0] as any;
const schedule = (activityType: string, args?: unknown, result?: unknown) =>
  outbound.scheduleActivity({ activityType, args }, () => Promise.resolve(result));

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
