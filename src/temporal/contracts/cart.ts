export interface CartItem {
  lineItemId: string;
  variantId: string;
  quantity: number;
  price: number;
  properties?: Record<string, unknown>;
  // Display snapshot, captured at add-to-cart (backlog #1 / remediation R1). Optional:
  // lines added before the snapshot existed fall back to showing the variantId, visibly.
  // Mirrors OrderLineItem's naming (contracts/oms.ts) so the order path maps it through
  // without renames. The seeded product names already carry the "[Simulated]" suffix.
  productId?: string;
  productTitle?: string;
  /** Option labels joined for display, e.g. "Baby Blue / 4XL". */
  variantTitle?: string;
  optionLabels?: string[];
  thumbnailUrl?: string;
}

export interface ShippingAddress {
  firstName: string;
  lastName: string;
  address1: string;
  address2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone?: string;
  email: string;
}

/** Required `ShippingAddress` fields with their shopper-facing labels (keeps the two layers of validation — storefront form and checkout workflow — agreeing on what "complete" means). */
export const REQUIRED_SHIPPING_ADDRESS_FIELDS = [
  ['firstName', 'First name'],
  ['lastName', 'Last name'],
  ['address1', 'Address'],
  ['city', 'City'],
  ['state', 'State'],
  ['postalCode', 'ZIP code'],
  ['country', 'Country'],
  ['email', 'Email'],
] as const satisfies ReadonlyArray<readonly [keyof ShippingAddress, string]>;

/**
 * Pure required-field check for a shipping address. Returns the shopper-facing labels of the
 * fields that are missing or whitespace-only; an empty array means the address is complete.
 */
export function validateShippingAddress(address: Partial<ShippingAddress>): string[] {
  return REQUIRED_SHIPPING_ADDRESS_FIELDS.filter(([key]) => !address[key]?.trim()).map(
    ([, label]) => label,
  );
}

/** The 50 states plus DC and the territories USPS delivers to — what "a valid state code" means here. */
export const US_STATE_CODES: ReadonlySet<string> = new Set([
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
  'DC',
  'PR',
  'VI',
  'GU',
  'AS',
  'MP',
]);

/** Countries checkout can ship to today. US-only until international addresses are designed (mono backlog #36.4). */
export const SUPPORTED_SHIPPING_COUNTRIES: ReadonlySet<string> = new Set(['US']);

