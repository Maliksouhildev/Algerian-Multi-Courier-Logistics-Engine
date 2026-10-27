-- ============================================================================
-- Algerian Multi-Courier Logistics Engine (V4 — Final Production Schema)
-- Supports: Yalidine, ZR Express (Procolis), Maystro Delivery, 80+ Ecotrack Couriers
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Tenants & Courier Accounts (Multi-Tenant + Origin Warehouse)
CREATE TABLE tenants (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE courier_accounts (
    id SERIAL PRIMARY KEY,
    tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    courier_code VARCHAR(32) NOT NULL, -- 'yalidine', 'zrexpress', 'maystro', 'ecotrack_{subdomain}'
    display_name VARCHAR(100) NOT NULL,
    base_url VARCHAR(255) NOT NULL,
    webhook_auth_strategy VARCHAR(32) NOT NULL DEFAULT 'HMAC_SHA256',
    -- Strategies: 'HMAC_SHA256', 'BEARER_TOKEN', 'QUERY_TOKEN', 'IP_WHITELIST', 'POLLING_ONLY'
    encryption_key_version SMALLINT NOT NULL DEFAULT 1,
    -- Envelope: v{ver}:{24-hex-iv}:{32-hex-tag}:{ciphertext} with AAD = "{tenant_id}:{courier_code}"
    api_id_encrypted TEXT NULL,
    api_token_encrypted TEXT NOT NULL,
    webhook_secret_encrypted TEXT NULL,
    origin_wilaya_id INT NOT NULL,
    origin_wilaya_name VARCHAR(100) NOT NULL,
    origin_commune_name VARCHAR(100) NOT NULL,
    pickup_address TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Holds courier-specific config: {"default_product_uuid": "...", "validation_path": "/api/v1/valid/order"}
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT check_token_envelope CHECK (
        api_token_encrypted ~ '^v[0-9]+:[0-9a-fA-F]{24}:[0-9a-fA-F]{32}:[0-9a-fA-F]+$'
        AND (api_id_encrypted IS NULL OR api_id_encrypted ~ '^v[0-9]+:[0-9a-fA-F]{24}:[0-9a-fA-F]{32}:[0-9a-fA-F]+$')
        AND (webhook_secret_encrypted IS NULL OR webhook_secret_encrypted ~ '^v[0-9]+:[0-9a-fA-F]{24}:[0-9a-fA-F]{32}:[0-9a-fA-F]+$')
    )
);

-- 2. Geographic Infrastructure
CREATE TABLE geo_wilayas (
    id INT PRIMARY KEY, -- 1 to 69
    name_fr VARCHAR(100) NOT NULL,
    name_ar VARCHAR(100) NOT NULL,
    zone INT DEFAULT 1
);

CREATE TABLE geo_communes (
    id SERIAL PRIMARY KEY,
    wilaya_id INT NOT NULL REFERENCES geo_wilayas(id) ON DELETE CASCADE,
    name_fr VARCHAR(100) NOT NULL,
    name_ar VARCHAR(100) NOT NULL,
    postal_code VARCHAR(10) NULL
);

-- Courier-Specific Commune & Wilaya Translation (Handles 58 vs 69 reform & spelling drift)
CREATE TABLE courier_commune_mappings (
    id SERIAL PRIMARY KEY,
    courier_code VARCHAR(32) NOT NULL,
    commune_id INT NOT NULL REFERENCES geo_communes(id) ON DELETE CASCADE,
    courier_wilaya_id INT NOT NULL,            -- Courier's internal Wilaya ID
    courier_wilaya_name VARCHAR(100) NOT NULL, -- Exact Wilaya string required by Yalidine
    courier_commune_id VARCHAR(64) NULL,       -- Exact integer Commune ID required by Maystro
    courier_commune_name VARCHAR(100) NOT NULL,
    is_deliverable_home BOOLEAN DEFAULT TRUE,
    UNIQUE(courier_code, commune_id)
);

-- Decoupled Stop-Desks (Queryable at Wilaya level)
CREATE TABLE courier_stopdesks (
    id SERIAL PRIMARY KEY,
    courier_code VARCHAR(32) NOT NULL,
    remote_center_id VARCHAR(64) NOT NULL,
    wilaya_id INT NOT NULL REFERENCES geo_wilayas(id),
    commune_id INT NULL REFERENCES geo_communes(id), -- Nullable so unmatched commune names on midnight sync never crash
    courier_wilaya_name VARCHAR(100) NOT NULL,
    courier_commune_id VARCHAR(64) NULL,             -- Maystro Stop-Desk host commune integer ID
    courier_commune_name VARCHAR(100) NOT NULL,      -- Yalidine Stop-Desk host commune exact string
    name VARCHAR(150) NOT NULL,
    address TEXT NOT NULL,
    phone VARCHAR(50) NULL,
    is_active BOOLEAN DEFAULT TRUE,
    last_synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(courier_code, remote_center_id)
);

-- 3. Orders & Dispatched Shipments
CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    tenant_id INT NOT NULL REFERENCES tenants(id),
    reference VARCHAR(64) NOT NULL,
    customer_name VARCHAR(150) NOT NULL,
    phone_primary VARCHAR(20) NOT NULL,
    phone_secondary VARCHAR(20) NULL,
    delivery_address TEXT NOT NULL,
    wilaya_id INT NOT NULL REFERENCES geo_wilayas(id),
    commune_id INT NULL REFERENCES geo_communes(id),
    is_stopdesk BOOLEAN DEFAULT FALSE,
    target_courier_code VARCHAR(32) NULL,
    stopdesk_id VARCHAR(64) NULL,
    product_description TEXT NOT NULL,
    total_cod_amount NUMERIC(12, 2) NOT NULL,
    is_free_shipping BOOLEAN DEFAULT FALSE,
    declared_value NUMERIC(12, 2) DEFAULT 0,
    do_insurance BOOLEAN DEFAULT FALSE,
    has_exchange BOOLEAN DEFAULT FALSE,
    product_to_collect TEXT NULL,
    estimated_weight NUMERIC(6, 2) DEFAULT 1.00,
    order_status VARCHAR(40) NOT NULL DEFAULT 'PENDING_CONFIRMATION',
    -- Statuses: 'PENDING_CONFIRMATION', 'CONFIRMED', 'DISPATCHING', 'DISPATCH_VERIFICATION_PENDING',
    -- 'DISPATCH_VALIDATION_PENDING', 'DISPATCH_MANUAL_RECONCILIATION_REQUIRED', 'PUSHED_TO_COURIER', 'DISPATCH_FAILED'
    dispatch_started_at TIMESTAMP WITH TIME ZONE NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT uq_orders_tenant_reference UNIQUE (tenant_id, reference),
    CONSTRAINT chk_order_location CHECK (
        (is_stopdesk = FALSE AND commune_id IS NOT NULL)
        OR (is_stopdesk = TRUE AND stopdesk_id IS NOT NULL)
    )
);

