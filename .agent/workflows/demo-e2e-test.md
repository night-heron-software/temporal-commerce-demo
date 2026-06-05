---
description: Complete end-to-end test suite for local temporal-commerce-demo — static checks, infrastructure, API, Temporal workflows, browser flows, and data integrity
---

# Demo End-to-End Test Suite

Comprehensive testing workflow that validates the entire temporal-commerce-demo platform from static code integrity through full browser-driven checkout flows. Each phase has explicit pass/fail criteria.

**Agent Instructions:**
- Execute phases in order. Phases 1–3 are hard gates — a failure stops execution and reports before continuing to runtime phases.
- Phases 4+ can tolerate individual test failures (report and continue).
- **Before any workers are started**, kill stale worker processes:
  ```bash
  stale_pids=$(pgrep -f "tsx.*worker" 2>/dev/null | tr '\n' ' ')
  if [ -n "$stale_pids" ]; then
    kill $stale_pids 2>/dev/null
    for i in 1 2 3 4 5; do
      [ -z "$(pgrep -f 'tsx.*worker' 2>/dev/null)" ] && break
      sleep 1
    done
    remaining=$(pgrep -f "tsx.*worker" 2>/dev/null | tr '\n' ' ')
    [ -n "$remaining" ] && kill -9 $remaining 2>/dev/null && sleep 1
  fi
  ```
- The storefront and workers MUST be running before Phase 4. If they are not, start them with `npm run dev:up` and `npm run workers-wait` before proceeding.
- Credentials for the shopper login test are stored in `.env.local`. Read variable **names** only — never echo secret values.

---

## Phase 1 — Static Code Integrity

Verify that all TypeScript code compiles, passes linting, and conforms to formatting rules.

**Agent Instruction:** Steps 1.1–1.3 are independent and should be run in parallel. Wait for all three before proceeding to Phase 2.

### 1.1 TypeScript Type Check

// turbo

```bash
cd /Users/jeffromine/src/portfolio/temporal-commerce-demo && npx tsc --noEmit
```

- **Pass**: Exit code 0, no type errors.
- **Fail**: Any type error. Record file and line.

### 1.2 Linting Compliance

// turbo

```bash
cd /Users/jeffromine/src/portfolio/temporal-commerce-demo && npm run lint
```

- **Pass**: Exit code 0.
- **Fail**: Any linting violation.

### 1.3 Code Formatting

// turbo

```bash
cd /Users/jeffromine/src/portfolio/temporal-commerce-demo && npm run format:check
```

- **Pass**: No formatting differences.
- **Fail**: Unformatted files found.

> [!IMPORTANT]
> Phase 1 is a hard gate. If any check fails, stop and report. Do not proceed to infrastructure or runtime checks with broken code.

---

## Phase 2 — Infrastructure Health

Verify all Docker containers and backing services are operational.

### 2.1 Platform Status

// turbo

```bash
cd /Users/jeffromine/src/portfolio/temporal-commerce-demo && npm run dev:status
```

- **Pass**: All of the following show `✅ UP`:
  - Cassandra (9042)
  - Elasticsearch (9200)
  - Temporal Server (7233)
  - Temporal UI (8233)
- **Fail**: Any service shows `❌ DOWN` or `⚠️`.

### 2.2 Deep Health Check (API)

Requires storefront running. If the storefront is not running, start it first.

// turbo

```bash
curl -sf http://localhost:3000/api/health | python3 -m json.tool
```

- **Pass**: `status` is `"healthy"` and all three services (`cassandra`, `temporal`, `elasticsearch`) report `"up"`.
- **Fail**: Any service reports `"down"` or overall status is `"degraded"` / `"unhealthy"`.

### 2.3 Temporal Worker Registration

// turbo

```bash
cd /Users/jeffromine/src/portfolio/temporal-commerce-demo && npm run workers-wait
```

All 6 core task queues must have active pollers:

| Queue | Domain | Validated? |
| --- | --- | --- |
| `identity-queue` | Identity | ✅ |
| `inventory-queue` | Inventory | ✅ |
| `cart-queue` | Cart | ✅ |
| `checkout-queue` | Checkout | ✅ |
| `oms-queue` | OMS | ✅ |
| `fulfillment-queue` | Fulfillment | ✅ |

- **Pass**: All 6 core queues show `✓`.
- **Fail**: Any queue missing or timeout reached.

---

## Phase 3 — Database Schema & Seed Validation

### 3.1 Cassandra Schema Consistency

// turbo

