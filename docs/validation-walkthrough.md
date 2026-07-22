# Validation Walkthrough

An interactive, full-system validation tour of the demo — conducted by Claude, with the user at
the browser. This document is the **reusable workflow definition**: it contains the stations, the
checks, and the questions, but **no results**.

**How the two-document process works.** Each run of this walkthrough is a live session: Claude
works through the stations in order, one station per turn. At each station Claude runs every
**Claude-performed test** itself, directs the user through the **User-performed tests**, and asks
the **Questions** (via AskUserQuestion — observations, pass/fail, free-form notes). Everything is
recorded into a dated **session record** in `docs/planning/` (e.g.
`validation-session-2026-07-22.md`) — Claude results, user results, and user comments verbatim.
Afterward the session record is applied back: issues and suggestions feed the improvement
backlog, and any place the workflow itself proved wrong or incomplete is amended **here**. The
loop is: run this doc → produce a record → update backlog and this doc.

Prerequisites: infra up (`npm run infra:up` or `npm run dev:init`), app + workers running
(`npm run dev:up`), seeded data. All Cassandra tables live in keyspace `catalog`. Key URLs:
storefront http://localhost:3000/shop, admin http://localhost:3000/admin, Temporal UI
http://localhost:8233, Jaeger http://localhost:16686, Prometheus http://localhost:9090, Grafana
http://localhost:3200.

---

## Station 0 — Setup

Workers do not hot-reload workflow code and do not re-read `.env.local`, so a walkthrough of
recently merged features (the `inventory_history` journal, in-place checkout renew) is only valid
against a **restarted** `dev:up` on the branch under test. This station confirms the stack is the
one we think it is: all six domain task queues have pollers, the read-only health checks pass,
and the journal table exists in the schema.

**Claude-performed tests**

| Check                            | Command / method                                                                  | Expected                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Branch is the one under test     | `git branch --show-current`                                                       | The branch being validated (e.g. `feat/in-place-renew`)                                          |
| All six task queues have pollers | `npm run workers-wait`                                                            | Reports pollers on identity, inventory, cart, checkout, oms, fulfillment queues; exits 0         |
| System health checks             | `npm run dev:validate`                                                            | `✅ All Validation Checks Passed!` — Passed count = total, Failed: 0                             |
| Service status table             | `npm run dev:status`                                                              | Infrastructure rows up; Application rows up; URL list printed                                    |
| Journal table exists             | `docker exec demo-cassandra cqlsh -e "DESCRIBE TABLE catalog.inventory_history;"` | Table definition with `PRIMARY KEY ((cart_id), at, seq)` and the operation/actor/details columns |

**User-performed tests**

| Step                                                                                       | What to verify                                                            |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Restart `npm run dev:up` on the branch under test (Ctrl-C the old one first)               | Both `storefront` and `workers` prefixes come up with no red error output |
| Confirm `.env.local` state (e.g. `OTEL_ENABLED`) matches what this session intends to test | Flag values as expected for Stations 6–7                                  |

**Questions**

1. Did the restart come up clean (no errors in either process)?
2. Is `OTEL_ENABLED` set the way you want for this run?
3. Anything unusual you already know about the current environment worth recording?

---

## Station 1 — Gates

The container-free CI-equivalent chain. This is the same set of gates every PR runs, plus the
local-only `build` step. It exercises the pure decider/state tests, projection and repository
unit tests, and the generated state-diagram ratchet — none of it needs Docker.

**Claude-performed tests**

| Check                 | Command / method              | Expected                                         |
| --------------------- | ----------------------------- | ------------------------------------------------ |
| Typecheck             | `npm run typecheck`           | Exits 0, no output                               |
| Lint                  | `npm run lint`                | Exits 0                                          |
| Formatting            | `npm run format:check`        | "All matched files use Prettier code style!"     |
| Unit + workflow tests | `npm test`                    | **320 tests** passing, < ~15s                    |
| Diagram ratchet       | `npm run docs:diagrams:check` | Strict + check pass, no drift                    |
| Production build      | `npm run build`               | Next.js build completes green                    |
| No side effects       | `git status --short`          | Clean (no stray `logs/` or generated-file churn) |

**User-performed tests**

