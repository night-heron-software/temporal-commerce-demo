/**
 * The two sharp edges the -017 remediation plan's Phase 4 files down.
 *
 * Both are the same shape as the defects that surfaced them: a value that means two things, or a
 * number that stands in for a measurement.
 */
import { describe, expect, it } from 'vitest';
import {
  describeMissingTimeouts,
  findWaitingStatesWithoutTimeout,
  shouldContinueAsNew,
} from './machine-validation';

describe('a waiting state must say how long it waits (mono-backlog-069)', () => {
  it('flags a non-transitional state with no timeout', () => {
    expect(findWaitingStatesWithoutTimeout({ live: { fn: 1 } as never })).toEqual(['live']);
  });

  it('CONTROL: a declared timeout is fine, including the function form', () => {
    expect(findWaitingStatesWithoutTimeout({ live: { timeout: '30 days' } })).toEqual([]);
    expect(findWaitingStatesWithoutTimeout({ live: { timeout: () => '1 day' } })).toEqual([]);
  });

  it('CONTROL: transitional states are exempt — they never wait, so a timer is meaningless', () => {
    expect(findWaitingStatesWithoutTimeout({ hop: { transitional: true } })).toEqual([]);
  });

  it('names EVERY offender, sorted, rather than the first one it trips over', () => {
    // A machine with three bad states should take one fix-and-run cycle, not three.
    expect(
      findWaitingStatesWithoutTimeout({
        zulu: {},
        alpha: {},
        ok: { timeout: '1h' },
        mike: { transitional: true },
      }),
    ).toEqual(['alpha', 'zulu']);
  });

  it('a zero timeout is a DECLARATION, not an omission', () => {
    // `0` is falsy. If the check ever regresses to a truthiness test, this is what catches it —
    // the same class of bug as the one being fixed, one level down.
    expect(findWaitingStatesWithoutTimeout({ live: { timeout: 0 } })).toEqual([]);
  });

  it('the message names the states and says what to do', () => {
    const m = describeMissingTimeouts('cartWorkflow', ['live', 'parked']);
    expect(m).toContain('cartWorkflow');
    expect(m).toContain('live, parked');
    expect(m).toMatch(/transitional/); // the other legitimate answer, offered
  });
});

describe('continue-as-new follows the SDK, not a guess (mono-backlog-068)', () => {
  it('continues when the SDK suggests it, whatever the count says', () => {
    // The whole point: the SDK measures history size, which is the thing that actually matters.
    expect(shouldContinueAsNew({ suggested: true, inputCount: 0 })).toBe(true);
    expect(shouldContinueAsNew({ suggested: true, inputCount: 0, threshold: 100 })).toBe(true);
  });

  it('does NOT continue on a low count when the SDK is content', () => {
    expect(shouldContinueAsNew({ suggested: false, inputCount: 99, threshold: 100 })).toBe(false);
  });

  it('an explicit threshold still applies, as a CEILING', () => {
    // A machine that knows something the SDK does not can still cap itself...
    expect(
      shouldContinueAsNew({
        suggested: false,
        inputCount: 100,
        threshold: 100,
      }),
    ).toBe(true);
  });

  it('with no threshold, the SDK alone decides — no hidden default', () => {
    // The old code defaulted to 100 via `|| 100`. A hidden number is exactly what Temporal warns
    // against, because an input's event cost varies with the path it takes.
    expect(shouldContinueAsNew({ suggested: false, inputCount: 10_000 })).toBe(false);
    expect(shouldContinueAsNew({ suggested: true, inputCount: 0 })).toBe(true);
  });

  it('a threshold of 0 means "every input", not "no threshold"', () => {
    // `|| 100` would have turned 0 into 100 — the falsy-default trap again.
    expect(shouldContinueAsNew({ suggested: false, inputCount: 0, threshold: 0 })).toBe(true);
  });
});
