/**
 * What changed between the cart the shopper last APPROVED and the cart as it stands now —
 * the explanation half of the cart-changed banner (this repo's remediation R3, extracted pure
 * in the parent platform and re-converged here).
 *
 * The banner's GATE is checkout-owned (`hasUnacknowledgedCartChange`, both versions live on the
 * checkout child); this module owns only the human explanation rendered once that gate fires.
 * The approved side is a `sessionStorage` snapshot captured whenever the banner sees a quiet
 * (acknowledged) checkout and refreshed on each acknowledge; the current side is built from the
 * live cart + checkout state at render. Pure and DOM-free so it unit-tests without rendering.
 *
 * Line identity goes through `cart-line-display.ts` — one fallback rule (`Variant <id>`, never
 * a bare UUID or `SKU:`), the same rule every other cart surface uses.
 */

import type { Cart } from '@/temporal/contracts';
import { computeCheckoutTotal } from '@/temporal/contracts/cart';
import { cartLineLabel, type CartLineDisplayFields } from '@/app/shop/cart-line-display';

/** One approved cart line — display identity plus the two numbers a diff can talk about. */
export interface ApprovedCartLine extends CartLineDisplayFields {
  lineItemId: string;
  quantity: number;
  /** `price × quantity`, integer cents. */
  lineTotal: number;
}

/** The approved cart as persisted to `sessionStorage` (JSON-serializable by construction). */
export interface ApprovedCartSnapshot {
  lines: ApprovedCartLine[];
  /** The headline checkout total (computeCheckoutTotal), never `cart.totalPrice`. */
  total: number;
}

/** The `sessionStorage` key for a checkout's approved-cart snapshot. */
export function approvedCartSnapshotKey(cartId: string): string {
  return `approved-cart-${cartId}`;
}

/**
 * Snapshot the cart in its approved state. Also used at render time to build the CURRENT side
 * of the diff, so both sides go through identical field selection.
 *
 * The total is the authoritative headline total — subtotal − discounts + the LIVE checkout
 * state's shipping and tax — because that is the figure the shopper approved and the figure
 * every other checkout surface shows.
 */
export function buildApprovedCartSnapshot(
  cart: Pick<Cart.CartDetails, 'items' | 'subtotalPrice' | 'totalDiscounts'>,
  checkout: Pick<Cart.CheckoutState, 'shippingCost' | 'tax'>,
): ApprovedCartSnapshot {
  return {
    lines: cart.items.map((item) => ({
      lineItemId: item.lineItemId,
      variantId: item.variantId,
      // Spread nothing: copy only display fields so the stored JSON stays small and stable.
      ...(item.productTitle ? { productTitle: item.productTitle } : {}),
      ...(item.variantTitle ? { variantTitle: item.variantTitle } : {}),
      quantity: item.quantity,
      lineTotal: item.price * item.quantity,
    })),
    total: computeCheckoutTotal(cart, checkout),
  };
}

export interface CartChangeDiff {
  /**
   * Human line-by-line changes, current-cart order first, removals last:
   * - `"<label>: added (× 2)"`
   * - `"<label>: quantity 1 → 2"`
   * - `"<label>: removed"`
   * where `<label>` is `cartLineLabel`. Empty when only totals moved.
   */
  changes: string[];
  previousTotal: number;
  currentTotal: number;
  totalChanged: boolean;
}

/**
 * Diff the approved snapshot against the current cart, keyed by `lineItemId`.
 *
 * Returns `null` when there is no snapshot to compare against — the first fire of a checkout
 * this session has nothing approved on record, and the banner degrades to its generic copy
 * rather than inventing a diff.
 */
export function computeCartDiff(
  snapshot: ApprovedCartSnapshot | null | undefined,
  current: ApprovedCartSnapshot,
): CartChangeDiff | null {
  if (!snapshot) return null;

  const beforeById = new Map(snapshot.lines.map((line) => [line.lineItemId, line]));
  const nowIds = new Set(current.lines.map((line) => line.lineItemId));

  const changes: string[] = [];
  for (const line of current.lines) {
    const before = beforeById.get(line.lineItemId);
    if (!before) {
      changes.push(`${cartLineLabel(line)}: added (× ${line.quantity})`);
    } else if (before.quantity !== line.quantity) {
      changes.push(`${cartLineLabel(before)}: quantity ${before.quantity} → ${line.quantity}`);
    }
  }
  for (const before of snapshot.lines) {
    if (!nowIds.has(before.lineItemId)) {
      changes.push(`${cartLineLabel(before)}: removed`);
    }
  }

  return {
    changes,
    previousTotal: snapshot.total,
    currentTotal: current.total,
    totalChanged: snapshot.total !== current.total,
  };
}
