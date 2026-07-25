# Feature: Customer Communications as a Domain Object

## Feature Description

Every customer-facing communication the demo "sends" today is a console-only stub — the
order confirmation, order-status updates, shipped/delivered notifications, and the feedback
thank-you all vanish into the log stream. This feature makes `CustomerCommunication` a
**first-class domain object** with the same treatment as orders, fulfillments, and shipments:
a contract type, a Cassandra source-of-truth table, and a full projection footprint — its own
`communications` ES index searchable by orderId, journey correlationId, **customer email**,
confirmation number, and subject/body text; nested communication summaries embedded on the
orders projection; the admin Search console; and a Communications section in the Order Trace.
The demo then demonstrates a real commerce-platform requirement (auditable customer
communications) using the same source-table → projection → dev-tool pattern as every other
domain object in the repo.

## User Story

As a demo operator / developer
I want every simulated email tied to an order saved as a domain object and queryable by
orderId, correlationId, customer email, or content
So that I can audit exactly what the customer was told, when, and by which workflow — from the
same admin tools I use for orders, journal rows, and projections.

## Problem Statement

Communications are the only customer-visible side effect with no persisted trace. Once the
console scrolls, there is no way to answer "did this order get a shipped notification, and
with which tracking number?" — the order trace shows workflow transitions and inventory
operations but nothing the customer saw. The four send sites are also inconsistent: checkout
routes through `sendEmail()` in `src/lib/email-service.ts`, while oms and fulfillment log
directly, so there is no single choke point to instrument.

## Solution Statement

1. **Contract first**: a `CustomerCommunication` domain type in
   `src/temporal/contracts/communications.ts` (id, orderId, correlationId, channel,
   commType, recipient, subject, body, sentAt, sender domain/actor) plus its
   `CommunicationDocument` ES shape in `contracts/elasticsearch.ts` — same
   type-plus-document pairing as orders and fulfillments.
2. Make `sendEmail()` the single choke point: refactor the oms and fulfillment stubs to build
   a typed `CustomerCommunication` (subject/body from pure template functions) and call it.
