/**
 * Order Trace — cross-domain trace assembly (server-only).
 *
 * Ported from nightheron-mono's storefront and adapted for this single-tenant demo
 * (fixed DEMO_STORE_ID; Cassandra tables have no store_id column).
 *
 * Given a way to identify an order, stitches together the full lifecycle across the
 * cart → checkout → OMS → fulfillment → fulfiller-order workflows: each workflow's
 * live queried state plus its persisted transitions (ADR-0010), alongside the
 * Cassandra `order_status_history` audit trail. Raw Temporal execution history is
 * not fetched — each node carries a Temporal Web UI deep link for that.
 *
 * Read-only. Imported only by the /api/dev/order-trace route (never a client bundle).
 */

import { getTemporalClient, TEMPORAL_NAMESPACE } from '@/lib/temporal-client';
import { getElasticsearchClient } from '@/lib/es-client';
import { getWorkflowTransitions } from '@/temporal/transition-recorder';
import { executeCql, cassandraTypes as types } from '@/lib/cassandra-client';
import {
  buildWorkflowId,
  parseWorkflowId,
  SEARCH_ATTRIBUTE_KEYS,
  DEMO_STORE_ID,
} from '@/temporal/contracts/constants';
import { Cart, Checkout, OMS, Fulfillment, Elasticsearch } from '@/temporal/contracts';
import { InventoryCommandRepository } from '@/temporal/inventory/db/inventory-command-repository';

// ============================================================================
// Types
// ============================================================================

export type TraceDomain = 'cart' | 'checkout' | 'oms' | 'fulfillment' | 'fulfiller-order';

/**
 * A persisted state transition (ADR-0010) read back from `workflow_state_transitions`: the real
 * from→to move, the decoded trigger payload, and a full context snapshot for computing diffs.
 */
export interface TraceTransition {
  at: string;
  seq: number;
  fromState: string;
  toState: string;
  triggerKind: string;
  triggerName: string | null;
  triggerPayload: unknown;
  contextSnapshot: unknown;
  /** Activities called in the state's prepare phase (beginning), with args + results. */
  prepareActivities: TraceActivityCall[];
  /** Activities called in the state's finalize phase (end), with args + results. */
  finalizeActivities: TraceActivityCall[];
  /** Decoded return value of the Update handler (enriched from Temporal history). */
  updateResult?: unknown;
}

/** A captured activity call: its name, arguments, and result (or error). */
export interface TraceActivityCall {
  name: string;
  args?: unknown;
  result?: unknown;
  error?: string;
}

/** One workflow in the order's lifecycle. */
export interface TraceNode {
  domain: TraceDomain;
  workflowId: string;
  runId?: string;
  /** Temporal execution status name: Running / Completed / Failed / Terminated / … */
  status: string;
  startTime?: string;
  closeTime?: string;
  historyLength?: number;
  /** Queried state snapshot; null when the workflow is closed (query no longer serviceable). */
  state: unknown;
  /** Persisted transitions (ADR-0010); empty for workflows recorded before the projection existed. */
  transitions: TraceTransition[];
  /** Deep link to this workflow in the Temporal Web UI. */
  temporalUiUrl: string;
}

export interface TraceStatusHistoryRow {
  orderId: string;
  eventTime: string;
  status: string;
  note: string | null;
  updatedBy: string;
  /** Correlation ID (ADR-0011); null for rows written before the column existed. */
  correlationId: string | null;
}

/**
 * One inventory_history journal row for the trace, serialization-ready (ISO timestamp,
 * `details` already JSON-parsed). The `actor` is the acting workflowId (matchable against
 * `TraceNode.workflowId` client-side) or a system actor ('api' | 'expiry-sweep' |
 * 'preemption' | 'reconciler').
 */
export interface TraceInventoryEvent {
  at: string;
  seq: number;
  operation: string;
  reservationId: string | null;
  blankSku: string | null;
  variantId: string | null;
  fulfillerId: string | null;
  quantity: number | null;
  priorStatus: string | null;
  newStatus: string | null;
  referenceId: string | null;
  actor: string;
  details: unknown;
}

