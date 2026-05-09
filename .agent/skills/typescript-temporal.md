# Temporal TypeScript SDK Patterns

Project-specific Temporal TypeScript SDK patterns for `temporal-commerce-demo`. Documents the module conventions and code organization patterns used across all 6 workflow domains.

## Workflow Domain Module Structure

This project uses a simplified structure compared to the multi-repo platform. All domains live under `src/temporal/` with shared contracts in `src/temporal/contracts/`.

### Entity Workflows (Full Structure)

Entity workflows manage long-lived, stateful objects (carts, orders, checkouts). They follow this template:

```text
src/temporal/{domain}/
  ├── activities.ts       Interface + proxyActivities() with retry config
  ├── activities-impl.ts  Implementation with database/external dependencies
  ├── types.ts            Interfaces and types for the domain
  ├── worker.ts           Worker registration for this domain
  └── workflows.ts        Workflow logic (deterministic, no I/O)
```

**Entity domains:** cart, checkout, oms, inventory, fulfillment, identity.

**Shared types** live in `src/temporal/contracts/` — one file per domain (cart.ts, checkout.ts, etc.) plus a barrel `index.ts`.

### Utility Domains (Minimal Structure)

Utility domains provide helper activities used by other workflows:

```text
src/temporal/{domain}/
  ├── activities.ts       Interface + proxyActivities()
  └── activities-impl.ts  Implementation
```

### When Creating a New Domain

- If it manages a **long-lived entity** with queries/updates → use the full entity structure.
- If it provides **helper activities** consumed by other workflows → use the minimal utility structure.
- Register new activities in the unified worker (`src/temporal/worker.ts`).

---

## Two-File Activity Pattern

Activities are split into two files to respect Temporal's sandbox isolation.

### Why the Split

The Temporal worker sandbox bundles everything imported by `workflows.ts` into an isolated V8 context. If `activities.ts` imported database clients, those would be pulled into the sandbox and fail. The split ensures:

- **`activities.ts`** contains ONLY the interface and `proxyActivities()` call. Safe to import from `workflows.ts`.
- **`activities-impl.ts`** contains actual implementations with real I/O (Cassandra, Elasticsearch, HTTP). Imported ONLY by the worker process, outside the sandbox.

### `activities.ts` — Contract (Sandbox-Safe)

```typescript
import { proxyActivities } from '@temporalio/workflow';

export interface InventoryActivities {
  projectStockForSkus(blankSkus: string[]): Promise<void>;
  projectReservationsForSkus(blankSkus: string[]): Promise<void>;
  syncInventoryToESForSkus(blankSkus: string[]): Promise<void>;
  expireReservations(): Promise<number>;
}

export const {
  projectStockForSkus,
  projectReservationsForSkus,
  syncInventoryToESForSkus,
  expireReservations,
} = proxyActivities<InventoryActivities>({
  startToCloseTimeout: '30s',
  retry: { maximumAttempts: 3, initialInterval: '1s', backoffCoefficient: 2 }
});
```

### `activities-impl.ts` — Implementation (Worker-Only)

```typescript
import { InventoryCommandRepository } from './db/inventory-command-repository';
import { executeCql } from '../../lib';

export async function projectStockForSkus(blankSkus: string[]): Promise<void> {
  // Real database operations here
}
```

**Key points:**

- Function names and signatures MUST exactly match the interface in `activities.ts`.
- Never import `activities-impl.ts` from `workflows.ts` or any Next.js code.

---

## Contracts Pattern

This project centralizes shared type definitions in `src/temporal/contracts/`:

```text
src/temporal/contracts/
  ├── cart.ts           CartItem, CartDetails, CheckoutStep, etc.
  ├── checkout.ts       CheckoutStep, CheckoutState types
  ├── fulfillment.ts    Fulfillment types
  ├── inventory.ts      Inventory signals and types
  ├── oms.ts            Order management types
  └── index.ts          Barrel re-export (import { Cart, Checkout, Inventory } from '../contracts')
```

**Key points:**

- Contracts include `defineQuery`/`defineSignal`/`defineUpdate` declarations alongside types.
- Next.js code imports from contracts for typed handles (safe — no workflow runtime imports).
- Workflows import from contracts for handler registration.

---

## Unified Execution Wrapper Pattern

Never call `client.workflow.getHandle().executeUpdate()` directly from Server Actions. Use domain-specific wrappers that centralize error handling:

```typescript
async function executeCartUpdate<TReturn, TArgs extends any[]>(
  cartId: string,
  updateDef: UpdateDefinition<TReturn, TArgs>,
  args: TArgs,
  options: ExecuteOptions = {}
): Promise<TReturn | null> {
  const client = await getTemporalClient();
  const workflowId = `cart-${cartId}`;

  try {
    const handle = client.workflow.getHandle(workflowId);
    return await handle.executeUpdate(updateDef, { args: args as any });
  } catch (e) {
    const error = e as { name?: string; cause?: { type?: string } };
    if (
      error?.name === 'WorkflowNotFoundError' ||
      error?.cause?.type === 'AcceptedUpdateCompletedWorkflow'
    ) {
      return null;
    }
    throw e;
  }
}
```

**Design decisions:**

- **Generic typed signature** — full type safety across all update calls.
- **Error recovery** — `WorkflowNotFoundError` returns `null` instead of throwing.
- **Workflow ID convention** — `{domain}-{entityId}` (no multi-tenant prefix in this demo).

---

## Cross-Runtime Import Boundary (CRITICAL)

This project runs two runtimes: Next.js App Router and Temporal worker sandbox.

**When importing from `src/temporal/` into `src/app/`:**

- ✅ Import from `src/temporal/contracts/` (query/signal/update handles, types)
- ✅ Use `import type` for interfaces
- ❌ NEVER import from `workflows.ts` (triggers sandbox initialization errors)
- ❌ NEVER import from `activities-impl.ts` (pulls in database/external dependencies)

### ✅ Good: Safe imports in a Server Action

```typescript
import { Cart, Checkout } from '@/temporal/contracts';
import type { CartDetails } from '@/temporal/contracts/cart';
```

### ❌ Bad: Importing workflow code into Next.js

```typescript
import { cartWorkflow } from '@/temporal/cart/workflows'; // triggers sandbox init
import { validateInventory } from '@/temporal/cart/activities-impl'; // pulls in Cassandra
```
