'use client';

import { useCart } from '@/context/CartContext';
import { useShopper } from '@/context/ShopperContext';
import { useRouter } from 'next/navigation';
import { useState, useEffect, useCallback } from 'react';
import { setShippingAddress } from '@/app/shop/cart-actions';
import Link from 'next/link';
import { CartChangedBanner } from '@/components/CartChangedBanner';
import type { Cart } from '@/temporal/contracts';

// Semi-random test address generator
function generateTestAddress(): Cart.ShippingAddress {
  const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

  const firstNames = ['Alice', 'Bob', 'Charlie', 'Diana', 'Ethan', 'Fiona', 'George', 'Hannah', 'Ivan', 'Julia'];
  const lastNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez'];
  const streets = ['123 Main St', '456 Oak Ave', '789 Elm Blvd', '321 Pine Dr', '654 Maple Ln', '987 Cedar Way', '111 Birch Ct', '222 Spruce Rd'];
  const units = ['', '', '', 'Apt 2B', 'Suite 100', 'Unit 4', '#301'];
  const locations = [
    { city: 'San Francisco', state: 'CA', zip: '94102' },
    { city: 'Austin', state: 'TX', zip: '78701' },
    { city: 'Portland', state: 'OR', zip: '97201' },
    { city: 'Denver', state: 'CO', zip: '80202' },
    { city: 'Chicago', state: 'IL', zip: '60601' },
    { city: 'Seattle', state: 'WA', zip: '98101' },
    { city: 'Nashville', state: 'TN', zip: '37201' },
    { city: 'Boise', state: 'ID', zip: '83702' },
  ];
  const loc = pick(locations);
  const first = pick(firstNames);
  const last = pick(lastNames);

  return {
    firstName: first,
    lastName: last,
    address1: pick(streets),
    address2: pick(units),
    city: loc.city,
    state: loc.state,
    postalCode: loc.zip,
    country: 'US',
    phone: `555-${String(Math.floor(Math.random() * 900) + 100)}-${String(Math.floor(Math.random() * 9000) + 1000)}`,
    email: `${first.toLowerCase()}.${last.toLowerCase()}@example.com`
  };
}

export default function ShippingPage() {
  const router = useRouter();
  const { cart, cartId, refreshCart } = useCart();
  const { shopper, savedAddress, signIn, signOut, saveAddress } = useShopper();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSignIn, setShowSignIn] = useState(false);
  const [signInEmail, setSignInEmail] = useState('');
  const [signingIn, setSigningIn] = useState(false);

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

  // Track whether we've already applied initial data to avoid re-running
  const [initialized, setInitialized] = useState(false);

  // Pre-fill from saved address (signed-in user) or existing checkout data
  useEffect(() => {
    if (initialized) return;

    if (shopper && savedAddress) {
      // Signed in with saved address → pre-fill everything
      setFormData({
        firstName: savedAddress.firstName,
        lastName: savedAddress.lastName,
        address1: savedAddress.address1,
        address2: savedAddress.address2 || '',
        city: savedAddress.city,
        state: savedAddress.state,
        postalCode: savedAddress.postalCode,
        country: savedAddress.country,
        phone: savedAddress.phone || '',
        email: shopper.email,
      });
      setInitialized(true);
    } else if (shopper && !savedAddress) {
      // Signed in but no saved address → just email
      setFormData((prev) => ({ ...prev, email: shopper.email }));
      setInitialized(true);
    } else if (cart?.checkout?.shippingAddress) {
      // Existing checkout data (e.g. going back from payment)
      setFormData(cart.checkout.shippingAddress);
      setInitialized(true);
    }
  }, [shopper, savedAddress, cart?.checkout?.shippingAddress, initialized]);

  const handleAutofill = async () => {
    const testAddr = generateTestAddress();
    let email = testAddr.email;
    if (shopper) {
      // Signed in → keep current email
      email = shopper.email;
    }
    const finalAddr = {
      ...testAddr,
      email,
    };

    setFormData(finalAddr);

    try {
      if (!shopper) {
        await signIn(email);
      }
      await saveAddress(finalAddr);
    } catch (e) {
      console.error('Failed to save autofill test data address:', e);
    }
  };

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
      // If not signed in, auto-create account from the email entered
      if (!shopper) {
        await signIn(formData.email.trim());
      }

      // Save the address for next time
      await saveAddress({
        firstName: formData.firstName,
        lastName: formData.lastName,
        address1: formData.address1,
        address2: formData.address2,
        city: formData.city,
        state: formData.state,
        postalCode: formData.postalCode,
        country: formData.country,
        phone: formData.phone,
        email: formData.email,
      });

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

  const handleShippingSignIn = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signInEmail.trim()) return;
    setSigningIn(true);
    setError(null);
    const result = await signIn(signInEmail.trim());
    if (result.ok) {
      setShowSignIn(false);
      setSignInEmail('');
      // Reset initialized so the useEffect re-applies saved address
      setInitialized(false);
    } else {
      setError(result.error || 'Sign in failed');
    }
    setSigningIn(false);
  }, [signInEmail, signIn]);

  const handleSignOut = async () => {
    await signOut();
    // Clear form except keep what they've typed
    setInitialized(false);
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

        <div className="flex items-center justify-between mt-6 mb-6">
          <h1 className="text-3xl font-bold">Shipping Address</h1>
          <button
            type="button"
            onClick={handleAutofill}
            className="px-3 py-1.5 text-xs font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border border-amber-300 dark:border-amber-700 rounded-lg hover:bg-amber-200 dark:hover:bg-amber-900/50 transition-colors"
          >
            🧪 Autofill Test Data
          </button>
        </div>

        {/* ── Identity Banner ── */}
        {shopper ? (
          <div className="mb-6 flex items-center justify-between bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800 rounded-lg px-4 py-3">
            <div className="flex items-center gap-2 text-sm">
              <span className="w-6 h-6 rounded-full bg-indigo-600 text-white text-xs flex items-center justify-center font-medium">
                {shopper.name.charAt(0).toUpperCase()}
              </span>
              <span className="text-indigo-700 dark:text-indigo-300">
                Signed in as <strong>{shopper.email}</strong>
              </span>
            </div>
            <button
              type="button"
              onClick={handleSignOut}
              className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
            >
              Sign Out
            </button>
          </div>
        ) : (
          !showSignIn ? (
            <div className="mb-6">
              <button
                type="button"
                onClick={() => setShowSignIn(true)}
                className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline"
              >
                Already have an account? Sign in for faster checkout →
              </button>
            </div>
          ) : (
            <form onSubmit={handleShippingSignIn} className="mb-6 bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800 rounded-lg p-4">
              <div className="text-sm font-medium mb-2">Sign in with email</div>
              <div className="flex gap-2">
                <input
                  type="email"
                  value={signInEmail}
                  onChange={(e) => setSignInEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                  className="flex-1 px-3 py-2 text-sm bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg focus:border-indigo-500 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={signingIn}
                  className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors font-medium"
                >
                  {signingIn ? '…' : 'Sign In'}
                </button>
                <button
                  type="button"
                  onClick={() => { setShowSignIn(false); setSignInEmail(''); }}
                  className="px-3 py-2 text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                >
                  ✕
                </button>
              </div>
              <p className="text-xs text-zinc-400 mt-2">No password needed — just enter your email</p>
            </form>
          )
        )}

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
              readOnly={!!shopper}
              className={`w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg p-3 focus:border-indigo-500 focus:outline-none ${shopper ? 'bg-gray-100 dark:bg-gray-700 text-gray-500 cursor-not-allowed' : ''}`}
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