3. `sendEmail()` persists each send: an INSERT into a new `customer_communications` Cassandra
   table (source of truth, keyed by order with `correlation_id` from the ambient
   `currentCorrelationId()` — ADR-0011) and a write-through index into a new `communications`
   ES index. Persistence is best-effort and never fails the send (same guard posture as the
   inventory journal's `recordHistoryBestEffort`).
4. **Full projection footprint** ("pushed to all projections"):
   - Dedicated `communications` index — `recipient`/`customerEmail` keyword (exact email
     search via the Explorer's free-text pass, like `customers.email` today),
     `orderId`/`correlationId`/`confirmationNumber` keywords (UUID sweep + PR #40 clause),
     `subject`/`body` text (fuzzy content search), `sentAt` date.
   - The **orders doc embeds nested communication summaries** (commType, subject, sentAt,
     recipient) the way it embeds `fulfillerOrders` and `statusHistory`: OMS's `indexOrder`
     activity enriches the built doc from the source table (activities read Cassandra
     freely), so an order is searchable by what was communicated about it.
   - Admin Search console index list, the reindex route (Cassandra source → rebuildable),
     and an Order Trace Communications section listing the order's emails chronologically.
   - **Order detail pages** (scope addition): a Communications list on every order-detail
     surface — the admin order detail page (`/admin/orders/[orderId]`) and the
     customer-facing order history (`/shop/orders`) — via one shared server action
     (`getOrderCommunications`) and one shared presentational component
     (`OrderCommunications`), reading the `communications` index by orderId.

## Relevant Files

- `src/lib/email-service.ts` — the central `sendEmail()` stub; gains the persistence
  write-through and a richer `SendEmailParams` (orderId, type, context).
- `src/temporal/checkout/activities-impl.ts` — `sendConfirmationEmail` (~line 175): already
  routes through `sendEmail`; passes the new orderId/type params.
- `src/temporal/oms/activities-impl.ts` — `sendOrderStatusEmail` (~line 228) and
  `sendFeedbackThankYouEmail` (~line 240): direct log stubs to refactor through `sendEmail`.
- `src/temporal/oms/states.ts` — finalize actions `sendStatusEmail` / `cancelAndNotify` /
  `sendFeedback` (~lines 92–115): call sites whose params feed the templates (no decider
  changes — actions and their payloads are unchanged).
- `src/temporal/fulfillment/activities-impl.ts` — `sendShippedEmail` (~line 28, carries
  tracking info) and `sendDeliveredEmail` (~line 37): refactor through `sendEmail`.
- `src/temporal/fulfillment/fulfiller-workflows.ts` — shipped-email call site (~line 178);
  signature unchanged.
- `cassandra/schema.cql` — add the `customer_communications` table.
- `src/lib/es-index-mappings.ts` — add the `communications` mapping (all-keyword +
  `sentAt` date + `subject`/`body` text); NOT in `NEVER_REINDEX` (it has a Cassandra source).
- `src/app/api/dev/reindex/route.ts` — add the communications rebuild (read Cassandra table,
  bulk index; follow the orders join pattern).
- `src/app/admin/admin-search-actions.ts` — add `communications` to `ALL_INDICES` (not a
  lifecycle index — records are immutable point-in-time facts).
- `src/app/dev/order-trace/trace-service.ts` + `src/app/dev/order-trace/page.tsx` — fetch and
  render the Communications section (query ES by correlationId with orderId fallback, styled
  like the teal Inventory History section — pick its own accent).
- `src/lib/correlation-context.ts` — read-only dependency: ambient journey key for the
  persisted record (activities already carry it via the PR #32 interceptor).

### New Files

- `src/temporal/contracts/communications.ts` — the `CustomerCommunication` domain type +
  `CommunicationType` union. Pure module (no Temporal imports) so any consumer can import it
  directly without dragging the contracts barrel's workflow definitions (see the
  document-builder barrel note from PR #41).
- `src/lib/communication-templates.ts` — pure builders: `buildCommunication(type, params) →
  { subject, body }` for the five types (`order-confirmation`, `order-status`, `shipped`,
  `delivered`, `feedback-thanks`). Pure domain logic → co-located tests required by the repo
  test policy.
- `src/lib/communication-templates.test.ts` — template unit tests.
- `src/lib/email-service.test.ts` — persistence write-through tests (mock Cassandra/ES via
  the `vi.hoisted` pattern used in `src/app/admin/admin-search-actions.test.ts`).
- `src/app/order-communications-actions.ts` (+ `.test.ts`) — shared Server Action
  `getOrderCommunications(orderId)`: `communications` index by orderId term, sentAt asc,
  failure-guarded to an empty list so order pages never break.
- `src/components/OrderCommunications.tsx` — shared presentational list (type badge,
  subject, timestamp, expandable body; `showRecipient` for the admin view) used by the
  admin order detail page and the shop order history.

Additional relevant files for the domain-object treatment:

- `src/temporal/contracts/elasticsearch.ts` — `CommunicationDocument` interface; orders
  `OrderDocument` gains a nested `communications` summary array.
- `src/temporal/oms/activities-impl.ts` — `indexOrder` enriches the order doc with
  communication summaries read from `customer_communications` (activities read Cassandra
  freely; the workflow-side builder stays pure).
- `src/lib/es-index-mappings.ts` — orders mapping gains the nested `communications`
  property alongside the new `communications` index mapping.

## Implementation Plan

### Phase 1: Foundation

Schema + contracts: `customer_communications` table (`PRIMARY KEY ((order_id), sent_at, seq)`
with `correlation_id`, `channel`, `comm_type`, `recipient`, `subject`, `body`, `actor`
columns; seq disambiguates same-millisecond sends, mirroring `inventory_history`), the
`communications` ES mapping, and the pure template module with tests. `actor` records the
sending surface (activity name) since the true workflowId is not ambient in activities —
the correlationId is the journey join.

### Phase 2: Core Implementation

`sendEmail()` gains `{ orderId?, correlationId?, commType?, context? }`; when `orderId` is
present it persists (Cassandra INSERT + ES index, both wrapped in a never-throw guard;
`correlationId = currentCorrelationId() ?? explicit param ?? null`). Refactor the four
non-checkout stubs to build their subject/body via `communication-templates` and call
`sendEmail`. Checkout's confirmation gains a body via the same template. Existing activity
signatures stay identical — only their bodies change — so no workflow/decider changes and no
Temporal versioning concerns.

### Phase 3: Integration

Admin Search (`ALL_INDICES`), reindex route (communications is reindexable from Cassandra),
the **orders-doc nested summaries** (`indexOrder` enrichment + orders mapping + reindex
join), and the Order Trace Communications section (trace-service fetch + page section).
Live DDL for a running stack is a single additive `CREATE TABLE IF NOT EXISTS` plus a
PUT `_mapping` for the orders nested property; `ensureIndicesExist` creates the new ES
index at worker boot.

## Step by Step Tasks

### 1. Contract, schema, and mapping foundation
- Create `src/temporal/contracts/communications.ts` (`CustomerCommunication`,
  `CommunicationType`) and add `CommunicationDocument` + the nested orders `communications`
  summary shape to `contracts/elasticsearch.ts`.
- Add `customer_communications` to `cassandra/schema.cql` (partition `order_id`, clustering
  `sent_at, seq`; `correlation_id TEXT` nullable for legacy).
- Add the `communications` mapping to `src/lib/es-index-mappings.ts` (keyword ids/type/
  recipient + `correlationId` keyword, `sentAt` date, `subject`/`body` text) and the nested
  `communications` property on the orders mapping.

### 2. Pure templates (test policy applies)
- Create `src/lib/communication-templates.ts` with `CommunicationType` union and
  `buildCommunication(type, params)` covering all five types (status template embeds
  tracking number/carrier when present).
- Create `src/lib/communication-templates.test.ts`: one test per type asserting subject and
  load-bearing body fragments (confirmation number, tracking number, status wording).

### 3. Persisting sendEmail
- Extend `SendEmailParams`; implement the best-effort persist (Cassandra INSERT + ES index)
  behind a single `persistCommunication()` helper inside `email-service.ts`; module-scoped
  monotonic `seq` like `inventory_history`'s writer.
- Create `src/lib/email-service.test.ts`: persists when orderId present; skips when absent;
  send still succeeds (and warns) when Cassandra or ES throws; ambient correlationId is
  stamped, explicit param wins over null ambient.

### 4. Route all send sites through sendEmail
- checkout `sendConfirmationEmail`: pass orderId/commType and template body (order object is
  already in scope).
- oms `sendOrderStatusEmail` + `sendFeedbackThankYouEmail`: replace direct logs with
  template + `sendEmail`.
- fulfillment `sendShippedEmail` + `sendDeliveredEmail`: same, preserving tracking-info
  params into the template.
- Signatures unchanged; run the oms/fulfillment workflow test suites to prove no
  workflow-visible drift.

### 5. Surfacing
- `ALL_INDICES` in `admin-search-actions.ts` (+ extend its index-list test). Verify the
  Explorer finds communications by: customer email (free-text pass hits the `recipient`
  keyword exactly), orderId/correlationId (UUID sweep), and subject/body words (fuzzy pass).
- Orders projection: `OrderDocument.communications` nested summaries; `indexOrder` enriches
  from the source table; orders mapping + orders reindex join gain the same.
- Reindex route: rebuild `communications` from `customer_communications` (follow the orders
  pattern; extend the route test if one covers index dispatch).
- Order Trace: `trace-service.ts` fetches communications (ES query `correlationId` OR
  `orderId`, sorted `sentAt`); `page.tsx` renders a Communications section (recipient,
  type badge, subject, expandable body, timestamp) with its own accent color.
- Order detail pages (scope addition): the admin order detail page gains a
  Communications card (recipient shown, loaded with the page); the shop order history
  gains a lazy "Emails about this order" panel per order (customer-appropriate: subject,
  sent date, type label, expandable body — no internal ids). Both use the shared
  `getOrderCommunications` action + `OrderCommunications` component.

### 6. Validation
- Run every command in `Validation Commands`; live-verify with a full `verify-checkout.ts`
  journey and confirm 3+ communications (confirmation, shipped, delivered) appear in
  Cassandra, ES, admin Search by correlationId, and the Order Trace.

## Testing Strategy

### Unit Tests
- Template builders: subject/body per type, tracking-info interpolation, unknown-type
  exhaustiveness (TypeScript `never` guard).
- `email-service` persistence: write-through happy path, no-orderId skip, Cassandra failure
  swallowed with warn, ES failure swallowed with warn, correlationId stamping.
- Search action: `communications` present in the index list; UUID term sweep already covers
  `correlationId` (PR #40 test).
- Orders enrichment: `indexOrder` merges communication summaries into the built doc (mocked
  Cassandra read); the pure builder stays communication-free (no workflow-side I/O).

### Integration Tests
- Existing workflow suites (checkout/oms/fulfillment) must pass unchanged — activity
  signatures are stable, so no mock updates should be needed beyond new-param defaults.
- `verify-checkout.ts` live journey (manual/E2E validation command) — communications exist
  end-to-end and join on the journey correlationId.

### Edge Cases
- Send with no ambient correlationId (script/API-originated) → record persists with null
  correlation, still queryable by orderId.
- Two sends in the same millisecond (shipped + delivered in fast simulation) → seq orders
  them deterministically.
- Cassandra up / ES down (and vice versa) → email still "sends", warn logged, reindex heals
  the ES side later.
- Reindex of `communications` → full rebuild from the source table (records are immutable).
- Legacy orders (pre-feature) → Order Trace shows an empty Communications section, not an
  error.

## Acceptance Criteria

- Every simulated send (5 types across checkout/oms/fulfillment) produces exactly one row in
  `customer_communications` and one doc in the `communications` ES index, carrying orderId,
  the journey correlationId, recipient (customer email), subject, body, and sentAt.
- Admin Search: searching a correlationId or orderId UUID returns the order's communications
  alongside its other domain docs; searching the **customer's email** returns their
  communications (and customer/order docs); searching a subject word returns the matching
  communication; `communications` appears in the index stats list.
- The orders ES doc carries nested communication summaries, so an order is findable by
  communication content and shows its communication history in one doc.
- Order Trace for a delivered order shows a Communications section with ≥3 entries in
  chronological order.
- Every order detail page lists the order's communications: the admin order detail page
  shows a Communications card (with recipient), and each order on the shop order history
  page exposes an expandable email list; legacy orders show an empty state, not an error.
- `/api/dev/reindex` rebuilds `communications` from Cassandra.
- All existing tests pass with zero deletions; new tests cover templates, persistence, and
  surfacing (≥10 new tests).
- No workflow/decider behavior change: oms decider tests and workflow suites pass untouched.

## Validation Commands

- `npm run typecheck` — zero type errors
- `npm run lint` — zero errors
- `npm run format:check` — clean
- `npm test` — all tests pass (baseline 488 + new tests, none deleted)
- `npm run docs:diagrams:check` — no state-machine drift (there must be none)
- `npm run build` — production build green
- `docker exec demo-cassandra cqlsh -e "DESCRIBE TABLE catalog.customer_communications;"` — table exists (after live DDL)
- `npx tsx --env-file=.env.local scripts/verify-checkout.ts` — full journey to delivered, zero errors
- `docker exec demo-cassandra cqlsh -e "SELECT comm_type, recipient, subject FROM catalog.customer_communications WHERE order_id=<orderId>;"` — confirmation + shipped + delivered rows
- `curl -s 'localhost:9200/communications/_search?q=correlationId:<uuid>'` — same records via the journey key
- `curl -s 'localhost:9200/communications/_search?q=recipient:<customer email>'` — same records via the customer email
- `curl -s 'localhost:9200/orders/_doc/<orderId>'` — orders doc includes the nested `communications` summaries

## Notes

- Plan format adapted to this repo: it is a Next.js + Temporal + Cassandra/ES monolith with
  npm (no `app/server`/`app/client` split, no `uv`/`pytest`); validation commands are the
  repo's standard gate chain. No new libraries are required.
- `communications` is intentionally NOT a lifecycle index (`LIFECYCLE_INDICES`) — records are
  immutable facts, not workflow-owned projections, so PR #37's completed-marking never
  touches them.
- The `channel` column is always `'email'` today; it exists so in-app/SMS notifications slot
  in without a schema change (matches the "customer communications" framing of the request).
- Future: a customer-facing "communication history" on the order status page could read the
  same ES index; a real provider (Mailgun/SendGrid) would slot into `sendEmail()` with the
  persistence unchanged.
- Mono-port note: when this pattern moves to nightheron-mono, the table gains `store_id` in
  the partition key (tenant guard) and the writer must use `@nightheron/infrastructure`
  client utilities per that repo's invariants.
