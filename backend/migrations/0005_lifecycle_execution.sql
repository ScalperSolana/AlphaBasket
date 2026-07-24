SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE basket_holding_projections
    ADD COLUMN condition_id TEXT
        CHECK (condition_id IS NULL OR condition_id ~ '^0x[0-9a-f]{64}$'),
    ADD COLUMN negative_risk BOOLEAN;

CREATE TABLE lifecycle_external_executions (
    operation_id TEXT PRIMARY KEY CHECK (length(operation_id) BETWEEN 1 AND 256),
    request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    kind TEXT NOT NULL CHECK (kind IN ('reconstitution', 'resolution')),
    basket_id TEXT NOT NULL CHECK (length(basket_id) BETWEEN 1 AND 128),
    state TEXT NOT NULL CHECK (state IN ('prepared', 'completed')),
    plan JSONB CHECK (plan IS NULL OR jsonb_typeof(plan) = 'object'),
    result JSONB CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    CHECK (
        (state = 'completed' AND result IS NOT NULL AND completed_at IS NOT NULL)
        OR (state = 'prepared' AND result IS NULL AND completed_at IS NULL)
    )
);

CREATE INDEX lifecycle_external_executions_active_idx
    ON lifecycle_external_executions (kind, basket_id, updated_at)
    WHERE state = 'prepared';

CREATE TABLE polymarket_condition_redemptions (
    wallet_address TEXT NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
    condition_id TEXT NOT NULL CHECK (condition_id ~ '^0x[0-9a-f]{64}$'),
    request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    negative_risk BOOLEAN NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('prepared', 'completed')),
    winning_token_id TEXT NOT NULL CHECK (winning_token_id ~ '^(0|[1-9][0-9]*)$'),
    wallet_payout_units NUMERIC(78, 0) NOT NULL CHECK (wallet_payout_units >= 0),
    wallet_balance_before_units NUMERIC(78, 0) NOT NULL CHECK (wallet_balance_before_units >= 0),
    relayer_transaction_id TEXT,
    polygon_transaction_hash TEXT CHECK (
        polygon_transaction_hash IS NULL OR polygon_transaction_hash ~ '^0x[0-9a-f]{64}$'
    ),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    PRIMARY KEY (wallet_address, condition_id),
    CHECK (
        (state = 'completed' AND relayer_transaction_id IS NOT NULL
                             AND polygon_transaction_hash IS NOT NULL
                             AND completed_at IS NOT NULL)
        OR (state = 'prepared' AND relayer_transaction_id IS NULL
                            AND polygon_transaction_hash IS NULL
                            AND completed_at IS NULL)
    )
);

CREATE TRIGGER polymarket_condition_redemptions_no_delete
    BEFORE DELETE ON polymarket_condition_redemptions
    FOR EACH ROW EXECUTE FUNCTION alphabasket_reject_mutation();

CREATE TABLE solana_lifecycle_operations (
    id UUID PRIMARY KEY,
    operation_key TEXT NOT NULL UNIQUE CHECK (length(operation_key) BETWEEN 1 AND 256),
    batch_hash TEXT NOT NULL CHECK (batch_hash ~ '^[0-9a-f]{64}$'),
    state TEXT NOT NULL CHECK (state IN ('pending', 'finalized', 'failed')),
    finalized_signature TEXT,
    finalized_slot NUMERIC(20, 0) CHECK (finalized_slot IS NULL OR finalized_slot >= 0),
    last_error TEXT,
    version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    CHECK (
        (state = 'finalized' AND finalized_signature IS NOT NULL
                             AND finalized_slot IS NOT NULL
                             AND completed_at IS NOT NULL)
        OR (state <> 'finalized' AND finalized_signature IS NULL
                              AND finalized_slot IS NULL
                              AND completed_at IS NULL)
    )
);

CREATE TABLE solana_lifecycle_submission_attempts (
    operation_id UUID NOT NULL REFERENCES solana_lifecycle_operations(id),
    attempt_number INTEGER NOT NULL CHECK (attempt_number BETWEEN 1 AND 32),
    state TEXT NOT NULL CHECK (state IN ('signed', 'submitted', 'expired', 'finalized', 'rejected')),
    transaction_signature TEXT NOT NULL CHECK (length(transaction_signature) BETWEEN 64 AND 128),
    serialized_transaction BYTEA NOT NULL CHECK (octet_length(serialized_transaction) BETWEEN 1 AND 1232),
    recent_blockhash TEXT NOT NULL CHECK (length(recent_blockhash) BETWEEN 32 AND 128),
    last_valid_block_height NUMERIC(20, 0) NOT NULL CHECK (last_valid_block_height >= 0),
    submitted_at TIMESTAMPTZ,
    finalized_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (operation_id, attempt_number),
    UNIQUE (transaction_signature),
    CHECK ((state IN ('submitted', 'finalized', 'rejected')) = (submitted_at IS NOT NULL)),
    CHECK ((state = 'finalized') = (finalized_at IS NOT NULL))
);

CREATE INDEX solana_lifecycle_attempts_signature_idx
    ON solana_lifecycle_submission_attempts (transaction_signature);

CREATE TRIGGER solana_lifecycle_operations_no_delete
    BEFORE DELETE ON solana_lifecycle_operations
    FOR EACH ROW EXECUTE FUNCTION alphabasket_reject_mutation();

CREATE TRIGGER solana_lifecycle_attempts_no_delete
    BEFORE DELETE ON solana_lifecycle_submission_attempts
    FOR EACH ROW EXECUTE FUNCTION alphabasket_reject_mutation();
