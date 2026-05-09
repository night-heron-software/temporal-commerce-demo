# Demo Instructions

Step-by-step instructions for running a 4–5 minute live demonstration of the Temporal Commerce Demo. Covers local setup, screen layout, and a streamlined walkthrough.

---

## Pre-Demo Setup

Allow **5–10 minutes** before the demo to start infrastructure and seed data.

### 1. Start Infrastructure

```bash
make init
```

Wait for Docker containers (Cassandra, Elasticsearch, Temporal) to report healthy.

### 2. Start the Application

```bash
make app-start
```

Wait for `▲ Next.js 15.x.x — Local: http://localhost:3000`.

### 3. Seed Demo Data

In a **second terminal**:

```bash
make seed
```

This populates the product catalog (~2,700 products across 40 collections) by calling the running app's API endpoints. Wait for `✨ Seeding complete!`.

### 4. Verify

| URL | What to Check |
| --- | --- |
| `http://localhost:3000/shop` | Product grid with images and prices |
| `http://localhost:3000/admin` | Admin dashboard loads with Orders, Inventory, Carts, Search cards |
| `http://localhost:3000/admin/search` | Elasticsearch Explorer shows doc counts across all 11 indices |
| `http://localhost:8233` | Temporal UI — Workflows page, no errors |

### 5. Set Fulfillment Mode

Go to `http://localhost:3000/admin/orders` and confirm the **Fulfillment Mode** toggle is set to **Automatic**. This lets the fulfillment workflow auto-advance through `in_production → shipped → delivered` with ~60-second delays, so the audience sees the full lifecycle during the demo without manual intervention.

---

## Screen Layout

Arrange two browser windows side by side:

| Window | Position | URL |
| --- | --- | --- |
| **Storefront** | Left half | `http://localhost:3000/shop` |
| **Temporal UI** | Right half | `http://localhost:8233` |

Pre-filter the Temporal UI to show all workflow types so new workflows appear immediately.

---

## Demo Walkthrough (4–5 minutes)

### 0:00 — Add Items to Cart (~1 minute)

1. In the **Storefront**, click a collection and select a product
2. Click **Add to Cart**
3. Glance at the **Temporal UI** — point out the new `cart-{uuid}` workflow (Running)
4. Add **one more item** from a different product
5. Click into the cart workflow in Temporal UI — briefly show the event history with `UpdateAccepted` / `UpdateCompleted` events

> "There is no cart table in the database. The Temporal workflow IS the cart — every add-to-cart is a synchronous Temporal Update, and the first click uses `updateWithStart` to atomically create the workflow."

### 1:00 — Checkout (~1 minute)

1. Open the **cart drawer** and click **Checkout**
2. Glance at Temporal UI — a `checkout-{uuid}` child workflow appeared
3. On the **Shipping** page, click **🧪 Autofill Test Data**, then **Continue to Payment**
4. On the **Payment** page, click **Continue with Mock Payment**
5. On the **Review** page, pause briefly to show the order summary

> "Checkout is a child workflow of the cart. Each step — shipping, payment, review — is a Temporal Update with validation guards enforcing the state machine."

### 2:00 — Place Order (~1 minute)

1. Click **Place Order** → the Confirmation page appears
2. Switch to **Temporal UI** and show the workflow cascade:
   - `cart-{uuid}` — **Completed** (received the `checkoutCompleted` signal)
   - `checkout-{uuid}` — **Completed**
   - `order-{orderId}` — **Running** (OMS workflow)
   - `fulfillment-{orderId}` — **Running** (fulfillment simulation)
   - `inventory-service` — **Running** (singleton, started lazily on the first inventory reservation)
3. Click into the `order-{orderId}` workflow — show auto-assignment and the fulfillment trigger activity

> "One click triggered a cascade: checkout persisted the order, signaled the parent cart, and the OMS workflow started. It auto-assigned items to suppliers and kicked off a fully decoupled fulfillment workflow on a separate task queue."

### 3:00 — Fulfillment and Admin (~1 minute)

1. Click into the `fulfillment-{orderId}` workflow — show status is `in_production`
2. Open the **Admin Panel** at `http://localhost:3000/admin/orders`
3. Show the order in the list with its current status
4. Open the **Elasticsearch Explorer** at `http://localhost:3000/admin/search`
5. Search for the order ID — show results across orders, supplier_orders, fulfillments, and inventory indices
6. Point out the Temporal UI link in the admin panel

> "The fulfillment workflow is simulating supplier processing with `wf.sleep()` timers. Status updates signal the OMS, which projects to Elasticsearch. The admin panel reads from ES — it's a CQRS projection kept in sync by the workflow. The search page lets us query across all 11 domain indices to verify every entity is being tracked."

### 4:00 — Wrap-Up (~30 seconds)

1. If the fulfillment has advanced to `shipped` by now, point it out in the admin panel
2. Summarize what the audience just saw:

> "This entire flow — cart, checkout, order management, fulfillment, inventory — has zero message queues, zero cron jobs, and zero saga orchestrators. Temporal workflows replaced all of that infrastructure. If I killed the workers right now, every workflow would resume from exactly where it left off when the workers restart."

---

## Quick Reset Between Demos

```bash
make app-stop
make clean
make init
make app-start    # Terminal 1
make seed         # Terminal 2
```

Takes about 2–3 minutes for a complete reset.

---

## Troubleshooting During Demo

| Problem | Quick Fix |
| --- | --- |
| Storefront shows no products | Run `make seed` again |
| "Workflow not found" errors | Cart cookie expired; clear cookies and add new items |
| Checkout stuck | Clear cookies, start a new cart |
| Temporal UI not loading | Check Docker: `make ps` |
| Worker crash on start | Check Temporal is running: `docker ps \| grep temporal` |
| Admin shows no orders | Place an order first; check `make seed` output |
| Fulfillment not advancing | Check worker logs; verify fulfillment mode is set to Automatic |

---

## Appendix: Manual Fulfillment Mode

For longer demos where you want to control the pace, switch to **Manual** fulfillment mode in the admin panel. In this mode, the fulfillment workflow pauses at each phase and waits for a signal.

### Advance to Shipped

Signal name: `supplierStatusUpdate`

```json
{
  "supplierOrderId": "<supplierOrderId from getStatus query>",
  "status": "shipped",
  "carrier": "Demo Carrier",
  "trackingNumber": "DEMO-TRACK-001"
}
```

### Advance to Delivered

Signal name: `supplierStatusUpdate`

```json
{
  "supplierOrderId": "<supplierOrderId from getStatus query>",
  "status": "delivered"
}
```

### Cancel Fulfillment

Signal name: `cancel` — no payload required.

### Finding the Supplier Order ID

1. Open the fulfillment workflow in Temporal UI
2. Go to the **Queries** tab
3. Run the `getStatus` query
4. In the result JSON, find `supplierOrders[0].supplierOrderId`
5. Copy this value into the signal payload