```bash
cd /Users/jeffromine/src/portfolio/temporal-commerce-demo && npm run db:verify
```

- **Pass**: All expected tables present in the `catalog` keyspace.
- **Fail**: Any missing table or CQL errors.

### 3.2 Elasticsearch Index Verification

// turbo

```bash
curl -sf 'http://localhost:9200/_cat/indices?h=index&format=json' | python3 -c "
import sys, json
indices = {i['index'] for i in json.load(sys.stdin) if not i['index'].startswith('.')}
required = {'products','collections','inventory','carts','orders','supplier_orders','fulfillments','shipments','reservations','customers'}
missing = required - indices
if missing: print(f'FAIL: Missing indices: {missing}'); sys.exit(1)
print(f'PASS: {len(indices)} indices present, all required found')
"
```

- **Pass**: All 10 required indices exist.
- **Fail**: Any index missing.

### 3.3 Seed Data Verification

// turbo

```bash
echo "--- Cassandra product count ---"
docker exec demo-cassandra cqlsh -e "SELECT count(*) FROM catalog.products;" 2>/dev/null | grep -oE '[0-9]+' | head -1

echo "--- Cassandra variant count ---"
docker exec demo-cassandra cqlsh -e "SELECT count(*) FROM catalog.variants;" 2>/dev/null | grep -oE '[0-9]+' | head -1

echo "--- Cassandra inventory_stock_w count ---"
docker exec demo-cassandra cqlsh -e "SELECT count(*) FROM catalog.inventory_stock_w;" 2>/dev/null | grep -oE '[0-9]+' | head -1

echo "--- Elasticsearch product count ---"
curl -sf http://localhost:9200/products/_count | python3 -c "import sys,json; print(json.load(sys.stdin).get('count', 0))"
```

- **Pass**: Products ≥ 1, Variants ≥ 1, inventory_stock_w ≥ 1, ES products ≥ 1.
- **Fail**: Any count is 0 (incomplete seed — run `npm run dev:seed`).

---

## Phase 4 — System Validation (Automated)

### 4.1 Cross-Domain System Checks

// turbo

```bash
cd /Users/jeffromine/src/portfolio/temporal-commerce-demo && npm run dev:validate
```

This runs `validate-system.ts`, which executes automated checks:

| Check | Description |
| --- | --- |
| Environment Configuration | Required env vars present |
| API Health | `GET /api/health` returns healthy |
| Search API Endpoint | `GET /api/search?q=*` returns 200 or 404 |
| Elasticsearch Cluster Health | `GET /_cluster/health` not red |
| Elasticsearch Index Mapping | `GET /_mapping` contains `products` key |
| Seed Data — Products in ES | ES products count > 0 |

- **Pass**: All checks `[PASS]`.
- **Fail**: Any check `[FAIL]`.

---

## Phase 5 — API Smoke Tests

### 5.1 Search API

// turbo

```bash
curl -sf 'http://localhost:3000/api/search?pageSize=5' | python3 -m json.tool
```

- **Pass**: Response contains `hits` array and `total` number.
- **Fail**: Non-200 status or malformed JSON.

### 5.2 Product API

// turbo

```bash
# Get first product ID from Cassandra and verify the API returns it
PRODUCT_ID=$(docker exec demo-cassandra cqlsh -e "SELECT id FROM catalog.products LIMIT 1;" 2>/dev/null | grep -oE '[0-9a-f-]{36}' | head -1)
echo "Testing product: $PRODUCT_ID"
curl -sf "http://localhost:3000/api/product/${PRODUCT_ID}" | python3 -m json.tool
```

- **Pass**: 200 response with product data (id, title, variants).
- **Fail**: 404, 500, or malformed JSON.

### 5.3 Health API (All Services)

// turbo

```bash
curl -sf http://localhost:3000/api/health | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f'Status: {d[\"status\"]}')
for svc, info in d.get('services', {}).items():
    status = info.get('status', 'unknown')
    latency = info.get('latencyMs', '?')
    icon = '✅' if status == 'up' else '❌'
    print(f'  {icon} {svc}: {status} ({latency}ms)')
if d['status'] not in ('healthy', 'degraded'):
    sys.exit(1)
"
```

- **Pass**: All three services (`cassandra`, `temporal`, `elasticsearch`) report `up`.
- **Fail**: Any service `down`.

### 5.4 Feature Flags API

// turbo

```bash
curl -sf http://localhost:3000/api/admin/feature-flags | python3 -m json.tool
```

