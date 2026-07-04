/**
 * Cart logic — pure, infrastructure-free helpers shared by the decider and shell.
 * No I/O, no clock, no id generation, no Temporal imports (repo test policy:
 * unit-testable as plain functions). Line-item ids are generated in the shell
 * (`states.ts` prepare) and injected via the decider command.
 */
import type { CartDetails, CartItem, CheckoutWorkflowInput } from './types';

/** Recalculate subtotal / discounts / tax / total from the cart's items and coupons. */
export function recalculateTotals(cart: CartDetails): void {
  cart.subtotalPrice = cart.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  cart.totalDiscounts = 0;
  if (cart.appliedCoupons.includes('SAVE20')) {
    cart.totalDiscounts = cart.subtotalPrice * 0.2;
  }
  cart.totalTax = (cart.subtotalPrice - cart.totalDiscounts) * 0.08;
  cart.totalPrice = cart.subtotalPrice - cart.totalDiscounts + cart.shippingCost + cart.totalTax;
}

/**
 * Add an item to the cart, merging by variantId (quantity sums rather than duplicating
 * the line). Mutates the passed cart; the decider's `evolve` owns the copy.
 */
export function addItem(cart: CartDetails, item: CartItem): void {
  const existing = cart.items.find((i) => i.variantId === item.variantId);
  if (existing) {
    existing.quantity += item.quantity;
  } else {
    cart.items.push({ ...item });
  }
  recalculateTotals(cart);
}

/** Deep-copy just the cart for immutability. */
export function copyCart(cart: CartDetails): CartDetails {
  return {
    ...cart,
    items: cart.items.map((i) => ({ ...i })),
    appliedCoupons: [...cart.appliedCoupons],
  };
}

/** Build the checkout child workflow's input from the current cart. */
export function buildCheckoutInput(
  cart: CartDetails,
  parentCartWorkflowId: string,
): Omit<CheckoutWorkflowInput, 'checkoutVersion'> {
  return {
    cartId: cart.cartId,
    parentCartWorkflowId,
    items: cart.items,
    subtotalPrice: cart.subtotalPrice,
    totalDiscounts: cart.totalDiscounts,
    currency: cart.currency,
    appliedCoupons: cart.appliedCoupons,
    isGuest: !cart.userId,
    cartVersion: cart.cartVersion,
  };
}
