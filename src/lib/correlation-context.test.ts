import { describe, expect, it } from 'vitest';

import { currentCorrelationId, runWithCorrelationId } from './correlation-context';

describe('correlation-context', () => {
  it('is undefined outside any runWithCorrelationId scope', () => {
    expect(currentCorrelationId()).toBeUndefined();
  });

  it('exposes the correlationId inside the scope (sync)', () => {
    runWithCorrelationId('cart-1', () => {
      expect(currentCorrelationId()).toBe('cart-1');
    });
    expect(currentCorrelationId()).toBeUndefined();
  });

  it('follows the async path across awaits', async () => {
    await runWithCorrelationId('cart-async', async () => {
      await Promise.resolve();
      expect(currentCorrelationId()).toBe('cart-async');
      await new Promise((r) => setTimeout(r, 0));
      expect(currentCorrelationId()).toBe('cart-async');
    });
    expect(currentCorrelationId()).toBeUndefined();
  });

  it('nests: the inner scope wins and the outer is restored after', () => {
    runWithCorrelationId('outer', () => {
      runWithCorrelationId('inner', () => {
        expect(currentCorrelationId()).toBe('inner');
      });
      expect(currentCorrelationId()).toBe('outer');
    });
  });

  it('isolates concurrent async scopes from each other', async () => {
    const seen: Record<string, string | undefined> = {};
    await Promise.all([
      runWithCorrelationId('cart-a', async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.a = currentCorrelationId();
      }),
      runWithCorrelationId('cart-b', async () => {
        await new Promise((r) => setTimeout(r, 1));
        seen.b = currentCorrelationId();
      }),
    ]);
    expect(seen).toEqual({ a: 'cart-a', b: 'cart-b' });
  });

  it('returns the callback result', () => {
    expect(runWithCorrelationId('cid', () => 42)).toBe(42);
  });
});