| Step                             | What to verify                                         |
| -------------------------------- | ------------------------------------------------------ |
| (none — observe Claude's report) | Test count matches the expected number for this branch |

**Questions**

1. Does the reported test count match what you expect for this PR chain?
2. Any gate you want run with different flags (e.g. `npm run coverage`)?

---

## Station 2 — Storefront flow

The customer-facing journey: browse → add to cart → edit quantity → checkout → mock payment →
confirmation. Underneath, every step is a Temporal workflow: the cart workflow reserves inventory
as items are added (RESERVE rows in the journal, actor = the cart workflow ID), and checkout
performs an **in-place renew** of the cart's TEMPORARY holds — extending their TTL rather than
releasing and re-reserving — so the journal should show RENEW rows with **no RELEASE/RESERVE
pair** at checkout time. While the user shops, Claude tails the journal keyed by the new cartId.

**Claude-performed tests**

| Check                              | Command / method                                                                                                                                                   | Expected                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Identify the cartId                | Ask user for it (visible in cart page URL / EntityIds widget), or newest row in `/admin/carts`                                                                     | A UUID to key the journal query                                                                  |
| RESERVE rows appear on add-to-cart | `docker exec demo-cassandra cqlsh -e "SELECT at, seq, operation, actor, blank_sku, quantity, new_status FROM catalog.inventory_history WHERE cart_id='<cartId>';"` | One RESERVE per line item, `new_status: TEMPORARY`, actor = `demo.cart.<cartId>`                 |
| Quantity edit is journaled         | Re-run the journal query after the user edits quantity                                                                                                             | Additional RESERVE (or RELEASE for decrease) rows reflecting the change                          |
| In-place renew at checkout         | Re-run the journal query after checkout starts                                                                                                                     | RENEW rows for the existing holds; **no** RELEASE+RESERVE pair; actor = `demo.checkout.<cartId>` |
| Order confirmed                    | Re-run after payment                                                                                                                                               | CONFIRM rows (`new_status: CONFIRMED`)                                                           |

**User-performed tests**

| Step                                              | What to verify                                             |
| ------------------------------------------------- | ---------------------------------------------------------- |
| Browse http://localhost:3000/shop, open a product | Product page renders with variants and stock               |
| Add an item to the cart                           | Cart badge/count updates; report the cartId to Claude      |
| Edit the quantity in the cart                     | New quantity sticks after refresh                          |
| Checkout: address → payment (mock) → submit       | Each step advances without error                           |
| Confirmation page                                 | Order confirmation number displayed; note it for Station 4 |

**Questions**

1. Did any step feel slow or flash an error state?
2. Did the cart contents/totals stay consistent through checkout?
3. What is the confirmation number (for the order-trace station)?

---

## Station 3 — Admin tour

`/admin` is a card dashboard (Orders, Inventory, Carts, Search) plus a "Patterns Demonstrated"
section mapping demo features to Temporal patterns. Orders lists projected orders and hosts the
`MANUAL_FULFILLMENT` feature-flag toggle (when on, fulfiller workflows wait for manual/webhook
status advances instead of simulating). Inventory has Stock and Reservations tabs with stats and
filters, backed by the ES read side. Carts lists active cart workflows with expandable detail.
Search is a raw Elasticsearch query console across the 11 app indexes.

**Claude-performed tests**

| Check                              | Command / method                                                                                                                     | Expected                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Feature flags API                  | `curl -s http://localhost:3000/api/admin/feature-flags`                                                                              | JSON including `MANUAL_FULFILLMENT` boolean      |
| Order projection has the new order | ES: `curl -s 'http://localhost:9200/orders/_count'` (count > 0)                                                                      | Station 2's order is projected                   |
| Reservations read table consistent | `docker exec demo-cassandra cqlsh -e "SELECT reservation_id, status, quantity, fulfiller_id FROM catalog.inventory_reservations_w;"` | Station 2's holds present with expected statuses |

**User-performed tests**

| Step               | What to verify                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `/admin` dashboard | Four cards render; Patterns Demonstrated section reads accurately                                              |
| `/admin/orders`    | Station 2's order listed with correct status; toggle `MANUAL_FULFILLMENT` on and off — label updates both ways |
| `/admin/inventory` | Stock tab shows seeded SKUs; Reservations tab shows the order's reservations; filters work                     |
| `/admin/carts`     | The session's cart appears (or is gone if completed carts drop off); expand one for details                    |
| `/admin/search`    | Pick 2–3 indexes (orders, reservations, inventory) and search; hits render                                     |

**Questions**

1. Per page: anything missing, stale, or confusing?
2. Did the MANUAL_FULFILLMENT toggle behave as labeled?
3. Which admin page is most/least useful to you as-is?

---

## Station 4 — Dev tools

Four developer surfaces. **Order Trace** (`/dev/order-trace`) resolves an order by ID,
confirmation number, or customer email into the full workflow tree — per-domain nodes (cart,
checkout, oms, fulfillment, fulfiller-order) with transition/activity/history tabs, plus the teal
**Inventory History** section rendering the journal with actor badges that link matching
workflow IDs back to their trace nodes (system actors like `expiry-sweep`, `preemption`,
`reconciler` render as plain badges). **System Errors** (`/dev/system-errors`) is the ES-backed
error browser (level + time filters, search). **System Logs** (`/dev/logs`) reads the JSON log
files. **Docs** (`/docs`) renders the repo's markdown — including this walkthrough.

**Claude-performed tests**

| Check                            | Command / method                                                                                                  | Expected                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Force an error for System Errors | `curl -s -X POST http://localhost:3000/api/dev/reindex -H 'Content-Type: application/json' -d '{"index":"nope"}'` | HTTP 400 `Unknown index: nope. Valid: …` and an error row captured |
| System errors index has the row  | `curl -s 'http://localhost:9200/system_errors/_search?size=1&sort=@timestamp:desc'`                               | Most recent hit corresponds to the forced error                    |
| Trace resolves by confirmation # | Direct the user; cross-check via `/dev/order-trace` service path if needed                                        | Full tree: cart → checkout → order → fulfillment → fulfiller-order |

**User-performed tests**

| Step                                                            | What to verify                                                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `/dev/order-trace`: look up Station 2's order by confirmation # | All domain nodes present; tabs (transitions, activities, snapshots) populated                          |
| Inventory History section in the trace                          | Teal journal table shows RESERVE → RENEW → CONFIRM rows; actor badges link to the right workflow nodes |
| `/dev/system-errors`                                            | The forced 400/reindex error appears with level + timestamp; filters work                              |
| `/dev/logs`                                                     | Both `web` and `workers` service tags present; entries searchable                                      |
| `/docs`                                                         | Doc index renders; open **Validation Walkthrough** — this page renders correctly                       |

**Questions**

1. In the order trace, was anything about the journey hard to read or missing?
2. Did the actor badges correlate correctly (cart wf for RESERVE, checkout wf for RENEW)?
3. Any dev tool you reach for that isn't here?

---

## Station 5 — Temporal UI

The Temporal Web UI at http://localhost:8233 is the ground truth for workflow execution. Every
workflow ID follows `{storeId}.{domain}.{entityId}` and carries correlation Search Attributes, so
one query — `CorrelationId = '<cartId>'` — should surface the entire journey's workflows. The
inventory domain runs a single long-lived service workflow, `demo.inventory.service`, which
processes dirty-SKU signals and a 5-minute consistency sweep (expiry + drift reconciliation +
full reprojection).

**Claude-performed tests**

| Check                                 | Command / method                                                                                    | Expected                                                             |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Correlation query returns the journey | `docker exec demo-temporal temporal workflow list --query "CorrelationId = '<cartId>'"` (or via UI) | Cart, checkout, order, fulfillment, fulfiller-order workflows listed |
| Inventory singleton running           | `docker exec demo-temporal temporal workflow describe -w demo.inventory.service`                    | Status **Running**, workflow type `inventoryServiceWorkflow`         |
| History sanity on one workflow        | `temporal workflow show -w demo.checkout.<cartId>` (tail)                                           | Completed with activity events; no unexpected failures/retries       |

**User-performed tests**

| Step                                                                   | What to verify                                                  |
| ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| Open http://localhost:8233, run the `CorrelationId = '<cartId>'` query | Same workflow set as Claude's list; statuses make sense         |
| Open the checkout workflow's history                                   | Renew/reserve activities visible; no retry storms or failures   |
| Open `demo.inventory.service`                                          | Long-running; recent sweep timer firings and signals in history |

**Questions**

1. Do the workflow IDs and Search Attributes make the journey easy to navigate?
2. Anything surprising in the histories (retries, failures, long gaps)?

---

## Station 6 — Observability

Gated behind `OTEL_ENABLED=true` in `.env.local` (containers via the compose overlay; Node-side
tracing keys off the same flag — both required). Three instrumentation points: worker
auto-instrumentation (Cassandra/ES/http spans), the Temporal client interceptor (context
propagation from Server Actions into workflows), and the activity-inbound interceptor (a span
per activity). Known coverage boundaries: **no workflow-execution spans** (only activities), the
**Next.js app itself is not traced**, and Temporal server traces arrive under a separate
`temporal-server` service. Server metrics flow Temporal → Prometheus → Grafana; application/
worker metrics are a known gap.

**Claude-performed tests**

| Check                         | Command / method                                                      | Expected                                                           |
| ----------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Flag + containers up          | `npm run dev:status`                                                  | `OTEL_ENABLED=true`; Jaeger/Prometheus/Grafana rows up             |
| Jaeger has both services      | `curl -s http://localhost:16686/api/services`                         | Includes `demo-workers` and `temporal-server`                      |
| Traces for the order exist    | Jaeger API: query `demo-workers` traces around Station 2's timestamps | Activity spans with Cassandra/ES child spans                       |
| Prometheus target UP          | `curl -s http://localhost:9090/api/v1/targets`                        | `temporal-server` job health `up` (scraping `temporal:9464`)       |
| Grafana dashboard provisioned | `curl -s http://admin:admin@localhost:3200/api/search?query=Temporal` | "Temporal Server" dashboard in the "Temporal Commerce Demo" folder |

**User-performed tests**

| Step                                                             | What to verify                                                               |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Jaeger UI: service `demo-workers`, find an order-placement trace | Activity spans fan out under the client parent; datastore spans nested       |
| Note where the trace _stops_                                     | Matches the documented boundaries (no workflow spans, no Next.js spans)      |
| Grafana → Temporal Server dashboard                              | Panels populated: request rate, latency p95, schedule-to-start, poll success |

**Questions**

1. Were the coverage boundaries what you expected from the observability guide?
2. Is the trace detail sufficient to answer "which activity is slow and why"?
3. How much do you care about the app-metrics gap (worker SDK / Next.js metrics)?

---

## Station 7 — Logs

Structured Pino logging: each process writes machine-readable JSON to
`logs/demo-<service>-<date>.log` (`web`, `workers`, `scripts` via `LOG_SERVICE`), pretty output
to the console. `npm run dev:logs` tails today's files. Retention is pruned at logger startup by
`LOG_RETENTION_DAYS` (default 7); the directory is overridable with `LOG_DIR`.

**Claude-performed tests**

| Check                              | Command / method                            | Expected                                                               |
| ---------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------- |
| Per-service files exist            | `ls logs/`                                  | `demo-web-<today>.log` and `demo-workers-<today>.log` present          |
| Entries are structured             | `tail -3 logs/demo-workers-$(date +%F).log` | JSON lines with level, time, service, and (for workers) taskQueue tags |
| Live tail works                    | `npm run dev:logs` (briefly)                | Streams entries from both files                                        |
| Retention knob documented behavior | Inspect `src/lib/logger.ts` constants       | Default 7 days; prune-on-startup, best-effort                          |

**User-performed tests**

| Step                               | What to verify                                        |
| ---------------------------------- | ----------------------------------------------------- |
| Skim the tail output Claude shares | Log volume and content look reasonable, no error spam |
| `/dev/logs` page                   | Same entries surfaced in the UI with service tags     |

**Questions**

1. Is anything logging too much or too little for day-to-day dev?
2. Is the default 7-day retention right for your machine?

---

## Station 8 — Deep probes

Claude-heavy station: targeted probes of the inventory write path — the area the 2026-07-21
review found weakest and the PR chain rebuilt. The journal is the instrument: it is the **only**
operation-level record (failed reserves, expiry sweeps, preemptions, drift corrections leave no
other trace), keyed by cartId with `__platform__` for cart-less operations. The user's role is
to confirm each expectation before Claude runs it.

**Claude-performed tests**

| Check                           | Command / method                                                                                                                                                       | Expected                                                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| E2E journey to FULFILL          | `npx tsx --env-file=.env.local scripts/verify-checkout.ts`                                                                                                             | `🎉 E2E Verification Check Completed Successfully with ZERO Errors!`                                                   |
| Journal sequence for that order | Journal query (Station 2) with the script's cartId                                                                                                                     | RESERVE → RENEW → CONFIRM → FULFILL, correctly attributed actors; FULFILLED rows carry a `fulfiller_id`                |
| Counters returned to baseline   | `docker exec demo-cassandra cqlsh -e "SELECT blank_sku, total_stock, reserved_stock FROM catalog.inventory_stock_w;"`                                                  | `reserved_stock` back to baseline; `total_stock` decremented by delivered quantity                                     |
| Drift probe                     | Compare each SKU's `reserved_stock` to the sum of TEMPORARY/CONFIRMED quantities in `catalog.inventory_reservations_w`                                                 | Zero mismatch                                                                                                          |
| Inject drift → reconciler heals | `docker exec demo-cassandra cqlsh -e "UPDATE catalog.inventory_stock_w SET reserved_stock = 99 WHERE blank_sku='<sku>' AND fulfiller_id='<fid>';"` then wait ≤5m sweep | Counter restored; `DRIFT_CORRECTION` row under `cart_id='__platform__'`, actor `reconciler`, details show before/after |
| Expiry-sweep RELEASE            | Create a hold (add to cart, abandon), let its TTL lapse, wait for sweep                                                                                                | Journal RELEASE row with actor `expiry-sweep`; `reserved_stock` released                                               |
| Missing-hold renew warning      | Attempt checkout renew for a reservation deleted out from under it (or inspect worker log after expiry race)                                                           | Worker log warn `Reservation not found for renewal`; checkout falls back to fresh reserve                              |
| Reindex wipe guard              | `curl -s -X POST http://localhost:3000/api/dev/reindex -H 'Content-Type: application/json' -d '{"index":"system_errors"}'`                                             | HTTP 400: system_errors "has no Cassandra source and is never reindexed"                                               |
| Standalone activities live      | `npm run smoke:standalone`                                                                                                                                             | Round-trip `echo:hello-standalone`; exits 0                                                                            |

**User-performed tests**

| Step                                                      | What to verify                                           |
| --------------------------------------------------------- | -------------------------------------------------------- |
| Watch `/admin/inventory` during the drift-injection probe | The bogus counter is visible, then heals after the sweep |
| Spot-check the journal output Claude shares               | Sequence and actors match your mental model of the flow  |

**Questions**

1. Before each destructive probe (drift injection, abandoned cart): OK to proceed?
2. Do the journal semantics (operations, actors, `__platform__`) match your expectations?
3. Any additional probe you want while the instruments are out?

---

## Station 9 — Wrap-up

Close the session: tally pass/fail per station, list every issue and suggestion captured, and
commit the session record. Then close the loop — file follow-ups into the improvement backlog
(review doc or a new plan) and amend this workflow document wherever the session showed it wrong
or incomplete.

**Claude-performed tests**

| Check                             | Command / method                                                                          | Expected                               |
| --------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------- |
| Session record complete           | Review the session doc — no `_pending_` left except intentionally skipped stations        | Every station has results and comments |
| Gates still green after any fixes | Re-run Station 1 chain if code changed mid-session                                        | All green                              |
| Commit + push                     | `git add` the session record (and any workflow amendments), commit, push to the PR branch | Clean commit on the branch under test  |

**User-performed tests**

| Step                       | What to verify                                 |
| -------------------------- | ---------------------------------------------- |
| Review the summary table   | Pass/fail assignments match your recollection  |
| Review the Follow-ups list | Priorities assigned; nothing captured got lost |

**Questions**

1. Overall verdict on the system as toured?
2. Which follow-ups are worth scheduling first?
3. What should change about this walkthrough before its next run?
