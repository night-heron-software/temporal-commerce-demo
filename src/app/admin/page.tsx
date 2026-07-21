import Link from 'next/link';

function PatternGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-purple-700 dark:text-purple-300">
        {title}
      </h3>
      <ul className="mt-2 space-y-1.5">{children}</ul>
    </div>
  );
}

function Pattern({ name, where }: { name: string; where: string }) {
  return (
    <li className="text-sm text-zinc-600 dark:text-zinc-400">
      <span className="text-zinc-800 dark:text-zinc-200">{name}</span>{' '}
      <span className="text-zinc-400 dark:text-zinc-500">— {where}</span>
    </li>
  );
}

export default function AdminDashboardPage() {
  return (
    <div className="max-w-4xl mx-auto p-8">
      <h1 className="text-3xl font-bold text-zinc-900 dark:text-zinc-100 mb-2">
        Temporal Commerce Demo
      </h1>
      <p className="text-zinc-500 dark:text-zinc-400 mb-8">
        Admin panel for monitoring orders, inventory, and controlling fulfillment workflows — plus
        developer tools for tracing workflow journeys.
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

        {/* Inventory */}
        <Link
          href="/admin/inventory"
          className="group p-6 bg-white dark:bg-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-700 hover:border-orange-400 dark:hover:border-orange-500 transition-all hover:shadow-lg"
        >
          <div className="text-3xl mb-3">🏭</div>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 group-hover:text-orange-600 dark:group-hover:text-orange-400 transition-colors">
            Inventory
          </h2>
          <p className="text-zinc-500 dark:text-zinc-400 text-sm mt-1">
            View stock levels, active reservations, and inventory utilization across all SKUs.
          </p>
        </Link>

        {/* Carts */}
        <Link
          href="/admin/carts"
          className="group p-6 bg-white dark:bg-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-700 hover:border-violet-400 dark:hover:border-violet-500 transition-all hover:shadow-lg"
        >
          <div className="text-3xl mb-3">🛒</div>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 group-hover:text-violet-600 dark:group-hover:text-violet-400 transition-colors">
            Carts
          </h2>
          <p className="text-zinc-500 dark:text-zinc-400 text-sm mt-1">
            Monitor active shopping carts, checkout progress, and cart workflow state.
          </p>
        </Link>

        {/* Search */}
        <Link
          href="/admin/search"
          className="group p-6 bg-white dark:bg-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-700 hover:border-emerald-400 dark:hover:border-emerald-500 transition-all hover:shadow-lg"
        >
          <div className="text-3xl mb-3">🔍</div>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors">
            Search
          </h2>
          <p className="text-zinc-500 dark:text-zinc-400 text-sm mt-1">
            Query all Elasticsearch indices — products, orders, inventory, customers, and more.
          </p>
        </Link>

        {/* Order Trace */}
        <Link
          href="/dev/order-trace"
          className="group p-6 bg-white dark:bg-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-700 hover:border-amber-400 dark:hover:border-amber-500 transition-all hover:shadow-lg"
        >
          <div className="text-3xl mb-3">🧭</div>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 group-hover:text-amber-600 dark:group-hover:text-amber-400 transition-colors">
            Order Trace
          </h2>
          <p className="text-zinc-500 dark:text-zinc-400 text-sm mt-1">
            Trace an order&apos;s full workflow journey — cart → checkout → order → fulfillment —
            with per-transition state history.
          </p>
        </Link>

        {/* System Errors */}
        <Link
          href="/dev/system-errors"
          className="group p-6 bg-white dark:bg-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-700 hover:border-red-400 dark:hover:border-red-500 transition-all hover:shadow-lg"
        >
          <div className="text-3xl mb-3">🚨</div>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 group-hover:text-red-600 dark:group-hover:text-red-400 transition-colors">
            System Errors
          </h2>
          <p className="text-zinc-500 dark:text-zinc-400 text-sm mt-1">
            Error and fatal log lines from the storefront and workers, searchable by component and
            time window.
          </p>
        </Link>

        {/* System Logs */}
        <Link
          href="/dev/logs"
          className="group p-6 bg-white dark:bg-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-700 hover:border-purple-400 dark:hover:border-purple-500 transition-all hover:shadow-lg"
        >
          <div className="text-3xl mb-3">📜</div>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 group-hover:text-purple-600 dark:group-hover:text-purple-400 transition-colors">
            System Logs
          </h2>
          <p className="text-zinc-500 dark:text-zinc-400 text-sm mt-1">
            Live structured log lines across all services, searchable by log level, service, and free text.
          </p>
        </Link>

        {/* Docs */}
        <Link
          href="/docs"
          className="group p-6 bg-white dark:bg-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-700 hover:border-sky-400 dark:hover:border-sky-500 transition-all hover:shadow-lg"
        >
          <div className="text-3xl mb-3">📚</div>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 group-hover:text-sky-600 dark:group-hover:text-sky-400 transition-colors">
            Docs
          </h2>
          <p className="text-zinc-500 dark:text-zinc-400 text-sm mt-1">
            Project documentation rendered in-app — guides, demo scripts, and state machine
            diagrams.
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
        <div className="md:col-span-2 p-6 bg-gradient-to-br from-purple-50 to-blue-50 dark:from-purple-950/30 dark:to-blue-950/30 rounded-xl border border-purple-200 dark:border-purple-800">
          <div className="text-3xl mb-3">🧩</div>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
            Patterns Demonstrated
          </h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
            What this demo actually exercises, and where to go read it.
          </p>

          <div className="grid sm:grid-cols-2 gap-x-8 gap-y-6 mt-5">
            <PatternGroup title="Entity lifetime">
              <Pattern name="Long-running entity workflows" where="Cart, Inventory" />
              <Pattern name="updateWithStart — atomic lazy creation" where="Cart" />
              <Pattern name="signalWithStart — singleton auto-start" where="Inventory" />
              <Pattern name="Continue-as-New with handler drain" where="Cart, Inventory" />
            </PatternGroup>

            <PatternGroup title="Interaction">
              <Pattern name="Updates (sync request-response)" where="Cart, Checkout, OMS" />
              <Pattern name="Signals & Queries as live read models" where="all domains" />
              <Pattern
                name="condition() timers — TTL & idle timeout"
                where="Cart, Checkout, Fulfillment"
              />
              <Pattern
                name="Standalone activities, no wrapper workflow"
                where="Identity — ADR-0006"
              />
            </PatternGroup>

            <PatternGroup title="Topology">
              <Pattern name="startChild + REQUEST_CANCEL" where="Cart → Checkout" />
              <Pattern name="startChild + ABANDON — independent child" where="OMS → Fulfillment" />
              <Pattern name="Activity-spawned peer, no parent link" where="Checkout → OMS" />
              <Pattern name="getExternalWorkflowHandle signaling" where="every reverse edge" />
              <Pattern name="Isolated task queues, shared connection" where="6 workers" />
            </PatternGroup>

            <PatternGroup title="Architecture">
              <Pattern
                name="prepare → decide → finalize, pure decider"
                where="ADR-0003 / ADR-0009"
              />
              <Pattern name="Saga compensation on terminal states" where="Checkout, Cart" />
              <Pattern name="Async transition-recording projection" where="ADR-0010" />
              <Pattern name="Search Attribute + memo correlation" where="ADR-0011" />
              <Pattern name="CQRS event processor, dirty-flag batching" where="Inventory, OMS" />
            </PatternGroup>
          </div>
        </div>
      </div>
    </div>
  );
}
