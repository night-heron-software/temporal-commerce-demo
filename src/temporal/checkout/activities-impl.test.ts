/**
 * Checkout activity tests for the mock payment gateway's idempotency contract: a key is a
 * nonce naming ONE charge attempt. Replaying it with the same amount returns the first
 * result without charging again; replaying it with a DIFFERENT amount throws non-retryably
 * (the gateway model — Stripe rejects a reused key whose request differs). Amount drift on
 * a retry is a bug to surface, never a silent second charge. Cassandra/ES and the logger
 * are mocked at the lib boundary; the gateway store under test is the module-level map, so
 * every test uses its own keys.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const lib = vi.hoisted(() => ({
  executeCql: vi.fn(async () => []),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  sendEmail: vi.fn(async () => undefined),
}));

vi.mock('../../lib', () => ({
  executeCql: lib.executeCql,
  logger: lib.logger,
  sendEmail: lib.sendEmail,
  getElasticsearchClient: () => ({ index: vi.fn() }),
  cassandraTypes: {
    Uuid: { fromString: (s: string) => ({ toString: () => s }) },
    TimeUuid: { fromDate: (d: Date) => ({ toString: () => d.toISOString() }) },
  },
}));
vi.mock('../../lib/communication-templates', () => ({ buildCommunication: vi.fn() }));
vi.mock('../../lib/correlation-context', () => ({ currentCorrelationId: vi.fn(() => undefined) }));
vi.mock('../inventory/db/inventory-command-repository', () => ({
  InventoryCommandRepository: class {},
  InventoryContentionError: class extends Error {},
}));

import { processPayment } from './activities-impl';

/** Run a charge with the mock's simulated-processing timer fast-forwarded. */
function charge(amount: number, key?: string): Promise<boolean> {
  const attempt = processPayment('tok_1', amount, 'USD', key);
  return Promise.all([attempt, vi.advanceTimersByTimeAsync(500)]).then(([result]) => result);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('processPayment idempotency (mock gateway)', () => {
  it('replaying a key with the SAME amount returns the first result without charging again', async () => {
    await expect(charge(15.8, 'demo.checkout.c-same-pay-1')).resolves.toBe(true);
    await expect(charge(15.8, 'demo.checkout.c-same-pay-1')).resolves.toBe(true);
    expect(lib.logger.warn).toHaveBeenCalledWith(expect.stringContaining('already charged'));
  });

  it('replaying a key with a DIFFERENT amount throws non-retryably instead of re-billing', async () => {
    await charge(15.8, 'demo.checkout.c-drift-pay-1');
    await expect(charge(25.8, 'demo.checkout.c-drift-pay-1')).rejects.toMatchObject({
      nonRetryable: true,
      type: 'IDEMPOTENCY_KEY_AMOUNT_MISMATCH',
    });
  });

  it('a fresh attempt ordinal is a fresh charge — no cross-key dedupe', async () => {
    await charge(15.8, 'demo.checkout.c-next-pay-1');
    await charge(15.8, 'demo.checkout.c-next-pay-2');
    expect(lib.logger.warn).not.toHaveBeenCalled();
  });
});