- **Pass**: 200 response with flags object (e.g., `MANUAL_FULFILLMENT`, `DATA_FLOW_LOGGING`).
- **Fail**: Non-200 or missing response.

### 5.5 Shopper Auth — Login Flow

// turbo

```bash
# Test the shopper login endpoint (email-only auth)
curl -sf -X POST http://localhost:3000/api/auth/shopper/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@example.com"}' \
  -c /tmp/demo-test-cookie.txt \
  -o /dev/null -w "%{http_code}"
```

- **Pass**: Returns 200 (auto-creates shopper on first login).
- **Fail**: Non-200 or connection error.

### 5.6 Shopper Me Endpoint (Authenticated)

// turbo

```bash
curl -sf http://localhost:3000/api/auth/shopper/me \
  -b /tmp/demo-test-cookie.txt | python3 -m json.tool
```

- **Pass**: Returns shopper object with `id` and `email`.
- **Fail**: 401, 403, or missing fields.

---

## Phase 6 — Temporal Workflow E2E: Cart → Checkout → Order → Fulfillment

### 6.1 Clean Stale Temporal State

Terminate any running cart, checkout, or fulfillment workflows from previous sessions before testing:

// turbo

```bash
for wtype in cartWorkflow checkoutWorkflow fulfillmentWorkflow omsOrderWorkflow supplierOrderWorkflow; do
  ids=$(curl -s "http://localhost:8233/api/v1/namespaces/default/workflows?query=WorkflowType%3D%22${wtype}%22+AND+ExecutionStatus%3D%22Running%22" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for e in d.get('executions',[]): print(e['execution']['workflowId'])
" 2>/dev/null)
  for wid in $ids; do
    temporal workflow terminate --workflow-id "$wid" --reason "e2e test cleanup" 2>/dev/null && echo "Terminated $wid"
  done
done
echo "✓ Stale workflows cleared"
```

### 6.2 Add to Cart (Creates Cart Workflow)

// turbo

```bash
# Get a variant for testing
VARIANT_ID=$(docker exec demo-cassandra cqlsh -e "SELECT id FROM catalog.variants LIMIT 1;" 2>/dev/null | grep -oE '[0-9a-f-]{36}' | head -1)
PRODUCT_ID=$(docker exec demo-cassandra cqlsh -e "SELECT product_id FROM catalog.variants WHERE id = $VARIANT_ID LIMIT 1;" 2>/dev/null | grep -oE '[0-9a-f-]{36}' | head -1)
echo "Test Variant: $VARIANT_ID"
echo "Test Product: $PRODUCT_ID"

# Add to cart via storefront (creates cartWorkflow via executeUpdateWithStart)
curl -sf -X POST http://localhost:3000/shop/product/${PRODUCT_ID} \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -b /tmp/demo-test-cookie.txt \
  -c /tmp/demo-test-cookie.txt \
  -d "variantId=${VARIANT_ID}&quantity=1" \
  -o /dev/null -w "%{http_code}" || echo "Note: Server action POST may return 302"
```

> [!NOTE]
> The storefront uses Next.js Server Actions for cart mutations. Use the browser flow in Phase 7 for the full add-to-cart → checkout journey. This step just verifies the cart workflow gets created.

Verify via Temporal:

// turbo

```bash
sleep 3
temporal workflow list --query "WorkflowType='cartWorkflow' AND ExecutionStatus='Running'" --limit 5
```

- **Pass**: At least 1 running `cartWorkflow`.
- **Fail**: 0 workflows (add-to-cart failed to create the workflow).

### 6.3 Cart → Checkout → Order Full Flow (Browser-Driven)

See Phase 7. The browser integration test in 7.4–7.6 exercises the full Temporal workflow chain.

### 6.4 Post-Checkout Workflow State Verification

After completing Phase 7 checkout, verify the full workflow chain ran:

// turbo

```bash
echo "=== Running Workflows ==="
for wtype in cartWorkflow omsOrderWorkflow fulfillmentWorkflow; do
  count=$(curl -s "http://localhost:8233/api/v1/namespaces/default/workflows?query=WorkflowType%3D%22${wtype}%22" | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('executions',[])))" 2>/dev/null)
  echo "  $wtype: $count"
done

echo "=== Cassandra Order Records ==="
docker exec demo-cassandra cqlsh -e "SELECT count(*) FROM catalog.orders;" 2>/dev/null | grep -oE '[0-9]+'| head -1

echo "=== Elasticsearch Order Index ==="
curl -sf http://localhost:9200/orders/_count | python3 -c "import sys,json; print(json.load(sys.stdin).get('count', 0))"
```

