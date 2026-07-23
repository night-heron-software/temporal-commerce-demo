import { describe, expect, it } from 'vitest';

import {
  CORRELATION_ID_HEADER,
  decodeCorrelationHeader,
  encodeCorrelationHeader,
} from './correlation-header';

describe('correlation-header codec', () => {
  it('round-trips a correlationId through the default payload converter', () => {
    const payload = encodeCorrelationHeader('cart-abc-123');
    expect(decodeCorrelationHeader(payload)).toBe('cart-abc-123');
  });

  it('decodes undefined for an absent header payload', () => {
    expect(decodeCorrelationHeader(undefined)).toBeUndefined();
  });

  it('decodes undefined for a non-string payload', () => {
    // A JSON payload carrying a number is not a valid correlationId.
    const numeric = encodeCorrelationHeader('x');
    numeric.data = Buffer.from('42');
    expect(decodeCorrelationHeader(numeric)).toBeUndefined();
  });

  it('decodes undefined (never throws) for a malformed payload', () => {
    expect(decodeCorrelationHeader({ metadata: {}, data: Buffer.from('{oops') })).toBeUndefined();
  });

  it('uses the agreed header key', () => {
    expect(CORRELATION_ID_HEADER).toBe('correlationId');
  });
});
