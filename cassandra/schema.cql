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
    supplier_id TEXT,
    supplier_name TEXT,
    supplier_order_id TEXT,
    quantity INT,
    carrier TEXT,
    status TEXT
);

CREATE TYPE IF NOT EXISTS supplier_order_item (
    assignment_id TEXT,
    variant_id TEXT,
    quantity INT
);

CREATE TYPE IF NOT EXISTS supplier_order_history_entry (
    status TEXT,
    timestamp TIMESTAMP,
    note TEXT
);

CREATE TYPE IF NOT EXISTS supplier_order (
    supplier_order_id TEXT,
    order_id TEXT,
    supplier_id TEXT,
    supplier_name TEXT,
    status TEXT,
    items LIST<FROZEN<supplier_order_item>>,
    carrier TEXT,
    tracking_number TEXT,
    rejection_reason TEXT,
    status_history LIST<FROZEN<supplier_order_history_entry>>,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

-- ===========================================
-- Store (single demo store — kept for reference only)
-- ===========================================

CREATE TABLE IF NOT EXISTS stores (
    id UUID PRIMARY KEY,
    name TEXT,
    slug TEXT,
    status TEXT,
    owner_email TEXT,
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
    blank_brand TEXT,
    blank_model TEXT,
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

CREATE TABLE IF NOT EXISTS option_types (
    name TEXT PRIMARY KEY,
    description TEXT
);

CREATE TABLE IF NOT EXISTS option_values_by_type (
    option_type TEXT,
    label TEXT,
    attributes MAP<TEXT, TEXT>,
    PRIMARY KEY (option_type, label)
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
    supplier_orders LIST<FROZEN<supplier_order>>,
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
-- Supplier Tables
-- ===========================================

CREATE TABLE IF NOT EXISTS suppliers (
    id TEXT,
    name TEXT,
    created_at TIMESTAMP,
    PRIMARY KEY (id)
);

INSERT INTO suppliers (id, name, created_at)
VALUES ('default-supplier', 'Default Supplier', toTimestamp(now()));

CREATE TABLE IF NOT EXISTS supplier_locations (
    supplier_id TEXT,
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
    PRIMARY KEY (supplier_id, location_id)
);
CREATE INDEX IF NOT EXISTS idx_supplier_locations_is_primary ON supplier_locations (is_primary);

INSERT INTO supplier_locations (supplier_id, location_id, name, cost, address1, city, state, postal_code, country, is_primary, created_at)
VALUES ('default-supplier', 'default-warehouse', 'Default Warehouse', 0, '123 Warehouse Ave', 'Warehouse City', 'WC', '00000', 'US', true, toTimestamp(now()));

-- ===========================================
-- Inventory Tables (CQRS Write Side)
-- ===========================================

CREATE TABLE IF NOT EXISTS inventory_stock_w (
    blank_sku TEXT,
    supplier_id TEXT,
    supplier_name TEXT,
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
    PRIMARY KEY (blank_sku, supplier_id)
);

CREATE TABLE IF NOT EXISTS inventory_reservations_w (
    reservation_id TEXT PRIMARY KEY,
    blank_sku TEXT,
    cart_id TEXT,
    variant_id TEXT,
    supplier_id TEXT,
    quantity INT,
    reference_id TEXT,
    status TEXT,
    expires_at TIMESTAMP,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_reservations_status ON inventory_reservations_w (status);
CREATE INDEX IF NOT EXISTS idx_reservations_blank_sku ON inventory_reservations_w (blank_sku);

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
    supplier_count INT,
    low_stock BOOLEAN,
    last_projected_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS inventory_stock_by_supplier (
    supplier_id TEXT,
    blank_sku TEXT,
    supplier_name TEXT,
    total_stock INT,
    reserved_stock INT,
    available_stock INT,
    cost INT,
    city TEXT,
    state TEXT,
    country TEXT,
    last_projected_at TIMESTAMP,
    PRIMARY KEY (supplier_id, blank_sku)
);

CREATE TABLE IF NOT EXISTS inventory_reservations_by_sku (
    blank_sku TEXT,
    reservation_id TEXT,
    cart_id TEXT,
    variant_id TEXT,
    quantity INT,
    status TEXT,
    supplier_id TEXT,
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
    store_id TEXT,
    email TEXT,
    id UUID,
    password_hash TEXT,
    name TEXT,
    phone TEXT,
    failed_attempts INT,
    locked_until TIMESTAMP,
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    PRIMARY KEY (store_id, email)
);

CREATE TABLE IF NOT EXISTS shopper_shipping_addresses (
    store_id TEXT,
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
    PRIMARY KEY (store_id, user_id, address_id)
);
