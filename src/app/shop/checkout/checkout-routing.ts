/**
 * Where a shopper belongs, given the machine's own step.
 *
 * ## Why this exists
 *
 * The parent platform's mono-issue-0318 is a CLASS, not one bug: **a routing guard and a state
 * machine disagreeing about the same step.** It was found twice there, in two different features,
 * and both instances were the same violation — *an action navigated to a path the machine's own
 * step did not agree with:*
 *
 * | | The action | The machine said | It navigated to | Result |
 * | --- | --- | --- | --- | --- |
 * | #0318 | "Continue to review" on the approved branch | `payment` | `/review` | review bounced it back, forever |
 * | #0326 | "Approve $120.00" in the reauthorization modal | `review` | `/payment` | payment showed "approved", no way forward |
 *
 * Each was fixed at its own call site. That leaves the class intact, because the next feature to
 * write `router.push('/shop/checkout/…')` next to a state it did not consult reintroduces it.
 * This repo had five such literal call sites when this module was ported.
 *
 * ## What this module changes
 *
 * **A checkout path is no longer nameable without a step.** `pathForStep` takes the step the
 * machine just reported and returns where that shopper belongs, so a caller cannot express "go to
 * review" independently of "the machine is at review". The disagreement becomes unrepresentable at
 * the call site rather than merely absent from it.
 *
 * `routeForStep` is the guard half, and it carries a **reason**. A silent `router.replace` is what
 * made #0318 present as "the button doesn't work" — a loop with no explanation. The reason is
 * available to log or surface, so the next instance describes itself.
 *
 * The **fixed-point property** in `checkout-routing.test.ts` is the part that actually defends the
 * class: for every step, the canonical path for that step must not itself redirect. A routing
 * relation that violates that has a cycle, and a cycle is the bug. It is checked over the whole
 * step union, so a new step cannot join the flow without either satisfying it or failing the suite.
 */
import type { Cart } from '@/temporal/contracts';

/** The three interactive checkout surfaces. Terminal steps live on the confirmation page. */
export const CHECKOUT_PATHS = {
  shipping: '/shop/checkout/shipping',
  payment: '/shop/checkout/payment',
  review: '/shop/checkout/review',
} as const;

export type CheckoutPath = (typeof CHECKOUT_PATHS)[keyof typeof CHECKOUT_PATHS];

/**
 * Where a shopper on `step` belongs, or `null` when the step is not one of the interactive
 * surfaces.
 *
 * `null` is deliberate rather than a fallback to shipping: `complete` means the order exists and
 * the destination is the confirmation page, whose href carries order parameters this module has no
 * business composing. Silently returning `/shipping` for a completed order would send a shopper who
 * just paid back to the start of checkout.
 */
export function pathForStep(step: Cart.CheckoutStep | undefined | null): CheckoutPath | null {
  switch (step) {
    // Not yet accepted — the shopper is still on the address form.
    case 'validating':
    case 'shipping':
      return CHECKOUT_PATHS.shipping;
    case 'payment':
      return CHECKOUT_PATHS.payment;
    case 'review':
      return CHECKOUT_PATHS.review;
    // Terminal or in-flight: not this module's to route.
    case 'processing':
    case 'complete':
    case 'failed':
    case 'cancelled':
      return null;
    default:
      // An unknown or absent step is the start of the flow, which is the safe reading: the
      // shopper has provided nothing yet.
      return step ? null : CHECKOUT_PATHS.shipping;
  }
}

export type StepRoute =
  | { kind: 'stay' }
  /** `reason` exists so a bounce is never silent — see the module note. */
  | { kind: 'redirect'; to: CheckoutPath; reason: string };

/**
 * The guard half: given the machine's step and where the shopper currently is, stay or move.
 *
 * Returns `stay` for a step this module does not route (terminal / in-flight), because bouncing a
 * shopper mid-submit is worse than leaving them on a page that is about to navigate itself.
 */
export function routeForStep(
  step: Cart.CheckoutStep | undefined | null,
  currentPath: string,
): StepRoute {
  const belongs = pathForStep(step);
  if (!belongs) return { kind: 'stay' };
  if (belongs === currentPath) return { kind: 'stay' };
  return {
    kind: 'redirect',
    to: belongs,
    reason: `checkout is at step "${step ?? 'unknown'}", which belongs at ${belongs}`,
  };
}

/**
 * Navigate on the strength of a state the caller just received — the ONLY way an action should
 * choose a checkout destination.
 *
 * Returns the path to push, or `null` when the state does not place the shopper on an interactive
 * surface (so the caller can decide, rather than being handed a wrong path). Callers that already
 * know they want a specific step should still route through `pathForStep` so the step and the path
 * cannot drift apart.
 */
export function destinationFor(
  state: { step?: Cart.CheckoutStep } | null | undefined,
): CheckoutPath | null {
  return pathForStep(state?.step);
}
