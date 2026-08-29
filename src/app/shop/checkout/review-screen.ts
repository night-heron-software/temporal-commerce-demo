/**
 * Which screen the review page shows — extracted pure, because the ORDER of these branches is the
 * whole fix and an ordering that lives only inside a component cannot be tested.
 *
 * Four states, and the one that was missing is `placed`.
 *
 * `clearCart()` runs synchronously before an async `router.push`, so between them the page
 * re-renders with `cart === null` while the order has in fact succeeded. Without a `placed` state
 * that render fell through to `missing` and told a shopper who had just been charged to
 * "Add something first" ([#255](https://github.com/night-heron-software/nightheron-mono/issues/255),
 * validation run 015). On the money path, at the one moment someone is waiting to learn whether
 * their card was taken, that reads as *the order failed, try again*.
 *
 * `missing` itself is R7 dead-end 4's fix (remediation `-014` Phase 5): an absent cart is a STATE,
 * not a stage of loading, and folding the two together stranded shoppers on "Loading checkout…"
 * forever. `placed` is a THIRD state added in front of it, never a loosening of it — which is what
 * the tests beside this file pin.
 */
export type ReviewScreen = 'placed' | 'missing' | 'loading' | 'review';

export interface ReviewScreenInput {
  /** Set the instant the order is confirmed placed, BEFORE the cart is cleared. */
  placedHref: string | null;
  /** True until the first cart bootstrap settles. */
  initializing: boolean;
  /** Whether a cart is present at all. */
  hasCart: boolean;
  /** Whether the checkout state has arrived AND reports step `review`. */
  isReady: boolean;
}

export function chooseReviewScreen(input: ReviewScreenInput): ReviewScreen {
  // FIRST. From here the cart is null on purpose, and `placed` is otherwise indistinguishable
  // from `missing` — same inputs, opposite meanings.
  if (input.placedHref) return 'placed';

  // A settled bootstrap with no cart: nothing to review, and no checkout state will ever arrive,
  // so a spinner here would never end.
  if (!input.initializing && !input.hasCart) return 'missing';

  if (!input.hasCart || !input.isReady) return 'loading';

  return 'review';
}
