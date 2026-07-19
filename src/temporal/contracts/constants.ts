/**
 * Workflow Type Constants & Task Queue Constants
 *
 * These string-based constants are the linchpin of cross-domain decoupling.
 * Domains use these to reference each other via Temporal's string-based
 * startChild/getExternalWorkflowHandle instead of direct workflow imports.
 */

// ============================================================================
// Task Queues
// ============================================================================

export const CART_TASK_QUEUE = 'cart-queue';
export const CHECKOUT_TASK_QUEUE = 'checkout-queue';
export const OMS_TASK_QUEUE = 'oms-queue';
export const FULFILLMENT_TASK_QUEUE = 'fulfillment-queue';
export const INVENTORY_TASK_QUEUE = 'inventory-queue';
export const IDENTITY_TASK_QUEUE = 'identity-queue';

// ============================================================================
// Workflow Type Names
// ============================================================================

export const CART_WORKFLOW_TYPE = 'cartWorkflow';
export const CHECKOUT_WORKFLOW_TYPE = 'checkoutWorkflow';
export const OMS_WORKFLOW_TYPE = 'orderWorkflow';
export const FULFILLMENT_WORKFLOW_TYPE = 'fulfillmentWorkflow';
export const INVENTORY_WORKFLOW_TYPE = 'inventoryWorkflow';
export const INVENTORY_SERVICE_WORKFLOW_TYPE = 'inventoryServiceWorkflow';
export const IDENTITY_WORKFLOW_TYPE = 'identityWorkflow';

// ============================================================================
// Tenancy
// ============================================================================

/**
 * The fixed single-tenant store id for this demo (ADR-0011 keeps workflow IDs
 * 3-part `{storeId}.{domain}.{entityId}` so they stay parseable and the code
 * stays diff-able against the multi-tenant source project). Dot-free by
 * construction — never change it once data exists: it is baked into workflow
 * IDs, Search Attributes, and Cassandra partition keys.
 */
export const DEMO_STORE_ID = 'demo';

// ============================================================================
// Workflow Domains
// ============================================================================

/**
 * The closed set of domain segments that may appear in a workflow ID. Keeping this a
 * fixed union (rather than a free string) is what makes `{storeId}.{domain}.{entityId}`
 * unambiguously parseable — the middle segment is always exactly one of these tokens.
 */
export const WORKFLOW_DOMAINS = [
  'cart',
  'checkout',
  'order',
  'fulfillment',
  'fulfiller-order',
  'inventory',
  'identity',
] as const;

export type WorkflowDomain = (typeof WORKFLOW_DOMAINS)[number];

/**
 * Reserved, non-UUID `entityId` slugs for singleton / externally-keyed workflows.
 * Per-entity workflows use a canonical UUID; these documented slugs cover the
 * workflows for which a UUID would be meaningless (singletons). All are dot-free
 * so they never break {@link parseWorkflowId}.
 */
export const WORKFLOW_ENTITY_SLUGS = {
  /** The single long-lived inventory projection/reservation service workflow. */
  inventoryService: 'service',
} as const;

// ============================================================================
// Workflow ID Utilities
// ============================================================================

/**
 * Delimiter separating the three top-level workflow-ID components. Chosen because it
 * never appears in a UUID (hex + `-`), the {@link WORKFLOW_DOMAINS} enum, or a reserved
 * slug, and is safe across URL (RFC 3986 unreserved), Markdown, HTML, and JSON contexts.
 * That means `id.split('.')` always yields exactly the three original components.
 */
export const WORKFLOW_ID_DELIMITER = '.';

/**
 * Build a deterministic, parseable workflow ID from its components.
 *
 * Convention: `{storeId}.{domain}.{entityId}` where `entityId` is a canonical UUID
 * (or a reserved slug) and `domain` is a {@link WorkflowDomain}.
 *
 * Examples:
 *   buildWorkflowId(DEMO_STORE_ID, 'cart', 'a1b2…-cart')  → 'demo.cart.a1b2…-cart'
 *   buildWorkflowId(DEMO_STORE_ID, 'inventory', 'service') → 'demo.inventory.service'
 *
 * Throws if `storeId` or `entityId` contains the delimiter — that would make the ID
 * ambiguous to parse and is always a bug.
 */
