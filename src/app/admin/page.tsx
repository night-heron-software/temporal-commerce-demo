import Link from 'next/link';

export default function AdminDashboardPage() {
  return (
    <div className="max-w-4xl mx-auto p-8">
      <h1 className="text-3xl font-bold text-zinc-900 dark:text-zinc-100 mb-2">
        Temporal Commerce Demo
      </h1>
      <p className="text-zinc-500 dark:text-zinc-400 mb-8">
        Admin panel for monitoring orders and controlling fulfillment workflows.
      </p>

      <div className="grid md:grid-cols-2 gap-6">
        {/* Orders */}
        <Link
          href="/admin/orders"
          className="group p-6 bg-white dark:bg-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-700 hover:border-zinc-400 dark:hover:border-zinc-500 transition-all hover:shadow-lg"
        >
          <div className="text-3xl mb-3">📦</div>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
            Orders
          </h2>
          <p className="text-zinc-500 dark:text-zinc-400 text-sm mt-1">
            View orders, check workflow state, and manually control fulfillment progression.
          </p>
        </Link>

        {/* Temporal UI */}
        <a
          href="http://localhost:8233"
          target="_blank"
          rel="noopener noreferrer"
          className="group p-6 bg-white dark:bg-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-700 hover:border-cyan-400 dark:hover:border-cyan-500 transition-all hover:shadow-lg"
        >
          <div className="text-3xl mb-3">⚡</div>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 group-hover:text-cyan-600 dark:group-hover:text-cyan-400 transition-colors">
            Temporal UI
          </h2>
          <p className="text-zinc-500 dark:text-zinc-400 text-sm mt-1">
            Inspect workflow executions, histories, and task queues in real time.
          </p>
        </a>

        {/* Storefront */}
        <Link
          href="/shop"
          className="group p-6 bg-white dark:bg-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-700 hover:border-green-400 dark:hover:border-green-500 transition-all hover:shadow-lg"
        >
          <div className="text-3xl mb-3">🛍️</div>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 group-hover:text-green-600 dark:group-hover:text-green-400 transition-colors">
            Storefront
          </h2>
          <p className="text-zinc-500 dark:text-zinc-400 text-sm mt-1">
            Browse the catalog, add items to cart, and place test orders.
          </p>
        </Link>

        {/* Temporal Patterns */}
        <div className="p-6 bg-gradient-to-br from-purple-50 to-blue-50 dark:from-purple-950/30 dark:to-blue-950/30 rounded-xl border border-purple-200 dark:border-purple-800">
          <div className="text-3xl mb-3">🧩</div>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
            Patterns Demonstrated
          </h2>
          <ul className="text-sm text-zinc-600 dark:text-zinc-400 mt-2 space-y-1">
            <li>• Long-running entity workflows (Cart)</li>
            <li>• Workflow Updates (sync request-response)</li>
            <li>• Continue-as-New (history management)</li>
            <li>• Child workflows (Cart → Checkout)</li>
            <li>• State machines (Checkout, Order)</li>
            <li>• Timer-based simulation (Fulfillment)</li>
            <li>• CQRS singleton service (Inventory)</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
