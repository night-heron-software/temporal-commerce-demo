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
export const CATALOG_TASK_QUEUE = 'catalog-queue';
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
export const CATALOG_SYNC_WORKFLOW_TYPE = 'catalogSyncWorkflow';
export const IDENTITY_WORKFLOW_TYPE = 'identityWorkflow';

// ============================================================================
// Workflow ID Utilities
// ============================================================================

/**
 * Build a deterministic workflow ID from domain components.
 *
 * Convention: `{storeId}-{domain}-{entityId}`
 *
 * Examples:
 *   buildWorkflowId('store-abc', 'cart', 'cart-123')     → 'store-abc-cart-cart-123'
 *   buildWorkflowId('store-abc', 'fulfillment', 'ord-1') → 'store-abc-fulfillment-ord-1'
 *   buildWorkflowId('store-abc', 'inventory', 'SKU-001') → 'store-abc-inventory-SKU-001'
 */
export function buildWorkflowId(storeId: string, domain: string, entityId: string): string {
  return `${storeId}-${domain}-${entityId}`;
}
