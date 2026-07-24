CREATE TABLE IF NOT EXISTS execution_gateway_requests (
    request_key TEXT PRIMARY KEY,
    request_kind TEXT NOT NULL CHECK (
        request_kind IN ('fak_order', 'pusd_transfer', 'solana_split')
    ),
    request_hash CHAR(64) NOT NULL,
    signed_payload BYTEA,
    transaction_reference TEXT,
    result JSONB,
    state TEXT NOT NULL CHECK (
        state IN ('prepared', 'submitted', 'finalized', 'failed')
    ),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    finalized_at TIMESTAMPTZ,
    CHECK (signed_payload IS NOT NULL OR state = 'failed'),
    CHECK ((state = 'finalized') = (result IS NOT NULL)),
    CHECK ((state = 'finalized') = (finalized_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS execution_gateway_requests_state_idx
    ON execution_gateway_requests (state, updated_at);
