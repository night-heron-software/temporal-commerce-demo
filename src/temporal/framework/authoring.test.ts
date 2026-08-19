import { describe, it, expect } from 'vitest';
import { terminal, isTerminal } from './authoring';
import * as index from './index';

describe('terminal()', () => {
  it('builds the __terminal: encoding', () => {
    expect(terminal('cancelled')).toBe('__terminal:cancelled');
  });
});

describe('isTerminal()', () => {
  it('matches any terminal without a reason', () => {
    expect(isTerminal('__terminal:complete')).toBe(true);
    expect(isTerminal('active')).toBe(false);
  });

  it('matches only the named terminal with a reason', () => {
    expect(isTerminal('__terminal:complete', 'complete')).toBe(true);
    expect(isTerminal('__terminal:complete', 'cancelled')).toBe(false);
  });
});

describe('the retired first-generation surface stays retired (clarity-plan Phase 4)', () => {
  it('exports none of the old authoring names', () => {
    const exported = index as Record<string, unknown>;
    for (const retired of ['defineDomain', 'defineTransitions', 'definePureState', 'route']) {
      expect(exported[retired], `'${retired}' must not be exported`).toBeUndefined();
    }
  });
});