CREATE TABLE shipping_parcels (
    id SERIAL PRIMARY KEY,
    order_id INT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    courier_account_id INT NOT NULL REFERENCES courier_accounts(id),
    courier_code VARCHAR(32) NOT NULL,
    tracking_number VARCHAR(100) NOT NULL,
    is_validated_by_courier BOOLEAN NOT NULL DEFAULT TRUE, -- FALSE until Ecotrack Step B (/valid/order) succeeds
    phase_gate VARCHAR(32) NOT NULL DEFAULT 'PREPARATION',
    -- Phases: 'PREPARATION', 'IN_TRANSIT', 'DELIVERY_LOOP', 'RETURN_IN_TRANSIT',
    -- 'TERMINAL_DELIVERED', 'TERMINAL_RETURNED', 'CANCELLED', 'FAILED_PERMANENTLY'
    current_status_raw VARCHAR(100) NOT NULL,
    attempt_count INT DEFAULT 0,
    payment_status VARCHAR(32) NOT NULL DEFAULT 'UNPAID', -- 'UNPAID', 'COLLECTED_BY_COURIER', 'SETTLED'
    cod_amount NUMERIC(12, 2) NOT NULL,
    base_delivery_fee NUMERIC(10, 2) NOT NULL DEFAULT 0,
    return_fee NUMERIC(10, 2) NOT NULL DEFAULT 0,
    cod_collection_fee NUMERIC(10, 2) NOT NULL DEFAULT 0,
    weight_surcharge NUMERIC(10, 2) NOT NULL DEFAULT 0,
    insurance_fee NUMERIC(10, 2) NOT NULL DEFAULT 0,
    exchange_fee NUMERIC(10, 2) NOT NULL DEFAULT 0,
    billed_weight NUMERIC(6, 2) NULL,
    label_pdf_path TEXT NULL,
    last_event_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT uq_parcel_courier_tracking UNIQUE (courier_code, tracking_number)
);

-- PARTIAL UNIQUE INDEX: Prevents double active parcels while allowing re-shipping after return/cancel/failure
CREATE UNIQUE INDEX idx_one_active_parcel_per_order 
ON shipping_parcels (order_id) 
WHERE phase_gate NOT IN ('TERMINAL_RETURNED', 'CANCELLED', 'FAILED_PERMANENTLY');

CREATE INDEX idx_parcels_reconciler 
ON shipping_parcels (courier_account_id, last_event_at) 
WHERE phase_gate NOT IN ('TERMINAL_DELIVERED', 'TERMINAL_RETURNED', 'CANCELLED', 'FAILED_PERMANENTLY');

CREATE INDEX idx_stopdesks_wilaya ON courier_stopdesks(courier_code, wilaya_id, is_active);

CREATE TABLE order_dispatch_errors (
    id BIGSERIAL PRIMARY KEY,
    order_id INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    courier_account_id INT NOT NULL REFERENCES courier_accounts(id),
    error_code VARCHAR(100) NULL,
    error_message TEXT NOT NULL,
    raw_response JSONB NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Append-Only Financial Clearing Ledger
CREATE TABLE courier_financial_ledger (
    id BIGSERIAL PRIMARY KEY,
    parcel_id INT NOT NULL REFERENCES shipping_parcels(id),
    entry_type VARCHAR(32) NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    batch_reference VARCHAR(100) NULL,
    idempotency_key VARCHAR(120) NOT NULL UNIQUE, -- e.g. 'parcel_992:WEIGHT_SURCHARGE_DEBIT:batch_44'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT chk_ledger_positive_magnitude CHECK (amount >= 0),
    CONSTRAINT chk_ledger_entry_type CHECK (
        entry_type IN (
            'COD_CREDIT', 'ADJUSTMENT_CREDIT',
            'BASE_DELIVERY_DEBIT', 'RETURN_PENALTY_DEBIT', 'COD_FEE_DEBIT',
            'WEIGHT_SURCHARGE_DEBIT', 'INSURANCE_DEBIT', 'EXCHANGE_FEE_DEBIT', 'ADJUSTMENT_DEBIT'
        )
    )
);
