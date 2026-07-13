SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE execution_operations (
    id UUID PRIMARY KEY,
    request_key TEXT NOT NULL UNIQUE CHECK (length(request_key) BETWEEN 1 AND 256),
    request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    kind TEXT NOT NULL CHECK (kind IN ('deposit', 'withdrawal', 'protocol_fee_withdrawal')),
    state TEXT NOT NULL CHECK (state IN (
        'created', 'intent_verified', 'funding_verified', 'bridge_pending',
        'bridge_completed', 'trading_completed', 'settlement_submitted',
        'completed', 'failed'
    )),
    workflow_id TEXT NOT NULL UNIQUE CHECK (length(workflow_id) BETWEEN 1 AND 256),
    basket TEXT NOT NULL CHECK (length(basket) BETWEEN 32 AND 64),
    user_address TEXT,
    checkpoint JSONB NOT NULL CHECK (jsonb_typeof(checkpoint) = 'object'),
    version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    CHECK ((state = 'completed') = (completed_at IS NOT NULL))
);

CREATE INDEX execution_operations_state_idx
    ON execution_operations (state, updated_at, id)
    WHERE state NOT IN ('completed', 'failed');

CREATE TABLE financial_quotes (
    id UUID PRIMARY KEY,
    operation_id UUID NOT NULL REFERENCES execution_operations(id),
    quote_hash TEXT NOT NULL UNIQUE CHECK (quote_hash ~ '^[0-9a-f]{64}$'),
    quote_kind TEXT NOT NULL CHECK (quote_kind IN ('deposit', 'withdrawal')),
    composition_version INTEGER NOT NULL CHECK (composition_version > 0),
    nav_report_hash TEXT NOT NULL CHECK (nav_report_hash ~ '^[0-9a-f]{64}$'),
    share_price NUMERIC(20, 0) NOT NULL CHECK (share_price > 0),
    expires_at TIMESTAMPTZ NOT NULL,
    payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (operation_id, quote_kind)
);

CREATE TABLE signed_intents (
    id UUID PRIMARY KEY,
    operation_id UUID NOT NULL UNIQUE REFERENCES execution_operations(id),
    quote_id UUID NOT NULL UNIQUE REFERENCES financial_quotes(id),
    intent_nonce NUMERIC(20, 0) NOT NULL CHECK (intent_nonce > 0),
    intent_hash TEXT NOT NULL UNIQUE CHECK (intent_hash ~ '^[0-9a-f]{64}$'),
    encoded_message BYTEA NOT NULL CHECK (octet_length(encoded_message) > 0),
    signer_public_key BYTEA NOT NULL CHECK (octet_length(signer_public_key) = 32),
    signature BYTEA NOT NULL CHECK (octet_length(signature) = 64),
    verified_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE bridge_transfers (
    id UUID PRIMARY KEY,
    operation_id UUID NOT NULL REFERENCES execution_operations(id),
    direction TEXT NOT NULL CHECK (direction IN ('deposit', 'withdrawal')),
    bridge_address TEXT NOT NULL CHECK (length(bridge_address) BETWEEN 16 AND 256),
    source_chain TEXT NOT NULL CHECK (length(source_chain) BETWEEN 1 AND 64),
    destination_chain TEXT NOT NULL CHECK (length(destination_chain) BETWEEN 1 AND 64),
    input_asset TEXT NOT NULL CHECK (length(input_asset) BETWEEN 1 AND 128),
    output_asset TEXT NOT NULL CHECK (length(output_asset) BETWEEN 1 AND 128),
    input_amount NUMERIC(78, 0) NOT NULL CHECK (input_amount > 0),
    output_amount NUMERIC(78, 0) CHECK (output_amount IS NULL OR output_amount > 0),
    source_tx_hash TEXT,
    destination_tx_hash TEXT,
    provider_status TEXT NOT NULL CHECK (length(provider_status) BETWEEN 1 AND 64),
    provider_payload JSONB NOT NULL CHECK (jsonb_typeof(provider_payload) = 'object'),
    observed_at TIMESTAMPTZ NOT NULL,
    UNIQUE (operation_id, direction),
    UNIQUE (direction, bridge_address, source_tx_hash)
);

CREATE TABLE clob_execution_orders (
    id UUID PRIMARY KEY,
    operation_id UUID NOT NULL REFERENCES execution_operations(id),
    client_order_id TEXT NOT NULL UNIQUE CHECK (length(client_order_id) BETWEEN 1 AND 256),
    order_id TEXT NOT NULL UNIQUE CHECK (length(order_id) BETWEEN 1 AND 256),
    token_id TEXT NOT NULL CHECK (length(token_id) BETWEEN 1 AND 128),
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    order_type TEXT NOT NULL CHECK (order_type = 'FAK'),
    requested_amount NUMERIC(78, 0) NOT NULL CHECK (requested_amount > 0),
    filled_input_amount NUMERIC(78, 0) NOT NULL CHECK (filled_input_amount >= 0),
    filled_output_amount NUMERIC(78, 0) NOT NULL CHECK (filled_output_amount >= 0),
    average_price NUMERIC(20, 0) CHECK (average_price IS NULL OR average_price > 0),
    status TEXT NOT NULL CHECK (status IN ('matched', 'partially_filled', 'unfilled', 'failed')),
    transaction_hashes JSONB NOT NULL CHECK (jsonb_typeof(transaction_hashes) = 'array'),
    trade_ids JSONB NOT NULL CHECK (jsonb_typeof(trade_ids) = 'array'),
    executed_at TIMESTAMPTZ NOT NULL,
    CHECK (
        (filled_input_amount = 0 AND filled_output_amount = 0)
        OR (filled_input_amount > 0 AND filled_output_amount > 0)
    )
);

CREATE INDEX clob_execution_orders_operation_idx
    ON clob_execution_orders (operation_id, side, id);

CREATE TABLE settlement_submissions (
    id UUID PRIMARY KEY,
    operation_id UUID NOT NULL UNIQUE REFERENCES execution_operations(id),
    execution_batch_hash TEXT NOT NULL UNIQUE CHECK (execution_batch_hash ~ '^[0-9a-f]{64}$'),
    settlement_nonce NUMERIC(20, 0) NOT NULL CHECK (settlement_nonce > 0),
    transaction_signature TEXT,
    receipt_address TEXT NOT NULL CHECK (length(receipt_address) BETWEEN 32 AND 64),
    status TEXT NOT NULL CHECK (status IN ('prepared', 'submitted', 'finalized', 'failed')),
    submitted_at TIMESTAMPTZ,
    finalized_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CHECK ((status IN ('submitted', 'finalized')) = (transaction_signature IS NOT NULL)),
    CHECK ((status = 'finalized') = (finalized_at IS NOT NULL))
);

CREATE TRIGGER financial_quotes_immutable
    BEFORE UPDATE OR DELETE ON financial_quotes
    FOR EACH ROW EXECUTE FUNCTION alphabasket_reject_mutation();

CREATE TRIGGER signed_intents_immutable
    BEFORE UPDATE OR DELETE ON signed_intents
    FOR EACH ROW EXECUTE FUNCTION alphabasket_reject_mutation();

CREATE TRIGGER clob_execution_orders_immutable
    BEFORE UPDATE OR DELETE ON clob_execution_orders
    FOR EACH ROW EXECUTE FUNCTION alphabasket_reject_mutation();
