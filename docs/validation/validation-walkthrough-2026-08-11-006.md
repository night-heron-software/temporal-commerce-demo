# Validation Walkthrough — 2026-08-11-006

An interactive, full-system validation tour of the demo — conducted by Claude, with the user at
the browser. This document is the **reusable workflow definition**: it holds the stations, the
checks, and the expected observations, but **no results**. Results go in a per-run **session
record** (`validation-session-<date>-NNN.md`, kept in `docs/private/` — local-only, gitignored,
backed up via the `sync-private-docs` skill).

The loop is: **run this doc → produce a session record → write the lessons into the NEXT
walkthrough number**. A version stays frozen once a run has executed it; amendments go into
`-<NNN+1>`, never back into the executed version. This mirrors the mono's validation system
(`nightheron-mono/docs/validation/` + its `mono-validate` skill), which was itself adapted from
this repo's original loop — the conventions have round-tripped.

**Lineage.** Walkthroughs `-001`…`-005` live in `docs/private/` (gitignored). `-005` was never
executed by a run, so per the freeze rule this `-006` revises and supersedes it — relocated into
the committed tree at `docs/validation/` because the walkthrough is a reusable project artifact,
not a private note. Session records stay private. `-006` is also the first version written for
the **decider-native + CommandBlock surface** (see Scope); `-005` described the pre-migration
architecture and would have validated code that no longer exists.

**Roles.** Claude is the **conductor**: it runs every Claude-performed test itself, directs the
user through the User-performed steps, and transcribes results and verbatim comments into the
session record. The user is at the browser. One station per turn, in order. No station quizzes —
the user volunteers observations; the conductor records them verbatim.

**Conduct rules** (each paid for by a prior run here or in the mono):

1. Verify the ARTIFACT of a user step (order row, journal entries) before recording a pass — an
   affirmative answer alone is insufficient.
2. Green stations plus a dirty log is not a pass — Station 8's log audit is mandatory.
3. Use ⚪ honestly: a skipped check is `⚪ skipped (<reason>)`, never a silent omission or a ✅.
4. A check that passes on stub data is not a passing check — ask what it would say if the
   feature were a convincing prop.
5. Every finding ends with exactly one disposition: fixed live | GitHub issue #n | backlog
   (named home) | by design (why).

---

## Scope of this version

Supersedes `-005` (unexecuted; `docs/private/`). Written for the branch
`feat/phase8-decider-forward-port` — the forward-port of the mono's **decider-native
state-machine surface** (mono ADR-0024, demo sync
[2026-08-09](../reference/mono-sync-2026-08-09.md)) and the **CommandBlock packaging sweep**
(demo sync [2026-08-10](../reference/mono-sync-2026-08-10.md)). Every domain machine — cart,
checkout, oms, fulfillment parent, fulfiller child — was rewritten onto the new authoring
surface: one co-located `states.ts` per machine, ONE exported `CommandBlock` per command
(guard / prepare / decide / evolve inlined), structural purity (no deep-copy barriers), and
central `decide`/`evolve` dispatchers assembled from the blocks. The behavior bar for the sweep
was "every non-decider test passes unmodified" — this run is where the *live* behavior earns the
same claim.

The one sentence that explains half of this document's expected observations:

> A command a state does not list — or that a guard refuses — is **REJECTED**: a typed error to
> the caller, **no transition, no recording, no projection**. A rejection is not a transition.

**The divergence ledger is BINDING.** The demo deliberately differs from the mono, and those
differences are enumerated in [mono-sync-2026-08-10.md](../reference/mono-sync-2026-08-10.md)
("Intentional differences kept"). Do not re-file a ledger divergence as a defect. The ones this
walkthrough leans on: **mock payments only** (no Stripe, no Twisp ledger), **reservations kept on
payment failure** (mono releases them), **single store** (`demo`), **no return-window / SLA
timers** (the returns path exists; nothing auto-closes it), **no catalog or inventory machines**
(inventory is the non-machine `demo.inventory.service` CQRS bridge), **simulated fulfillment**
with memo-driven delays, and **workflow-id-derived tracking numbers**.

State diagrams are **generated, never hand-drawn** — read
[state-machine-diagrams.md](../reference/state-machine-diagrams.md) (all mermaid) alongside the
stations rather than expecting diagrams here; `npm run docs:diagrams:check` in Station 1 is what
keeps them honest.

## Differences from the mono route (omitted stations, one line each)

- **Multi-tenancy isolation** (mono Station 3) — the demo is single-store (`DEMO_STORE_ID =
  'demo'`); there is no second tenant to leak into.
- **Money rails / `verify:rails`** (mono Station 8) — mock payments only; no Stripe listeners,
  no PSP fees, no Twisp ledger to tie out.
- **Merchant-surface hygiene** (mono run-012 class) — the demo's `/admin` is deliberately a
  developer-facing surface; Temporal ⚡ deep links there are a feature, not a leak.