const US_ZIP_RE = /^\d{5}(-\d{4})?$/;
// Deliberately shallow: one non-space local part, one @, a dot somewhere in the domain. Real
// deliverability belongs to a verification service (mono backlog #36.2) — a stricter regex here only
// manufactures false rejections.
const EMAIL_SHAPE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Pure format check for a shipping address — the sibling of `validateShippingAddress`, split
 * rather than merged because the two answer different questions ("is it filled in?" vs "does what
 * they typed make sense?") and both callers join the results into one message anyway. Fields that
 * are absent are SKIPPED here: reporting "ZIP code is invalid" for a blank field would double up
 * with the required-field check that both call sites run first.
 *
 * US-shaped by design (mono backlog #36.1); the country whitelist is what makes that explicit instead
 * of silent — a non-US country fails here rather than sailing through to a mis-shipped parcel.
 */
export function validateShippingAddressFormat(address: Partial<ShippingAddress>): string[] {
  // Derived from the keyed form below so there is one rule set, not two that agree today. The
  // order is fixed by FORMAT_FIELD_ORDER rather than by insertion, because callers join these
  // into one sentence and a reordered sentence is a changed message.
  const byField = validateShippingAddressFormatFields(address);
  return FORMAT_FIELD_ORDER.map((field) => byField[field]).filter(
    (problem): problem is string => problem !== undefined,
  );
}

/** The order format problems are reported in when they are flattened into one message. */
const FORMAT_FIELD_ORDER = ['postalCode', 'state', 'email', 'country'] as const;

/** A problem message per field, for callers that know where to put it. */
export type ShippingAddressFieldErrors = Partial<Record<keyof ShippingAddress, string>>;

/**
 * The same format rules as `validateShippingAddressFormat`, keyed by the field they belong to.
 *
 * A flat `string[]` is the right shape for the workflow, which refuses the whole address and says
 * why. It is the wrong shape for a form: the mono's run-009 shopper filled six fields, pressed Continue, and
 * got three problems at once with nothing indicating which box each belonged to. Same rules, so the
 * field-level message a shopper sees and the authoritative refusal can never disagree.
 */
export function validateShippingAddressFormatFields(
  address: Partial<ShippingAddress>,
): ShippingAddressFieldErrors {
  const problems: ShippingAddressFieldErrors = {};

  const postalCode = address.postalCode?.trim();
  if (postalCode && !US_ZIP_RE.test(postalCode)) {
    problems.postalCode = 'ZIP code must be 5 digits (or ZIP+4)';
  }

  const state = address.state?.trim();
  if (state && !US_STATE_CODES.has(state.toUpperCase())) {
    problems.state = 'State must be a two-letter code (e.g. UT)';
  }

  const email = address.email?.trim();
  if (email && !EMAIL_SHAPE_RE.test(email)) {
    problems.email = 'Email address does not look valid';
  }

  const country = address.country?.trim();
  if (country && !SUPPORTED_SHIPPING_COUNTRIES.has(country.toUpperCase())) {
    problems.country = 'We currently ship to US addresses only';
  }

  return problems;
}

/**
 * Everything wrong with one field: missing first, then malformed — never both, because "ZIP code is
 * required" and "ZIP code must be 5 digits" for the same empty box is two ways of saying nothing
 * was typed.
 *
 * This is what a form binds to. `validateShippingAddress` + `validateShippingAddressFormat` remain
 * the pair the checkout workflow uses, and all three read the same rules.
 */
export function validateShippingAddressFields(
  address: Partial<ShippingAddress>,
): ShippingAddressFieldErrors {
  const errors: ShippingAddressFieldErrors = {};
  for (const [field, label] of REQUIRED_SHIPPING_ADDRESS_FIELDS) {
    if (!address[field]?.trim()) errors[field] = `${label} is required`;
  }
  for (const [field, problem] of Object.entries(validateShippingAddressFormatFields(address))) {
    if (!errors[field as keyof ShippingAddress]) {
      errors[field as keyof ShippingAddress] = problem;
    }
  }
  return errors;
}

export interface PaymentMethod {
  type: 'card' | 'mock';
  last4?: string;
  token: string; // In real impl, this would be a tokenized payment reference
}

export interface Order {
  orderId: string;
  cartId: string;
  /**
   * The journey's correlationId — its own UUID (ADR-0031), threaded from the cart
   * workflow's Search Attribute at order creation,
   * captured from the ambient correlation context when the order is created.
   */
  correlationId: string;
  customerEmail: string;
  items: CartItem[];
  shippingAddress: ShippingAddress;
  paymentMethod: PaymentMethod;
  subtotal: number;
  shippingCost: number;
  tax: number;
  totalDiscounts: number;
  total: number;
  currency: string;
  status: 'pending' | 'paid' | 'fulfilled' | 'cancelled';
  createdAt: string;
  updatedAt?: string;
  confirmationNumber: string;
}

export type CheckoutStep =
  | 'validating'
  | 'shipping'
  | 'payment'
  | 'review'
  | 'processing'
  | 'complete'
  | 'failed'
  | 'cancelled';

export interface CheckoutState {
  step: CheckoutStep;
  isGuest: boolean;
  shippingAddress?: ShippingAddress;
  paymentMethod?: PaymentMethod;
  shippingCost: number;
  tax: number;
  cartVersionAtStart?: number;
  /**
   * The cart version this checkout has actually priced — checkout-owned, updated whenever the
   * checkout re-reads the cart. Paired with `cartVersionAcknowledged` so the changed-cart
   * question is answered from ONE workflow.
   *
   * Previously the storefront compared the CART workflow's live `cartVersion` against this
   * checkout's acknowledged baseline. Both were correct individually, but they are two
   * workflows read by two independent RPCs, so any timing difference between them read as a
   * content change. `validating` re-syncing the baseline fixed the instance that fired on every
   * fresh checkout; owning both numbers here removes the whole class.
   */
  cartVersion?: number;
  cartVersionAcknowledged?: number;
  order?: Order;
  error?: string;
  clientSecret?: string;
}

export interface CartDetails {
  cartId: string;
  /**
   * The journey key (ADR-0031) — its own UUID, NOT the cartId. Read back off the cart
   * workflow's own `CorrelationId` Search Attribute by the query handler and by every update
   * response, which makes the workflow the authority: the storefront caches this value (the
   * scoped cart cookie) but never decides it. Absent on a locally-constructed `CartDetails`
   * that has not come from a running workflow.
   */
  correlationId?: string;
  email?: string;
  userId?: string; // Linked user ID if authenticated
  items: CartItem[];
  subtotalPrice: number;
  totalDiscounts: number;
  totalTax: number;
  totalPrice: number;
  shippingCost: number;
  currency: string;
  appliedCoupons: string[];
  cartVersion: number;
  status: 'active' | 'checkout' | 'processing' | 'completed' | 'failed' | 'abandoned';
  checkout?: CheckoutState;
  createdAt: string;
  updatedAt: string;
}

/**
 * Has the cart changed since the shopper last approved these totals?
 *
 * BOTH numbers are checkout-owned — `cartVersion` is what the checkout priced,
 * `cartVersionAcknowledged` is what the shopper approved. That single authority is the point:
 * comparing a cart-side version against a checkout-side baseline makes any cross-workflow timing
 * difference read as a content change.
 *
 * Exported so the workflow and the storefront share one predicate rather than two copies of a `>`.
 * Either value being absent means "we cannot tell", which must not render as "changed".
 */
export function hasUnacknowledgedCartChange(
  checkout: Pick<CheckoutState, 'cartVersion' | 'cartVersionAcknowledged'> | null | undefined,
): boolean {
  if (!checkout) return false;
  const { cartVersion, cartVersionAcknowledged } = checkout;
  if (cartVersion === undefined || cartVersionAcknowledged === undefined) return false;
  return cartVersion > cartVersionAcknowledged;
}

/**
 * The authoritative checkout total: subtotal − discounts + the LIVE checkout state's shipping
 * and tax. This is the amount the payment step prices and the amount stamped at completion — so
 * it is what the shopper is actually charged.
 *
 * Exists because checkout pages reach for `cart.totalPrice` for their headline totals — a figure
 * computed BEFORE the address attached real shipping and tax, and only reconciled at completion.
 * The itemized rows read live state while the Total row and the Pay button read the stale figure,
 * so the page could show one number and charge another. Every headline total on the checkout path
 * must use this, never `cart.totalPrice`.
 */
export function computeCheckoutTotal(
  cart: Pick<CartDetails, 'subtotalPrice' | 'totalDiscounts'>,
  checkout: Pick<CheckoutState, 'shippingCost' | 'tax'>,
): number {
  return cart.subtotalPrice - cart.totalDiscounts + checkout.shippingCost + checkout.tax;
}

// ==================
// Cart Command — one union for every intent the machine accepts (ADR-0024).
//
// The first block is the WIRE union (what `cartUpdate` callers send). The second
// block is internal: signal-mapped commands from the checkout child (see `toSignal`
// in cart/workflows.ts) and the commands the two states' timers synthesize. The
// decider sees these enriched with prepared data + the deterministic timestamp
// (see `EnrichedCartCommand` in cart/states.ts).
// ==================

export type CartCommand =
  // — wire (cartUpdate) —
  | {
      type: 'addItem';
      variantId: string;
      quantity: number;
      price: number;
      properties?: Record<string, unknown>;
      // Display snapshot resolved server-side at add-to-cart (see lib/variant-display.ts);
      // absent when resolution fails — the line then falls back to its variantId.
      productId?: string;
      productTitle?: string;
      variantTitle?: string;
      optionLabels?: string[];
      thumbnailUrl?: string;
    }
  | { type: 'updateQuantity'; lineItemId: string; quantity: number }
  | { type: 'removeItem'; lineItemId: string }
  | { type: 'applyCoupon'; code: string }
  | { type: 'linkUser'; email: string; userId: string }
  | { type: 'beginCheckout' }
  // — from the checkout child (signal transport, mapped to commands at registration) —
  | { type: 'checkoutCompleted'; result: CheckoutWorkflowResult }
  | { type: 'submitStarted' }
  | { type: 'submitAborted' }
  // — synthesized by state timers (onTimeout) —
  | { type: 'expireCart' }
  | { type: 'checkoutTimedOut' };

// Update response: either the updated cart state or void for terminal operations
export type CartUpdateResponse = CartDetails | void;

// ==================
// Checkout Workflow Input/Output
// ==================

/**
 * Checkout child input. Cart contents are NOT snapshotted here — the checkout
 * pulls them live via the queryCart activity at `validating` (and again on each
 * recompute nudge), so a mid-checkout cart edit can never leave a stale snapshot.
 */
export interface CheckoutWorkflowInput {
  cartId: string;
  parentCartWorkflowId: string;
  currency: string;
  isGuest: boolean;
  cartVersion: number;
  checkoutVersion: number;
}

export interface CheckoutWorkflowResult {
  success: boolean;
  cancelled?: boolean;
  timedOut?: boolean;
  order?: Order;
  error?: string;
  finalState: CheckoutState;
  checkoutVersion: number;
}

// ==================
// Workflow Definitions
// ==================

import { defineQuery, defineSignal, defineUpdate } from '@temporalio/workflow';

// Single consolidated cart update
export const cartUpdate = defineUpdate<CartUpdateResponse, [CartCommand]>('cartUpdate');

// Queries
export const getCartQuery = defineQuery<CartDetails>('getCart');
export const getCheckoutStateQuery = defineQuery<CheckoutState | null>('getCheckoutState');
export const getCheckoutWorkflowIdQuery = defineQuery<string | null>('getCheckoutWorkflowId');
export const getUserIdQuery = defineQuery<string | undefined>('getUserId');

/**
 * Combined inbound signal from the checkout child to the cart parent (wire name
 * 'checkoutCompleted'): the completion result, plus the submit-freeze phases that
 * lock cart edits while the checkout child is placing the order.
 */
export type CartInboundSignal =
  | { kind: 'completed'; result: CheckoutWorkflowResult }
  | { kind: 'submitStarted' }
  | { kind: 'submitAborted' };

// Signals (from checkout child → cart parent)
export const checkoutCompletedSignal = defineSignal<[CartInboundSignal]>('checkoutCompleted');