- **Pass**: ≥ 1 order in Cassandra and ES, all expected workflow types visible.
- **Fail**: 0 orders (checkout never completed).

---

## Phase 7 — Browser Integration: Shopper Storefront

Use the Chrome DevTools MCP (browser automation) to verify the shopper-facing storefront renders correctly and the full checkout flow works.

**Agent Instruction:** Read the Chrome DevTools skill at `/Users/jeffromine/.gemini/config/plugins/chrome-devtools-plugin/skills/chrome-devtools/SKILL.md` before executing browser steps.

### 7.1 Landing / Shop Page

1. Navigate to `http://localhost:3000/shop`
2. Verify the page loads without errors (no 500, no blank page).
3. Confirm product cards are visible (at least 1 `<a>` with `/shop/product/` href).

- **Pass**: Products visible, no console errors.
- **Fail**: Blank page, error page, JS crash, or empty state when catalog is seeded.

### 7.2 Product Detail Page

1. Click a product card to navigate to its detail page (`/shop/product/{id}?variantId={id}`).
2. Verify product title, price, and **Add to Cart** button are visible.
3. Verify variant selector renders correctly.

- **Pass**: Product details load, Add to Cart button present.
- **Fail**: 404, blank page, or missing price/button.

### 7.3 Search Functionality

1. On the shop page, locate the search input.
2. Type a search query (e.g., `shirt`).
3. Wait for debounced results (~300ms).
4. Verify results update reactively.

- **Pass**: Search input accepts text, results update.
- **Fail**: Input unresponsive or JS error.

### 7.4 Shopper Login

1. Navigate to `http://localhost:3000/shop/auth/signin` (if there is a sign-in page) or use the header account link.
2. Enter a test email address.
3. Verify the login succeeds and the shopper is recognized on the shop page.

- **Pass**: Shopper authenticated, email visible in account area.
- **Fail**: Login error or redirect failure.

### 7.5 Add to Cart → Begin Checkout

1. On a product detail page, select a variant if needed.
2. Click **Add to Cart**.
3. Verify cart count in header updates to 1.
4. Navigate to cart and click **Proceed to Checkout** (or equivalent).
5. Verify redirect to `/shop/checkout/shipping`.

- **Pass**: Item in cart, checkout initiated, shipping page loads.
- **Fail**: Add to Cart hangs, error toast, or checkout page fails to load.

> [!IMPORTANT]
> A hang on Add to Cart means the cart workflow has a non-determinism error from a previous stale workflow. Run Phase 6.1 cleanup before retrying.

### 7.6 Checkout: Shipping Address

1. On the shipping page (`/shop/checkout/shipping`), fill in the shipping address form:
   - First Name, Last Name
   - Address Line 1
   - City, State, ZIP
   - Country
   - Email
2. Click **Continue to Payment**.
3. Verify redirect to `/shop/checkout/payment`.

- **Pass**: Shipping saved, payment page loads.
- **Fail**: "Failed to save shipping address" error or timeout (check Temporal for workflow task failures).

### 7.7 Checkout: Payment

1. On the payment page (`/shop/checkout/payment`), the form should contain mock payment fields.
2. Enter mock card details (any value — demo always approves).
3. Click **Continue to Review** (or equivalent).
4. Verify redirect to `/shop/checkout/review`.

- **Pass**: Payment step completes, review page loads with order summary.
- **Fail**: Payment error or timeout.

### 7.8 Checkout: Review & Submit

1. On the review page (`/shop/checkout/review`), verify the order summary shows:
   - Item(s) with correct variant
   - Shipping address
   - Payment method (mock)
   - Total amount
2. Click **Place Order**.
3. Verify redirect to `/shop/checkout/confirmation`.
4. Verify the confirmation page shows a confirmation number.

- **Pass**: Order placed, confirmation number displayed.
- **Fail**: Submit fails, no confirmation number, or timeout.

### 7.9 Order History

1. Navigate to `/shop/orders`.
2. Verify the most recent order appears in the list.
3. Click the order to view its detail page.
4. Verify the order detail shows status, items, and confirmation number.

- **Pass**: Order in list, detail page loads.
- **Fail**: Empty list or 404 on detail.

---

## Phase 8 — Browser Integration: Admin Dashboard

### 8.1 Admin Orders Page

1. Navigate to `http://localhost:3000/admin/orders`.
2. Verify the orders page loads.
3. If Phase 7 checkout completed: verify at least 1 order row is visible.
4. Click the order row to open the order detail.
5. Verify order status and fulfillment status are visible.

