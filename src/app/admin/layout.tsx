import Link from 'next/link';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-900">
      {/* Admin NavBar */}
      <nav className="bg-zinc-800 dark:bg-zinc-950 text-white border-b border-zinc-700 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/admin" className="font-bold text-lg tracking-tight">
              ⚙️ Admin
            </Link>
            <div className="flex gap-4 text-sm">
              <Link
                href="/admin/orders"
                className="text-zinc-300 hover:text-white transition-colors"
              >
                Orders
              </Link>
              <Link
                href="/admin/inventory"
                className="text-zinc-300 hover:text-white transition-colors"
              >
                Inventory
              </Link>
              <Link
                href="/admin/carts"
                className="text-zinc-300 hover:text-white transition-colors"
              >
                Carts
              </Link>
            </div>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <a
              href="http://localhost:8233"
              target="_blank"
              rel="noopener noreferrer"
              className="text-cyan-400 hover:text-cyan-300 transition-colors flex items-center gap-1"
            >
              <span>🔗</span> Temporal UI
            </a>
            <Link
              href="/shop"
              className="text-zinc-400 hover:text-white transition-colors"
            >
              → Storefront
            </Link>
          </div>
        </div>
      </nav>
      <main>{children}</main>
    </div>
  );
}