- **Return-window / SLA staleness** (mono `ops:stale` per-status thresholds) — no deadline
  timers exist; `delivered` and `return_requested` wait indefinitely by design, and there is no
  `closed` status.
- **Catalog / inventory-transfer machines** — never ported; demo inventory remains the
  `inventoryServiceWorkflow` singleton (dirty-SKU signals + 5-minute sweep).
- **Projection-service kill/recovery** (mono ADR-0023) — the demo projects from workflow
  activities directly; there is no per-store projection service to kill.
- **Designs / plugins / team admin pages** — no such surfaces in the demo.
- **Process registry / multi-worker-set reaping** — one `dev:up` process pair; `npm run
  dev:status` is the whole story.
- **Lint ratchet, package-range, docs:generate/docs:assertions gates** — the demo's gates are
  typecheck / lint / format / test / diagrams / build; do not go looking for mono-only scripts.
- **Fulfillment fault injection** (mono #151/#158) — the simulated plugin always succeeds; the
  `submitting` failure path is covered by `fulfiller-states.test.ts` / `fulfiller-decider.test.ts`
  and cannot be forced live.
- **Payment-decline path** — `processPayment` is a mock that always approves, so
  "reservations kept on payment failure" cannot be forced by a declined card; it is pinned by a
  checkout `states.test.ts` case, and the live-reachable submit failure is the `CART_CHANGED`
  guard (Station 3), which demonstrably keeps the holds.

## Prerequisites

```bash
export PATH="/opt/homebrew/bin:$PATH"   # homebrew node; this repo is npm, not pnpm
npm run dev:init      # full reset: containers + schema + seeded catalog (2–4 min), OR:
npm run infra:up      # containers only (add infra:up:obs for the observability overlay)
npm run dev:up        # storefront :3000 + workers (concurrently)
```

| Surface | URL |
| --- | --- |
| Storefront | `http://localhost:3000/shop` |
| Admin dashboard | `http://localhost:3000/admin` (orders, inventory, carts, search) |
| Order trace (dev) | `http://localhost:3000/dev/order-trace` |
| System logs / errors (dev) | `http://localhost:3000/dev/logs`, `/dev/system-errors` |
| In-app docs | `http://localhost:3000/docs` |
| Temporal UI | `http://localhost:8233` (namespace `default`) |
| Temporal gRPC | `localhost:7233` (the `temporal` CLI's default address) |
| Elasticsearch | `http://localhost:9200` |
| Cassandra | `localhost:9042` (`docker exec -i demo-cassandra cqlsh`, keyspace `catalog`) |
| Jaeger / Prometheus / Grafana | `:16686` / `:9090` / `:3200` (only with `OTEL_ENABLED=true` + the observability compose overlay) |

Every workflow ID is `demo.{domain}.{entityId}` (ADR-0011): `demo.cart.<cartId>`,
`demo.checkout.<cartId>`, `demo.order.<orderId>`, `demo.fulfillment.<orderId>`,
`demo.fulfiller-order.so-<8hex>`, `demo.inventory.service`. The journey's `correlationId` is a
dedicated UUID minted at cart creation — deliberately ≠ the cartId — carried as a Search
Attribute on every workflow in the journey.

---

## Station 0 — Stack bringup & preflight

Prove the running stack is the branch under test. The most common way a validation run lies is
by testing yesterday's workers: **workers load workflow code at start and do not hot-reload it**
(and do not re-read `.env.local`), so any workflow-code change — and this branch rewrote every
machine — is only live after the workers are **restarted** (Ctrl-C `dev:up`, start it again;
there is no dist build step — `tsx` loads the TypeScript directly). See
`.agent/workflows/demo-temporal-worker-changes.md`.

**Deploy-boundary check — run it first, and mean it.** This branch renamed and moved
workflow-side code wholesale. A workflow started before the migration and still Running will
replay against code that no longer matches its history
(`WORKFLOW_TASK_FAILED_CAUSE_NON_DETERMINISTIC_ERROR`). On a freshly initialized stack this is
moot; on a stack that has been up across the migration it invalidates the run. List open
workflows (`temporal workflow list --query "ExecutionStatus='Running'"`), compare their start
times to the workers' start time, and terminate stragglers (pre-prod) before proceeding. Record
which case it was.

**Claude-performed tests**

| Check | Command / method | Expected |
| --- | --- | --- |
| Branch + tree state | `git branch --show-current`, `git log --oneline -1` | `feat/phase8-decider-forward-port` (or `main` post-merge); cite the sha in the session record |
| Containers up | `npm run infra:ps` | cassandra, elasticsearch, temporal, temporal-ui (± observability) all `Up` |
| Workers restarted after the branch was checked out | `dev:up` log timestamps | Workers started AFTER the last workflow-code change; restart if in doubt |
| Deploy boundary | `temporal workflow list --query "ExecutionStatus='Running'"` | Only `demo.inventory.service` (and live carts you know about) — nothing Running from before the migration |
| All six task queues have pollers | `npm run workers-wait` | identity, inventory, cart, checkout, oms, fulfillment queues polling; exits 0 |
| System health checks | `npm run dev:validate` | `✅ All Validation Checks Passed!` — Failed: 0 |
| Service status | `npm run dev:status` | Infrastructure + application rows up; flags (`OTEL_ENABLED`, …) as intended for this run |
| DB populated | `npm run db:verify` | Schema tables present; seeded products/variants non-zero |
| Journal table exists | `docker exec demo-cassandra cqlsh -e "DESCRIBE TABLE catalog.inventory_history;"` | `PRIMARY KEY ((correlation_id), at, seq)` with operation/actor/details columns |
| Retired surface stays retired | `grep -rn "defineDomain\|defineTransitions\|definePureState" src/temporal --include="*.ts" \| grep -v framework` | Zero hits outside the vendored framework's own historical comments and its retirement-pin test |

**User-performed tests**

| Step | What to verify |
| --- | --- |
| Restart `npm run dev:up` on the branch under test | Both `storefront` and `workers` prefixes come up with no red error output |
| Open `http://localhost:3000/shop` | Product grid renders with images and prices |

**Scope declaration** — record in the session-record header before Station 1: branch + sha under
test; payment mode (always mock in this repo — state it anyway); the Known Issues list below
re-checked against the tree (anything on it is *expected*, not rediscovered).

---

## Station 1 — Gates (container-free)

Everything CI runs, plus the local-only build. Exercises the pure decider/block tests, the
workflow-environment suites, and the generated-diagram ratchet — none of it needs Docker. A
failure here stops the run.

**Claude-performed tests**

| Check | Command / method | Expected |
| --- | --- | --- |
| Types | `npm run typecheck` | Exits 0, no output |
| Lint | `npm run lint` | 0 errors (one pre-existing warning in the generated `coverage/` artifact is known) |
| Format | `npm run format:check` | "All matched files use Prettier code style!" |
| Tests | `npm test` | **709 tests / 65 files** green, no containers (baseline from the 2026-08-10 sync: 607 + the five decider suites' block/no-mutation coverage). Re-baseline if it moves and record the number |
| Diagram ratchet | `npm run docs:diagrams:check`, then **fail-prove it once**: perturb one machine's `route` table, re-run, confirm drift is reported, revert | Strict + check pass on the clean tree; the perturbed run FAILS. A generator that cannot fail would pass forever |
| Production build | `npm run build` | Next.js build completes green |
| Tree still clean | `git status --short` | No stray churn from running the gates |

**User-performed tests** — none (observe the reported counts).

---

## Station 2 — Cart: edits, guards, abandonment

The shopper path's first machine, and the first place the decider-native surface is observable
live. Cart edits run guard → prepare → decide → evolve; reservations are per-variant
release-then-re-reserve (ledger divergence — not the mono's absolute sku holds), and the edit
blocks **compensate by re-reserving the old quantity before throwing** if the new reserve fails.
While the user shops, Claude tails the journal keyed by the journey's **correlationId** (read it
from the cart workflow's `CorrelationId` Search Attribute — it must be ≠ the cartId).

**Claude-performed tests**

| Check | Command / method | Expected |
| --- | --- | --- |
| Identify the cartId | From the user (cart page) or newest row in `/admin/carts` | A UUID naming `demo.cart.<cartId>` |
| Resolve the correlationId | `temporal workflow describe -w demo.cart.<cartId>` → `CorrelationId` Search Attribute | A UUID, present immediately after add-to-cart, **distinct from the cartId** |
| RESERVE rows on add-to-cart | `docker exec demo-cassandra cqlsh -e "SELECT at, seq, operation, actor, blank_sku, quantity, new_status FROM catalog.inventory_history WHERE correlation_id='<correlationId>';"` | One RESERVE per line, `new_status: TEMPORARY`, actor `demo.cart.<cartId>` |
| Quantity edit is journaled | Re-run the journal query after the user edits quantity | RELEASE + RESERVE rows reflecting the change (per-variant re-reserve — ledger divergence, not churn to fix) |
| Transition recorded per accepted command | `docker exec demo-cassandra cqlsh -e "SELECT seq, from_state, to_state, event_type FROM catalog.workflow_state_transitions WHERE store_id='demo' AND workflow_id='demo.cart.<cartId>';"` | Ordered `seq`; one row per accepted command; **none** for rejected ones |
| **Last-routed-wins abandonment** | Have the user remove the LAST line from the cart; then `temporal workflow describe -w demo.cart.<cartId>` | `removeItem` decides `[ItemRemoved, CartAbandoned]` and routing takes the **last routed event**: the cart workflow **Completes** with final state `abandoned`. The shell never re-checks `items.length === 0` — the decider decided the abandonment. A cart left Running after emptying is a defect |
| Abandoned cart projected | `curl -s 'localhost:9200/carts/_search?q=status:abandoned&size=1'` | The emptied cart's doc, status `abandoned` |

**User-performed tests**

| Step | What to verify |
| --- | --- |
| Browse, open a product, add to cart | Cart badge updates; report the cartId to Claude |
| Edit a quantity up and down | New quantity sticks after refresh; totals recompute |
| Add a second item, then remove one line | The removed line does not come back |
| Empty the cart entirely | UI returns to an empty cart cleanly; the next add starts a fresh cart workflow (new cartId) |

**What would indicate a defect:** an edit accepted while the journal shows no reservation
movement; a transition row for a rejected command; the emptied cart's workflow still Running;
correlationId == cartId.

---

## Station 3 — Checkout: mock payment, the reviewed-version guard, the submit freeze

Checkout is a child workflow (`demo.checkout.<cartId>`) with one accumulating state
(`collecting`) after a transitional `validating` hop. Entry performs an **in-place renew** of the
cart's TEMPORARY holds (RENEW rows, no RELEASE/RESERVE pair). The payment path is entirely
**mock** — `processPayment` waits 500 ms and approves. Three behaviors under test are pure
decider-surface behaviors:

- **The recompute nudge**: the cart's edit effects signal the checkout child (`recompute`) with
  the new cartVersion; checkout re-pulls the cart and re-prices shipping/tax, so it never prices
  a stale snapshot.
- **The `CART_CHANGED` reviewed-version guard**: `submitOrder` accepts an optional
  `reviewedCartVersion`; if it no longer matches the live cart, the submit fails with
  `CART_CHANGED` **before** any payment or order write, and the freeze is aborted.
- **The submit freeze**: `submitOrderBlock.prepare` signals the parent cart `submitStarted`
  (best-effort — ledger divergence; mono signals unconditionally) so cart edits are rejected by
  the shared `notWhileSubmitting` guard while the pipeline runs, and `submitAborted` un-freezes
  on any failure.

**Claude-performed tests**

| Check | Command / method | Expected |
| --- | --- | --- |
| In-place renew at checkout entry | Journal query after the user starts checkout | RENEW rows for the existing holds, actor `demo.checkout.<cartId>`; **no** RELEASE+RESERVE pair |
| Recompute nudge | With the user parked on the review step, have them edit the cart quantity in a second tab; poll `temporal workflow query -w demo.checkout.<cartId> --type getCheckoutStateForCheckout` | Totals (subtotal, tax, shipping-inclusive total) re-price to the new contents; the review page reflects it on refresh |
| **CART_CHANGED guard** | Read the live cartVersion from the query above; have the user edit the cart again (version bumps); then `temporal workflow update execute -w demo.checkout.<cartId> --name submitOrder --input '{"reviewedCartVersion": <the OLD version>}'` | The update **returns** (not errors) a checkout state with `error: "CART_CHANGED"`, step unchanged. No order exists, no CONFIRM rows in the journal |
| **Reservations KEPT on submit failure** (ledger divergence) | Immediately after the CART_CHANGED failure: `docker exec demo-cassandra cqlsh -e "SELECT reservation_id, status FROM catalog.inventory_reservations_w;"` (filter to this cart) | The holds are still `TEMPORARY` — nothing was released; the shopper can retry submit without re-reserving. (Mono releases here.) A declined-payment repro is ⚪ not forceable — the mock always approves; the divergence is pinned by checkout `states.test.ts` |
| **Submit freeze rejects edits** | Arm two commands. 1: `temporal workflow update start -w demo.checkout.<cartId> --name submitOrder --input '{}' --wait-for-stage accepted`; 2 (immediately): `temporal workflow update execute -w demo.cart.<cartId> --name cartUpdate --input '{"type":"updateQuantity","lineItemId":"<id>","quantity":3}'` | Command 2 fails with a **non-retryable ApplicationFailure whose message is the guard's reason: `Order is being placed — please wait`**. No transition row is recorded for it and the cart contents are unchanged — a rejection is not a transition. (If the pipeline wins the race the edit reports the cart already completed — re-run with a fresh cart; ~3 s window) |
| Order confirmed | Journal query after the submit completes | CONFIRM rows (`new_status: CONFIRMED`); checkout workflow **Completed** with step `complete`; cart workflow Completed (`CartCompleted` clears the checkout link — ledger divergence: the child already closed) |

**User-performed tests**

| Step | What to verify |
| --- | --- |
| Checkout: address → payment (mock) → review | Each step advances; totals include shipping + tax |
| Watch the review totals after the second-tab cart edit | They catch up to the edit (the nudge) — no stale price at submit |
| Submit the order | Confirmation page shows a confirmation number — note it for Stations 4–7 |

**What would indicate a defect:** a submit that succeeds against contents the shopper never
reviewed when `reviewedCartVersion` was supplied; holds released after a failed submit; an edit
accepted mid-freeze; `CART_CHANGED` surfacing as a thrown error rather than a returned state.

---

## Station 4 — Order intake: the three transitional hops

On submit, checkout starts `demo.order.<orderId>`. The three intake states are **transitional**:
the framework never waits in them — each synthesizes its command on entry and the transition is
recorded with trigger `automatic`. The commands are `capturePayment` (decides a bare
`PaymentCaptured` — ledger divergence: no capture payload, no ledger effect; the demo took mock
payment at checkout), `assignFulfillers` (`prepare` resolves fulfillers + mints assignment ids),
and `requestFulfillment` (`prepare` mints `so-<8hex>` fulfiller-order ids; the child start +
indexing are the `FulfillmentRequested` effect). An order should traverse
`pending_assignment → assigning_fulfillers → requesting_fulfillment → processing` in seconds.

**Claude-performed tests**

| Check | Command / method | Expected |
| --- | --- | --- |
| The three hops, recorded as automatic | `docker exec demo-cassandra cqlsh -e "SELECT seq, from_state, to_state, event_type, trigger FROM catalog.workflow_state_transitions WHERE store_id='demo' AND workflow_id='demo.order.<orderId>';"` | `pending_assignment→assigning_fulfillers` (`PaymentCaptured`), `→requesting_fulfillment` (`FulfillersAssigned`), `→processing` (`FulfillmentRequested`), each with an `automatic` trigger — nothing timed out; the states advance by design |
| No-resolution fallback is an edge, not a hang | Read the same table / the state diagram | `NoFulfillersResolved → ready_to_fulfill` exists as a route; with seeded fulfillers it should NOT be taken — if it was, that is the finding |
| Order projected | `curl -s 'localhost:9200/orders/_search?q=confirmationNumber:<CONF>'` | One doc; status `processing`; `correlationId` = the journey UUID |
| Fulfillment children started | `temporal workflow list --query "CorrelationId = '<correlationId>'"` | `demo.fulfillment.<orderId>` and `demo.fulfiller-order.so-…` now present, correlation-tagged (started with `parentClosePolicy: ABANDON`) |

**User-performed tests**

| Step | What to verify |
| --- | --- |
| Open `/admin/orders` right after submitting | The order appears and is already `processing` (or passes through intake too fast to see — that is the pass) |

**What would indicate a defect:** an order parked in an intake state (the mono treats >1 h there
as provably stale; here anything beyond seconds is wrong); a transition recorded with a
non-`automatic` trigger for an intake hop; an order in `ready_to_fulfill` with seeded fulfillers.

---

## Station 5 — Simulated fulfillment: memo delays and tracking numbers

The fulfiller child (`demo.fulfiller-order.so-<8hex>`) auto-advances
`received → submitting → in_production → shipped → delivered` on **simulation timers whose
durations ride workflow memo** (`processingDelayMs`, `shippingDelayMs`, `deliveryDelayMs` — read
once at workflow start, **default 15000 ms each**; nothing in the app sets the memo today, so
the defaults are what you will observe: ~15 s to ship, ~30 s more to deliver). The timers
synthesize `simulatedShip` / `simulatedDeliver` commands; `MANUAL_FULFILLMENT=true` (the
`/admin/orders` Fulfillment Mode toggle, read at child start) makes `onTimeout` return null so
the order waits for `fulfillerStatus` updates instead. Partial shipments deliberately
auto-complete on the same timer — do not re-report it.

**Claude-performed tests**

| Check | Command / method | Expected |
| --- | --- | --- |
| Auto-advance timing | Watch `demo.fulfiller-order.so-…` in the Temporal UI | `in_production` for ~15 s, `shipped` for ~30 s, then Completed `delivered` — matching the memo defaults |
| **Workflow-id tracking number** (ledger divergence) | `temporal workflow query -w demo.order.<orderId> --type getOrderState` → fulfiller orders' `trackingNumber`; cross-check the shipments doc: `curl -s 'localhost:9200/shipments/_search?q=correlationId:<correlationId>'` | `SIM` + the child workflow id's first 8 chars uppercased — `simulatedShipBlock.prepare` derives it from the id (mono derives from the timestamp in `evolve`). **NB:** with ADR-0011 dot-ids the first 8 chars are the constant prefix `demo.ful`, so every simulated shipment reads `SIMDEMO.FUL`. Record it; whether the derivation should use the entity segment (`so-…`) instead is a backlog candidate, not a walkthrough failure |
| FULFILL journaled | Journal query (Station 2) after delivery | FULFILL rows, actor `demo.fulfiller-order.so-…`, carrying a `fulfiller_id`; `reserved_stock` back to baseline and `total_stock` decremented in `catalog.inventory_stock_w` |
| Aggregation decides the outcome | Order transitions after delivery | `processing → shipped → delivered` driven by `FulfillmentShipped` / `FulfillmentDelivered` — the machine decides the OUTCOME event; the shell never re-inspects the applied status |
| Manual mode holds | Toggle Fulfillment Mode to Manual, place a second order | Its fulfiller child parks in `in_production` (idle ticks, no `simulatedShip`); toggle back to Automatic for the rest of the run — **the flag is read at child start**, so the parked order stays manual |

**User-performed tests**

| Step | What to verify |
| --- | --- |
| Watch `/admin/orders/<orderId>` for ~a minute | Status walks processing → shipped → delivered on its own; shipped/delivered emails appear in the communications log |
| Open the order in `/dev/order-trace` (by confirmation number) | The full tree renders — cart, checkout, order, fulfillment, fulfiller-order — with transitions, activity captures, and the teal Inventory History journal, actor badges linking back to the right nodes |

**What would indicate a defect:** an Automatic-mode order that never ships; a delivered order
whose holds are still CONFIRMED; a tracking number not of the `SIM` + id-prefix form; the order
machine reaching `delivered` without the fulfiller child having delivered.

---

## Station 6 — OMS lifecycle: admin moves, refund, returns

The order machine's post-intake surface. Admin `updateStatus` decides a **per-target event**
(`OrderShipped`, `OrderDelivered`, …) so every admin jump is a visible edge in the generated
diagram; anything not in `FORCEABLE_STATUSES` (`processing`, `partially_shipped`, `shipped`,
`delivered`, `return_requested`, `cancelled`, `refunded`, `returned`, `complete` — ledger
divergence: no `closed`) is **guard-rejected, never a decide-throw**. Refunds are the demo's
mock math (`computeRefundRecord`: pro-rated tax, over-refund guard) with no ledger posting. The
returns path is `requestReturn → return_requested → {confirmReturn → returned | denyReturn →
delivered}` with **no SLA timers** — the review state waits indefinitely. The admin UI offers
only the valid next-step buttons, and there is **no UI for refunds or returns** — those are
driven through Temporal updates (the CLI), which is itself the point: the machine, not a
controller, owns validity.

Use a fresh **delivered** order from Station 5 (Automatic mode makes one in under a minute).

**Claude-performed tests**

| Check | Command / method | Expected |
| --- | --- | --- |
| **Guard-rejected unforceable status** | `temporal workflow update execute -w demo.order.<orderId> --name updateStatus --input '{"status":"pending_assignment","updatedBy":"admin"}'` | Non-retryable failure: `Unexpected status in updateStatus: pending_assignment`. Order status unchanged, **no transition row recorded**, projection untouched — the typed-rejection contract, end to end |
| Forced move IS an edge | On a `processing` order (manual-mode one from Station 5): `... --name updateStatus --input '{"status":"shipped","updatedBy":"admin","note":"walkthrough probe"}'` | Accepted; decides `OrderShipped`; a `shipped` status email is the state-level effect (aggregate-driven versions send nothing) |
| **Partial refund stays delivered** | On the delivered order: `temporal workflow update execute -w demo.order.<orderId> --name refundOrder --input '{"lines":[{"lineItemId":"<id>","quantity":1}],"reason":"partial probe","updatedBy":"admin"}'` (line ids from `getOrderState`) | Returns the state with a refund record — pro-rated tax, `refund-1` id; `Refunded` routes SELF, status still `delivered` |
| Over-refund guard | Re-run the same partial with a quantity exceeding the remainder | Guard rejection (refund-selection problem named), not a decide-throw; no record appended |
| **Full refund is terminal** | `... --name refundOrder --input '{"reason":"full refund probe","updatedBy":"admin"}'` (no lines = full remainder) | A second refund record for the remainder AND `OrderRefunded` → terminal `refunded` (last routed event wins); `refunded` email sent; workflow Completed |
| **Returns: request → deny → request → confirm** | On a second delivered order: `--name requestReturn --input '{"reason":"walkthrough","updatedBy":"customer"}'` then `--name denyReturn --input '{}'` then request again, then `--name confirmReturn --input '{"reason":"approved"}'` | Request → status `return_requested` (record stored); deny → back to `delivered`, request cleared; confirm → refund issued for the requested lines, `returned` email, terminal `returned`. Between steps the state waits indefinitely — **no return-window/SLA auto-close exists** (ledger divergence); a state that closed itself would be the defect |
| `delivered` layers its refund guard | `--name updateStatus --input '{"status":"refunded","updatedBy":"admin"}'` on an already-fully-refunded... use the FIRST order post-full-refund — it is terminal, so instead run this on a fresh delivered order | The admin `refunded` status is **enriched into a real `refundOrder` command** — it records a real refund with trued-up tax, not a bare status stamp |
| Terminal is terminal | Any update against the `refunded`/`returned` order | `Workflow is in a terminal state` / already-completed — no zombie acceptance |

**User-performed tests**

| Step | What to verify |
| --- | --- |
| `/admin/orders/<orderId>` on a live order | Only the valid next-step buttons render (`→ Ready to Fulfill` / `→ Processing` / `→ Shipped` / `→ Delivered` / `✕ Cancel`); a terminal order shows "No further actions available" |
| Walk one order shipped → delivered via the buttons | Each move lands; the status pipeline strip advances; status history records `updated_by: admin` |
| Open the refunded and returned orders' Status History (order-trace) | The refund/return hops are visible transitions with their events, not silent field edits |

**What would indicate a defect:** a forced unforceable status accepted; a transition/projection
row for a rejected update; refund math over-refunding or skipping the tax pro-rate; a
`return_requested` order auto-closing.

---

## Station 7 — Cross-cutting reads: admin, dev tools, Temporal UI

The read models against the writes Stations 2–6 made. Low-interaction; may be batched with
Station 8's presentation, results still recorded per station.

**Claude-performed tests**

| Check | Command / method | Expected |
| --- | --- | --- |
| One-id query | `temporal workflow list --query "CorrelationId = '<correlationId>'"` | The whole journey — cart, checkout, order, fulfillment, fulfiller-order(s) — from one query (no accounting workflows: ledger divergence). IDs parse as `demo.{domain}.{entityId}` |
| Inventory singleton healthy | `temporal workflow describe -w demo.inventory.service` | Running, type `inventoryServiceWorkflow`; recent sweep timer firings in history |
| Order counts reconcile three stores | ES `orders/_count` vs `SELECT count(*) FROM catalog.orders` vs `temporal workflow list --query "WorkflowType='orderWorkflow'"` | Equal (explain any divergence — do NOT compare the admin list to ES alone; the admin list IS ES, so that check cannot fail) |
| Reservations read model consistent | `/admin/inventory` Reservations tab vs `catalog.inventory_reservations_w` | Same rows; Active scope hides terminal rows, All reveals them |
| Feature flags API | `curl -s http://localhost:3000/api/admin/feature-flags` | JSON including `MANUAL_FULFILLMENT` (left `false` after Station 5) |
| system_errors clean | `curl -s 'http://localhost:9200/system_errors/_count'` | Unchanged since session start — 5xx-only by design; the walkthrough forced no server failures |
| Structured logs correlated | `grep -c '"correlationId":"<correlationId>"' logs/demo-workers-$(date +%F).log` | > 0 — activity log lines carry the ambient correlationId |

**User-performed tests**

| Step | What to verify |
| --- | --- |
| `/admin` dashboard | Cards render; "Patterns Demonstrated" reads accurately for the decider-native surface |
| `/admin/carts` | Status chips filter; the abandoned cart from Station 2 and completed carts are findable by cartId/email |
| `/admin/search` | Pick 2–3 indexes (orders, reservations, shipments); hits render with the lifecycle filter |
| `/admin/orders` → an order's Temporal ⚡ link | Opens the Temporal UI querying the minted correlationId and lists the journey (dev-facing by design — not the mono's merchant-surface leak class) |
| `/dev/order-trace` timeline | Default window fits cart→fulfiller-order (order bar clipped ▸); pan/zoom/reset work |
| `/dev/logs`, `/docs` | Both service tags present; the docs browser renders (this walkthrough is not in its curated list — that is expected, not missing) |

---

## Station 8 — Deep probes & the log audit (Claude-heavy)

Failure-mode probes the UI cannot reach, plus **the log audit, which is mandatory**. Run
destructive probes SERIALLY and restore each before the next. The journal is the instrument: it
is the only operation-level record. System actors (expiry-sweep, preemption, reconciler) journal
under the reservation row's stored journey key (`rowJournalKey` — AGENTS.md invariant 6).

**Claude-performed tests**

| Check | Command / method | Expected |
| --- | --- | --- |
| Scripted E2E to FULFILL | `npx tsx --env-file=.env.local scripts/verify-checkout.ts` | `🎉 E2E Verification Check Completed Successfully with ZERO Errors!` — record the duration. It prints only the cartId; resolve its correlationId the Station-2 way |
| Journal for that order | Journal query with the script's correlationId | RESERVE → RENEW → CONFIRM → FULFILL in order, correctly attributed actors |
| Drift probe (at rest) | Compare each SKU's `reserved_stock` in `catalog.inventory_stock_w` to the sum of TEMPORARY/CONFIRMED quantities in `catalog.inventory_reservations_w` | Zero mismatch |
| Inject drift → reconciler heals | `docker exec demo-cassandra cqlsh -e "UPDATE catalog.inventory_stock_w SET reserved_stock = 99 WHERE blank_sku='<sku>' AND fulfiller_id='<fid>';"` then wait for the ≤5-min sweep (plant early, poll later) | Counter restored; a `DRIFT_CORRECTION` journal row under `correlation_id='__platform__'`, actor `reconciler`, details showing before/after |
| Expiry-sweep RELEASE | Create a hold (add to cart, abandon the tab), backdate `expires_at` in **BOTH** `catalog.inventory_reservations_w` AND the `inventory_reservations_by_status_w` mirror (the scan reads the mirror), wait for the sweep | RELEASE row with actor `expiry-sweep` under the row's stored journey key; `reserved_stock` released |
| Reindex wipe guard | `curl -s -X POST http://localhost:3000/api/dev/reindex -H 'Content-Type: application/json' -d '{"index":"system_errors"}'` | HTTP 400 — system_errors has no Cassandra source and is never reindexed |
| Forced 4xx logs at warn, not ERROR | Same endpoint with `{"index":"nope"}`, then grep `Unknown index: nope` in `logs/demo-web-$(date +%F).log` | HTTP 400; a level-40 line; `system_errors/_count` unchanged |
| Standalone activities live | `npm run smoke:standalone` | Round-trip `echo:hello-standalone`; exit 0 |
| **Log audit (mandatory)** | Aggregate every `level >= 40` line in `logs/demo-*-$(date +%F).log` since session start; group by message; triage each as expected-probe / known-benign / **NEW** in a `\| # \| Lines \| Level \| Message \| Verdict \|` table | Zero unexplained lines. Known-benign: the forced-400 warns (this station), the best-effort `Failed to signal cart submit-freeze phase` warn (only when the parent cart already closed), `Failed to send recompute nudge` (same class). NOT benign: `Cannot confirm non-TEMPORARY reservation` / `Reservation already terminal` (the pay-after-expiry path — check that order's accounting; issue #34); any level≥40 `Failed to notify parent` (the child→parent race must log info) |

**Probes that cannot be forced live** — name them in the record rather than burning the run:
payment decline (mock always approves — pinned by checkout `states.test.ts`); the fulfiller
`submitting` failure (simulated plugin always succeeds — `fulfiller-*.test.ts`); concurrent CAS
contention at scale (unit-covered).

**User-performed tests**

| Step | What to verify |
| --- | --- |
| Watch `/admin/inventory` during the drift probe | The bogus counter is visible, then heals after the sweep |
| Confirm before each destructive probe | OK to proceed, and the restore succeeded afterward |

---

## Station 9 — Wrap-up

**Claude-performed tests**

| Check | Command / method | Expected |
| --- | --- | --- |
| Tally | Count station statuses | Recorded in the session record |
| Defect table | `\| # \| Defect \| Disposition \|` | Every finding has exactly one disposition |
| Gates re-run after any live fix | Station 1 chain | All green against the final tree |
| Session record finalized | `docs/private/validation-session-<date>-006.md` | Complete, verbatim user comments included; `git status` shows no docs/private churn (gitignored); back up with the `sync-private-docs` skill |
| Next version written | `docs/validation/validation-walkthrough-<date>-007.md` | Contains this run's amendments; **this `-006` stays frozen** once executed |
| Committed | git | The next walkthrough version committed; session record stays private |

Close the record with the user's overall verdict in their own words, the amendments going into
`-007`, and any promotions (GitHub issue / backlog) decided during the run.

---

## Known issues at the time of writing (do not rediscover)

- **Pay-after-expiry accounting**
  ([issue #34](https://github.com/night-heron-software/temporal-commerce-demo/issues/34)) — a
  hold that expires at the payment step can be resold; the submit refunds and fails, but the
  warn lines in Station 8's audit are the tripwire, not noise.
- **Simulated tracking numbers are currently the constant `SIMDEMO.FUL`** — the workflow-id
  derivation predates the ADR-0011 dot-prefixed ids, so the first 8 chars are the shared
  prefix. The derivation itself is a ledger divergence (keep); deriving from the entity segment
  is a backlog candidate (Station 5).
- **No UI for refunds or returns** — deliberately CLI/update-driven in the demo (Station 6);
  absence of buttons is not a missing feature to file.
- **Partial shipments auto-complete on the simulation timer** — by design (documented in the
  fulfiller states file); `MANUAL_FULFILLMENT` is the escape hatch.
- **`workflowTaskTimeout: '2m'` on the cart start path only** — every other start takes
  Temporal's 10 s default; relevant when timing stalls.
- **System releases journal under the row's stored journey key** — for legacy rows that is the
  `cart_id` fallback, not the minted journey UUID; the order trace merges both partitions.

**Standing facts, not issues:** the demo is single-store; `fulfillers` and stock are global by
design; `npm run dev:init` is a full re-provision, not a migration; workers must be restarted
after workflow-code changes (no hot reload, no `.env.local` re-read).
