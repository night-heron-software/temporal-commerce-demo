# ADR-0011 — Parseable workflow IDs + Search-Attribute correlation tagging

- **Status:** Accepted
- **Tags:** temporal, workflow-id, observability
- **Provenance:** adapted from the parent platform's ADR-0011

## Context

Domains couple only through string workflow IDs and workflow-type constants. Before this decision,
IDs like `cart-{uuid}` were built ad hoc: they could not be reliably parsed back into their parts
(every component may itself contain `-`), and no correlation tags existed — relating an order's
workflows meant re-deriving each domain's ID formula and walking workflow state, and any broken
link silently truncated the trace. There was no way to ask Temporal "return every workflow for
cart X."

## Decision

### 1. Dot-delimited, parseable IDs

`buildWorkflowId(storeId, domain, entityId)` (`src/temporal/contracts/constants.ts`) joins with
**`.`** — `{storeId}.{domain}.{entityId}`, e.g. `demo.cart.4f0e…`. Dot is the only separator
absent from UUIDs and the domain enum while staying safe across URL, Markdown, HTML, and JSON, so
`parseWorkflowId(id)` always recovers the three components. The demo is single-tenant: `storeId`
is the fixed `DEMO_STORE_ID` (`demo`). `domain` is the closed `WORKFLOW_DOMAINS` union (`cart`,
`checkout`, `order`, `fulfillment`, `fulfiller-order`, `inventory`, `identity`) — typos can't
compile. Inline ID construction is banned by a custom ESLint rule.

### 2. Correlation tagging via Search Attributes + memo

`SEARCH_ATTRIBUTE_KEYS` defines five custom **Keyword Search Attributes** set at every workflow
start:

| Attribute       | Purpose                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------- |
| `CorrelationId` | root id tying the whole journey together — a dedicated UUID minted at cart creation (not the `cartId`; see Amendment) |
| `StoreId`       | store filter (`demo`)                                                                                                 |
| `Domain`        | filter by stage                                                                                                       |
| `OrderId`       | order-scoped queries                                                                                                  |
| `CartId`        | cart-scoped queries                                                                                                   |

`memo` carries display-only, non-indexed metadata. The attributes are registered on the namespace
by `scripts/register-search-attributes.sh` locally (on managed Temporal, once via UI or `tcld`) —
**workflow starts are rejected if they are unregistered**, so registration is a hard setup step.

### 3. One helper, enforced

`buildWorkflowStartOptions({ storeId, domain, entityId, correlationId, orderId?, cartId? })`
returns `{ workflowId, searchAttributes, memo }` and is spread into every `workflow.start` /
`startChild` / `WithStartWorkflowOperation`. `correlationId` is **required** (type
`string | undefined`) so no caller silently omits it; correlation-less singletons (the
inventory service workflow) opt out by passing `undefined` explicitly.

## Consequences

- **The Order Trace tool is a single visibility query.** `CorrelationId = '<correlationId>'` returns the
  entire cart → checkout → order → fulfillment → fulfiller-order chain; each execution is
  categorized by its parsed domain segment. No state-hopping to discover children.
- **The Temporal UI becomes filterable** by domain / order / correlation.
- **Search Attributes are a hard start-time dependency** — registration must precede workers
  accepting work (wired into local compose; a documented one-time step on managed Temporal).

## Alternatives considered

- **Colon / underscore / tilde delimiters** — need URL encoding or collide with Markdown; dot was
  the only clean choice.
- **memo-only correlation** — not queryable, so it can't power the trace query or UI filtering.

## Amendment (2026-07-25)

The correlation arc (PRs #31–#44) evolved this decision in three ways. The reference lines above
(the `CorrelationId` table row, the helper signature, and the visibility-query example) have been
updated in place to the current truth; this section records what changed and why.

### correlationId is its own UUID, not the cartId

As originally implemented, `CorrelationId` reused the `cartId`. That conflated two different
things: the cartId identifies **one entity** in the journey, while the correlationId identifies
**the journey itself**. The overload broke down once correlation had to outlive and cross-cut the
cart — cart merges on sign-in, projections keyed by journey, and journal partitions that must
survive cart re-keying. `correlationId` is now a **dedicated UUID minted at cart creation** and
threaded through every downstream start. Legacy read paths (order trace, inventory journal) still
fall back to the cartId for journeys that predate the split.

### correlationId is required at every start

`BuildWorkflowStartOptionsInput.correlationId` is typed `string | undefined` but **not
optional** — every caller must state a value, and correlation-less singletons (the inventory
service workflow) opt out by passing `undefined` explicitly rather than by omission.

### Ambient activity correlation

Activities no longer thread the correlationId by hand. The chain
(`src/temporal/framework/correlation-header.ts` + `activity-capture.ts` outbound,
`src/lib/worker-otel.ts` inbound, `src/lib/correlation-context.ts` ambient storage):

1. the workflow-outbound interceptor stamps a correlation header on every activity invocation
   from the workflow's own `CorrelationId` Search Attribute;
2. the activity-inbound interceptor decodes the header and seeds an `AsyncLocalStorage` context;
3. any code inside the activity — repositories, the email service — reads
   `currentCorrelationId()`;
4. a pino mixin stamps the ambient value onto every activity log line.

### Consequences (additional)

- **Projection joins.** All order-flow projections join on the correlationId: `orders`, `carts`,
  `reservations`, `fulfiller_orders`, `fulfillments`, `shipments`, and `communications` ES docs
  carry `correlationId`; write-side reservation rows store `correlation_id`; the
  `inventory_history` journal is **partitioned** by `correlation_id`; and
  `customer_communications` rows carry it as the journey join.
