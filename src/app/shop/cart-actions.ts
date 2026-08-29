'use server';

/**
 * Cart Server Actions — Demo version
 *
 * Simplified: no auth, cookie-only cart ID.
 * Uses Temporal updateWithStart for lazy cart creation.
 */

import { cookies } from 'next/headers';
import { randomUUID } from 'crypto';
import { createLogger } from '@/lib/logger';
import { getTemporalClient } from '@/lib/temporal-client';
import { resolveVariantDisplay } from '@/lib/variant-display';
import { Cart, Checkout, Constants } from '@/temporal/contracts';
import {
  buildWorkflowId,
  buildWorkflowStartOptions,
  DEMO_STORE_ID,
} from '@/temporal/contracts/constants';
import { domainErrorOf, domainMessageOf } from './cart-actions-outcome';
import { getSignedInShopper } from '@/lib/shopper-session';

const log = createLogger('cart-actions');

const CART_ID_COOKIE = 'cartId';
const CART_CORRELATION_COOKIE = 'cartCorrelationId';
const CART_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

// Re-export types for client components
export type CartDetails = Cart.CartDetails;
export type CheckoutState = Cart.CheckoutState;

/**
 * Get or create a cart ID from cookie.
 */
export async function getOrCreateCartId(): Promise<string> {
  const cookieStore = await cookies();
  const existing = cookieStore.get(CART_ID_COOKIE)?.value;
  if (existing) return existing;

  const cartId = randomUUID();
  cookieStore.set(CART_ID_COOKIE, cartId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60,
    path: '/',
  });
  return cartId;
}

// ── Journey correlation: minted server-side, cached in a cookie, owned by the workflow ──────
// (ADR-0031 — the journey key is its own UUID, not the cartId.)

/** The cached journey key for `cartId`, or undefined if the cache is empty or names another cart. */
async function readCachedCorrelation(cartId: string): Promise<string | undefined> {
  const raw = (await cookies()).get(CART_CORRELATION_COOKIE)?.value;
  if (!raw) return undefined;
  const sep = raw.indexOf(':');
  if (sep < 0) return undefined;
  // Scoped to a cart id precisely so a stale entry cannot be applied to a different cart.
  return raw.slice(0, sep) === cartId ? raw.slice(sep + 1) || undefined : undefined;
}

