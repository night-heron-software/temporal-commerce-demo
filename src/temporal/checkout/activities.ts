/**
 * Checkout Activities
 * Activity proxies for workflow use
 */

import { proxyActivities } from '@temporalio/workflow';
import { Cart } from '../contracts';
export type CartItem = Cart.CartItem;
export type Order = Cart.Order;

export interface ReservationInfo {
  variantId: string;
  reservationId: string;
}

export interface CreateOrderInput {
  cartId: string;
  items: CartItem[];
  shippingAddress: Cart.ShippingAddress;
  paymentMethod: Cart.PaymentMethod;
  subtotal: number;
  shippingCost: number;
  tax: number;
  totalDiscounts: number;
  total: number;
  currency: string;
}

export interface CheckoutActivities {
  createPaymentIntent(
    amount: number,
    currency: string
  ): Promise<{ clientSecret: string; id: string }>;
  verifyPayment(paymentIntentId: string): Promise<boolean>;
  calculateShipping(address: string): Promise<number>;
  calculateTax(state: string, subtotal: number): Promise<number>;
  processPayment(token: string, amount: number, currency: string, idempotencyKey?: string): Promise<boolean>;
  createOrder(input: CreateOrderInput): Promise<Order>;
  sendConfirmationEmail(email: string, confirmationNumber: string, order: Order): Promise<void>;
  startOrderManagementWorkflow(order: Order, customerEmail: string): Promise<string>;
  renewReservationsForCheckout(
    cartId: string,
    items: CartItem[]
  ): Promise<{
    success: boolean;
    reservations: ReservationInfo[];
    unavailableItems?: Array<{ variantId: string; error: string }>;
    error?: string;
  }>;
  confirmReservations(reservations: ReservationInfo[]): Promise<void>;
  releaseReservations(reservations: ReservationInfo[]): Promise<void>;
  cancelReservations(reservations: ReservationInfo[]): Promise<void>;
}

// Payment activities: non-retryable for permanent failures (declined cards, invalid tokens)
export const {
  createPaymentIntent,
  verifyPayment,
  processPayment
} = proxyActivities<CheckoutActivities>({
  startToCloseTimeout: '1m',
  retry: {
    maximumAttempts: 3,
    initialInterval: '1s',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ['PaymentDeclinedError', 'InvalidCardError', 'InsufficientFundsError']
  }
});

// Email activities: longer timeout for external Mailgun API
export const {
  sendConfirmationEmail
} = proxyActivities<CheckoutActivities>({
  startToCloseTimeout: '2m',
  retry: {
    maximumAttempts: 3,
    initialInterval: '1s',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ['InvalidRecipientError']
  }
});

// General checkout activities: calculations, order creation, reservations, OMS start
export const {
  calculateShipping,
  calculateTax,
  createOrder,
  startOrderManagementWorkflow,
  renewReservationsForCheckout,
  confirmReservations,
  releaseReservations,
  cancelReservations
} = proxyActivities<CheckoutActivities>({
  startToCloseTimeout: '1m',
  retry: {
    maximumAttempts: 3,
    initialInterval: '1s',
    backoffCoefficient: 2
  }
});
