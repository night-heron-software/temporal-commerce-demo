/**
 * Tests for the logger's pure surface — `toSystemErrorDocument`, which shapes a pino JSON line
 * into a `system_errors` document. Deliberately free of Elasticsearch and the filesystem: both
 * side-effecting streams are disabled under vitest (see `isTest` in logger.ts).
 */
import { describe, expect, it } from 'vitest';

import { correlationMixin, createLogger, toSystemErrorDocument } from './logger';
import { runWithCorrelationId } from './correlation-context';

/** Build a pino-shaped JSON line. */
function line(fields: Record<string, unknown>): string {
  return JSON.stringify({ level: 50, time: 1_700_000_000_000, msg: 'boom', ...fields });
}

describe('toSystemErrorDocument', () => {
  describe('filtering', () => {
    it('returns null for a line that is not JSON', () => {
      expect(toSystemErrorDocument('not json at all')).toBeNull();
    });

    it('returns null for levels below error (50)', () => {
      expect(toSystemErrorDocument(line({ level: 30 }))).toBeNull();
      expect(toSystemErrorDocument(line({ level: 40 }))).toBeNull();
    });

    it('returns null when level is missing or non-numeric', () => {
      expect(toSystemErrorDocument(JSON.stringify({ msg: 'no level' }))).toBeNull();
      expect(toSystemErrorDocument(line({ level: 'error' }))).toBeNull();
    });
  });

  describe('level mapping', () => {
    it('maps 50 to error and 60 to fatal', () => {
      expect(toSystemErrorDocument(line({ level: 50 }))?.level).toBe('error');
      expect(toSystemErrorDocument(line({ level: 60 }))?.level).toBe('fatal');
    });
  });

  describe('field lifting', () => {
    it('lifts component and storeId out of the bindings to top level', () => {
      const doc = toSystemErrorDocument(line({ component: 'cart:worker', storeId: 'demo' }));

      expect(doc?.component).toBe('cart:worker');
      expect(doc?.storeId).toBe('demo');
      // ...and does not leave them duplicated in context
      expect(doc?.context).not.toHaveProperty('component');
      expect(doc?.context).not.toHaveProperty('storeId');
    });

    it('lifts correlationId (stamped by the mixin) to top level', () => {
      const doc = toSystemErrorDocument(line({ correlationId: 'cart-1' }));

      expect(doc?.correlationId).toBe('cart-1');
      expect(doc?.context).not.toHaveProperty('correlationId');
    });

    it('leaves correlationId undefined when the line has none', () => {
      expect(toSystemErrorDocument(line({}))?.correlationId).toBeUndefined();
    });

    it('lifts err.stack into stack', () => {
      const doc = toSystemErrorDocument(
        line({ err: { type: 'Error', message: 'nope', stack: 'Error: nope\n  at x' } }),
      );

      expect(doc?.stack).toBe('Error: nope\n  at x');
      expect(doc?.context.err).toMatchObject({ message: 'nope' });
    });

    it('handles the Temporal SDK `error` key identically to pino `err`', () => {
      const asErr = toSystemErrorDocument(line({ err: { stack: 'S', message: 'm' } }));
      const asError = toSystemErrorDocument(line({ error: { stack: 'S', message: 'm' } }));

      expect(asError?.stack).toBe(asErr?.stack);
      expect(asError?.context).toEqual(asErr?.context);
    });

    it('leaves stack undefined when there is no error object', () => {
      expect(toSystemErrorDocument(line({}))?.stack).toBeUndefined();
    });
  });

  describe('context', () => {
    it('sweeps remaining fields into context without pino internals', () => {
      const doc = toSystemErrorDocument(
        line({ orderId: 'ord_1', attempt: 3, pid: 42, hostname: 'mac' }),
      );

      expect(doc?.context).toMatchObject({ orderId: 'ord_1', attempt: 3 });
      // level/msg/time are lifted or dropped, never mirrored into context
      expect(doc?.context).not.toHaveProperty('level');
      expect(doc?.context).not.toHaveProperty('msg');
      expect(doc?.context).not.toHaveProperty('time');
    });
  });

  describe('identity fields', () => {
    it('derives an ISO timestamp from pino numeric time', () => {
      const doc = toSystemErrorDocument(line({ time: 1_700_000_000_000 }));
      expect(doc?.timestamp).toBe('2023-11-14T22:13:20.000Z');
    });

    it('falls back to now when time is absent', () => {
      const doc = toSystemErrorDocument(JSON.stringify({ level: 50, msg: 'x' }));
      expect(Number.isNaN(Date.parse(doc!.timestamp))).toBe(false);
    });

    it('assigns a unique errorId per line', () => {
      const a = toSystemErrorDocument(line({}));
      const b = toSystemErrorDocument(line({}));

      expect(a?.errorId).toMatch(/^[0-9a-f-]{36}$/);
      expect(a?.errorId).not.toBe(b?.errorId);
    });

    it('defaults message to empty string when msg is absent', () => {
      expect(toSystemErrorDocument(JSON.stringify({ level: 50 }))?.message).toBe('');
    });
  });
});

describe('createLogger', () => {
  it('binds the component name so log lines are filterable', () => {
    expect(createLogger('cart:worker').bindings()).toMatchObject({ component: 'cart:worker' });
  });
});

describe('correlationMixin', () => {
  it('returns no fields outside a correlation scope', () => {
    expect(correlationMixin()).toEqual({});
  });

  it('stamps the ambient correlationId inside runWithCorrelationId', () => {
    runWithCorrelationId('cart-1', () => {
      expect(correlationMixin()).toEqual({ correlationId: 'cart-1' });
    });
  });

  it('feeds toSystemErrorDocument: a mixin-stamped error line lifts correlationId', () => {
    const stamped = runWithCorrelationId('cart-2', () =>
      JSON.stringify({ level: 50, time: 1_700_000_000_000, msg: 'boom', ...correlationMixin() }),
    );
    expect(toSystemErrorDocument(stamped)?.correlationId).toBe('cart-2');
  });
});