async function cacheCorrelation(cartId: string, correlationId: string): Promise<void> {
  (await cookies()).set(CART_CORRELATION_COOKIE, `${cartId}:${correlationId}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: CART_COOKIE_MAX_AGE,
    path: '/',
  });
}

/**
 * Adopt the workflow's own correlation whenever it disagrees with what we cached.
 *
 * The workflow is the authority (it reads the value off its own Search Attribute), so this is
 * the self-healing path for every way the cache can be wrong: a cleared cookie, or an id we
 * minted optimistically for a cart that turned out to already exist —
 * `workflowIdConflictPolicy: 'USE_EXISTING'` discards our start options in that case, and this
 * is what stops the discarded value from living on in the cache.
 */
async function reconcileCorrelation(
  cartId: string,
  used: string,
  cart: Cart.CartDetails | null,
): Promise<void> {
  const authoritative = cart?.correlationId;
  if (!authoritative || authoritative === used) return;
  log.warn(
    { cartId, cachedCorrelationId: used, correlationId: authoritative },
    "correlation cache stale — adopting the cart workflow's own journey key",
  );
  await cacheCorrelation(cartId, authoritative);
}

/**
 * Terminal cart statuses — a cart in one of these will never accept another command.
 */
const TERMINAL_CART_STATUSES = ['completed', 'abandoned', 'failed'];

/**
 * Retire the cart cookie once its cart can no longer be shopped.
 *
 * The cookie outlives the cart unless something clears it, and `updateWithStart` happily
 * starts a NEW RUN under the same workflow id — so the next add-to-cart resumed a dead
 * journey's id. Post-R5 the cartId IS the journey correlationId, so reuse silently widens
 * "one query returns everything this cart did" into "…everything this browser ever did":
 * validation run -008 ended with FIVE shopping trips, three orders and two checkouts sharing
 * one correlationId, and its journal reads had to be filtered by SKU and time to mean
 * anything (backlog #10).
 *
 * Clearing was previously wired to exactly one path — a checkout reaching `complete`. This
 * covers every way a cart can end: abandoned (emptied), failed, completed, and the cases
 * where the workflow is simply gone.
 */
async function retireCartCookie(cartId: string, why: string): Promise<void> {
  const cookieStore = await cookies();
  if (cookieStore.get(CART_ID_COOKIE)?.value !== cartId) return; // already moved on
  cookieStore.delete(CART_ID_COOKIE);
  // The journey key retires with the cart it was scoped to — a fresh cart mints a fresh
  // journey (ADR-0031). The scoping makes a stale survivor harmless, but not deleting it
  // would leave a dead journey's key lying around for no reason.
  cookieStore.delete(CART_CORRELATION_COOKIE);
  log.info({ cartId, why }, 'cart cookie retired');
}

/** Did this result come back as a cart that has reached a terminal state? */
function terminalCartStatusOf(result: unknown): string | undefined {
  const status = (result as { status?: unknown } | null)?.status;
  return typeof status === 'string' && TERMINAL_CART_STATUSES.includes(status) ? status : undefined;
}

/**
 * Get the current cart ID (cookie only).
 */
export async function getCartId(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(CART_ID_COOKIE)?.value || null;
}

/**
 * Why a workflow update produced no result: the workflow is gone (never started /
 * timed out / terminated) vs. it already reached a terminal state and no longer
 * accepts updates. Distinguished so recovery paths can log what actually happened
 * instead of collapsing both into a silent `null`.
 */
type UpdateFailureReason = 'workflow-not-found' | 'workflow-already-completed';

type UpdateOutcome<T> = { ok: true; value: T } | { ok: false; reason: UpdateFailureReason };

function classifyUpdateError(e: unknown): UpdateFailureReason | null {
  const error = e as { name?: string; cause?: { type?: string } };
  if (error?.name === 'WorkflowNotFoundError') return 'workflow-not-found';
  if (error?.cause?.type === 'AcceptedUpdateCompletedWorkflow') return 'workflow-already-completed';
  return null;
}

/**
 * Unified wrapper for Temporal cart updates with error handling.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- Temporal SDK executeUpdate overloads require any */
export async function executeCartUpdate<TReturn, TArgs extends any[]>(
  cartId: string,
  updateDef: any,
  args: TArgs,
  options: { createIfMissing?: boolean } = {},
): Promise<TReturn | null> {
  const client = await getTemporalClient();
  const workflowId = buildWorkflowId(DEMO_STORE_ID, 'cart', cartId);
  // The journey key is its OWN id (ADR-0031, reversing R5's cartId-as-correlation), minted
  // server-side here at the root and carried by every workflow in the journey on its
  // `CorrelationId` Search Attribute. A freshly minted value only takes effect if this call
  // actually CREATES the workflow — `workflowIdConflictPolicy: 'USE_EXISTING'` discards start
  // options otherwise, which is why the response is reconciled below rather than trusted.
  const correlationId = (await readCachedCorrelation(cartId)) ?? randomUUID();
  // R6 (backlog #6): one entry line + one exit line per mutating action, correlation-tagged,
  // so a shopper journey is reconstructable from demo-web.log alone. Every cart mutation
  // funnels through here; the command's own type is the action name. No payloads.
  const command = (args[0] as { type?: string } | undefined)?.type ?? updateDef?.name;
  log.info({ correlationId, cartId, command }, 'cart action start');

  try {
    let result: TReturn | null;
    if (options.createIfMissing) {
      // Use updateWithStart to lazily create the workflow. R5's cartId-as-correlation
      // (decided 2026-08-11 against run -006 F9's per-run mint) is reversed by ADR-0031:
      // the per-JOURNEY mint above brings back the one-query property R5 wanted — the key
      // now lives in a scoped cookie and survives cart revivals — without welding the
      // journey key to a reusable entity id. Downstream workflow starts still read the
      // value from their parent's CorrelationId Search Attribute; when the cart workflow
      // already exists (USE_EXISTING), the existing workflow's value stays authoritative,
      // and the reconcile below repairs our cache to match it.
      const { WithStartWorkflowOperation } = await import('@temporalio/client');
      const startOp = new WithStartWorkflowOperation('cartWorkflow', {
        ...buildWorkflowStartOptions({
          storeId: DEMO_STORE_ID,
          domain: 'cart',
          entityId: cartId,
          correlationId,
          cartId,
        }),
        args: [{ cartId }],
        taskQueue: Constants.CART_TASK_QUEUE,
        workflowIdConflictPolicy: 'USE_EXISTING',
        workflowExecutionTimeout: '30 days',
        workflowTaskTimeout: '2m',
      });
      result = await client.workflow.executeUpdateWithStart(updateDef, {
        startWorkflowOperation: startOp,
        args: args as unknown as [any, ...any[]],
      });
    } else {
      const handle = client.workflow.getHandle(workflowId);
      result = await handle.executeUpdate(updateDef, { args: args as unknown as [any, ...any[]] });
    }
    // Every cart mutation returns CartDetails carrying the workflow's own journey key —
    // adopt it whenever our cache disagrees (ADR-0031).
    await reconcileCorrelation(cartId, correlationId, result as Cart.CartDetails | null);
    const domainError = domainErrorOf(result);
    if (domainError) {
      // NOT `ok: true`. The transport succeeded; the domain refused (mono #242 — its run 013
      // logged a clean journey around a triple charge because this line couldn't tell).
      log.warn(
        { correlationId, cartId, command, ok: false, domainError },
        'cart action reported a domain failure',
      );
    } else {
      log.info({ correlationId, cartId, command, ok: true }, 'cart action done');
    }
    // The cart may have just ended (emptying it decides CartAbandoned; a completed checkout
    // decides CartCompleted). Retire the cookie so the next add starts a genuinely new
    // journey instead of a second run under this id (#10).
    const terminal = terminalCartStatusOf(result);
    if (terminal) await retireCartCookie(cartId, `cart ${terminal}`);
    return result;
  } catch (e) {
    const reason = classifyUpdateError(e);
    if (reason) {
      log.info({ correlationId, cartId, command, ok: false, reason }, 'cart action done');
      // The id in the cookie names a workflow that is gone or closed — keeping it would point
      // every later command at a dead journey (#10).
      await retireCartCookie(cartId, reason);
      return null;
    }
    const domainReason = domainMessageOf(e);
    log.warn(
      { correlationId, cartId, command, ok: false, err: domainReason ?? (e as Error).message },
      'cart action failed',
    );
    // Re-throw carrying the DOMAIN's sentence so the UI can show it instead of guessing.
    if (domainReason) throw new Error(domainReason, { cause: e });
    throw e;
  }
}

/**
 * Checkout workflow update with a discriminated outcome — callers that recover
 * (e.g. setShippingAddress restarting a dead checkout) can see WHY it failed.
 */
async function runCheckoutUpdate<TReturn, TArgs extends any[]>(
  checkoutWorkflowId: string,
  updateDef: any,
  args: TArgs,
): Promise<UpdateOutcome<TReturn>> {
  const client = await getTemporalClient();
  const handle = client.workflow.getHandle(checkoutWorkflowId);
  // R6: every checkout mutation funnels through here; the update's wire name is the
  // action. The checkout workflow id carries the checkoutId — the journey join key
  // is on the caller's cart lines (the journey key rides those — ADR-0031).
  const action = updateDef?.name ?? 'checkoutUpdate';
  log.info({ checkoutWorkflowId, action }, 'checkout action start');
  try {
    const value = await handle.executeUpdate(updateDef, {
      args: args as unknown as [any, ...any[]],
    });
    const domainError = domainErrorOf(value);
    if (domainError) {
      log.warn(
        { checkoutWorkflowId, action, ok: false, domainError },
        'checkout action reported a domain failure',
      );
    } else {
      log.info({ checkoutWorkflowId, action, ok: true }, 'checkout action done');
    }
    return { ok: true, value: value as TReturn };
  } catch (e) {
    const reason = classifyUpdateError(e);
    if (reason) {
      log.info({ checkoutWorkflowId, action, ok: false, reason }, 'checkout action done');
      return { ok: false, reason };
    }
    const domainReason = domainMessageOf(e);
    log.warn(
      { checkoutWorkflowId, action, ok: false, err: domainReason ?? (e as Error).message },
      'checkout action failed',
    );
    if (domainReason) throw new Error(domainReason, { cause: e });
    throw e;
  }
}

/** Unified wrapper for checkout workflow updates (null on any tolerated failure). */
async function executeCheckoutUpdate<TReturn, TArgs extends any[]>(
  checkoutWorkflowId: string,
  updateDef: any,
  args: TArgs,
): Promise<TReturn | null> {
  const outcome = await runCheckoutUpdate<TReturn, TArgs>(checkoutWorkflowId, updateDef, args);
  return outcome.ok ? outcome.value : null;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Get cart details by querying the workflow.
 */
export async function getCart(cartId: string): Promise<Cart.CartDetails | null> {
  const client = await getTemporalClient();
  const handle = client.workflow.getHandle(buildWorkflowId(DEMO_STORE_ID, 'cart', cartId));
  try {
    return await handle.query(Cart.getCartQuery);
  } catch (e: unknown) {
    const err = e as { name?: string };
    if (err?.name === 'WorkflowNotFoundError') {
      log.info({ cartId }, 'Cart workflow not found');
    } else {
      log.error({ cartId, err: e }, 'Failed to get cart');
    }
    return null;
  }
}

/**
 * Add an item to the cart (creates cart workflow if needed). The display snapshot is
 * resolved server-side here (backlog #1 / remediation R1) — the client is not trusted
 * for what the shopper bought; a failed resolution adds the line without a snapshot and
 * the UI falls back to the variantId.
 */
export async function addItemToCart(
  cartId: string,
  variantId: string,
  quantity: number,
  price: number,
): Promise<Cart.CartDetails | null> {
  const display = await resolveVariantDisplay(variantId);
  const cart = await executeCartUpdate<Cart.CartDetails, [Cart.CartCommand]>(
    cartId,
    Cart.cartUpdate,
    [{ type: 'addItem' as const, variantId, quantity, price, ...(display ?? {}) }],
    { createIfMissing: true },
  );
  return linkShopperIfNeeded(cartId, cart);
}

/**
 * Attach the signed-in shopper to a cart that does not have one yet (backlog #11).
 *
 * Linking used to happen in ONE place — the login route — which links whatever cart exists at
 * sign-in. A cart created AFTER login (the normal case once a prior cart completes) therefore
 * stayed a guest cart forever: no email, no userId, `isGuest: true` for an authenticated
 * shopper. Order history still worked, because it queries by the address email — what broke
 * silently was cart RECOVERY at the next sign-in, which matches on the cart doc's `email`
 * (`api/auth/shopper/login/route.ts`, `term: { email }` + `status: active`).
 *
 * Same `linkUser` command the login route dispatches, so there is one linking mechanism, not
 * two. Cheap by construction: an already-linked cart short-circuits BEFORE the session lookup,
 * so the two extra reads happen only on the first add to a new cart.
 *
 * A cart already linked to a DIFFERENT shopper is left alone — switching accounts is the login
 * route's job (it recovers that shopper's own active cart, or links the guest one).
 */
async function linkShopperIfNeeded(
  cartId: string,
  cart: Cart.CartDetails | null,
): Promise<Cart.CartDetails | null> {
  if (!cart || cart.userId) return cart;

  const shopper = await getSignedInShopper();
  if (!shopper) return cart; // a genuine guest cart

  const linked = await executeCartUpdate(cartId, Cart.cartUpdate, [
    { type: 'linkUser' as const, email: shopper.email, userId: shopper.id },
  ]);
  // Linking is best-effort: it must never cost the shopper the item they just added.
  return (linked as Cart.CartDetails | null) ?? cart;
}

export async function removeFromCart(
  cartId: string,
  lineItemId: string,
): Promise<Cart.CartDetails | null> {
  return executeCartUpdate(cartId, Cart.cartUpdate, [{ type: 'removeItem' as const, lineItemId }]);
}

export async function updateItemQuantity(
  cartId: string,
  lineItemId: string,
  quantity: number,
): Promise<Cart.CartDetails | null> {
  return executeCartUpdate(cartId, Cart.cartUpdate, [
    { type: 'updateQuantity' as const, lineItemId, quantity },
  ]);
}

// ==================
// Checkout Flow
// ==================

export async function beginCheckout(cartId: string): Promise<Cart.CartDetails | null> {
  return executeCartUpdate(cartId, Cart.cartUpdate, [{ type: 'beginCheckout' as const }]);
}

export async function getCheckoutWorkflowId(cartId: string): Promise<string | null> {
  const client = await getTemporalClient();
  const handle = client.workflow.getHandle(buildWorkflowId(DEMO_STORE_ID, 'cart', cartId));
  try {
    return await handle.query(Cart.getCheckoutWorkflowIdQuery);
  } catch {
    return null;
  }
}

export async function setShippingAddress(
  cartId: string,
  shippingAddress: Cart.ShippingAddress,
): Promise<Cart.CheckoutState | null> {
  let checkoutWfId = await getCheckoutWorkflowId(cartId);

  if (!checkoutWfId) {
    await beginCheckout(cartId);
    checkoutWfId = await getCheckoutWorkflowId(cartId);
    if (!checkoutWfId) return null;
  }

  const outcome = await runCheckoutUpdate<
    Cart.CheckoutState,
    [{ shippingAddress: Cart.ShippingAddress }]
  >(checkoutWfId, Checkout.setShippingUpdate, [{ shippingAddress }]);
  if (outcome.ok) return outcome.value;

  // Recovery: the checkout workflow was dead (timed out / terminated / already
  // completed) — start a fresh attempt and retry the update against it.
  log.info(
    { checkoutWorkflowId: checkoutWfId, reason: outcome.reason },
    'Checkout unavailable; starting a fresh checkout',
  );
  await beginCheckout(cartId);
  const newId = await getCheckoutWorkflowId(cartId);
  if (!newId) return null;
  return executeCheckoutUpdate(newId, Checkout.setShippingUpdate, [
    { shippingAddress },
  ]) as Promise<Cart.CheckoutState | null>;
}

export async function setPaymentMethod(
  cartId: string,
  paymentMethod: Cart.PaymentMethod,
): Promise<Cart.CheckoutState | null> {
  const checkoutWfId = await getCheckoutWorkflowId(cartId);
  if (!checkoutWfId) return null;
  return executeCheckoutUpdate(checkoutWfId, Checkout.setPaymentUpdate, [
    { paymentMethod },
  ]) as Promise<Cart.CheckoutState | null>;
}

/**
 * Place the order.
 *
 * `reviewedCartVersion` is the cartVersion the SHOPPER'S REVIEW WAS RENDERED FROM, and passing
 * it is what arms the checkout machine's price-integrity guard: if the live cart has moved on,
 * `submitOrderBlock` returns `CART_CHANGED` before any payment or order write. Callers must pass
 * the version they actually rendered — reading it fresh here would compare the live cart against
 * itself and guarantee a match, which is the guard defeating itself.
 *
 * It is optional only because the machine treats it as optional (`!= null`), and omitting it is a
 * deliberate "submit whatever is current" — used by scripts, not by the shopper path. Backlog #17
 * (run -009 F-2) was exactly this: the review page omitted it, so the guard existed but could
 * never fire from the one surface it protects, and an order placed against an unacknowledged
 * cart change looked identical to a clean one.
 */
/**
 * Does the visitor still hold the identity this cart was placed under?
 *
 * The cart cookie is the journey's credential, and sign-out does not touch it — so a
 * signed-out browser could place an order that landed attributed to the linked shopper
 * (backlog #16, run -009 F-1). GUEST CHECKOUT IS NOT THE BUG: a cart with no `userId` is a
 * genuine guest cart and must check out without a session, which is why the gate keys on the
 * cart's own linkage rather than on the presence of a session.
 *
 * Post-#11 (`fc37ba9`) every cart created while signed in is linked at the creation seam, so
 * this covers essentially all signed-in journeys.
 *
 * Returns null when the submit may proceed, or the reason it may not. Signing in as a
 * DIFFERENT shopper is refused for the same reason as signing out: the order would be
 * attributed to someone who is not at the keyboard.
 */
async function checkoutIdentityRefusal(
  cartId: string,
): Promise<'SIGNED_OUT' | 'SIGNED_IN_AS_OTHER' | null> {
  const cart = await getCart(cartId);
  if (!cart?.userId) return null; // genuine guest cart — sessionless checkout is the feature
  const shopper = await getSignedInShopper();
  if (!shopper) return 'SIGNED_OUT';
  return shopper.id === cart.userId ? null : 'SIGNED_IN_AS_OTHER';
}

export async function submitOrder(
  cartId: string,
  reviewedCartVersion?: number,
): Promise<Cart.CheckoutState | null> {
  const checkoutWfId = await getCheckoutWorkflowId(cartId);
  if (!checkoutWfId) return null;

  // The credential boundary is HERE, in the action — not in the button. A hidden or disabled
  // Place Order is a courtesy; this is the check that actually holds, and it runs before the
  // update reaches the workflow so no payment or order write is attempted (#16).
  const refusal = await checkoutIdentityRefusal(cartId);
  if (refusal) {
    log.warn({ cartId, refusal }, 'checkout refused: identity mismatch');
    const current = await getCheckoutState(cartId);
    return { ...(current ?? ({} as Cart.CheckoutState)), error: refusal };
  }
  const state = (await executeCheckoutUpdate(checkoutWfId, Checkout.submitOrderUpdate, [
    { reviewedCartVersion },
  ])) as Cart.CheckoutState | null;

  if (state?.step === 'complete') {
    // Through retireCartCookie, NOT a bare delete: its same-cart guard means an older tab
    // completing checkout cannot clear a NEWER cart's cookie (the two-tab hazard c6d278d
    // guarded at the other clear sites — this one predated it), and it retires the journey
    // correlation cookie alongside (ADR-0031).
    await retireCartCookie(cartId, 'checkout complete');
  }

  return state;
}

export async function cancelCheckout(cartId: string): Promise<Cart.CheckoutState | null> {
  const checkoutWfId = await getCheckoutWorkflowId(cartId);
  if (!checkoutWfId) return null;
  return executeCheckoutUpdate(checkoutWfId, Checkout.cancelCheckoutUpdate, [
    {},
  ]) as Promise<Cart.CheckoutState | null>;
}

export async function getCheckoutState(cartId: string): Promise<Cart.CheckoutState | null> {
  const checkoutWfId = await getCheckoutWorkflowId(cartId);
  if (checkoutWfId) {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(checkoutWfId);
    try {
      return await handle.query(Checkout.getCheckoutStateQuery);
    } catch {
      // fall through
    }
  }
  try {
    const client = await getTemporalClient();
    const cartHandle = client.workflow.getHandle(buildWorkflowId(DEMO_STORE_ID, 'cart', cartId));
    return await cartHandle.query(Cart.getCheckoutStateQuery);
  } catch {
    return null;
  }
}

export async function acknowledgeCartChange(
  cartId: string,
  cartVersion: number,
): Promise<Cart.CheckoutState | null> {
  const checkoutWfId = await getCheckoutWorkflowId(cartId);
  if (!checkoutWfId) return null;
  return executeCheckoutUpdate(checkoutWfId, Checkout.acknowledgeCartChangeUpdate, [
    { cartVersion },
  ]) as Promise<Cart.CheckoutState | null>;
}