- **Pass**: Page loads, order from Phase 7 visible with correct status.
- **Fail**: Crash, empty list when order exists, or 500.

### 8.2 Admin Inventory Page

1. Navigate to `http://localhost:3000/admin/inventory`.
2. Verify the page loads and displays inventory stats (total SKUs, reserved, available).
3. Verify active reservations count matches expectations (0 if no pending carts, 1+ if a cart is active).

- **Pass**: Page renders, stats are non-zero, reservation count is correct.
- **Fail**: Crash, all zeros when data exists, or stale reservation after delivery.

### 8.3 Admin Carts Page

1. Navigate to `http://localhost:3000/admin/carts`.
2. Verify the page loads and shows active cart workflows.

- **Pass**: Page renders without errors.
- **Fail**: Crash or 404.

### 8.4 Admin Search Page

1. Navigate to `http://localhost:3000/admin/search`.
2. Verify the ES debug/search page renders.

- **Pass**: Page renders without errors.
- **Fail**: Crash or 404.

### 8.5 Dev — ES Index Status

// turbo

```bash
curl -sf 'http://localhost:3000/api/dev/init/status' | python3 -m json.tool
```

- **Pass**: Returns 200 with index status map.
- **Fail**: Non-200 or missing indices.

---

## Phase 9 — Data Consistency & CQRS Projection Verification

### 9.1 Product Count Parity

// turbo

```bash
echo "--- Cassandra ---"
docker exec demo-cassandra cqlsh -e "SELECT count(*) FROM catalog.products;" 2>/dev/null | grep -oE '[0-9]+' | head -1

echo "--- Elasticsearch ---"
curl -sf http://localhost:9200/products/_count | python3 -c "import sys,json; print(json.load(sys.stdin).get('count', 0))"
```

- **Pass**: Counts match and are both > 0.
- **Fail**: Counts diverge (ES projection out of sync).

### 9.2 Collection Count Parity

// turbo

```bash
echo "--- Cassandra ---"
docker exec demo-cassandra cqlsh -e "SELECT count(*) FROM catalog.collections;" 2>/dev/null | grep -oE '[0-9]+' | head -1

echo "--- Elasticsearch ---"
curl -sf http://localhost:9200/collections/_count | python3 -c "import sys,json; print(json.load(sys.stdin).get('count', 0))"
```

- **Pass**: Counts match.
- **Fail**: Diverge.

### 9.3 Inventory Count Parity

// turbo

```bash
echo "--- Cassandra (write table) ---"
docker exec demo-cassandra cqlsh -e "SELECT count(*) FROM catalog.inventory_stock_w;" 2>/dev/null | grep -oE '[0-9]+' | head -1

echo "--- Elasticsearch ---"
curl -sf http://localhost:9200/inventory/_count | python3 -c "import sys,json; print(json.load(sys.stdin).get('count', 0))"
```

- **Pass**: Counts match and > 0.
- **Fail**: Diverge or both 0 (inventory not seeded).

### 9.4 Zero Stale Reservations After Delivery

After Phase 7 checkout completes and the fulfillment workflow delivers:

// turbo

```bash
echo "--- Cassandra reservations (expect 0 after delivery) ---"
docker exec demo-cassandra cqlsh -e "SELECT count(*) FROM catalog.inventory_reservations_w;" 2>/dev/null | grep -oE '[0-9]+' | head -1

echo "--- inventory_stock_w reserved_stock (expect 0) ---"
docker exec demo-cassandra cqlsh -e "SELECT blank_sku, reserved_stock FROM catalog.inventory_stock_w WHERE reserved_stock > 0 ALLOW FILTERING;" 2>/dev/null
```

- **Pass**: 0 reservations after a delivered order, `reserved_stock` = 0 for all SKUs.
- **Fail**: Stale CONFIRMED reservation remaining (indicates `fulfillInventoryReservations` failed — check `variantId` vs `sku` mapping).

> [!NOTE]
> The demo simulates delivery automatically via timed state transitions in the supplier order workflow (~30–45 seconds). Wait for the fulfillment workflow to reach `__terminal:delivered` before checking this.

### 9.5 Order in Both Cassandra and ES

// turbo

```bash
echo "--- Cassandra orders ---"
docker exec demo-cassandra cqlsh -e "SELECT count(*) FROM catalog.orders;" 2>/dev/null | grep -oE '[0-9]+' | head -1

echo "--- Elasticsearch orders ---"
curl -sf http://localhost:9200/orders/_count | python3 -c "import sys,json; print(json.load(sys.stdin).get('count', 0))"
```

