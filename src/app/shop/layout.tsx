'use client';

import { useState } from 'react';
import { CartProvider } from '@/context/CartContext';
import { ShopperProvider } from '@/context/ShopperContext';
import { CartDrawer } from '@/components/CartDrawer';
import { ShopNavBar } from '@/components/ShopNavBar';

export default function ShopLayout({ children }: { children: React.ReactNode }) {
  const [isCartOpen, setIsCartOpen] = useState(false);

  return (
    <ShopperProvider>
      <CartProvider>
        <ShopNavBar onCartClick={() => setIsCartOpen(true)} />
        <div className="pt-14">{children}</div>
        <CartDrawer isOpen={isCartOpen} onClose={() => setIsCartOpen(false)} />
      </CartProvider>
    </ShopperProvider>
  );
}
