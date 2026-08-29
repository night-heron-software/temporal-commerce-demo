import { describe, it, expect } from 'vitest';
import { chooseReviewScreen, type ReviewScreenInput } from './review-screen';

/**
 * These tests exist because of validation run 015 / [#255](https://github.com/night-heron-software/nightheron-mono/issues/255).
 *
 * The review page called `clearCart()` synchronously and then `router.push(...)`. The push is an
 * async client navigation, so in the window between them the page re-rendered with `cart === null`
 * — and fell through the missing-cart branch, telling a shopper who had just been charged to
 * "Add something first".
 *
 * The fix is a third state, and the substance of it is the ORDER of the branches. `placed` and
 * `missing` receive **identical** inputs — no cart, bootstrap settled — and mean opposite things.
 * So the tests below are mostly about that collision.
 */
const base: ReviewScreenInput = {
  placedHref: null,
  initializing: false,
  hasCart: true,
  isReady: true,
};

describe('chooseReviewScreen', () => {
  it('shows the review page when everything is ready', () => {
    expect(chooseReviewScreen(base)).toBe('review');
  });

  it('THE DEFECT: a cleared cart after a successful order is `placed`, not `missing`', () => {
    // Exactly the state #255 produced: order succeeded, cart deliberately nulled, navigation in
    // flight. Before the fix this returned 'missing' and rendered "Add something first".
    expect(
      chooseReviewScreen({
        ...base,
        placedHref: '/shop/checkout/confirmation?order=AXRCU8XA',
        hasCart: false,
      }),
    ).toBe('placed');
  });

  it('`placed` and `missing` are otherwise IDENTICAL inputs — order is the only thing separating them', () => {
    const cleared = { ...base, hasCart: false, initializing: false };
    // Same inputs in every respect except the flag...
    expect(chooseReviewScreen({ ...cleared, placedHref: '/x' })).toBe('placed');
    expect(chooseReviewScreen({ ...cleared, placedHref: null })).toBe('missing');
    // ...which is precisely why the flag must be set BEFORE the cart is cleared, and why this
    // branch must be evaluated FIRST.
  });

  it('R7 dead-end 4 still holds: no cart and no order placed is `missing`, never a spinner', () => {
    // The regression that matters most. An absent cart is a STATE, not a stage of loading — the
    // fix for #255 must not soften this into an endless "Loading review…".
    expect(chooseReviewScreen({ ...base, hasCart: false })).toBe('missing');
    expect(chooseReviewScreen({ ...base, hasCart: false, isReady: false })).toBe('missing');
  });

  it('still loading while the bootstrap has not settled', () => {
    // `initializing` true with no cart is NOT missing — the cart may yet arrive. Collapsing these
    // two is the original dead-end.
    expect(chooseReviewScreen({ ...base, initializing: true, hasCart: false })).toBe('loading');
  });

  it('a present cart whose checkout state has not arrived is loading', () => {
    expect(chooseReviewScreen({ ...base, isReady: false })).toBe('loading');
  });

  it('`placed` wins even mid-bootstrap', () => {
    // Order placed is terminal for this page: nothing about a bootstrap in flight should send a
    // charged shopper back to a spinner or, worse, to the missing-cart copy.
    expect(
      chooseReviewScreen({
        ...base,
        placedHref: '/x',
        initializing: true,
        hasCart: false,
        isReady: false,
      }),
    ).toBe('placed');
  });
});