export function buildWorkflowId(storeId: string, domain: WorkflowDomain, entityId: string): string {
  if (storeId.includes(WORKFLOW_ID_DELIMITER) || entityId.includes(WORKFLOW_ID_DELIMITER)) {
    throw new Error(
      `Workflow ID components must not contain '${WORKFLOW_ID_DELIMITER}': ` +
        `storeId=${JSON.stringify(storeId)} entityId=${JSON.stringify(entityId)}`,
    );
  }
  return `${storeId}${WORKFLOW_ID_DELIMITER}${domain}${WORKFLOW_ID_DELIMITER}${entityId}`;
}

/**
 * Split a workflow ID produced by {@link buildWorkflowId} back into its components.
 * Returns `null` for a string that is not in the three-part `{storeId}.{domain}.{entityId}`
 * shape.
 */
export function parseWorkflowId(
  workflowId: string,
): { storeId: string; domain: string; entityId: string } | null {
  const parts = workflowId.split(WORKFLOW_ID_DELIMITER);
  if (parts.length !== 3) return null;
  return { storeId: parts[0], domain: parts[1], entityId: parts[2] };
}

// ============================================================================
// Correlation Tagging — Search Attributes + memo
// ============================================================================

/**
 * Custom Temporal Search Attribute keys used to correlate related workflows across a
 * customer journey. All are registered on the namespace as `Keyword` type — see
 * `scripts/register-search-attributes.sh`.
 */
export const SEARCH_ATTRIBUTE_KEYS = {
  /** Root id tying the whole journey graph together (defaults to cartId). */
  correlationId: 'CorrelationId',
  storeId: 'StoreId',
  domain: 'Domain',
  orderId: 'OrderId',
  cartId: 'CartId',
} as const;

/** Legacy Temporal search-attribute map shape: keyword values are string arrays. */
export type WorkflowSearchAttributes = Record<string, string[]>;

export interface BuildWorkflowStartOptionsInput {
  storeId: string;
  domain: WorkflowDomain;
  entityId: string;
  /** Root id tying the journey graph together. Defaults to `cartId` when present. */
  correlationId?: string;
  orderId?: string;
  cartId?: string;
  /** Display-only, non-indexed metadata. Safe for PII (email, confirmation number). */
  memo?: Record<string, unknown>;
}

export interface WorkflowStartTagging {
  workflowId: string;
  searchAttributes: WorkflowSearchAttributes;
  memo: Record<string, unknown>;
}

/**
 * Build the `workflowId` + correlation Search Attributes + memo for a workflow start.
 * Spread the result into a client `workflow.start`, `startChild`, or `executeChild`
 * options object so every workflow in a journey carries consistent, queryable tags:
 *
 *   await startChild('checkoutWorkflow', {
 *     ...buildWorkflowStartOptions({ storeId, domain: 'checkout', entityId: checkoutId, cartId }),
 *     taskQueue: CHECKOUT_TASK_QUEUE,
 *     args: [input],
 *   });
 *
 * With these tags set, the full graph is one visibility query away
 * (`CorrelationId = '<cartId>'`) instead of a hand-rolled per-domain ID walk.
 */
export function buildWorkflowStartOptions(
  input: BuildWorkflowStartOptionsInput,
): WorkflowStartTagging {
  const { storeId, domain, entityId, orderId, cartId, memo } = input;
  const correlationId = input.correlationId ?? cartId;

  const searchAttributes: WorkflowSearchAttributes = {
    [SEARCH_ATTRIBUTE_KEYS.storeId]: [storeId],
    [SEARCH_ATTRIBUTE_KEYS.domain]: [domain],
  };
  if (correlationId) searchAttributes[SEARCH_ATTRIBUTE_KEYS.correlationId] = [correlationId];
  if (orderId) searchAttributes[SEARCH_ATTRIBUTE_KEYS.orderId] = [orderId];
  if (cartId) searchAttributes[SEARCH_ATTRIBUTE_KEYS.cartId] = [cartId];

  return {
    workflowId: buildWorkflowId(storeId, domain, entityId),
    searchAttributes,
    memo: { domain, ...memo },
  };
}

