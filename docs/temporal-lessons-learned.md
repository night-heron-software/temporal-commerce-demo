# Temporal Lessons Learned

Hard-won lessons from building a full e-commerce application on Temporal durable execution. These aren't theoretical best practices — they're patterns that emerged from debugging real workflow failures, performance bottlenecks, and architectural dead ends during the development of the Temporal Commerce Demo.

---

## Table of Contents

- [Workflow Design](#workflow-design)
- [The Deterministic Sandbox](#the-deterministic-sandbox)
- [State Management](#state-management)
- [Cross-Workflow Communication](#cross-workflow-communication)
- [Activity Design](#activity-design)
- [Worker Architecture](#worker-architecture)
- [CQRS and Projections](#cqrs-and-projections)
- [Error Handling](#error-handling)
- [Entity Modeling Decisions](#entity-modeling-decisions)
- [Operational Lessons](#operational-lessons)

---

## Workflow Design

### 1. `updateWithStart` is the right default for lazy entity creation

**The problem:** The first "Add to Cart" click needs to either create a cart workflow or update an existing one. A naive `start` + `executeUpdate` sequence introduces a race condition — two concurrent clicks can both attempt to start the same workflow.

**The lesson:** `updateWithStart` with `workflowIdConflictPolicy: 'USE_EXISTING'` makes this atomic. If the workflow exists, the update is routed to it. If not, the workflow starts and the update is delivered. Zero race conditions.

```typescript
const startOp = new WithStartWorkflowOperation('cartWorkflow', {
  workflowId: `cart-${cartId}`,
  args: [{ cartId }],
  taskQueue: 'cart-queue',
  workflowIdConflictPolicy: 'USE_EXISTING',
});
return await client.workflow.executeUpdateWithStart(updateDef, {
  startWorkflowOperation: startOp,
  args: args
});
```

**Corollary:** Don't start workflows until there's an actual payload. Empty workflows bloat the Temporal persistence layer and complicate the UI. Generate IDs locally (UUID) and defer workflow creation to the first substantive mutation.

### 2. `allHandlersFinished` is not optional

**The problem:** Update handlers return values to callers synchronously. If the workflow exits (via `continueAsNew` or terminal state) before the handler completes, the caller receives an `AcceptedUpdateCompletedWorkflow` error — the update was accepted, but the response was lost because the workflow ended underneath it.

**The lesson:** Always `await condition(allHandlersFinished)` before any workflow exit point — `continueAsNew`, `return`, or `throw`. This ensures every in-flight handler delivers its response.

```typescript
// Before continueAsNew
if (updateCount >= CONTINUE_AS_NEW_THRESHOLD) {
  await condition(allHandlersFinished);  // ← CRITICAL
  await continueAsNew<typeof cartWorkflow>({ ... });
}

// Before workflow exit
await condition(allHandlersFinished);  // ← CRITICAL
return state;
```

**This mistake cost hours of debugging.** The symptom was intermittent "workflow not found" errors that seemed random but were actually correlated with high cart activity triggering `continueAsNew` at exactly the wrong moment.

### 3. `continueAsNew` requires full state serialization

**The problem:** Long-running workflows (cart, inventory service) accumulate unbounded event history. After hundreds of updates, replay performance degrades and the Temporal Server history limit becomes a concern.

**The lesson:** `continueAsNew` resets the event history by starting a fresh execution. But it only preserves what you explicitly pass forward. Every piece of state that matters must be serialized into the `continueAsNew` arguments.

```typescript
await continueAsNew<typeof cartWorkflow>({
  cartId,
  initialCart: cart,         // Full cart state
  createdAt: cart.createdAt, // Preserve original timestamp
  updateCount: 0             // Reset counter
});
```

**What we forgot once:** The `checkoutWorkflowId` reference. After `continueAsNew`, the cart "forgot" it was in checkout, and the checkout workflow's completion signal was delivered to a cart that didn't know what to do with it. The fix was trivial — include it in the state — but the debugging was not.

### 4. Parent-child vs. activity-driven workflow spawning

**The problem:** The checkout workflow needs to survive if the cart is destroyed (user clears cookies, creates a new cart). The OMS needs to start fulfillment workflows that may outlive the OMS itself if the OMS hits `continueAsNew`.

**The lesson:** There are two patterns, each with specific tradeoffs:

| Pattern | Use When | Trade-off |
| --- | --- | --- |
| **Parent-child** with `ABANDON` | The child should survive parent destruction but you want the parent to monitor it | Parent can observe child status; child runs independently |
| **Activity-driven spawning** | The spawned workflow is fully independent and the caller doesn't need lifecycle coupling | Maximum decoupling; no parent-child relationship in Temporal UI |

We use parent-child for Cart → Checkout (the cart monitors checkout status) and activity-driven for OMS → Fulfillment (fully decoupled, signals back via external workflow handle). Choosing the wrong pattern for OMS → Fulfillment initially caused lifecycle coupling issues where `continueAsNew` on the OMS would terminate the fulfillment child.

---

## The Deterministic Sandbox

### 5. The async predicate death loop

**The problem:** `wf.condition()` takes a synchronous predicate. If you pass an `async` function, it returns a `Promise` — which is always truthy in JavaScript.

**The lesson:** This creates an infinite loop that burns through the event history in seconds.

```typescript
// ❌ DEATH LOOP: Promise is always truthy
await wf.condition(async () => {
  return state.status === 'complete';
});

// ✅ CORRECT: Synchronous predicate
await wf.condition(() => state.status === 'complete');
```

**Symptom:** Worker CPU spikes to 100%, the workflow generates thousands of events, and eventually hits the history size limit. The error message does not mention the async predicate — you have to know this.

### 6. No Map or Set across the serialization boundary

**The problem:** Temporal uses JSON serialization for data passed between activities and workflows. JavaScript `Map` and `Set` objects serialize to empty objects `{}`.

**The lesson:** Use `Record<string, T>` for all data transfer objects. Convert Maps to plain objects in activities before returning.

```typescript
// In activities — convert before returning
const internalMap = new Map<string, string>();
return Object.fromEntries(internalMap);

// In workflows — use plain object access
const result = await someActivity();
if (key in result) {
  const value = result[key];
}
```

**The symptom:** `TypeError: result.myMap.has is not a function`. The Map methods disappear after JSON round-tripping, but the runtime error doesn't mention serialization — it looks like a simple type mismatch.

### 7. No dynamic imports in workflow code

**The problem:** Temporal bundles workflow code into a deterministic sandbox at worker startup. Dynamic `import()` calls bypass this bundling and can introduce non-determinism.

**The lesson:** All workflow imports must be static. If you need conditional behavior, use feature flags fetched via activities, not dynamic imports.

```typescript
// ❌ WRONG: Dynamic import in workflow
const module = await import(`./strategies/${type}`);

// ✅ CORRECT: Static imports, dynamic dispatch
import { runSimulated } from './strategies/simulated';
import { runDynamic } from './strategies/dynamic';

if (type === 'simulated') await runSimulated(...);
else if (type === 'dynamic') await runDynamic(...);
```

---

## State Management

### 8. Step-based state machines need explicit back-navigation guards

**The problem:** The checkout flow has steps: `shipping → payment → review → processing → complete`. Users need to go back — edit their shipping address from the review page.

**The lesson:** Each update handler must explicitly declare which steps it can accept transitions from. Without guards, a stale browser tab can corrupt the state machine.

```typescript
setHandler(setShippingUpdate, async (input) => {
  const allowedSteps = ['shipping', 'payment', 'review'];
  if (!allowedSteps.includes(state.step)) {
    return { ...state, error: `Cannot set shipping from step: ${state.step}` };
  }
  // Recalculate costs because shipping changed
  state.shippingCost = await calculateShipping(input.address);
  state.tax = await calculateTax(input.address, items);
  state.step = 'payment';
  return state;
});
```

**Key insight:** Setting shipping from the `review` step means recalculating costs. The step guard isn't just validation — it defines which side effects are triggered during backward navigation.

### 9. TypeScript narrowing breaks across `condition()` yields

**The problem:** TypeScript narrows `checkoutResult` to `null` after a null check. But `condition()` yields the workflow — signal handlers can reassign the variable during the yield. TypeScript doesn't know this.

**The lesson:** Use a getter function to defeat TypeScript's narrowing:

```typescript
let checkoutResult: CheckoutWorkflowResult | null = null;

// Handler sets it during a yield
setHandler(checkoutCompletedSignal, (result) => {
  checkoutResult = result;
});

// ❌ TypeScript narrows this to 'never' after the condition
if (checkoutResult !== null) { ... }

// ✅ Getter defeats narrowing
const getResult = () => checkoutResult;
if (getResult() !== null) {
  const result = getResult()!;
  applyCheckoutResult(result);
}
```

This is a TypeScript-specific gotcha that doesn't appear in Go or Java Temporal SDKs.

---

## Cross-Workflow Communication

### 10. Signals for fire-and-forget, updates for confirmed mutations

**The lesson:** Temporal offers three communication primitives. Choosing the wrong one has real consequences:

| Primitive | Delivery Guarantee | Response | Use Case |
| --- | --- | --- | --- |
| **Signal** | At-least-once, fire-and-forget | None | Status notifications, inventory change events |
| **Update** | Exactly-once, synchronous response | Yes | Cart mutations, checkout step transitions |
| **Query** | Read-only, no side effects | Yes | Cart state reads, checkout status |

**Where we got this wrong initially:** Using signals for cart mutations meant the UI couldn't confirm whether the add-to-cart succeeded — it had to poll the query afterward. Switching to updates gave us synchronous return values, eliminating an entire class of race conditions in the React UI.

**Where signals are correct:** Fulfillment status flowing upward to the OMS. The fulfillment workflow doesn't need to wait for the OMS to acknowledge — it just signals the status change and continues. If the OMS workflow has completed, the signal is dropped silently, which is the correct behavior.

### 11. `signalWithStart` for singleton services

**The problem:** The inventory service is a singleton workflow. Write-side code needs to signal it with changed SKUs, but the workflow might not be running yet (first mutation after a clean start).

**The lesson:** Use `signalWithStart` to atomically ensure the workflow exists and deliver the signal:

```typescript
export async function signalInventoryChanged(blankSkus: string[]) {
  const client = await getTemporalClient();
  try {
    await client.workflow.getHandle('inventory-service')
      .signal('inventoryChanged', { blankSkus });
  } catch (e) {
    // Auto-start if not running
    await client.workflow.signalWithStart('inventoryServiceWorkflow', {
      workflowId: 'inventory-service',
      taskQueue: INVENTORY_TASK_QUEUE,
      signal: 'inventoryChanged',
      signalArgs: [{ blankSkus }],
    });
  }
}
```

**Why try/catch instead of always using `signalWithStart`:** `signalWithStart` has higher overhead than a simple signal delivery. For hot paths (every cart mutation triggers an inventory signal), optimize for the common case (workflow already running) and fall back to `signalWithStart` only when needed.

---

## Activity Design

### 12. The Two-File Activity Pattern prevents sandbox contamination

**The problem:** Workflows run in a deterministic sandbox. If a workflow file imports an activity that imports a database driver, the sandbox tries to bundle the database driver — and fails.

**The lesson:** Split every domain's activities into two files:

| File | Purpose | Imported By |
| --- | --- | --- |
| `activities.ts` | Proxy signatures + timeout/retry config | Workflows |
| `activities-impl.ts` | Actual implementations with I/O | Workers |

Workflows import from `activities.ts`, which contains only `proxyActivities` calls. Workers register from `activities-impl.ts`, which has the real database and API calls.

### 13. Compensation must be explicit — Temporal doesn't auto-rollback

**The problem:** The checkout flow reserves inventory, processes payment, and creates an order. If payment fails, the inventory reservations must be released. If the checkout times out, they must also be released.

**The lesson:** Temporal retries activities, but it does not provide automatic compensation. You must build the undo logic:

```typescript
const completedBeforeTimeout = await condition(
  () => orderComplete || checkoutCancelled,
  '1 hour'
);

// If checkout times out or is cancelled, release reservations
if (!orderComplete && reservations.length > 0) {
  await releaseReservations(reservations);
}
```

**The key insight:** This is dramatically simpler than building a distributed saga because the workflow remembers everything. You don't need to reconstruct what was reserved from a database — the reservations array is right there in workflow memory.

---

## Worker Architecture

### 14. Shared connection, isolated task queues

**The lesson:** Running all six domain workers in a single Node.js process is efficient for development and small deployments. They share one gRPC connection to Temporal, but each domain has its own task queue.

```typescript
const connection = await NativeConnection.connect({ address });
await Promise.all([
  cartWorker(connection),
  checkoutWorker(connection),
  omsWorker(connection),
  fulfillmentWorker(connection),
  inventoryWorker(connection),
  identityWorker(connection),
]);
```

**Critical benefit:** Task queue isolation means a slow fulfillment activity (waiting for `wf.sleep('60s')` to simulate processing) does not block cart operations. Each domain processes work independently.

**Production consideration:** In production, these can be split into separate deployments for independent scaling. The fulfillment worker might need more resources than the identity worker. The code change is zero — just deploy each worker module separately with its own task queue.

### 15. Worker restarts replay from checkpoint, not from scratch

**The lesson we learned the hard way:** When a worker crashes and restarts, Temporal replays the workflow from the last checkpoint. This is the core durability guarantee, but it means:

- Activities that already completed are **not re-executed** — their results are replayed from history
- `wf.sleep()` timers that already expired are **instant** during replay
- Signal handlers that already fired are **re-delivered** from the event history

The implication: workflow code must be deterministic. If you add a new `log.info()` call between two existing activity calls, existing workflows will replay correctly. But if you change the *order* of activity calls, you get a `Non-Determinism` error on replay.

---

## CQRS and Projections

### 16. The dirty-flag projection pattern prevents write amplification

**The problem:** Every cart mutation, order status change, and fulfillment update needs to be synced to Elasticsearch. If the sync happens inside every handler, five rapid-fire cart additions produce five Elasticsearch writes.

**The lesson:** Use a dirty flag. Handlers set a flag; the main loop flushes:

```typescript
let projectionDirty = false;

// In update handlers — just set the flag
function syncProjections(): void {
  projectionDirty = true;
}

// In the main loop — flush between iterations
while (!isComplete) {
  await condition(() => isComplete || projectionDirty, timeout);
  if (projectionDirty) {
    projectionDirty = false;
    await indexToElasticsearch(currentState);
  }
}
```

Five rapid cart additions → one ES write. This is the Temporal equivalent of database write coalescing.

### 17. The inventory service workflow replaces an entire infrastructure layer

**The lesson:** The traditional CQRS implementation requires: a message queue consumer (Kafka/RabbitMQ), a cron job for periodic sweeps, a dead-letter queue for failures, and a reconciliation script for drift. Temporal replaces all of this with a single `condition()` call:

```typescript
await condition(() => dirtySkus.size > 0, '5m');
```

This gives both event-driven behavior (wake up when signaled) and time-driven behavior (wake up every 5 minutes for consistency sweeps) in a single construct. The `continueAsNew` at 100 signals prevents unbounded history growth while preserving pending dirty SKUs.

### 18. Every domain entity that changes must trigger its own ES projection

**The problem:** We initially only indexed products, collections, orders, and supplier orders. But the admin dashboard needed visibility into carts, fulfillment status, inventory levels, and customer records — and those entities were invisible to search.

**The lesson:** If a domain entity's state changes via a workflow, it should project to Elasticsearch. We ended up with 11 indices:

| Index | Trigger |
| --- | --- |
| `products`, `collections`, `suppliers` | Reindex API (bulk, from Cassandra) |
| `orders`, `customers`, `supplier_orders` | OMS workflow activities (on every status change) |
| `carts` | Cart workflow activities (on every mutation) |
| `reservations` | Cart + checkout activities |
| `inventory` | Inventory service workflow |
| `fulfillments`, `shipments` | Fulfillment workflow activities |

**The Elasticsearch search page** (`/admin/search`) became the single pane of glass for debugging. Searching for an order ID returns results across orders, supplier_orders, fulfillments, customers, and inventory — showing the complete system state for that transaction.

### 19. UUID search requires keyword-only matching

**The problem:** Searching for a UUID like `14fca5e0-5afb-47ef-b8cb-2080c737ba0f` in Elasticsearch returned hundreds of false-positive results. Products, orders, and carts that had nothing to do with that UUID were showing up.

**The root cause:** Elasticsearch's standard analyzer tokenizes at hyphens. The UUID gets split into `14fca5e0`, `5afb`, `47ef`, `b8cb`, `2080c737ba0f`. Each fragment matches against any document containing those hex strings — which is nearly everything.

**The lesson:** Detect UUIDs in search input via regex and route them through `term` queries on `.keyword` sub-fields, which are not analyzed:

```typescript
const UUID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const uuids = query.match(UUID_REGEX) || [];

// Route UUIDs through keyword-only matching (zero analysis)
const uuidClauses = uuids.flatMap(uuid => [
  { ids: { values: [uuid] } },
  { term: { 'orderId.keyword': uuid } },
  { term: { 'cartId.keyword': uuid } },
  // ... all known UUID fields
]);

// Route remaining text through fuzzy full-text search
const remainingText = query.replace(UUID_REGEX, '').trim();
```

---

## Error Handling

### 20. Redemptive State Recovery — never lose the cart

**The principle:** When a workflow operation fails, return to the last known good state instead of crashing. The user's cart items must never be lost.

**How this manifests:**

| Failure | Recovery |
| --- | --- |
| Payment fails | Checkout returns to the `payment` step with an error message |
| Checkout times out | Reservations released, cart returns to `active` |
| Terminal workflow | Server Action returns `null`, UI clears stale cookie |
| Worker crash | Temporal replays from last checkpoint — zero state loss |

```typescript
// Server Action wrapper — never throws for terminal workflows
try {
  return await handle.executeUpdate(updateDef, { args });
} catch (e) {
  if (error?.name === 'WorkflowNotFoundError' ||
      error?.cause?.type === 'AcceptedUpdateCompletedWorkflow') {
    return null;  // ← graceful degradation
  }
  throw e;        // ← only re-throw unexpected errors
}
```

**The key insight:** Temporal makes this pattern dramatically simpler than traditional distributed systems because the workflow remembers everything. Recovery is just a state transition, not a database reconciliation.

---

## Entity Modeling Decisions

### 21. Workflow-per-entity vs. singleton service — choose by cardinality

**The lesson:** We initially considered workflow-per-entity for inventory (one workflow per SKU). With ~2,700 products and multiple variants each, this would have created thousands of concurrent workflows, overwhelming the Temporal UI and creating massive `continueAsNew` overhead.

| Model | Use When | Examples in This Project |
| --- | --- | --- |
| **Workflow-per-entity** | Low cardinality, independent lifecycles | Cart, Order, Fulfillment |
| **Singleton service** | High cardinality, shared infrastructure | Inventory service |
| **Sharded service** | High cardinality with natural partitions | Per-tenant inventory (future) |

The singleton inventory service workflow handles all SKUs. Write-side activities signal it with changed SKUs, and it batches projections. One workflow to monitor instead of thousands.

### 22. Decouple fulfillment from OMS via activity-driven spawning

**The architectural evolution:** The OMS initially started fulfillment as a child workflow. This created a lifecycle coupling — if the OMS needed `continueAsNew`, the child relationship complicated things.

**The final pattern:** OMS starts fulfillment via an activity (just a Temporal client `workflow.start` call inside an activity). Fulfillment is a fully standalone workflow that signals back to the OMS via `getExternalWorkflowHandle`. Each runs on its own task queue and has its own lifecycle.

```
OMS Workflow ─── activity ──→ Fulfillment Workflow (standalone)
                              │
                              └── signal ──→ OMS Workflow
```

This pattern means fulfillment can outlive any single OMS execution. It's the right choice when the child workflow may run longer than the parent's `continueAsNew` cycle.

---

## Operational Lessons

### 23. The Wipe-before-Seed initialization sequence matters

**The problem:** Running a schema migration script against an existing database with `IF NOT EXISTS` silently skips changes. Developers add a column, re-run init, and get "Undefined column" errors because the table already existed.

**The lesson:** For local development, always follow:

1. **Wipe** — `docker-compose down -v` (delete all volumes)
2. **Init** — Recreate schema on an empty database
3. **Start** — Launch app and workers
4. **Seed** — Populate via API (canonical path)
5. **Sync** — Reindex all to Elasticsearch

Using the API for seeding (`POST /api/seed-cassandra`) instead of direct database writes ensures all side effects fire — Temporal workflows start, ES projections run, and the system reaches a production-like state.

### 24. Feature flags via activities, not environment variables

**The problem:** The `MANUAL_FULFILLMENT` flag controls whether the simulated fulfillment workflow auto-advances or waits for manual signals. An environment variable requires a worker restart to take effect.

**The lesson:** Check feature flags via activities at decision points:

```typescript
const manualMode = await getFeatureFlag('MANUAL_FULFILLMENT');

if (manualMode) {
  // Wait for explicit signal to advance
  await wf.condition(() => so.status !== 'in_production');
} else {
  // Auto-simulate with timers
  await wf.sleep(processingDelayMs);
}
```

The flag check is recorded in Temporal history, so you can debug why a workflow took a specific branch. And updating the flag in the admin UI takes effect on the next activity execution — no worker restart needed.

### 25. Elasticsearch mappings must be created before indexing

**The problem:** If auto-index creation is disabled (or if indices require specific mappings like `keyword` fields for UUID matching), workflow activities that index documents will fail silently or create indices with the wrong mappings.

**The lesson:** The seed pipeline must create ES index mappings **before** any data ingestion:

```
1. POST /api/dev/init/es-indices  ← Create all 11 index mappings
2. POST /api/seed-cassandra       ← Load catalog data
3. POST /api/seed-inventory       ← Seed stock levels
4. POST /api/dev/reindex          ← Bulk sync to ES
```

Reversing steps 1 and 4 creates a "Search Hole" — the database is full but the search index has wrong mappings or is empty.

---

## Summary

The overarching lesson: **Temporal eliminates infrastructure complexity but demands workflow design discipline.** There are no message queues to debug, no cron jobs to monitor, and no saga orchestrators to maintain. But the deterministic sandbox, serialization boundaries, and lifecycle management require deliberate patterns that are different from traditional service development.

The payoff is significant — this application has zero message queues, zero cron jobs, zero dead-letter queues, and zero distributed transaction coordinators. Every state transition is a workflow, every side effect is an activity, and every failure mode is handled by durable execution. When the workers crash, they resume from exactly where they left off.
