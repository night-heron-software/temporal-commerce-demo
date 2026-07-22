# Repository Review — 2026-07-21

> Full-repo review at `main` = `928d571` (post PR #17/#18/#19): findings, prioritized
> improvement suggestions, and a validation runbook. Document-only — no fixes applied here.
> Line numbers reference `main` at review time.

## Executive summary

The workflow layer is in excellent shape: zero TODO debt, every `condition()` bounded or
intentionally terminal, `allHandlersFinished` guarded before every continue-as-new, a real
cross-domain order-journey e2e running in CI without containers, and the diagrams ratchet
enforced. The problems cluster in one place — **the inventory write path** — where the review
found a **confirmed live regression** introduced by PR #17 (fulfillment's inventory mutations
silently no-oping; see finding 1's correction note) plus four structural integrity holes shared
with the nightheron-mono sibling. The P0 tier was fixed and live-verified the same day on
`fix/inventory-write-path`. Second tier: three states files lack the tests the repo's own
policy requires, and CI never runs `next build`. Third tier: the observability metrics path is
still wired wrong (documented in the observability guide as Known gaps), and a handful of docs
drifted behind the code.

| Tier | Theme                            | Items                         | Effort  |
| ---- | -------------------------------- | ----------------------------- | ------- |
| P0   | Inventory write-path correctness | 7 findings, 1 likely live bug | ~1 day  |
| P1   | Test coverage + CI build gate    | 3 policy gaps + build check   | ~½ day  |
| P2   | Observability completion         | 2-line fix + 1 dashboard      | ~1 hour |
| P3   | Docs + hygiene                   | 5 small items                 | ~1 hour |

---

## P0 — Inventory write-path correctness

All in `src/temporal/inventory/db/inventory-command-repository.ts` unless noted.

### 1. Live regression from PR #17: fulfillment mutations derive IDs that no longer exist

> **Correction (same day):** the original draft named `reconcile()` as the likely live vehicle.
> Implementation of the fix established that `reconcile()` (and `confirmAllForCart()`) have
> **zero callers** — dead code — while the actually-live vehicle is worse: all three
> fulfillment inventory activities.

PR #17 changed `reserveAll` to reserve **once per unique `blank_sku`**, creating reservation IDs
keyed `${cartId}-${blankSku}` (`:889`). But `src/temporal/fulfillment/activities-impl.ts` derives
`${cartId}-${variantId}` in `transferInventoryReservations` (`:54`),
`fulfillInventoryReservations` (`:73`), and `releaseInventoryReservations` (`:98`) — so post-#17
every one of those lookups missed and **silently no-oped**: delivered orders never transferred,
never decremented `total_stock`, and left their reservations CONFIRMED with `reserved_stock`
inflated forever; fulfillment cancellations never freed holds. Confirmed in the live environment:
a pre-fix delivered order left two CONFIRMED, unattributed reservation rows with
`reserved_stock: 2` stuck and `total_stock: 100` undecremented. The dead `reconcile()` and cart
flow (`cart/activities-impl.ts:73`) carry the same variant-keyed scheme, so the codebase ran two
divergent schemes.

**Fix shape:** one shared `buildReservationId(cartId, variantId)` in contracts used by every
site; `reserveAll` keeps one LWT CAS per blank_sku but writes one reservation row per variant
(regression-pinned in `inventory-command-repository.test.ts`).

### 2. Phantom-hold leak: LWT and registry batch are separate ops

`reserve()` CAS-increments `reserved_stock` (`:426-433`), then writes the reservation +
`by_cart` + `by_status` rows in a **separate** batch (`:449-487`). If the batch fails after the
LWT applied, the counter is incremented with no reservation record — a hold nothing can ever
release. `reserveAll`'s rollback (`:900-909`) only covers reserves that returned failure, not a
mid-`reserve()` crash. No reconciler exists to heal this (finding 5).

### 3. Unguarded read-modify-write decrements

Only `reserve()` is LWT-guarded. `release` (`:531-536`), `cancel` (`:644-649`), and `fulfill`
(`:783-788`) decrement stock with plain UPDATEs and `Math.max(0, …)` clamps — concurrent terminal
transitions on the same `(blank_sku, fulfiller_id)` row can lose updates, and the clamp masks
corruption instead of surfacing it. The TTL expiry sweep routes through the same unguarded
`release()` path (`src/temporal/inventory/activities-impl.ts:27-35`).

### 4. Wrong-row release (latent, masked by single-fulfiller seed)

`reserve()` picks a fulfiller row for the LWT (`:412-414`, `:431`) but writes
`fulfiller_id: null` on the reservation (`:460`, `:480`); `release()` then decrements
`stockRows[0]` — the _first_ fulfiller row, with a comment admitting the guess (`:527-536`).
Correct today only because the seed creates one fulfiller per SKU; the schema permits several
(`cassandra/schema.cql:258`).

### 5. No drift reconciler

`projectStockSummaries` copies `reserved_stock` verbatim (`activities-impl.ts:105`); nothing
recomputes it from the sum of active reservations. Leaks from findings 2–4 are therefore
permanent until `dev:init`.

### 6. LWT contention soft-fail never retried

On `[applied]=false`, `reserve()` returns `{success:false, error:'Concurrent modification,
retry needed'}` (`:437-443`). Callers return `null`/`success:false` rather than throwing
(`cart/activities-impl.ts:106-108`, `checkout/activities-impl.ts:277-283`), so Temporal's
activity retry policies never fire — contention surfaces to the shopper as a hard reservation
failure. The "retry needed" hint is dead code.

### 7. Preemption gate ignores renewals

Preemption correctly protects live holds via a `created_at + MIN_HOLD_MS(15m)` gate (`:60-72`) —
but `renewReservation` (`:565-604`) extends `expires_at` without touching `created_at`. A
renewed, _unexpired_ checkout hold older than 15 minutes by wall clock is still preemptible.
Gate should key on `expires_at`.

**Recommended fix shape (mirrors mono's planned ADR-0016 phase):** regression-test then unify
IDs (1); attribute the chosen fulfiller on the reservation at reserve (4); CAS-guard all
decrements with a small bounded retry (3); key preemption on `expires_at` (7); make LWT
contention a retryable error at the activity boundary (6); add a scheduled drift reconciler that
recomputes `reserved_stock` from active reservations and CAS-corrects, logging every correction
(2, 5). Extract eligibility/reconcile computations as pure functions with co-located tests.
Current tests cover only two pure helpers and the mocked singleton loop — none of the seven
findings are covered.

---

## P1 — Test coverage and CI

- **`main`'s lint is red today**: `src/app/dev/logs/page.tsx:120` fails
  `react-hooks/set-state-in-effect` (fetch-on-mount effect from PR #19, missing the repo's
  established disable comment — see `admin/orders/page.tsx:38` for the pattern). Any future PR's
  CI inherits this failure; fix is one comment line. _Discovered during this review's gates._
- **Test-policy violations** (AGENTS.md requires co-located tests for decider/states files):
  `oms/states.ts` (777 lines — the largest states file), `fulfillment/states.ts`, and
  `fulfillment/fulfiller-states.ts` have no dedicated states tests. All five deciders are
  covered; these three are exercised only indirectly via workflow/e2e tests.
- **CI never runs `npm run build`.** Next 16 build/RSC errors pass CI today. Add a build step
  (or job) to `.github/workflows/ci.yml`. No coverage gate exists either (`coverage` script is
  never invoked in CI) — optional.
- **Untested significant modules** (lower priority, listed for the backlog):
  `transition-recorder/repository.ts`, `lib/temporal-client.ts` (incl.
  `executeStandaloneActivity`), `order-trace/trace-service.ts`, all six Server Actions, and
  seven API routes (admin/feature-flags, dev/init/es-indices, dev/order-trace,
  dev/system-errors, product/[productId], seed-cassandra, seed-inventory).

## P2 — Observability completion

> **Update 2026-07-22:** items 1–3 fixed on `fix/observability-metrics` (PROMETHEUS_ENDPOINT,
> scrape target, provisioned Temporal Server dashboard) and live-verified — target UP, dashboard
> rendering real data. Item 4 (application metrics) remains the deliberate leftover.

All four Known gaps in `docs/observability-guide.md` were open at review time:

1. `PROMETHEUS_ENDPOINT` is unset on the `temporal` service (`docker-compose.yml:95-128`
   publishes 9464 but the server never opens the listener).
2. `observability/prometheus.yml:8` scrapes `temporal:9090` — Prometheus's own port — instead of
   `temporal:9464`.
3. `observability/grafana/provisioning/dashboards/json/` contains only `.gitkeep`.
4. No application/worker metrics are exported at all.

Items 1–2 are a two-line fix; item 3 is one provisioned dashboard JSON (a community Temporal
server dashboard works). Landing them flips the guide's Known-gaps section to working behavior.
Item 4 (SDK metrics via `Runtime.install` telemetryOptions) is a separate, larger choice.

## P3 — Docs and hygiene

- `docs/project-description.md:230-247` still carries the stale 13-row patterns table; the admin
  dashboard card (grouped by Entity lifetime / Interaction / Topology / Architecture, ADR-linked)
  is ahead of it. Reconcile the doc to the card.
- **`/dev/logs` (PR #19) shipped with zero documentation** — `docs/developer-guide.md` covers
  `/dev/system-errors` only. Add it to the Logs section and the admin/dev-tools lists.
- Dead contract stubs: `src/temporal/contracts/inventory.ts:144-169` — per-SKU query/signal
  definitions with no implementing workflow and zero references. Delete (they predate the
  singleton-over-entity decision, `docs/temporal-lessons-learned.md` §22).
- `uuid` dependency (+`@types/uuid`) is redundant with `crypto.randomUUID()` (already used by
  the logger); six `uuidv4` call sites to migrate, two deps to drop.
- Minor: `.env.local` vs `.env.example` drift (`OTEL_ENABLED` default, two keys with code-side
  defaults); unauthenticated mutating dev routes (`seed-*`, `dev/reindex`, `dev/init`,
  `admin/feature-flags`) have no NODE_ENV guard — acceptable for a demo, noted for awareness.

### New findings surfaced while writing the P1 states tests (backlog candidates)

- `fulfiller-states.ts` `submitting` never checks `submitFulfillerOrder`'s `result.success` —
  a failed submission still advances to in_production, and the optional `fulfillerOrderId` is
  assigned to the required `fulfillerExternalId`.
- `oms/states.ts` calls `uuid4()` inside `decide` phases (assigningFulfillers, buildFulfillment)
  — replay-safe but contrary to the decider headers' purity doctrine.
- `buildFulfillment` prices line items by `.find()` on variantId — duplicate variantIds under
  one fulfiller both price from the first line.
- `routeByStatus` maps `partially_shipped` to the `shipped` state, whose non-manual timeout
  auto-delivers everything — partial shipments silently complete on the timer.

## What's healthy

Worth naming, because it's most of the repo: zero TODO/FIXME debt anywhere; all workflow awaits
bounded or intentionally terminal (the 863c45f/b741c1e sweep is fully absorbed);
`allHandlersFinished` before every CAN; the time-skipping order-journey e2e
(`src/temporal/order-journey.e2e.test.ts`) runs in CI with only I/O edges mocked; the diagrams
ratchet (`docs:diagrams:check`) is enforced in CI; the reindex wipe-guard protects
`system_errors`; no open issues or PRs; and #17's per-partition `reserveAll` correctly eliminated
LWT self-contention — finding 1 is its only loose end.

---

## Validation runbook

### Container-free (CI-equivalent)

```bash
npm run typecheck && npm run lint && npm run format:check && npm test && npm run docs:diagrams:check
npm run build   # run locally until CI gains a build step
```

Expect ~250 tests in <10s and a clean `git status` (no `logs/` side effects).

### Live sequence

```bash
npm run dev:init        # or reuse running infra
npm run workers-wait    # all 6 task queues have pollers
npm run dev:validate    # 6 read-only health checks
npx tsx scripts/verify-checkout.ts   # the real e2e order journey (recommend wiring as `e2e:checkout`)
npm run smoke:standalone             # proves activity.enableStandalone on the server
npm run dev:status
```

### Targeted probes

- **ID-scheme regression repro (P0 finding 1):** run a full order to delivery
  (`npx tsx --env-file=.env.local scripts/verify-checkout.ts`), then inspect state:

  ```bash
  docker exec demo-cassandra cqlsh -e \
    "SELECT reservation_id, status, quantity, fulfiller_id FROM catalog.inventory_reservations_w;"
  docker exec demo-cassandra cqlsh -e \
    "SELECT blank_sku, total_stock, reserved_stock FROM catalog.inventory_stock_w;"
  ```

  Pre-fix: the order's reservations stay CONFIRMED with `fulfiller_id: null`, its SKU's
  `reserved_stock` stays inflated and `total_stock` never decrements. Post-fix: reservations
  are FULFILLED with an attributed fulfiller, `reserved_stock` returns to baseline, and
  `total_stock` drops by the delivered quantity. (Verified live 2026-07-21 on
  `fix/inventory-write-path`.)

- **Drift probe:** after any e2e run, compare each SKU's `reserved_stock` against the sum of
  active (TEMPORARY/CONFIRMED) reservation quantities from the same tables — any mismatch is
  findings 2–4 manifesting.
- **Dev tools spot-checks:** `/dev/order-trace` resolves the verify-checkout order end-to-end;
  `/dev/system-errors` captures a forced error (e.g. reindex with an invalid index);
  `/dev/logs` shows both `demo-web-*` and `demo-workers-*` files with taskQueue tags.
- **Observability (after P2 lands):** Prometheus target UP on `temporal:9464`
  (http://localhost:9090/targets); Grafana dashboard renders server metrics; Jaeger shows
  `demo-workers` and `temporal-server` traces for the e2e order (requires `OTEL_ENABLED=true`).

## Suggested execution phasing

| PR  | Branch                          | Content                                                       |
| --- | ------------------------------- | ------------------------------------------------------------- |
| 1   | `fix/inventory-write-path`      | P0: regression test + ID unification first, then findings 2–7 |
| 2   | `test/states-coverage-ci-build` | P1: three states test files + CI build step                   |
| 3   | `fix/observability-metrics`     | P2: PROMETHEUS_ENDPOINT, scrape target, dashboard JSON        |
| 4   | `chore/docs-hygiene`            | P3: patterns table, /dev/logs docs, dead stubs, uuid          |

Each PR: container-free gates + the relevant runbook sections live.

## Related

- Mono sibling analysis and overhaul plan:
  `nightheron-mono/docs/planning/inventory-overhaul-plan-2026-07-21.md` — the P0 findings here
  mirror its Phase 1 (four of five structural holes are shared; the reconcile-ID regression is
  demo-only). Fixes should mirror where code shapes match.
