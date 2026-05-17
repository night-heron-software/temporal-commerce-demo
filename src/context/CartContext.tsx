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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearError = useCallback(() => setError(null), []);

  // Initialize cart ID from cookie on mount
  useEffect(() => {
    getCartId().then((id) => {
      if (id) setCartId(id);
    });
  }, []);

  // Fetch cart when cartId is set
  useEffect(() => {
    if (cartId) {
      getCart(cartId).then((cartData) => {
        if (cartData && !['completed', 'abandoned', 'failed'].includes(cartData.status)) {
          setCart(cartData);
        }
      });
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
    } catch {
      setError('Unable to connect to cart service. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const removeItem = async (lineItemId: string) => {
    if (!cartId) return;
    setLoading(true);
    setError(null);
    try {
      const newCart = await removeFromCart(cartId, lineItemId);
      if (newCart) {
        if (newCart.status === 'abandoned' || newCart.items.length === 0) {
          setCart(null);
          setCartId(null);
        } else {
          setCart(newCart);
        }
      } else {
        setCart(null);
        setCartId(null);
      }
    } catch {
      setError('Unable to connect to cart service. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const updateQuantity = async (lineItemId: string, quantity: number) => {
    if (!cartId) return;
    setLoading(true);
    setError(null);
    try {
      const newCart = await updateItemQuantity(cartId, lineItemId, quantity);
      if (newCart) {
        if (newCart.status === 'abandoned' || newCart.items.length === 0) {
          setCart(null);
          setCartId(null);
        } else {
          setCart(newCart);
        }
      } else {
        setCart(null);
        setCartId(null);
      }
    } catch {
      setError('Unable to connect to cart service. Please try again.');
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
  }, []);

  return (
    <CartContext.Provider
      value={{
        cartId,
        cart,
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
