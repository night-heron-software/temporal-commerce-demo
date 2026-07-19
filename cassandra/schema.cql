-- Temporal Commerce Demo — Cassandra Schema
-- Single-store demo: no store_id partition keys

CREATE KEYSPACE IF NOT EXISTS catalog
WITH replication = {
    'class': 'SimpleStrategy',
    'replication_factor': 1
};

USE catalog;

-- ===========================================
-- User Defined Types (UDTs)
-- ===========================================

CREATE TYPE IF NOT EXISTS option_selection (
    option_type TEXT,
    label TEXT,
    attributes MAP<TEXT, TEXT>
);

CREATE TYPE IF NOT EXISTS shipping_address (
    first_name TEXT,
    last_name TEXT,
    address1 TEXT,
    address2 TEXT,
    city TEXT,
    state TEXT,
    postal_code TEXT,
    country TEXT,
    phone TEXT,
    email TEXT
);

CREATE TYPE IF NOT EXISTS payment_method (
    type TEXT,
    last4 TEXT,
    payment_token TEXT
);

CREATE TYPE IF NOT EXISTS order_item (
    line_item_id TEXT,
    variant_id TEXT,
    quantity INT,
    price INT,
    properties MAP<TEXT, TEXT>
);

CREATE TYPE IF NOT EXISTS order_assignment (
    assignment_id TEXT,
    line_item_id TEXT,
    variant_id TEXT,
    fulfiller_id TEXT,
    fulfiller_name TEXT,
    fulfiller_order_id TEXT,
    quantity INT,
    carrier TEXT,
    status TEXT
);

CREATE TYPE IF NOT EXISTS fulfiller_order_item (
    assignment_id TEXT,
    variant_id TEXT,
    quantity INT
);

CREATE TYPE IF NOT EXISTS fulfiller_order_history_entry (
    status TEXT,
    timestamp TIMESTAMP,
    note TEXT
);

CREATE TYPE IF NOT EXISTS fulfiller_order (
    fulfiller_order_id TEXT,
    order_id TEXT,
    fulfiller_id TEXT,
    fulfiller_name TEXT,
    status TEXT,
    items LIST<FROZEN<fulfiller_order_item>>,
    carrier TEXT,
    tracking_number TEXT,
    rejection_reason TEXT,
    status_history LIST<FROZEN<fulfiller_order_history_entry>>,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);


-- ===========================================
-- Catalog Tables
-- ===========================================

CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY,
    type TEXT,
    collection_ids LIST<UUID>,
    collection_names LIST<TEXT>,
    name TEXT,
    description TEXT,
    base_price_amount INT,
    base_price_currency TEXT,
    default_variant_id UUID,
    default_variant_image_url TEXT,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products_by_collection (
    collection_id UUID,
    product_id UUID,
    type TEXT,
    name TEXT,
    base_price_amount INT,
    base_price_currency TEXT,
    default_variant_id UUID,
    default_variant_image_url TEXT,
    PRIMARY KEY (collection_id, product_id)
);

