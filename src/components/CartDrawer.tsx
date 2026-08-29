'use client';

import { useCart } from '@/context/CartContext';
import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { beginCheckout } from '@/app/shop/cart-actions';
import { destinationFor } from '@/app/shop/checkout/checkout-routing';
import { cartLineTitle } from '@/app/shop/cart-line-display';
import { IdChip } from '@/components/EntityIds';

interface CartDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CartDrawer({ isOpen, onClose }: CartDrawerProps) {
  const { cart, cartId, removeItem, updateQuantity, loading, error, clearError } = useCart();
  const router = useRouter();
  const pathname = usePathname();
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  // Hide cart on checkout pages
  const isCheckoutPage = pathname?.startsWith('/shop/checkout');

  // Close drawer when cart becomes empty
  useEffect(() => {
    if (!cart || cart.items.length === 0) {
      onClose();
    }
  }, [cart, onClose]);

  // Don't render on checkout pages
  if (isCheckoutPage || !isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Drawer Panel */}
      <div className="relative w-full max-w-md bg-zinc-900 h-full shadow-2xl flex flex-col overflow-hidden border-l border-zinc-700">
        {/* Header */}
        <div className="flex justify-between items-center p-6 border-b border-zinc-700">
          <h2 className="text-2xl font-bold text-white">Your Cart</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-white transition-colors">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="w-6 h-6"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Cart Items */}
        <div className="flex-1 overflow-y-auto p-6">
          {!cart || cart.items.length === 0 ? (
            <div className="text-center text-zinc-400 py-12">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                className="w-16 h-16 mx-auto mb-4 opacity-50"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 00-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 00-16.536-1.84M7.5 14.25L5.106 5.272M6 20.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm12.75 0a.75.75 0 11-1.5 0 .75.75 0 011.5 0z"
                />
              </svg>
              <p>Your cart is empty</p>
            </div>
          ) : (
            <div className="space-y-4">
              {/*
                A checkout is live. Say so BEFORE the shopper edits, not after — an edit here is
                real, and the checkout will ask the shopper to re-approve the new totals (the
                parent platform's run-015 OB#2: the old warn-at-mutation modal arrived unannounced).
              */}
              {cart.status === 'checkout' && cart.checkout?.step !== 'failed' && (
                <div className="bg-[var(--heron-gold)]/20 border border-[var(--heron-gold)] rounded-xl p-3">
                  <p className="text-sm font-semibold text-white">
                    You have a checkout in progress
                  </p>
                  <p className="text-xs text-zinc-400 mt-1">
                    Changes you make here will update it — you&apos;ll be asked to review the new
                    total before placing the order.
                  </p>
                </div>
              )}

              {/* Checkout failure recovery: the failure is otherwise visible only in checkout
                  state nobody polls once the shopper is back on the shop. */}
              {cart.checkout?.step === 'failed' && cart.checkout?.error && (
                <div className="bg-red-900/30 border border-red-700 rounded-xl p-4">
                  <div className="flex items-start gap-3">
                    <div className="flex-1">
                      <p className="text-red-300 text-sm font-medium mb-1">
                        Checkout could not proceed
                      </p>
                      <p className="text-red-400/80 text-xs">{cart.checkout.error}</p>
                      <p className="text-zinc-400 text-xs mt-2">
                        Remove the unavailable items from your cart, then try checkout again.
                      </p>
                    </div>
                    <button
                      onClick={clearError}
                      className="text-zinc-500 hover:text-zinc-300 transition-colors p-1 flex-shrink-0"
                      title="Dismiss"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              )}

              {/* Generic cart error from the context (mutation failures surface here, in the
                  drawer the shopper is looking at, not only in a console). */}
              {error && cart.checkout?.step !== 'failed' && (
                <div className="bg-red-900/30 border border-red-700 rounded-xl p-3 flex items-start justify-between gap-2">
                  <p className="text-red-300 text-xs">{error}</p>
                  <button
                    onClick={clearError}
                    className="text-zinc-500 hover:text-zinc-300 flex-shrink-0"
                    title="Dismiss"
                  >
                    ✕
                  </button>
                </div>
              )}

              {cart.items.map((item) => (
                <div
                  key={item.lineItemId}
                  className="bg-zinc-800 rounded-xl p-4 border border-zinc-700"
                >
                  <div className="flex justify-between items-start mb-3">
                    <div className="flex gap-3 min-w-0">
                      {item.thumbnailUrl && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={item.thumbnailUrl}
                          alt={item.productTitle ?? ''}
                          className="w-12 h-12 rounded-lg object-cover border border-zinc-700 flex-shrink-0"
                        />
                      )}
                      <div className="min-w-0">
                        {/* Product identity from the add-to-cart snapshot; a line without one
                            falls back to its variantId — visibly, and labelled for what it is:
                            `Variant <id>`, never `SKU: <id>` (a variantId is not a sku). The
                            fallback rule lives in cart-line-display.ts so this surface and the
                            checkout summaries cannot diverge again (mono #252 Phase 5a). */}
                        <h3 className="font-medium text-white text-sm truncate max-w-[200px]">
                          {cartLineTitle(item)}
                        </h3>
                        {item.variantTitle && (
                          <p className="text-zinc-400 text-xs truncate max-w-[200px]">
                            {item.variantTitle}
                          </p>
                        )}
                        <p className="text-purple-400 font-semibold">
                          ${(item.price / 100).toFixed(2)}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => removeItem(item.lineItemId)}
                      className="text-red-400 hover:text-red-300 transition-colors p-1"
                      disabled={loading}
                      title="Remove item"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        fill="none"
                        viewBox="0 0 24 24"
                        strokeWidth={1.5}
                        stroke="currentColor"
                        className="w-5 h-5"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"
                        />
                      </svg>
                    </button>
                  </div>

                  {/* Quantity Controls */}
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => updateQuantity(item.lineItemId, item.quantity - 1)}
                      className="w-8 h-8 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-white flex items-center justify-center transition-colors disabled:opacity-50"
                      disabled={loading}
                    >
                      −
                    </button>
                    <span className="w-8 text-center text-white font-medium">{item.quantity}</span>
                    <button
                      onClick={() => updateQuantity(item.lineItemId, item.quantity + 1)}
                      className="w-8 h-8 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-white flex items-center justify-center transition-colors disabled:opacity-50"
                      disabled={loading}
                    >
                      +
                    </button>
                    <span className="ml-auto text-zinc-400 text-sm">
                      ${((item.price * item.quantity) / 100).toFixed(2)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer with Totals */}
        {cart && cart.items.length > 0 && (
          <div className="border-t border-zinc-700 p-6 space-y-3 bg-zinc-800/50">
            <div className="flex justify-between text-zinc-400">
              <span>Subtotal</span>
              <span>${(cart.subtotalPrice / 100).toFixed(2)}</span>
            </div>
            {cart.totalDiscounts > 0 && (
              <div className="flex justify-between text-green-400">
                <span>Discount</span>
                <span>-${(cart.totalDiscounts / 100).toFixed(2)}</span>
              </div>
            )}
            {/*
              No tax and no shipping here, deliberately: BOTH are address-derived, and a cart has
              no address. The cart's own `totalTax` is a flat pre-address estimate and
              `cart.totalPrice` folds it in, which is how a drawer comes to print one figure while
              the checkout the shopper is standing in says another (the parent platform's run-016
              Defect #5). A cart can only honestly total what it holds; the checkout owns the rest.
            */}
            <div className="flex justify-between text-xl font-bold text-white pt-2 border-t border-zinc-700">
              <span>Total</span>
              <span>${((cart.subtotalPrice - cart.totalDiscounts) / 100).toFixed(2)}</span>
            </div>
            <p className="text-sm text-zinc-500 italic">Shipping and tax calculated at checkout</p>

            {/* The cartId is the ENTITY key — since ADR-0031 the journey correlationId is its
                own UUID again (carried on cart.correlationId, minted at cart creation). The
                cartId stays the value diagnostics key off: `temporal workflow describe
                demo.cart.<id>`,
                an inventory_history query, a validation station, a bug report. Surfacing it
                here is deliberate — this repo's shopper surface is developer-facing, and the
                alternative was fishing the id out of a cookie by hand (backlog #9, raised
                mid-run in validation session -008). Reuses R2's IdChip so the copy affordance
                behaves identically to the admin ones; the palette is passed explicitly
                because the drawer is unconditionally dark and IdChip's default is not. */}
            {cartId && (
              <div className="flex justify-between items-baseline gap-2 pt-1">
                <span className="text-zinc-500 text-xs shrink-0">Cart</span>
                <IdChip
                  value={cartId}
                  className="bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 border border-zinc-700"
                />
              </div>
            )}
            {checkoutError && (
              <div className="text-red-400 text-sm text-center">{checkoutError}</div>
            )}
            <button
              onClick={async () => {
                if (!cartId) return;
                setCheckoutLoading(true);
                setCheckoutError(null);
                try {
                  const updatedCart = await beginCheckout(cartId);
                  const destination = destinationFor(updatedCart?.checkout);
                  if (
                    (updatedCart?.checkout?.step === 'shipping' ||
                      updatedCart?.checkout?.step === 'validating') &&
                    destination
                  ) {
                    // Derived from the state the update just returned (mono-issue-0318).
                    router.push(destination);
                    onClose();
                  } else if (updatedCart?.checkout?.error) {
                    setCheckoutError(updatedCart.checkout.error);
                  } else {
                    setCheckoutError('Unable to start checkout. Please try again.');
                  }
                } catch {
                  setCheckoutError('Unable to start checkout. Please try again.');
                } finally {
                  setCheckoutLoading(false);
                }
              }}
              disabled={loading || checkoutLoading}
              className="w-full mt-4 bg-green-600 hover:bg-green-500 text-white py-4 rounded-xl font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {checkoutLoading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                      fill="none"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                  Processing...
                </span>
              ) : (
                'Checkout'
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