- **Pass**: Counts match and ≥ 1 after checkout.
- **Fail**: Diverge or 0.

---

## Phase 10 — Observability Stack

### 10.1 Temporal UI

// turbo

```bash
curl -sf http://localhost:8233/ -o /dev/null -w "%{http_code}"
```

- **Pass**: Returns 200.
- **Fail**: Non-200 or connection refused.

### 10.2 Jaeger UI

// turbo

```bash
curl -sf http://localhost:16686/ -o /dev/null -w "%{http_code}"
```

- **Pass**: Returns 200.
- **Fail**: Non-200 or connection refused.

### 10.3 Prometheus

// turbo

```bash
curl -sf http://localhost:9090/-/healthy -o /dev/null -w "%{http_code}"
```

- **Pass**: Returns 200.
- **Fail**: Non-200 or connection refused.

### 10.4 Grafana

// turbo

```bash
curl -sf http://localhost:3200/api/health -o /dev/null -w "%{http_code}"
```

- **Pass**: Returns 200.
- **Fail**: Non-200 or connection refused.

---

## Results Report

After all phases complete, create a results artifact with the following structure:

```markdown
# E2E Test Results — temporal-commerce-demo

**Date**: <timestamp>
**Catalog State**: Seeded / Blank Start
**Total Duration**: <elapsed>

## Summary

| Phase | Sub-Test | Result | Duration | Notes |
| --- | --- | --- | --- | --- |
| 1.1 | TypeScript Type Check | ✅/❌ | | |
| 1.2 | Linting Compliance | ✅/❌ | | |
| 1.3 | Code Formatting | ✅/❌ | | |
| 2.1 | Platform Status | ✅/❌ | | |
| 2.2 | Deep Health Check | ✅/❌ | | |
| 2.3 | Worker Registration | ✅/❌ | | |
| 3.1 | Cassandra Schema | ✅/❌ | | |
| 3.2 | ES Index Verification | ✅/❌ | | |
| 3.3 | Seed Data Verification | ✅/❌ | | |
| 4.1 | System Validation | ✅/❌ | | |
| 5.1 | Search API | ✅/❌ | | |
| 5.2 | Product API | ✅/❌ | | |
| 5.3 | Health API | ✅/❌ | | |
| 5.4 | Feature Flags API | ✅/❌ | | |
| 5.5 | Shopper Login API | ✅/❌ | | |
| 5.6 | Shopper Me Endpoint | ✅/❌ | | |
| 6.1 | Stale Workflow Cleanup | ✅/❌ | | |
| 6.2 | Cart Workflow Created | ✅/❌ | | |
| 6.4 | Post-Checkout Workflow State | ✅/❌/⏭️ | | |
| 7.1 | Shop Page | ✅/❌ | | |
| 7.2 | Product Detail Page | ✅/❌ | | |
| 7.3 | Search Functionality | ✅/❌ | | |
| 7.4 | Shopper Login | ✅/❌ | | |
| 7.5 | Add to Cart → Checkout | ✅/❌ | | |
| 7.6 | Shipping Address | ✅/❌ | | |
| 7.7 | Payment | ✅/❌ | | |
| 7.8 | Review & Submit | ✅/❌ | | |
| 7.9 | Order History | ✅/❌ | | |
| 8.1 | Admin Orders Page | ✅/❌ | | |
| 8.2 | Admin Inventory Page | ✅/❌ | | |
| 8.3 | Admin Carts Page | ✅/❌ | | |
| 8.4 | Admin Search Page | ✅/❌ | | |
| 8.5 | Dev ES Index Status | ✅/❌ | | |
| 9.1 | Product Count Parity | ✅/❌ | | |
| 9.2 | Collection Count Parity | ✅/❌ | | |
| 9.3 | Inventory Count Parity | ✅/❌ | | |
| 9.4 | Zero Stale Reservations | ✅/❌/⏭️ | | |
| 9.5 | Order in Cassandra & ES | ✅/❌/⏭️ | | |
| 10.1 | Temporal UI | ✅/❌ | | |
| 10.2 | Jaeger UI | ✅/❌ | | |
| 10.3 | Prometheus | ✅/❌ | | |
| 10.4 | Grafana | ✅/❌ | | |

## Failures

<detailed failure descriptions with file, line, and error message>

## Recommendations

<action items for any failures found>
```
