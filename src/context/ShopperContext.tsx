'use client';

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { Identity } from '@/temporal/contracts';

interface ShopperProfile {
  id: string;
  email: string;
  name: string;
}

interface ShopperContextType {
  shopper: ShopperProfile | null;
  loading: boolean;
  savedAddress: Identity.SavedAddress | null;
  signIn: (email: string) => Promise<{ ok: boolean; error?: string }>;
  signOut: () => Promise<void>;
  refreshAddress: () => Promise<void>;
  saveAddress: (address: Partial<Identity.SavedAddress>) => Promise<void>;
}

const ShopperContext = createContext<ShopperContextType | undefined>(undefined);

export function ShopperProvider({ children }: { children: React.ReactNode }) {
  const [shopper, setShopper] = useState<ShopperProfile | null>(null);
  const [savedAddress, setSavedAddress] = useState<Identity.SavedAddress | null>(null);
  const [loading, setLoading] = useState(true);

  // Fetch current session on mount
  useEffect(() => {
    fetch('/api/auth/shopper/me', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        setShopper(data.shopper || null);
        setSavedAddress(data.savedAddress || null);
      })
      .catch(() => {
        // Not signed in
      })
      .finally(() => setLoading(false));
  }, []);

  const signIn = useCallback(async (email: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch('/api/auth/shopper/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) return { ok: false, error: data.error || 'Sign in failed' };

      setShopper(data.shopper);
      setSavedAddress(data.savedAddress || null);
      return { ok: true };
    } catch {
      return { ok: false, error: 'Network error' };
    }
  }, []);

  const signOut = useCallback(async () => {
    await fetch('/api/auth/shopper/logout', { method: 'POST' });
    setShopper(null);
    setSavedAddress(null);
  }, []);

  const refreshAddress = useCallback(async () => {
    if (!shopper) return;
    try {
      const res = await fetch('/api/auth/shopper/address', { cache: 'no-store' });
      const data = await res.json();
      const addresses = data.addresses || [];
      const defaultAddr = addresses.find((a: Identity.SavedAddress) => a.isDefault) || addresses[0] || null;
      setSavedAddress(defaultAddr);
    } catch {
      // ignore
    }
  }, [shopper]);

  const saveAddress = useCallback(async (address: Partial<Identity.SavedAddress>) => {
    if (!shopper) return;
    await fetch('/api/auth/shopper/address', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(address),
    });
    await refreshAddress();
  }, [shopper, refreshAddress]);

  return (
    <ShopperContext.Provider
      value={{
        shopper,
        loading,
        savedAddress,
        signIn,
        signOut,
        refreshAddress,
        saveAddress,
      }}
    >
      {children}
    </ShopperContext.Provider>
  );
}

export function useShopper() {
  const context = useContext(ShopperContext);
  if (context === undefined) {
    throw new Error('useShopper must be used within a ShopperProvider');
  }
  return context;
}
