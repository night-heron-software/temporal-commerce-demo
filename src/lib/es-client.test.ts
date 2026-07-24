/**
 * Tests for the Elasticsearch error predicate — `isIndexNotFoundError` must recognize a
 * missing-index failure both by the typed ResponseError body and by message text, and
 * reject everything else.
 */
import { describe, expect, it } from 'vitest';
import { isIndexNotFoundError } from './es-client';

describe('isIndexNotFoundError', () => {
  it('matches a ResponseError-shaped body with type index_not_found_exception', () => {
    const err = Object.assign(new Error('ResponseError'), {
      meta: { body: { error: { type: 'index_not_found_exception' } } },
    });
    expect(isIndexNotFoundError(err)).toBe(true);
  });

  it('matches on message text when the typed body is absent', () => {
    expect(
      isIndexNotFoundError(new Error('index_not_found_exception: no such index [products]')),
    ).toBe(true);
  });

  it('rejects other errors and non-error values', () => {
    expect(isIndexNotFoundError(new Error('es exploded'))).toBe(false);
    expect(
      isIndexNotFoundError(
        Object.assign(new Error('search_phase_execution_exception'), {
          meta: { body: { error: { type: 'search_phase_execution_exception' } } },
        }),
      ),
    ).toBe(false);
    expect(isIndexNotFoundError(undefined)).toBe(false);
    expect(isIndexNotFoundError(null)).toBe(false);
    expect(isIndexNotFoundError('index_not_found_exception')).toBe(false);
  });
});
