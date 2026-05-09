# Next.js Architecture

This project uses **Next.js** with the **App Router** and **Tailwind CSS**.

## Core Directives

- Always default to **React Server Components (RSC)**.
- Only apply `"use client"` when `useState`, `useEffect`, or browser event listeners are strictly required.
- Use **Server Actions** for all data mutations. Do not use Route Handlers for operations that can be expressed as Server Actions.
- Use **Route Handlers** (`route.ts`) for webhook endpoints, integration APIs, and developer tools.
- Minimize `useEffect`. Prefer derived state, Server Components, or Server Actions.

## Server Action File Convention

Server Actions that involve Temporal or database operations SHOULD be in dedicated `*-actions.ts` files with `'use server'` at the top.

**Naming:**

- Domain-scoped at route group level: `cart-actions.ts`, `order-actions.ts`
- Admin-scoped: `admin-order-actions.ts`, `admin-cart-actions.ts`, `admin-inventory-actions.ts`

### ✅ Good: Dedicated action file

```typescript
// src/app/shop/cart-actions.ts
'use server';

import { getTemporalClient } from '@/lib/temporal-client';
import { Cart } from '@/temporal/contracts';

export async function addItemToCart(cartId: string, sku: string, quantity: number, price: number) {
  // implementation
}
```

### ❌ Bad: Inline server action in page component for complex logic

```tsx
// src/app/shop/page.tsx
export default function ShopPage() {
  async function addItem(formData: FormData) {
    'use server';
    const client = await getTemporalClient(); // complex logic shouldn't be inline
  }
  return <form action={addItem}>...</form>;
}
```

## Route Handler Segmentation

| Path Prefix | Purpose | Example |
| --- | --- | --- |
| `/api/admin/*` | Store management | `/api/admin/orders` |
| `/api/dev/*` | Developer instrumentation | `/api/dev/reindex`, `/api/dev/init/es-indices` |
| `/api/seed-*` | Database seeding | `/api/seed-cassandra`, `/api/seed-inventory` |
| `/api/*` (root) | Public/shopper-facing | `/api/search`, `/api/health` |

## Cross-Runtime Import Boundary (CRITICAL)

This project runs two runtimes: the Next.js App Router and the Temporal worker sandbox.

**When importing from `src/temporal/` into `src/app/`:**

- ✅ Import from `src/temporal/contracts/` (query/signal/update handles, types)
- ✅ Use `import type` for interfaces
- ❌ NEVER import from `workflows.ts` (triggers sandbox initialization errors)
- ❌ NEVER import from `activities-impl.ts` (pulls in database/external dependencies)

## Data Freshness Model

This project fetches data in real-time via Temporal queries and Cassandra reads rather than using Next.js cache invalidation. All entity state lives in Temporal workflows and is queried directly.

## Error Handling

- Use `error.tsx` files for error boundaries at route segment level.
- Handle expected errors as return values from Server Actions, not try/catch.
- Use early returns and guard clauses to avoid deeply nested conditionals.

## Component Patterns

- Wrap interactive client components in `Suspense` with meaningful fallbacks.
- Use `loading.tsx` for route-level loading states.
- Optimize images: use Next.js `Image` component with proper `width`/`height`.
