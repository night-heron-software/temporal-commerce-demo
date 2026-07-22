# Validation Session — 2026-07-22

Session record for a run of [docs/validation-walkthrough.md](../validation-walkthrough.md).

- **Date:** 2026-07-22
- **Branch:** `feat/in-place-renew`
- **Conductor:** Claude (Claude-performed tests, questions, transcription)
- **User:** Jeff (browser/UI steps, observations, verdicts)
- **Scope:** full system as of PR chain #20–#24

---

## Station 0 — Setup

**Claude-performed tests**

| Check | Result |
| ----- | ------ |
| Restart `dev:up` on `feat/in-place-renew` (user chose Claude-restarts) | ✅ old processes killed cleanly; relaunched in background |
| `npm run workers-wait` | ✅ all 6 task queues have pollers |
| `npm run dev:validate` | ✅ all health checks passed, 0 failed, 0 skipped |
| Storefront `/api/health` | ✅ HTTP 200 on :3000 |
| `inventory_history` table exists (cqlsh COUNT) | ✅ table present in keyspace `catalog` |

**User-performed tests**

| Step | Result |
| ---- | ------ |
| Chose restart mode | ✅ delegated restart to Claude |

**User comments & suggestions**

None.

Status: ✅ PASS

---

## Station 1 — Gates

**Claude-performed tests**

| Check | Result |
| ----- | ------ |
| `npm run typecheck` | ✅ clean |
| `npm run lint` | ✅ clean |
| `npm run format:check` | ✅ all files use Prettier style |
| `npm test` | ✅ 35 files, **320 tests** passed |
| `npm run docs:diagrams:check` | ✅ diagrams + state-graph.json up to date |
| `npm run build` | ✅ compiled successfully, 53/53 pages |
| `git status` clean (no `logs/` side effects) | ✅ only session-record edits present |

**User-performed tests**

| Step | Result |
| ---- | ------ |
| (none at this station) | — |

**User comments & suggestions**

None.

Status: ✅ PASS

---

## Station 2 — Storefront flow

Order: cart `7eaa511d-04f1-476d-8f4a-2324891bfb9e`, order `82f46f1b…`, confirmation
**CRU89HK9**, SKU `sim-gildan-18500-2xl-navy` ×1.

**Claude-performed tests**

| Check | Result |
| ----- | ------ |
| Journal sequence for the cart | ✅ RESERVE (actor `demo.cart.7eaa511d…`) → **RENEW in place** (actor `demo.checkout.b9e08f7e…`, TEMPORARY→TEMPORARY) → CONFIRM → TRANSFER (actor `demo.fulfillment.82f46f1b…`) → FULFILL (actor `demo.fulfiller-order.so-02cf6caa`) |
| No RELEASE/RESERVE pair at checkout (in-place-renew regression check) | ✅ single RENEW row — #24 behavior confirmed live |
| Actor attribution spans four workflows, correlated by cartId | ✅ cart, checkout, fulfillment, fulfiller-order |
| Order reached `delivered`; counters closed | ✅ `total_stock 100→99`, `reserved_stock 0`, reservation FULFILLED |

**User-performed tests**

| Step | Result |
| ---- | ------ |
| Browse → add to cart → checkout → mock payment → confirmation | ✅ "All steps worked" |
| Quantity-edit sub-step | ⚪ skipped (single qty-1 item; no cart-edit journal rows) — no RENEW-with-delta exercised this run |

**User comments & suggestions**

None (no confirmation number noted; Claude recovered it from Cassandra).

Status: ✅ PASS

---

## Station 3 — Admin tour

**Claude-performed tests**

| Check | Result |
| ----- | ------ |
| Backend projections behind the pages | ✅ ES `inventory` doc + `inventory_stock_summary` both 99/0 for the ordered SKU; cart indexed; order indexed `delivered` |
| Root-cause of FULFILLED reservation showing (user finding) | ✅ identified — `admin-inventory-actions.ts:89-91` full-scans `inventory_reservations_w`, which retains terminal rows by design; pre-#20 FULFILL never fired so terminal FULFILLED rows are newly visible |
| ES `reservations` index state | ✅ empty as expected (doc deleted at fulfill) |

**User-performed tests**

| Step | Result |
| ---- | ------ |
| Dashboard cards + Patterns Demonstrated card | ✅ render correctly |
| Orders page: CRU89HK9 delivered, manual-fulfillment toggle present | ✅ |
| Inventory page stock numbers | ✅ data correct, but see issue below |
| Carts page lists the cart | ⚠️ see issue below |
| Search returns the order | ✅ |

**User comments & suggestions**

> "A reservation still shows up with status FULFILLED on /admin/inventory with reservations
> selected. The carts page has no way to search for non-active carts."

Status: ⚠️ PASS with 2 findings → Follow-ups #1, #2

---

### (Station 3 findings promoted to Follow-ups)

1. **/admin/inventory reservations view shows terminal rows** — reads the full
   `inventory_reservations_w` write table (terminal rows retained by design; newly visible now
   that FULFILL works post-#20). Fix: default to the active registry
   (`getActiveReservations()`) or add a status filter with active-only default.
2. **/admin/carts cannot find non-active carts** — no search/filter for completed or abandoned
   carts. Fix: status filter + lookup by cartId/email against the `carts` ES index.

---

## Station 4 — Dev tools

**Claude-performed tests**

| Check | Result |
| ----- | ------ |
| Force test error (`POST /api/dev/reindex {"index":"nope"}`) | ✅ 400 with correlationId; flowed to `system_errors` |

**User-performed tests**

| Step | Result |
| ---- | ------ |
| Order Trace CRU89HK9 — three tabs render | ✅ |
| Inventory History section: 5 journal rows, actor badges matching workflow-node domain colors, Temporal UI links | ✅ "Yes, fully correlated" |
| /dev/system-errors shows the forced error | ✅ |
| /dev/logs filters + taskQueue tags | ✅ |
| /docs lists + renders Validation Walkthrough | ✅ |

**User comments & suggestions**

None.

Status: ✅ PASS

---

## Station 5 — Temporal UI

**Claude-performed tests**

| Check | Result |
| ----- | ------ |

**User-performed tests**

| Step | Result |
| ---- | ------ |

**User comments & suggestions**

_pending_

Status: _pending_

---

## Station 6 — Observability

**Claude-performed tests**

| Check | Result |
| ----- | ------ |

**User-performed tests**

| Step | Result |
| ---- | ------ |

**User comments & suggestions**

_pending_

Status: _pending_

---

## Station 7 — Logs

**Claude-performed tests**

| Check | Result |
| ----- | ------ |

**User-performed tests**

| Step | Result |
| ---- | ------ |

**User comments & suggestions**

_pending_

Status: _pending_

---

## Station 8 — Deep probes

**Claude-performed tests**

| Check | Result |
| ----- | ------ |

**User-performed tests**

| Step | Result |
| ---- | ------ |

**User comments & suggestions**

_pending_

Status: _pending_

---

## Station 9 — Wrap-up

**Claude-performed tests**

| Check | Result |
| ----- | ------ |

**User-performed tests**

| Step | Result |
| ---- | ------ |

**User comments & suggestions**

_pending_

Status: _pending_

---

## Follow-ups
