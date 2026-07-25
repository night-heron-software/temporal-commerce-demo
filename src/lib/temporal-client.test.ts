/**
 * Unit tests for the Temporal client singleton and the standalone-activity helper
 * (ADR-0006): connection caching, and the bounded defaults that keep synchronous HTTP
 * callers from hanging (3 attempts, schedule-to-close cap).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { connect, activityExecute, clientCtorOptions } = vi.hoisted(() => ({
  connect: vi.fn(),
  activityExecute: vi.fn(),
  clientCtorOptions: [] as unknown[],
}));

vi.mock('@temporalio/client', () => ({
  Connection: { connect },
  Client: class {
    activity = { execute: activityExecute };
    constructor(options: unknown) {
      clientCtorOptions.push(options);
    }
  },
}));

beforeEach(() => {
  vi.resetModules();
  connect.mockReset().mockResolvedValue({ fake: 'connection' });
  activityExecute.mockReset().mockResolvedValue('activity-result');
  clientCtorOptions.length = 0;
});

async function importFresh() {
  return import('./temporal-client');
}

describe('getTemporalClient', () => {
  it('connects once and caches the client across calls', async () => {
    const mod = await importFresh();
    const a = await mod.getTemporalClient();
    const b = await mod.getTemporalClient();

    expect(a).toBe(b);
    expect(connect).toHaveBeenCalledTimes(1);
    // Local dev: no TLS unless both cert and key env vars are present.
    expect(connect.mock.calls[0][0]).toMatchObject({ tls: undefined });
    expect(clientCtorOptions[0]).toMatchObject({ namespace: mod.TEMPORAL_NAMESPACE });
  });
});

describe('executeStandaloneActivity', () => {
  it('applies the bounded defaults: 3 attempts, 10s per attempt, 30s total', async () => {
    const mod = await importFresh();
    const result = await mod.executeStandaloneActivity<string>('registerShopper', {
      taskQueue: 'identity-queue',
      activityId: 'register-shopper-x',
      args: [{ email: 'a@b.c' }],
    });

    expect(result).toBe('activity-result');
    expect(activityExecute).toHaveBeenCalledWith('registerShopper', {
      id: 'register-shopper-x',
      taskQueue: 'identity-queue',
      args: [{ email: 'a@b.c' }],
      startToCloseTimeout: '10 seconds',
      scheduleToCloseTimeout: '30 seconds',
      retry: { maximumAttempts: 3 },
      typedSearchAttributes: undefined,
    });
  });

  it('lets callers override timeouts, retry, and search attributes', async () => {
    const mod = await importFresh();
    const typedSearchAttributes = [{ key: 'CorrelationId', value: 'corr-1' }] as never;
    await mod.executeStandaloneActivity('registerShopper', {
      taskQueue: 'identity-queue',
      activityId: 'id-1',
      args: [],
      startToCloseTimeout: '2 seconds',
      scheduleToCloseTimeout: '5 seconds',
      retry: { maximumAttempts: 1 },
      typedSearchAttributes,
    });

    expect(activityExecute).toHaveBeenCalledWith(
      'registerShopper',
      expect.objectContaining({
        startToCloseTimeout: '2 seconds',
        scheduleToCloseTimeout: '5 seconds',
        retry: { maximumAttempts: 1 },
        typedSearchAttributes,
      }),
    );
  });
});
