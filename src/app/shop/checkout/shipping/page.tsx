'use client';

import { useCart } from '@/context/CartContext';
import { useRouter } from 'next/navigation';
import { useState, useEffect } from 'react';
import { setShippingAddress } from '@/app/shop/cart-actions';
import Link from 'next/link';
import { CartChangedBanner } from '@/components/CartChangedBanner';
import type { Cart } from '@/temporal/contracts';

export default function ShippingPage() {
  const router = useRouter();
  const { cart, cartId, refreshCart } = useCart();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [formData, setFormData] = useState<Cart.ShippingAddress>({
    firstName: '',
    lastName: '',
    address1: '',
    address2: '',
    city: '',
    state: '',
    postalCode: '',
    country: 'US',
    phone: '',
    email: ''
  });

  // Pre-fill from existing checkout data
  useEffect(() => {
    if (cart?.checkout?.shippingAddress) {
      setFormData(cart.checkout.shippingAddress);
    }
  }, [cart?.checkout?.shippingAddress]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cartId) return;

    if (!formData.email?.trim()) {
      setError('Email address is required');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const checkoutState = await setShippingAddress(cartId, formData);
      if (checkoutState?.step === 'payment') {
        await refreshCart();
        router.push('/shop/checkout/payment');
      } else if (checkoutState?.error) {
        setError(checkoutState.error);
      } else if (!checkoutState) {
        setError('Checkout session not found. Please return to cart and try again.');
      }
    } catch {
      setError('Failed to save shipping address');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setFormData((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  if (!cart) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-lg">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100 p-8">
      <div className="max-w-2xl mx-auto">
        <Link href="/shop" className="text-indigo-600 dark:text-indigo-400 hover:underline mb-4 inline-block">
          ← Back to Shop
        </Link>

        <h1 className="text-3xl font-bold mb-6 mt-6">Shipping Address</h1>

        {error && (
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 p-4 rounded-lg mb-6">
            {error}
          </div>
        )}

        <CartChangedBanner />

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">First Name *</label>
              <input
                type="text" name="firstName" value={formData.firstName} onChange={handleChange} required
                autoComplete="shipping given-name"
                className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg p-3 focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">Last Name *</label>
              <input
                type="text" name="lastName" value={formData.lastName} onChange={handleChange} required
                autoComplete="shipping family-name"
                className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg p-3 focus:border-indigo-500 focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">Email *</label>
            <input
              type="email" name="email" value={formData.email} onChange={handleChange} required
              autoComplete="shipping email"
              className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg p-3 focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">Address *</label>
            <input
              type="text" name="address1" value={formData.address1} onChange={handleChange} required
              autoComplete="shipping address-line1"
              className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg p-3 focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">Apartment, suite, etc.</label>
            <input
              type="text" name="address2" value={formData.address2} onChange={handleChange}
              autoComplete="shipping address-line2"
              className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg p-3 focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">City *</label>
              <input
                type="text" name="city" value={formData.city} onChange={handleChange} required
                autoComplete="shipping address-level2"
                className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg p-3 focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">State *</label>
              <input
                type="text" name="state" value={formData.state} onChange={handleChange} required
                placeholder="CA" maxLength={2} autoComplete="shipping address-level1"
                className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg p-3 focus:border-indigo-500 focus:outline-none uppercase"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">ZIP *</label>
              <input
                type="text" name="postalCode" value={formData.postalCode} onChange={handleChange} required
                autoComplete="shipping postal-code"
                className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg p-3 focus:border-indigo-500 focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">Phone</label>
            <input
              type="tel" name="phone" value={formData.phone} onChange={handleChange}
              autoComplete="shipping tel"
              className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg p-3 focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full bg-indigo-600 hover:bg-indigo-700 text-white py-4 rounded-xl font-semibold transition-colors disabled:opacity-50"
          >
            {isSubmitting ? 'Saving...' : 'Continue to Payment'}
          </button>
        </form>
      </div>
    </div>
  );
}
