'use client';

import {
  addItemToCart,
  beginCheckout,
  getCart,
  getCartId,
  getOrCreateCartId,
  removeFromCart,
  updateItemQuantity,
} from '@/app/shop/cart-actions';
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { Cart } from '@/temporal/contracts';

interface CartContextType {
  cartId: string | null;
  cart: Cart.CartDetails | null;
  /**
   * Has the initial cart lookup FINISHED? `cart === null` means two different things —
   * "not looked yet" and "there is no active cart" — and a page that cannot tell them apart
   * renders a spinner forever for the second. That is backlog #12: a terminal cart is
   * deliberately not adopted (see below), so after any completed order the review page sat on
   * "Loading review…" with no redirect and no message.
   *
   * `loading` is NOT this: it tracks in-flight mutations (add/remove/update), not the initial
   * resolution. Guard "there is no cart" branches on `resolved`, never on `loading`.
   */
  resolved: boolean;
  loading: boolean;
  error: string | null;
  addItem: (sku: string, quantity: number, price: number) => Promise<void>;
  removeItem: (lineItemId: string) => Promise<void>;
  updateQuantity: (lineItemId: string, quantity: number) => Promise<void>;
  checkoutCart: () => Promise<void>;
  refreshCart: () => Promise<void>;
  clearCart: () => void;
  clearError: () => void;
}

const CartContext = createContext<CartContextType | undefined>(undefined);

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [cartId, setCartId] = useState<string | null>(null);
  const [cart, setCart] = useState<Cart.CartDetails | null>(null);
  const [resolved, setResolved] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearError = useCallback(() => setError(null), []);

  // Initialize cart ID from cookie on mount. No cookie means resolution is already finished
  // and the answer is "no cart" — the completed-order path deletes it (see cart-actions).
  useEffect(() => {
    getCartId().then((id) => {
      if (id) setCartId(id);
      else setResolved(true);
    });
  }, []);

  // Fetch cart when cartId is set. A TERMINAL cart is deliberately not adopted: `cart` is the
  // ACTIVE cart, and completed/abandoned/failed ones must not keep driving shopping UI. Either
  // way the lookup is finished, so `resolved` flips — that is what lets a page say "there is no
  // cart" instead of spinning (#12).
  useEffect(() => {
    if (cartId) {
      getCart(cartId)
        .then((cartData) => {
          if (cartData && !['completed', 'abandoned', 'failed'].includes(cartData.status)) {
            setCart(cartData);
          }
        })
        .finally(() => setResolved(true));
    }
  }, [cartId]);

  const refreshCart = useCallback(async () => {
    if (!cartId) return;
    const cartData = await getCart(cartId);
    if (cartData && !['completed', 'abandoned', 'failed'].includes(cartData.status)) {
      setCart(cartData);
    } else {
      setCart(null);
    }
  }, [cartId]);

  const addItem = async (sku: string, quantity: number, price: number) => {
    setLoading(true);
    setError(null);
    try {
      const id = cartId || (await getOrCreateCartId());
      if (!id) {
        setError('Unable to create cart.');
        return;
      }
      if (!cartId) setCartId(id);

      const newCart = await addItemToCart(id, sku, quantity, price);
      if (newCart) {
        setCart(newCart);
      } else {
        setError('Failed to add item to cart. Please try again.');
      }
    } catch (err) {
      setError(messageForShopper(err));
    } finally {
      setLoading(false);
    }
  };

  /**
   * Adopt an edit result: an abandoned/emptied cart (its workflow reached terminal)
   * or a missing result clears local cart state; otherwise the new cart is applied.
   */
  /**
   * What to put in front of the shopper when a cart action throws (mono #242).
   *
   * A real sentence from the domain beats a generic one every time; the generic line is reserved
   * for the case where there genuinely is no message — which is what a transport failure looks
   * like. `executeCartUpdate` now unwraps the decider's own sentence out of Temporal's
   * `WorkflowUpdateFailedError`, so this no longer guesses from substrings — and no longer
   * reports a deliberate refusal as a connectivity problem. (The mono's run 013: a shopper whose
   * edit was refused with "Order is being placed — please wait" was told the service was
   * unreachable, retried, and produced a triple charge.)
   */
  const messageForShopper = (err: unknown): string => {
    const message = err instanceof Error ? err.message : String(err);
    if (!message || /^workflow update failed/i.test(message) || /fetch failed/i.test(message)) {
      return 'Unable to connect to cart service. Please try again.';
    }
    return message;
  };

  const adoptEditedCart = (newCart: Awaited<ReturnType<typeof removeFromCart>>) => {
    if (newCart && newCart.status !== 'abandoned' && newCart.items.length > 0) {
      setCart(newCart);
    } else {
      setCart(null);
      setCartId(null);
    }
  };

  const removeItem = async (lineItemId: string) => {
    if (!cartId) return;
    setLoading(true);
    setError(null);
    try {
      adoptEditedCart(await removeFromCart(cartId, lineItemId));
    } catch (err) {
      setError(messageForShopper(err));
    } finally {
      setLoading(false);
    }
  };

  const updateQuantity = async (lineItemId: string, quantity: number) => {
    if (!cartId) return;
    setLoading(true);
    setError(null);
    try {
      adoptEditedCart(await updateItemQuantity(cartId, lineItemId, quantity));
    } catch (err) {
      setError(messageForShopper(err));
    } finally {
      setLoading(false);
    }
  };

  const checkoutCart = async () => {
    if (!cartId) return;
    setLoading(true);
    try {
      const newCart = await beginCheckout(cartId);
      if (newCart && newCart.status === 'checkout') {
        setCart(newCart);
        // Navigate to checkout flow — the status is now 'checkout'
      } else if (newCart && newCart.status === 'completed') {
        setCart(null);
        setCartId(null);
      }
    } finally {
      setLoading(false);
    }
  };

  const clearCart = useCallback(() => {
    setCart(null);
    setCartId(null);
    // Resolution stands: we KNOW there is no cart now. Leaving this false would put the
    // checkout pages back into "still loading" and reintroduce #12 after every order.
    setResolved(true);
  }, []);

  return (
    <CartContext.Provider
      value={{
        cartId,
        cart,
        resolved,
        loading,
        error,
        addItem,
        removeItem,
        updateQuantity,
        checkoutCart,
        refreshCart,
        clearCart,
        clearError,
      }}
    >
      {children}
    </CartContext.Provider>
  );
}

export function useCart() {
  const context = useContext(CartContext);
  if (context === undefined) {
    throw new Error('useCart must be used within a CartProvider');
  }
  return context;
}