export interface OrderTrace {
  orderId: string;
  storeId: string;
  confirmationNumber?: string;
  /** The order's cart linkage (kept for the deterministic-ID safety net + display). */
  cartId?: string;
  /**
   * The journey's correlationId (ADR-0011) — its own UUID minted at cart creation; ties
   * every workflow in the journey together. Falls back to cartId for orders written
   * before the `orders.correlation_id` column existed (correlationId used to = cartId).
   */
  correlationId?: string;
  nodes: TraceNode[];
  statusHistory: TraceStatusHistoryRow[];
  /** Correlation-keyed inventory operation journal (inventory_history) for the order's cart. */
  inventory: { history: TraceInventoryEvent[] };
}

/** Lightweight order descriptor used when a lookup resolves to more than one order. */
export interface OrderCandidate {
  orderId: string;
  confirmationNumber: string;
  total: number;
  currency: string;
  status: string;
  createdAt: string;
}

export interface ResolveResult {
  /** Set when the lookup resolves to exactly one order. */
  orderId?: string;
  /** Always DEMO_STORE_ID in this single-tenant demo — present whenever orderId is set. */
  storeId?: string;
  /** Set when an email lookup matches multiple orders (user must pick one). */
  candidates?: OrderCandidate[];
}

// ============================================================================
// Trace assembly (I/O)
// ============================================================================

function temporalUiUrl(workflowId: string): string {
  const base = process.env.TEMPORAL_UI_URL || 'http://localhost:8233';
  return `${base}/namespaces/${TEMPORAL_NAMESPACE}/workflows/${encodeURIComponent(workflowId)}`;
}

type TemporalClient = Awaited<ReturnType<typeof getTemporalClient>>;

/**
 * A query the trace issues: either a contract `QueryDefinition` or a raw query name for
 * defs that live only in a domain module (the fulfiller-order child's
 * `getFulfillerOrderState`).
 */
type TraceQuery =
  | typeof OMS.getOrderStateQuery
  | typeof Cart.getCartQuery
  | typeof Checkout.getCheckoutStateQuery
  | typeof Fulfillment.getStatusQuery
  | string;

/**
 * Build a single trace node for a workflow. Returns null when the workflow does not
 * exist. A closed workflow still yields a node (state may be null if its query is no
 * longer serviceable), so the timeline shows completed steps.
 */
async function fetchNode(
  client: TemporalClient,
  storeId: string,
  domain: TraceDomain,
  workflowId: string,
  query: TraceQuery,
): Promise<TraceNode | null> {
  const handle = client.workflow.getHandle(workflowId);

  let desc;
  try {
    desc = await handle.describe();
  } catch {
    return null; // Workflow not found — skip this node.
  }

  let state: unknown = null;
  try {
    // Cast to the exact shape `handle.query` accepts; a `TraceQuery` union otherwise
    // defeats the method's single-Ret generic inference.
    state = await handle.query(query as Parameters<typeof handle.query>[0]);
  } catch {
    state = null; // Closed workflow / query unavailable — still render the node.
  }

  // Persisted transition projection (ADR-0010) — the authoritative from→to timeline with
  // full context snapshots. Empty for workflows started before the projection existed.
  let transitions: TraceTransition[] = [];
  try {
    transitions = (await getWorkflowTransitions(storeId, workflowId)).map((r) => ({
      at: r.at,
      seq: r.seq,
      fromState: r.fromState,
      toState: r.toState,
      triggerKind: r.triggerKind,
      triggerName: r.triggerName,
      triggerPayload: r.triggerPayload,
      contextSnapshot: r.contextSnapshot,
      prepareActivities: r.prepareActivities,
      finalizeActivities: r.finalizeActivities,
      updateResult: r.updateResult,
    }));
  } catch {
    transitions = [];
  }

  return {
    domain,
    workflowId,
    runId: desc.runId,
    status: desc.status?.name ?? 'UNKNOWN',
    startTime: desc.startTime?.toISOString(),
    closeTime: desc.closeTime?.toISOString(),
    historyLength: desc.historyLength,
    state,
    transitions,
    temporalUiUrl: temporalUiUrl(workflowId),
  };
}

