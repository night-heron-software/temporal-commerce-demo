/**
 * The web tier tells the truth about domain failures — ported from nightheron-mono `75b30296`
 * (#242, its ledger -013 R6+R7).
 *
 * The mono's validation run 013 produced a triple charge while its storefront log said the
 * journey went fine at every step — `ok: true` on actions whose worker-side counterparts had
 * failed. Two distinct blindnesses, one per helper below:
 *
 *  - a Temporal update that RETURNS `{ error: … }` is a transport success, so a throw-vs-no-throw
 *    wrapper logs `ok: true`. Silence would have been better; false success is worse than nothing.
 *  - a decider `reject(...)` arrives as `WorkflowUpdateFailedError: Workflow Update failed`, with
 *    the domain's actual sentence one or two `cause` links down. Matching on the transport
 *    message, recognising nothing, and blaming the network invites the retry that produced the
 *    triple charge.
 */
import { describe, expect, it } from 'vitest';
import { domainMessageOf, domainErrorOf } from './cart-actions-outcome';

describe('domainMessageOf — the domain gets to keep its own words', () => {
  it('digs the decider sentence out from under the transport wrapper', () => {
    const err = Object.assign(new Error('Workflow Update failed'), {
      cause: new Error('Order is being placed — please wait'),
    });
    expect(domainMessageOf(err)).toBe('Order is being placed — please wait');
  });

  it('digs through TWO cause links', () => {
    const err = Object.assign(new Error('Workflow Update failed'), {
      cause: Object.assign(new Error('Workflow Update failed'), {
        cause: new Error('Inventory reservation failed: variant has no inventory sku'),
      }),
    });
    expect(domainMessageOf(err)).toBe('Inventory reservation failed: variant has no inventory sku');
  });

  it('returns undefined when the transport message is ALL there is', () => {
    // A genuine connectivity failure has no domain sentence, and must not be dressed up as one.
    expect(domainMessageOf(new Error('Workflow Update failed'))).toBeUndefined();
  });

  it('does not loop forever on a self-referential cause', () => {
    const err: { message: string; cause?: unknown } = { message: 'Workflow Update failed' };
    err.cause = err;
    expect(domainMessageOf(err)).toBeUndefined();
  });
});

describe('domainErrorOf — a refusal returned as a VALUE is still a failure', () => {
  it('catches the price-integrity refusal that submitOrder returns', () => {
    expect(domainErrorOf({ error: 'CART_CHANGED', step: 'review' })).toBe('CART_CHANGED');
  });

  it('catches a failed checkout step even with no error string', () => {
    expect(domainErrorOf({ step: 'failed' })).toBe('step=failed');
  });

  it('catches a failure mirrored onto the cart', () => {
    expect(domainErrorOf({ checkout: { error: 'Checkout failed' } })).toBe('Checkout failed');
    expect(domainErrorOf({ checkout: { step: 'failed' } })).toBe('checkout.step=failed');
  });

  it('stays quiet for a genuinely successful result', () => {
    expect(domainErrorOf({ step: 'review', cartVersion: 3 })).toBeUndefined();
    expect(domainErrorOf(null)).toBeUndefined();
    expect(domainErrorOf(undefined)).toBeUndefined();
    expect(domainErrorOf('not an object')).toBeUndefined();
  });

  it('ignores an empty error string rather than reporting a failure that is not one', () => {
    expect(domainErrorOf({ error: '' })).toBeUndefined();
  });
});
