---
description: Guidelines for Temporal workflow/worker code changes
---

# Temporal Worker Code Changes

**IMPORTANT**: The Temporal workers do NOT auto-reload when workflow or activity code changes.

> [!NOTE]
> Workers are launched via `npm run dev:worker` (or `npm run dev:up`), which runs `npx tsx --env-file=.env.local ./src/temporal/worker.ts`.
> Since `tsx` transpiles TypeScript on the fly, a worker restart picks up code changes **without** a separate build step.

## When to Restart Workers

After making changes to any of these files, suggest restarting workers:

- `src/temporal/worker.ts` — Unified worker entry point
- `src/temporal/*/worker.ts` — Individual domain worker registration
- `src/temporal/*/workflows.ts` — Workflow definitions
- `src/temporal/*/activities-impl.ts` — Activity implementations
- `src/temporal/*/activities.ts` — Activity contracts
- `src/temporal/*/definitions.ts` — Signal/query/update definitions
- `src/temporal/*/types.ts` — Types used by workflows/activities

## How to Restart Workers

```bash
# If running `npm run dev:up`, press Ctrl+C and restart:
npm run dev:up

# If running workers separately:
# Stop (Ctrl+C or:)
npm run dev:down

# Restart
npm run dev:worker
```

## Domain Workers Launched

`src/temporal/worker.ts` starts all 6 domains on a single `NativeConnection`:

| Domain | Task Queue | Source |
| --- | --- | --- |
| Cart | `cart-tasks` | `src/temporal/cart/worker.ts` |
| Checkout | `checkout-tasks` | `src/temporal/checkout/worker.ts` |
| Fulfillment | `fulfillment-tasks` | `src/temporal/fulfillment/worker.ts` |
| Identity | `identity-tasks` | `src/temporal/identity/worker.ts` |
| Inventory | `inventory-tasks` | `src/temporal/inventory/worker.ts` |
| OMS | `oms-tasks` | `src/temporal/oms/worker.ts` |

## Testing Changes

After restarting, **start a new workflow** to test changes. Existing in-flight workflows continue using the old code until they complete or are terminated.

> [!WARNING]
> Modifying workflow files while workflows are running causes non-determinism errors. Always restart workers after workflow code changes.

## Type Checking

Verify all domains compile cleanly:

```bash
npx tsc --noEmit
```
