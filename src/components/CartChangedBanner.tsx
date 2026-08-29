'use client';

import { useCart } from '@/context/CartContext';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { acknowledgeCartChange, getCheckoutState } from '@/app/shop/cart-actions';
import type { Cart } from '@/temporal/contracts';
import { hasUnacknowledgedCartChange } from '@/temporal/contracts/cart';
import { cartLineLabel } from '@/app/shop/cart-line-display';

/**
 * Banner shown during checkout when the cart has been modified since the shopper last
 * approved it (cart.cartVersion vs the CHECKOUT's cartVersionAcknowledged).
 *
 * Remediation R3 (backlog #3, F5+F6): the bounce back to payment is treated as an event
 * to be EXPLAINED, not a redirect to be survived —
 * - reads the acknowledged version from the LIVE checkout state (`getCheckoutState`),
 *   not the cart query's `checkout` snapshot — the cart workflow initializes that
 *   snapshot to undefined and never mirrors the live ack, so the previous banner's
 *   guard was never true and it was DEAD CODE on every page it was mounted on (why
 *   F5/F6's operator saw no messaging at all);
 * - names what changed line by line ("Bald Eagle Portrait — M / Royal Blue: quantity
 *   1 → 2") by diffing against a snapshot of the last-approved cart (sessionStorage,
 *   captured whenever the cart is in its approved state), using the R1 display snapshot
 *   for human names;
 * - shows the previous vs new total;
 * - polls both while mounted (the recompute nudge lands server-side; without a poll the
 *   page learns about it only on reload — F5's half of the gap).
 */

const POLL_MS = 3000;

interface ApprovedSnapshot {
  cartVersion: number;
  totalPrice: number;
  items: Array<{
    lineItemId: string;
    label: string;
    quantity: number;
  }>;
}

function snapshotKey(cartId: string) {
  return `approved-cart-${cartId}`;
}

// One fallback rule for line identity (cart-line-display.ts): `Variant <id>`, never
// `SKU <id>` — a variantId is not a sku (mono #252 Phase 5a).
const itemLabel = (item: Cart.CartItem): string => cartLineLabel(item);

function buildSnapshot(cart: Cart.CartDetails): ApprovedSnapshot {
  return {
    cartVersion: cart.cartVersion,
    totalPrice: cart.totalPrice,
    items: cart.items.map((i) => ({
      lineItemId: i.lineItemId,
      label: itemLabel(i),
      quantity: i.quantity,
    })),
  };
}

/** Human lines describing old → new, by lineItemId. */
function diffLines(prev: ApprovedSnapshot, cart: Cart.CartDetails): string[] {
  const lines: string[] = [];
  const prevById = new Map(prev.items.map((i) => [i.lineItemId, i]));
  const nowById = new Map(cart.items.map((i) => [i.lineItemId, i]));

  for (const item of cart.items) {
    const before = prevById.get(item.lineItemId);
    if (!before) {
      lines.push(`${itemLabel(item)}: added (× ${item.quantity})`);
    } else if (before.quantity !== item.quantity) {
      lines.push(`${before.label}: quantity ${before.quantity} → ${item.quantity}`);
    }
  }
  for (const before of prev.items) {
    if (!nowById.has(before.lineItemId)) {
      lines.push(`${before.label}: removed`);
    }
  }
  return lines;
}

export function CartChangedBanner() {
  const { cart, cartId, refreshCart } = useCart();
  const router = useRouter();
  const [dismissing, setDismissing] = useState(false);
  const [checkoutState, setCheckoutState] = useState<Cart.CheckoutState | null>(null);

  // Poll cart + LIVE checkout state while mounted so a recompute lands here without a
  // manual reload (F5). The acknowledged version lives only on the checkout child.
  useEffect(() => {
    if (!cartId) return;
    let cancelled = false;
    const tick = () => {
      refreshCart();
      getCheckoutState(cartId).then((state) => {
        if (!cancelled) setCheckoutState(state ?? null);
      });
    };
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [cartId, refreshCart]);

  const inCheckout = !!cart && !!cartId && cart.status === 'checkout' && checkoutState !== null;

  // Both numbers come from the CHECKOUT state — one workflow, one RPC, one authority
  // (`asCheckoutState` projects the version this checkout priced). Comparing the cart query's
  // live version against the checkout's acknowledged baseline raced two workflows read by two
  // independent RPCs, so any timing gap between them read as a content change.
  const changed = inCheckout && hasUnacknowledgedCartChange(checkoutState);
  const currentVersion = checkoutState?.cartVersion ?? cart?.cartVersion ?? 0;

  // While the cart is in its APPROVED state, keep a snapshot to diff against later.
  useEffect(() => {
    if (inCheckout && !changed && cart) {
      try {
        sessionStorage.setItem(snapshotKey(cart.cartId), JSON.stringify(buildSnapshot(cart)));
      } catch {
        // storage unavailable — the banner degrades to its generic message
      }
    }
  }, [inCheckout, changed, cart]);

  if (!inCheckout || !changed || !cart || !cartId) {
    return null;
  }

  let prev: ApprovedSnapshot | null = null;
  try {
    const raw = sessionStorage.getItem(snapshotKey(cartId));
    prev = raw ? (JSON.parse(raw) as ApprovedSnapshot) : null;
  } catch {
    prev = null;
  }
  const changes = prev ? diffLines(prev, cart) : [];
  const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  async function handleDismiss() {
    if (!cartId) return;
    setDismissing(true);
    try {
      await acknowledgeCartChange(cartId, currentVersion);
      // Clear now, not on the next poll tick.
      setCheckoutState((prev) =>
        prev ? { ...prev, cartVersionAcknowledged: currentVersion } : prev,
      );
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
        {changes.length > 0 ? (
          <ul className="text-xs text-[var(--heron-gray-dark)] dark:text-[var(--heron-gray)] mt-1 space-y-0.5 list-disc list-inside">
            {changes.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-[var(--heron-gray-dark)] dark:text-[var(--heron-gray)] mt-1">
            Items in your cart have changed since you approved payment.
          </p>
        )}
        <p className="text-xs font-medium text-[var(--heron-slate-dark)] dark:text-[var(--heron-cream)] mt-1.5">
          {prev && prev.totalPrice !== cart.totalPrice
            ? `Total: ${fmt(prev.totalPrice)} → ${fmt(cart.totalPrice)}`
            : `Total: ${fmt(cart.totalPrice)}`}
        </p>
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
