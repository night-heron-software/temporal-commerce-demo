/**
 * How a cart line names itself on screen — the single source of the fallback rule.
 *
 * Every cart line carries a display snapshot captured at add-to-cart (backlog #1 / remediation
 * R1): `productTitle`, `variantTitle`, `thumbnailUrl`. A line added BEFORE that capture existed
 * has none of them, and that absence is meaningful — it is not an error to paper over. The rule
 * here is to fall back visibly to the id, labelled for what it actually is (`Variant <id>`,
 * never `SKU: <id>` — a variantId is not a sku).
 *
 * Ported from nightheron-mono (#252 Phase 5a / `5480e...`, backlog #54 there). The mono's R2 fix
 * corrected only its cart drawer and wrote the rule inline; its validation run 013 then found the
 * raw UUID still rendering on the checkout order summaries, because each surface formatted lines
 * for itself. The demo was one commit behind on the same path: the drawer said `SKU: <variantId>`
 * and the review page fell back to the bare unlabelled UUID. Hence one module — a third copy of
 * this logic is a third place for the next surface to diverge.
 */

/**
 * The display fields a renderable line must carry. Structural rather than `CartItem` so any
 * surface holding a snapshot can render through the same fallback without importing the cart
 * contract.
 */
export interface CartLineDisplayFields {
  variantId: string;
  productTitle?: string;
  variantTitle?: string;
  thumbnailUrl?: string;
}

/**
 * The line's primary name. Falls back to the id when the line predates the snapshot.
 *
 * The check is truthiness, not nullishness: the snapshot resolver omits a field rather than
 * writing an empty string, so an empty `productTitle` means the same thing as a missing one and
 * must not render as a blank row.
 */
export function cartLineTitle(item: CartLineDisplayFields): string {
  return item.productTitle || `Variant ${item.variantId}`;
}

/**
 * The line on ONE line — title plus variant label — for space-constrained surfaces where a
 * two-line block does not fit.
 */
export function cartLineLabel(item: CartLineDisplayFields): string {
  const title = cartLineTitle(item);
  return item.variantTitle ? `${title} — ${item.variantTitle}` : title;
}