/** Read the Cassandra `order_status_history` audit trail for an order. */
async function fetchStatusHistory(orderId: string): Promise<TraceStatusHistoryRow[]> {
  interface Row {
    order_id: { toString(): string };
    event_time: { toISOString(): string } | null;
    status: string;
    note: string | null;
    updated_by: string;
    correlation_id: string | null;
  }
  try {
    const rows = await executeCql<Row>(
      `SELECT order_id, event_time, status, note, updated_by, correlation_id
       FROM order_status_history
       WHERE order_id = ?`,
      [types.Uuid.fromString(orderId)],
    );
    return rows.map((r) => ({
      orderId: r.order_id.toString(),
      eventTime: r.event_time?.toISOString() ?? '',
      status: r.status,
      note: r.note ?? null,
      updatedBy: r.updated_by,
      correlationId: r.correlation_id ?? null,
    }));
  } catch {
    return [];
  }
}

/**
 * Resolve a lookup (orderId | confirmation | email) to a concrete orderId using the
 * Elasticsearch orders index.
 *
 * An email that matches multiple orders returns `{ candidates }` for the caller to
 * disambiguate.
 */
export async function resolveOrderId(input: {
  orderId?: string;
  confirmation?: string;
  email?: string;
}): Promise<ResolveResult> {
  const es = getElasticsearchClient();

  if (input.orderId) {
    // Exact term match on the indexed orderId field.
    const resp = await es.search<{ orderId: string }>({
      index: Elasticsearch.ES_INDICES.orders,
      size: 1,
      _source: ['orderId'],
      query: { term: { orderId: input.orderId.trim() } },
    });
    const hit = resp.hits.hits[0]?._source;
    if (!hit) return {};
    return { orderId: hit.orderId, storeId: DEMO_STORE_ID };
  }

  if (input.confirmation) {
    const resp = await es.search<{ orderId: string }>({
      index: Elasticsearch.ES_INDICES.orders,
      size: 1,
      _source: ['orderId'],
      query: { term: { confirmationNumber: input.confirmation.trim() } },
    });
    const hit = resp.hits.hits[0]?._source;
    if (!hit) return {};
    return { orderId: hit.orderId, storeId: DEMO_STORE_ID };
  }

  if (input.email) {
    type HitSource = {
      orderId: string;
      confirmationNumber: string;
      total: number;
      currency: string;
      status: string;
      createdAt: string;
    };
    const resp = await es.search<HitSource>({
      index: Elasticsearch.ES_INDICES.orders,
      size: 50,
      _source: ['orderId', 'confirmationNumber', 'total', 'currency', 'status', 'createdAt'],
      query: { term: { customerEmail: input.email.trim() } },
      sort: [{ createdAt: { order: 'desc' as const } }],
    });
    const candidates: OrderCandidate[] = resp.hits.hits
      .map((h) => h._source)
      .filter((s): s is HitSource => Boolean(s))
      .map((s) => ({
        orderId: s.orderId,
        confirmationNumber: s.confirmationNumber,
        total: s.total,
        currency: s.currency,
        status: s.status,
        createdAt: s.createdAt,
      }));
    if (candidates.length === 1) {
      const only = resp.hits.hits[0]._source!;
      return { orderId: only.orderId, storeId: DEMO_STORE_ID };
    }
    return { candidates };
  }

  return {};
}

/**
 * Maps a workflow-ID domain segment to its trace domain + the query used to snapshot
 * its live state. The `order` ID segment surfaces as the `oms` trace domain.
 */
const DOMAIN_TRACE: Record<string, { domain: TraceDomain; query: TraceQuery }> = {
  cart: { domain: 'cart', query: Cart.getCartQuery },
  checkout: { domain: 'checkout', query: Checkout.getCheckoutStateQuery },
  order: { domain: 'oms', query: OMS.getOrderStateQuery },
  fulfillment: { domain: 'fulfillment', query: Fulfillment.getStatusQuery },
  // The fulfiller-order query def lives only in the fulfillment workflow module, so query by name.
  'fulfiller-order': { domain: 'fulfiller-order', query: 'getFulfillerOrderState' },
};

/** Journey order for presenting the assembled nodes top-to-bottom. */
const DOMAIN_ORDER: TraceDomain[] = ['cart', 'checkout', 'oms', 'fulfillment', 'fulfiller-order'];

