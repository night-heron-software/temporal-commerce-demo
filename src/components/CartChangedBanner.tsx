'use client';

import { useCart } from '@/context/CartContext';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { acknowledgeCartChange, getCheckoutState } from '@/app/shop/cart-actions';
import type { Cart } from '@/temporal/contracts';
import { hasUnacknowledgedCartChange } from '@/temporal/contracts/cart';
import {
  approvedCartSnapshotKey,
  buildApprovedCartSnapshot,
  computeCartDiff,
  type ApprovedCartSnapshot,
} from './cart-change-diff';

const POLL_MS = 3000;

// sessionStorage wrappers — the diff math itself is pure and lives (tested) in cart-change-diff.
// Storage failure in either direction degrades to the generic banner copy, never throws.
function writeApprovedSnapshot(
  cartId: string,
  cart: Pick<Cart.CartDetails, 'items' | 'subtotalPrice' | 'totalDiscounts'>,
  checkout: Pick<Cart.CheckoutState, 'shippingCost' | 'tax'>,
): void {
  try {
    sessionStorage.setItem(
      approvedCartSnapshotKey(cartId),
      JSON.stringify(buildApprovedCartSnapshot(cart, checkout)),
    );
  } catch {
    // storage unavailable — the banner falls back to its generic message
  }
}

function readApprovedSnapshot(cartId: string): ApprovedCartSnapshot | null {
  try {
    const raw = sessionStorage.getItem(approvedCartSnapshotKey(cartId));
    return raw ? (JSON.parse(raw) as ApprovedCartSnapshot) : null;
  } catch {
    return null;
  }
}

/**
 * Banner shown during checkout when the cart changed since the shopper approved these totals.
 *
 * Both numbers it compares are CHECKOUT-owned (`hasUnacknowledgedCartChange`): the version this
 * checkout priced and the version the shopper approved, one workflow, one RPC. Comparing the
 * cart query's live version against a checkout baseline raced two workflows and read any timing
 * gap as a content change.
 *
 * Callers that already hold the checkout state pass it in; a page with none on mount falls back
 * to fetching (and polls, since the recompute nudge lands server-side and nothing would
 * otherwise tell the page).
 *
 * When it fires it EXPLAINS the change (remediation R3): while the checkout is quiet the banner
 * keeps a `sessionStorage` snapshot of the approved cart, and on fire it names what moved line
 * by line ("<title> — <variant>: quantity 1 → 2") plus old → new totals via `computeCartDiff`.
 * No snapshot yet — first fire of the session — degrades to the generic copy.
 */
