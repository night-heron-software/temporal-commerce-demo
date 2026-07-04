import { describe, it, expect, beforeEach, vi } from 'vitest';

/** The convention resolver only reads `workflowInfo()`; swap it per test. */
let info: { workflowId: string; searchAttributes?: Record<string, unknown> };

vi.mock('@temporalio/workflow', () => ({
  workflowInfo: () => info,
}));

import { conventionIdentityResolver } from './identity';

beforeEach(() => {
  info = { workflowId: 'store-1.oms.order-1', searchAttributes: {} };
});

describe('conventionIdentityResolver', () => {
  it('resolves tenant and tags from Search Attributes', () => {
    info.searchAttributes = {
      StoreId: ['store-1'],
      Domain: ['oms'],
      CorrelationId: ['cart-9'],
      OrderId: ['order-1'],
    };
    expect(conventionIdentityResolver()()).toEqual({
      tenantId: 'store-1',
      tags: { Domain: 'oms', CorrelationId: 'cart-9', OrderId: 'order-1' },
    });
  });

  it('falls back to the dot-delimited workflow-ID convention when untagged', () => {
    info = { workflowId: 'store-7.cart.cart-2', searchAttributes: {} };
    expect(conventionIdentityResolver()()).toEqual({
      tenantId: 'store-7',
      tags: { Domain: 'cart' },
    });
  });

  it('prefers Search Attributes over the workflow-ID parse, field by field', () => {
    // Tagged Domain differs from the workflow-ID segment; SA wins.
    info = {
      workflowId: 'store-1.cart.entity-1',
      searchAttributes: { Domain: ['oms'] },
    };
    expect(conventionIdentityResolver()()).toEqual({
      tenantId: 'store-1', // from the workflow-ID fallback
      tags: { Domain: 'oms' }, // from the Search Attribute
    });
  });

  it('returns undefined when no tenant id is resolvable', () => {
    info = { workflowId: 'singleton', searchAttributes: { Domain: ['oms'] } };
    expect(conventionIdentityResolver()()).toBeUndefined();
  });

  it('excludes Temporal built-in attributes and non-keyword values from tags', () => {
    info.searchAttributes = {
      StoreId: ['store-1'],
      TemporalChangeVersion: ['patch-1'],
      TemporalScheduledById: ['sched-1'],
      HistoryLength: [42],
      Domain: ['oms'],
    };
    expect(conventionIdentityResolver()()).toEqual({
      tenantId: 'store-1',
      tags: { Domain: 'oms' },
    });
  });

  it('honors a custom tenant attribute and workflow-ID fallback', () => {
    info = {
      workflowId: 'acct-9:billing:sub-3',
      searchAttributes: {},
    };
    const resolver = conventionIdentityResolver({
      tenantAttribute: 'AccountId',
      workflowIdFallback: (id) => {
        const [tenantId, domain] = id.split(':');
        return tenantId ? { tenantId, tags: { Domain: domain } } : undefined;
      },
    });
    expect(resolver()).toEqual({ tenantId: 'acct-9', tags: { Domain: 'billing' } });

    info.searchAttributes = { AccountId: ['acct-override'] };
    expect(resolver()?.tenantId).toBe('acct-override');
  });

  it('omits tags entirely when none resolve', () => {
    info = { workflowId: 'untagged', searchAttributes: { StoreId: ['store-1'] } };
    expect(conventionIdentityResolver()()).toEqual({ tenantId: 'store-1', tags: undefined });
  });
});