CREATE TABLE IF NOT EXISTS variants (
    id UUID PRIMARY KEY,
    blank_sku TEXT,
    product_id UUID,
    product_name TEXT,
    product_type TEXT,
    price_amount INT,
    price_currency TEXT,
    available BOOLEAN,
    images MAP<TEXT, TEXT>,
    options LIST<FROZEN<option_selection>>,
    created_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS variants_by_product (
    product_id UUID,
    id UUID,
    blank_sku TEXT,
    price_amount INT,
    price_currency TEXT,
    available BOOLEAN,
    variant_image_url TEXT,
    options LIST<FROZEN<option_selection>>,
    PRIMARY KEY (product_id, id)
);

CREATE TABLE IF NOT EXISTS collections (
    id UUID PRIMARY KEY,
    name TEXT,
    description TEXT,
    created_at TIMESTAMP
);

-- ===========================================
-- Order Management Tables
-- ===========================================

CREATE TABLE IF NOT EXISTS orders (
    order_id UUID PRIMARY KEY,
    cart_id TEXT,
    confirmation_number TEXT,
    customer_email TEXT,
    items LIST<FROZEN<order_item>>,
    assignments LIST<FROZEN<order_assignment>>,
    fulfiller_orders LIST<FROZEN<fulfiller_order>>,
    shipping_address FROZEN<shipping_address>,
    payment_method FROZEN<payment_method>,
    subtotal INT,
    shipping_cost INT,
    tax INT,
    total_discounts INT,
    total INT,
    currency TEXT,
    status TEXT,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders_by_customer (
    customer_email TEXT,
    created_at TIMESTAMP,
    order_id UUID,
    confirmation_number TEXT,
    total INT,
    currency TEXT,
    status TEXT,
    PRIMARY KEY (customer_email, created_at, order_id)
) WITH CLUSTERING ORDER BY (created_at DESC, order_id ASC);

CREATE TABLE IF NOT EXISTS orders_by_confirmation (
    confirmation_number TEXT PRIMARY KEY,
    order_id UUID,
    customer_email TEXT
);

CREATE TABLE IF NOT EXISTS order_status_history (
    order_id UUID,
    event_time TIMESTAMP,
    id TIMEUUID,
    status TEXT,
    note TEXT,
    updated_by TEXT,
    PRIMARY KEY (order_id, event_time, id)
) WITH CLUSTERING ORDER BY (event_time DESC, id DESC);

-- ===========================================
-- Fulfiller Tables
-- ===========================================

CREATE TABLE IF NOT EXISTS fulfillers (
    id TEXT,
    name TEXT,
    created_at TIMESTAMP,
    PRIMARY KEY (id)
);

INSERT INTO fulfillers (id, name, created_at)
VALUES ('default-fulfiller', 'Default Fulfiller', toTimestamp(now()));

CREATE TABLE IF NOT EXISTS fulfiller_locations (
    fulfiller_id TEXT,
    location_id TEXT,
    name TEXT,
    cost INT,
    address1 TEXT,
    address2 TEXT,
    city TEXT,
    state TEXT,
    postal_code TEXT,
    country TEXT,
    is_primary BOOLEAN,
    created_at TIMESTAMP,
    PRIMARY KEY (fulfiller_id, location_id)
);
CREATE INDEX IF NOT EXISTS idx_fulfiller_locations_is_primary ON fulfiller_locations (is_primary);

INSERT INTO fulfiller_locations (fulfiller_id, location_id, name, cost, address1, city, state, postal_code, country, is_primary, created_at)
VALUES ('default-fulfiller', 'default-warehouse', 'Default Warehouse', 0, '123 Warehouse Ave', 'Warehouse City', 'WC', '00000', 'US', true, toTimestamp(now()));

-- ===========================================
-- Inventory Tables (CQRS Write Side)
-- ===========================================

CREATE TABLE IF NOT EXISTS inventory_stock_w (
    blank_sku TEXT,
    fulfiller_id TEXT,
    fulfiller_name TEXT,
    total_stock INT,
    reserved_stock INT,
    ordered_stock INT,
    cost INT,
    address1 TEXT,
    address2 TEXT,
    city TEXT,
    state TEXT,
    postal_code TEXT,
    country TEXT,
    updated_at TIMESTAMP,
    PRIMARY KEY (blank_sku, fulfiller_id)
);

CREATE TABLE IF NOT EXISTS inventory_reservations_w (
    reservation_id TEXT PRIMARY KEY,
    blank_sku TEXT,
    cart_id TEXT,
    variant_id TEXT,
    fulfiller_id TEXT,
    quantity INT,
    reference_id TEXT,
    status TEXT,
    expires_at TIMESTAMP,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

-- Active-reservation registry: denormalized rows for TEMPORARY / CONFIRMED reservations only,
-- partitioned by status so the sweep queries (expiration, projection) and SKU-preemption scans
-- are partition reads over the active working set — never ALLOW FILTERING over all history.
-- Terminal transitions (RELEASED / CANCELLED / FULFILLED) DELETE the row instead of moving it.
CREATE TABLE IF NOT EXISTS inventory_reservations_by_status_w (
    status TEXT,
    reservation_id TEXT,
    blank_sku TEXT,
    cart_id TEXT,
    variant_id TEXT,
    fulfiller_id TEXT,
    quantity INT,
    reference_id TEXT,
    expires_at TIMESTAMP,
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    PRIMARY KEY (status, reservation_id)
);

CREATE TABLE IF NOT EXISTS inventory_reservations_by_cart_w (
    cart_id TEXT,
    reservation_id TEXT,
    blank_sku TEXT,
    variant_id TEXT,
    quantity INT,
    status TEXT,
    PRIMARY KEY (cart_id, reservation_id)
);

-- ===========================================
-- Inventory Tables (CQRS Read Side)
-- ===========================================

CREATE TABLE IF NOT EXISTS inventory_stock_summary (
    blank_sku TEXT PRIMARY KEY,
    total_stock INT,
    reserved_stock INT,
    available_stock INT,
    fulfiller_count INT,
    low_stock BOOLEAN,
    last_projected_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS inventory_stock_by_fulfiller (
    fulfiller_id TEXT,
    blank_sku TEXT,
    fulfiller_name TEXT,
    total_stock INT,
    reserved_stock INT,
    available_stock INT,
    cost INT,
    city TEXT,
    state TEXT,
    country TEXT,
    last_projected_at TIMESTAMP,
    PRIMARY KEY (fulfiller_id, blank_sku)
);

CREATE TABLE IF NOT EXISTS inventory_reservations_by_sku (
    blank_sku TEXT,
    reservation_id TEXT,
    cart_id TEXT,
    variant_id TEXT,
    quantity INT,
    status TEXT,
    fulfiller_id TEXT,
    expires_at TIMESTAMP,
    created_at TIMESTAMP,
    PRIMARY KEY (blank_sku, reservation_id)
);

CREATE TABLE IF NOT EXISTS inventory_low_stock (
    threshold_bucket TEXT,
    available_stock INT,
    blank_sku TEXT,
    total_stock INT,
    last_projected_at TIMESTAMP,
    PRIMARY KEY (threshold_bucket, available_stock, blank_sku)
) WITH CLUSTERING ORDER BY (available_stock ASC, blank_sku ASC);

-- ===========================================
-- Shopper Identity Tables
-- ===========================================

CREATE TABLE IF NOT EXISTS shoppers (
    email TEXT,
    id UUID,
    password_hash TEXT,
    name TEXT,
    phone TEXT,
    failed_attempts INT,
    locked_until TIMESTAMP,
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    PRIMARY KEY (email)
);

-- Lookup table for cookie-session resolution (id -> email); both columns are immutable,
-- so only shopper creation writes here.
CREATE TABLE IF NOT EXISTS shoppers_by_id (
    id UUID PRIMARY KEY,
    email TEXT
);

CREATE TABLE IF NOT EXISTS shopper_shipping_addresses (
    user_id TEXT,
    address_id UUID,
    label TEXT,
    first_name TEXT,
    last_name TEXT,
    address1 TEXT,
    address2 TEXT,
    city TEXT,
    state TEXT,
    postal_code TEXT,
    country TEXT,
    phone TEXT,
    email TEXT,
    is_default BOOLEAN,
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    PRIMARY KEY (user_id, address_id)
);

-- ===========================================
-- Workflow Observability (ADR-0010, ported from nightheron-mono)
-- ===========================================
-- Async state-transition projection: every state-machine transition, with a full JSON
-- snapshot of the workflow context and the decoded trigger payload. Written off the hot
-- path by the in-workflow AsyncTransitionRecorder. Audit/debug projection, not a source of
-- truth (Temporal remains authoritative). store_id is TEXT; in this demo it is always the
-- fixed 'demo' tenant. (at, run_id, seq) is workflow-determined → idempotent under activity
-- retry; run_id in the key keeps per-run seq collision-free across continue-as-new.
CREATE TABLE IF NOT EXISTS workflow_state_transitions (
    store_id TEXT,
    workflow_id TEXT,
    at TIMESTAMP,
    run_id TEXT,
    seq INT,
    workflow_type TEXT,
    domain TEXT,
    correlation_id TEXT,
    order_id TEXT,
    from_state TEXT,
    to_state TEXT,
    trigger_kind TEXT,
    trigger_name TEXT,
    trigger_payload TEXT,
    context_snapshot TEXT,
    prepare_activities TEXT,
    finalize_activities TEXT,
    update_result TEXT,
    PRIMARY KEY ((store_id, workflow_id), at, run_id, seq)
) WITH CLUSTERING ORDER BY (at ASC, run_id ASC, seq ASC)
  AND default_time_to_live = 7776000;
