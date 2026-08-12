import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  temporalUiUrl,
  temporalWorkflowUrl,
  temporalWorkflowsByCorrelationUrl,
  temporalWorkflowsByTypeUrl,
} from './temporal-links';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('temporal-links', () => {
  it('defaults to localhost:8233 / default namespace', () => {
    expect(temporalUiUrl()).toBe('http://localhost:8233');
    expect(temporalWorkflowUrl('demo.order.o-1')).toBe(
      'http://localhost:8233/namespaces/default/workflows/demo.order.o-1',
    );
  });

  it('honors TEMPORAL_UI_URL and TEMPORAL_NAMESPACE (server env)', () => {
    vi.stubEnv('TEMPORAL_UI_URL', 'https://temporal.example.dev');
    vi.stubEnv('TEMPORAL_NAMESPACE', 'demo-ns');
    expect(temporalWorkflowUrl('demo.cart.c-1')).toBe(
      'https://temporal.example.dev/namespaces/demo-ns/workflows/demo.cart.c-1',
    );
  });

  it('builds the journey query with the correlation id encoded', () => {
    expect(temporalWorkflowsByCorrelationUrl('cart-1')).toBe(
      `http://localhost:8233/namespaces/default/workflows?query=${encodeURIComponent('CorrelationId="cart-1"')}`,
    );
  });

  it('builds the type-filtered list', () => {
    expect(temporalWorkflowsByTypeUrl('orderWorkflow')).toContain(
      encodeURIComponent('WorkflowType="orderWorkflow"'),
    );
  });

  it('encodes dot-delimited workflow ids safely', () => {
    expect(temporalWorkflowUrl('demo.fulfiller-order.so-1')).toContain(
      encodeURIComponent('demo.fulfiller-order.so-1'),
    );
  });
});