/**
 * Assemble the full cross-domain trace for one order.
 *
 * The whole related graph is found with a single Temporal visibility query on the
 * `CorrelationId` search attribute (the journey UUID stored on the orders row; cartId
 * for legacy orders), rather than re-deriving each domain's workflow-ID formula and
 * walking state. Deterministic IDs for the core order workflows are still probed as a
 * safety net (e.g. a workflow started before its search attributes were indexed).
 *
 * Each workflow fetch is isolated, so a missing/closed workflow degrades gracefully.
 */
export async function buildOrderTrace(storeId: string, orderId: string): Promise<OrderTrace> {
  const client = await getTemporalClient();
  const nodes: TraceNode[] = [];
  const seen = new Set<string>();

  // Resolve cartId + the journey correlationId + confirmation from Cassandra (reliable
  // even after workflows close). The correlationId is its own UUID minted at cart
  // creation; legacy orders predate the column, where correlationId equalled cartId.
  let cartId: string | undefined;
  let correlationId: string | undefined;
  let confirmationNumber: string | undefined;
  try {
    interface OrderRow {
      cart_id: string;
      correlation_id: string | null;
      confirmation_number: string;
    }
    const rows = await executeCql<OrderRow>(
      `SELECT cart_id, correlation_id, confirmation_number FROM orders WHERE order_id = ?`,
      [types.Uuid.fromString(orderId)],
    );
    if (rows[0]) {
      cartId = rows[0].cart_id;
      correlationId = rows[0].correlation_id ?? rows[0].cart_id;
      confirmationNumber = rows[0].confirmation_number;
    }
  } catch {
    // Order not in Cassandra (or bad id) — still attempt the deterministic lookups below.
  }

  // Add a node for a workflow id, categorised by its domain segment. De-duplicated so the
  // visibility query and the deterministic safety-net never double-count a workflow.
  async function addByWorkflowId(workflowId: string): Promise<void> {
    if (seen.has(workflowId)) return;
    const parsed = parseWorkflowId(workflowId);
    const mapping = parsed ? DOMAIN_TRACE[parsed.domain] : undefined;
    if (!mapping) return; // not a journey workflow we render
    seen.add(workflowId);
    const node = await fetchNode(client, storeId, mapping.domain, workflowId, mapping.query);
    if (node) nodes.push(node);
  }

  // Inventory operation journal for the journey (correlation-keyed). Guarded: the trace
  // must never 500 because the journal is unavailable (or the table predates this deploy).
  let inventoryHistory: TraceInventoryEvent[] = [];
  if (correlationId) {
    try {
      inventoryHistory = (
        await InventoryCommandRepository.getHistoryByCorrelation(correlationId)
      ).map((r) => ({
        at: r.at.toISOString(),
        seq: r.seq,
        operation: r.operation,
        reservationId: r.reservationId,
        blankSku: r.blankSku,
        variantId: r.variantId,
        fulfillerId: r.fulfillerId,
        quantity: r.quantity,
        priorStatus: r.priorStatus,
        newStatus: r.newStatus,
        referenceId: r.referenceId,
        actor: r.actor,
        details: r.details,
      }));
    } catch {
      inventoryHistory = [];
    }
  }

  // Primary: one visibility query returns every workflow in the journey — including the
  // checkout and per-fulfiller children that previously required state hops to discover.
  const listQuery = correlationId
    ? `${SEARCH_ATTRIBUTE_KEYS.correlationId} = '${correlationId}'`
    : `${SEARCH_ATTRIBUTE_KEYS.orderId} = '${orderId}'`;
  try {
    for await (const exec of client.workflow.list({ query: listQuery })) {
      await addByWorkflowId(exec.workflowId);
    }
  } catch {
    // Visibility query unavailable (e.g. attributes not yet registered) — safety net below.
  }

  // Safety net: deterministic IDs for the core order workflows.
  await addByWorkflowId(buildWorkflowId(storeId, 'order', orderId));
  await addByWorkflowId(buildWorkflowId(storeId, 'fulfillment', orderId));
  if (cartId) await addByWorkflowId(buildWorkflowId(storeId, 'cart', cartId));

  nodes.sort((a, b) => DOMAIN_ORDER.indexOf(a.domain) - DOMAIN_ORDER.indexOf(b.domain));

  const statusHistory = await fetchStatusHistory(orderId);

  return {
    orderId,
    storeId,
    confirmationNumber,
    cartId,
    correlationId,
    nodes,
    statusHistory,
    inventory: { history: inventoryHistory },
  };
}
