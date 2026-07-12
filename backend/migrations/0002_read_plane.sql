SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE indexer_cursors (
    stream TEXT PRIMARY KEY CHECK (length(stream) BETWEEN 1 AND 256),
    cursor_kind TEXT NOT NULL CHECK (cursor_kind IN ('account', 'event')),
    source_slot NUMERIC(20, 0) NOT NULL CHECK (source_slot >= 0),
    signature TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
        (cursor_kind = 'account' AND signature IS NULL)
        OR (cursor_kind = 'event' AND signature IS NOT NULL AND length(signature) > 0)
    )
);

CREATE TABLE solana_account_projections (
    address TEXT PRIMARY KEY CHECK (length(address) BETWEEN 1 AND 64),
    owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 64),
    lamports NUMERIC(20, 0) NOT NULL CHECK (lamports >= 0),
    account_kind TEXT NOT NULL CHECK (length(account_kind) BETWEEN 1 AND 128),
    account_data JSONB NOT NULL CHECK (jsonb_typeof(account_data) = 'object'),
    content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    source_slot NUMERIC(20, 0) NOT NULL CHECK (source_slot >= 0),
    is_active BOOLEAN NOT NULL DEFAULT true,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX solana_account_projection_kind_idx
    ON solana_account_projections (account_kind, source_slot DESC);

CREATE TABLE solana_program_events (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
    signature TEXT NOT NULL CHECK (length(signature) BETWEEN 1 AND 128),
    event_index INTEGER NOT NULL CHECK (event_index >= 0),
    source_slot NUMERIC(20, 0) NOT NULL CHECK (source_slot >= 0),
    block_time_ms NUMERIC(20, 0) CHECK (block_time_ms >= 0),
    event_name TEXT NOT NULL CHECK (length(event_name) BETWEEN 1 AND 128),
    event_data JSONB NOT NULL CHECK (jsonb_typeof(event_data) = 'object'),
    content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (signature, event_index)
);

CREATE TRIGGER solana_program_events_immutable
    BEFORE UPDATE OR DELETE ON solana_program_events
    FOR EACH ROW EXECUTE FUNCTION alphabasket_reject_mutation();

CREATE TABLE basket_portfolio_states (
    basket_id TEXT PRIMARY KEY CHECK (length(basket_id) BETWEEN 1 AND 128),
    ledger_version TEXT NOT NULL CHECK (length(ledger_version) BETWEEN 1 AND 256),
    composition_version NUMERIC(20, 0) NOT NULL CHECK (composition_version >= 0),
    composition_hash TEXT NOT NULL CHECK (composition_hash ~ '^[0-9a-f]{64}$'),
    idle_pusd_units NUMERIC(20, 0) NOT NULL CHECK (idle_pusd_units >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE basket_holding_projections (
    basket_id TEXT NOT NULL REFERENCES basket_portfolio_states(basket_id),
    market_id TEXT NOT NULL CHECK (length(market_id) BETWEEN 1 AND 64),
    token_id TEXT NOT NULL CHECK (token_id ~ '^(0|[1-9][0-9]*)$'),
    outcome TEXT NOT NULL CHECK (length(outcome) BETWEEN 1 AND 128),
    quantity_units NUMERIC(78, 0) NOT NULL CHECK (quantity_units >= 0),
    mark_price_units NUMERIC(20, 0) NOT NULL CHECK (mark_price_units >= 0),
    price_scale NUMERIC(20, 0) NOT NULL CHECK (price_scale > 0),
    mark_observed_at_ms NUMERIC(20, 0) NOT NULL CHECK (mark_observed_at_ms >= 0),
    mark_source_hash TEXT NOT NULL CHECK (length(mark_source_hash) BETWEEN 1 AND 256),
    mark_condition TEXT NOT NULL CHECK (
        mark_condition IN ('fresh', 'stale', 'illiquid', 'unavailable')
    ),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (basket_id, market_id, token_id, outcome)
);

CREATE TABLE basket_share_supply_projections (
    basket_id TEXT PRIMARY KEY CHECK (length(basket_id) BETWEEN 1 AND 128),
    total_shares_units NUMERIC(20, 0) NOT NULL CHECK (total_shares_units >= 0),
    protocol_fee_shares_units NUMERIC(20, 0) NOT NULL CHECK (protocol_fee_shares_units >= 0),
    last_management_fee_at_seconds NUMERIC(20, 0) NOT NULL
        CHECK (last_management_fee_at_seconds >= 0),
    management_fee_accrual_remainder NUMERIC(39, 0) NOT NULL
        CHECK (management_fee_accrual_remainder >= 0),
    source_slot NUMERIC(20, 0) NOT NULL CHECK (source_slot >= 0),
    source_version TEXT NOT NULL CHECK (length(source_version) BETWEEN 1 AND 256),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (protocol_fee_shares_units <= total_shares_units)
);

CREATE TABLE nav_sequence_counters (
    basket_id TEXT PRIMARY KEY CHECK (length(basket_id) BETWEEN 1 AND 128),
    next_sequence NUMERIC(20, 0) NOT NULL CHECK (next_sequence > 0)
);

CREATE TABLE nav_snapshots (
    basket_id TEXT NOT NULL CHECK (length(basket_id) BETWEEN 1 AND 128),
    sequence NUMERIC(20, 0) NOT NULL CHECK (sequence >= 0),
    snapshot_hash TEXT NOT NULL UNIQUE CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
    observed_at_ms NUMERIC(20, 0) NOT NULL CHECK (observed_at_ms >= 0),
    snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (basket_id, sequence)
);

CREATE TRIGGER nav_snapshots_immutable
    BEFORE UPDATE OR DELETE ON nav_snapshots
    FOR EACH ROW EXECUTE FUNCTION alphabasket_reject_mutation();

CREATE TABLE execution_wallets (
    wallet_id TEXT PRIMARY KEY CHECK (length(wallet_id) BETWEEN 1 AND 128),
    polygon_address TEXT NOT NULL UNIQUE CHECK (polygon_address ~ '^0x[0-9a-fA-F]{40}$'),
    shard TEXT NOT NULL CHECK (length(shard) BETWEEN 1 AND 128),
    status TEXT NOT NULL CHECK (status IN ('active', 'draining', 'disabled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE wallet_assignments (
    basket_id TEXT PRIMARY KEY CHECK (length(basket_id) BETWEEN 1 AND 128),
    wallet_id TEXT NOT NULL REFERENCES execution_wallets(wallet_id),
    shard TEXT NOT NULL CHECK (length(shard) BETWEEN 1 AND 128),
    strategy_version TEXT NOT NULL CHECK (length(strategy_version) BETWEEN 1 AND 128),
    assigned_at_ms NUMERIC(20, 0) NOT NULL CHECK (assigned_at_ms >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER wallet_assignments_immutable
    BEFORE UPDATE OR DELETE ON wallet_assignments
    FOR EACH ROW EXECUTE FUNCTION alphabasket_reject_mutation();
