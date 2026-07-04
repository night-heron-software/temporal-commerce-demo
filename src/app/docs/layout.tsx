import Link from 'next/link';

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-900">
      <nav className="bg-zinc-800 dark:bg-zinc-950 text-white border-b border-zinc-700 sticky top-0 z-50">
        <div className="max-w-4xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link href="/docs" className="font-bold text-lg tracking-tight">
            📚 Documentation
          </Link>
          <div className="flex items-center gap-4 text-sm">
            <Link href="/admin" className="text-zinc-300 hover:text-white transition-colors">
              ⚙️ Admin
            </Link>
            <Link href="/shop" className="text-zinc-400 hover:text-white transition-colors">
              → Storefront
            </Link>
          </div>
        </div>
      </nav>
      {children}
    </div>
  );
}