export function CartChangedBanner({
  checkoutState,
}: {
  checkoutState?: Cart.CheckoutState | null;
}) {
  const { cart, cartId, refreshCart } = useCart();
  const router = useRouter();
  const [dismissing, setDismissing] = useState(false);
  const [fetched, setFetched] = useState<Cart.CheckoutState | null>(null);
  // What this session acknowledged. Needed because a parent that SUPPLIES the state owns its
  // own refresh cadence — a page may fetch once on mount — so without a local record the banner
  // would keep rendering after a successful dismiss until the page reloaded.
  const [dismissedVersion, setDismissedVersion] = useState<number | null>(null);

  const supplied = checkoutState !== undefined;
  const state = supplied ? checkoutState : fetched;

  useEffect(() => {
    if (supplied || !cartId) return;
    let cancelled = false;
    const tick = () => {
      getCheckoutState(cartId).then((s) => {
        if (!cancelled) setFetched(s);
      });
    };
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [supplied, cartId]);

  const changed = hasUnacknowledgedCartChange(state);

  // The diff's "after" side is built from the CART (below); the watcher above refreshes only the
  // CHECKOUT state. Without this, a banner raised by a second-tab edit diffs fresh checkout
  // numbers against a stale cart — no line entries at all (so it degrades to the generic copy)
  // and a total that moves only by the shipping/tax delta, which is a WRONG NUMBER shown to a
  // shopper (the parent platform's run-016 Defect #3). Refresh once per raised version rather
  // than on every tick: the cart is only stale when the banner is actually firing, and
  // re-polling it every 3s would be load for nothing.
  const refreshedForVersion = useRef<number | null>(null);
  useEffect(() => {
    const version = state?.cartVersion ?? null;
    if (!changed || version === null) return;
    if (refreshedForVersion.current === version) return;
    refreshedForVersion.current = version;
    void refreshCart();
  }, [changed, state?.cartVersion, refreshCart]);

  // While the checkout is QUIET, keep the approved-cart snapshot fresh — this is the "before"
  // side of the diff shown when the banner later fires. Written on every quiet render rather
  // than once so it always describes the most recently approved cart.
  useEffect(() => {
    if (!cartId || !cart || !state || changed) return;
    writeApprovedSnapshot(cartId, cart, state);
  }, [cartId, cart, state, changed]);

  if (!cartId || !changed) return null;

  const currentVersion = state!.cartVersion!;
  if (dismissedVersion !== null && dismissedVersion >= currentVersion) return null;

  // The explanation: approved snapshot (if this session captured one) vs the cart as it stands.
  const diff = cart
    ? computeCartDiff(readApprovedSnapshot(cartId), buildApprovedCartSnapshot(cart, state!))
    : null;

  const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  async function handleDismiss() {
    if (!cartId) return;
    setDismissing(true);
    try {
      const updated = await acknowledgeCartChange(cartId, currentVersion);
      // Clear immediately on the version we just acknowledged, whoever owns the state — the
      // self-fetched path also adopts the fresh response so the next poll agrees.
      setDismissedVersion(currentVersion);
      if (updated && !supplied) setFetched(updated);
      // The cart just became the approved cart: re-baseline the snapshot now (optimistically,
      // alongside the version clear) so the next fire diffs against what was acknowledged here.
      if (cart) writeApprovedSnapshot(cartId, cart, updated ?? state!);
      await refreshCart();
    } catch {
      // Non-blocking
    } finally {
      setDismissing(false);
    }
  }

  function handleReturnToCart() {
    router.push('/shop');
  }

  return (
    <div className="bg-[var(--heron-gold)]/20 border border-[var(--heron-gold)] rounded-xl p-4 mb-6 flex items-start gap-3">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={1.5}
        stroke="currentColor"
        className="w-6 h-6 text-[var(--heron-gold-dark)] flex-shrink-0 mt-0.5"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
        />
      </svg>
      <div className="flex-1">
        <p className="text-sm font-semibold text-[var(--heron-slate-dark)] dark:text-[var(--heron-cream)]">
          Your cart changed — please re-confirm payment
        </p>
        {diff && diff.changes.length > 0 ? (
          <ul className="text-xs text-[var(--heron-gray-dark)] dark:text-[var(--heron-gray)] mt-1 space-y-0.5 list-disc list-inside">
            {diff.changes.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : (
          // No snapshot to diff against (first fire this session) or a change the line diff
          // cannot name — the generic copy is the honest fallback.
          <p className="text-xs text-[var(--heron-gray-dark)] dark:text-[var(--heron-gray)] mt-1">
            Items in your cart have changed since you approved payment.
          </p>
        )}
        {diff && (
          <p className="text-xs font-medium text-[var(--heron-slate-dark)] dark:text-[var(--heron-cream)] mt-1.5">
            {diff.totalChanged
              ? `Total: ${fmt(diff.previousTotal)} → ${fmt(diff.currentTotal)}`
              : `Total: ${fmt(diff.currentTotal)}`}
          </p>
        )}
        <div className="flex gap-2 mt-3">
          <button
            onClick={handleReturnToCart}
            className="text-xs font-medium px-3 py-1.5 rounded-lg bg-[var(--heron-slate)] text-white hover:bg-[var(--heron-slate-dark)] transition-colors"
          >
            Review Cart
          </button>
          <button
            onClick={handleDismiss}
            disabled={dismissing}
            className="text-xs font-medium px-3 py-1.5 rounded-lg bg-transparent border border-[var(--heron-gray)] text-[var(--heron-gray-dark)] dark:text-[var(--heron-gray)] hover:bg-[var(--heron-cream-dark)] dark:hover:bg-[var(--heron-slate-dark)] transition-colors disabled:opacity-50"
          >
            {dismissing ? 'Dismissing...' : 'Got it — continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
