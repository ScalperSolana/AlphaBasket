SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE execution_work_items (
    operation_id UUID PRIMARY KEY REFERENCES execution_operations(id),
    state TEXT NOT NULL CHECK (state IN (
        'awaiting_funding', 'pending', 'claimed', 'dispatched', 'completed'
    )),
    wallet_id TEXT NOT NULL REFERENCES execution_wallets(wallet_id),
    polymarket_wallet TEXT NOT NULL CHECK (
        polymarket_wallet ~ '^0x[0-9a-fA-F]{40}$'
    ),
    withdrawal_destination TEXT CHECK (
        withdrawal_destination IS NULL
        OR length(withdrawal_destination) BETWEEN 32 AND 64
    ),
    funding_address TEXT CHECK (
        funding_address IS NULL
        OR length(funding_address) BETWEEN 32 AND 128
    ),
    funding_transaction_signature TEXT CHECK (
        funding_transaction_signature IS NULL
        OR length(funding_transaction_signature) BETWEEN 32 AND 128
    ),
    funding_idempotency_key TEXT CHECK (
        funding_idempotency_key IS NULL
        OR length(funding_idempotency_key) BETWEEN 8 AND 128
    ),
    claim_token UUID,
    claim_owner TEXT CHECK (
        claim_owner IS NULL OR length(claim_owner) BETWEEN 1 AND 256
    ),
    claim_expires_at TIMESTAMPTZ,
    dispatch_attempts INTEGER NOT NULL DEFAULT 0
        CHECK (dispatch_attempts BETWEEN 0 AND 1000),
    next_attempt_at TIMESTAMPTZ NOT NULL,
    temporal_run_id TEXT,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    CHECK (
        (state = 'awaiting_funding'
         AND funding_transaction_signature IS NULL)
        OR state <> 'awaiting_funding'
    ),
    CHECK (
        (state = 'claimed'
         AND claim_token IS NOT NULL
         AND claim_owner IS NOT NULL
         AND claim_expires_at IS NOT NULL)
        OR
        (state <> 'claimed'
         AND claim_token IS NULL
         AND claim_owner IS NULL
         AND claim_expires_at IS NULL)
    ),
    CHECK (
        (state = 'completed' AND completed_at IS NOT NULL)
        OR (state <> 'completed' AND completed_at IS NULL)
    )
);

CREATE UNIQUE INDEX execution_work_items_funding_key_idx
    ON execution_work_items (funding_idempotency_key)
    WHERE funding_idempotency_key IS NOT NULL;

CREATE INDEX execution_work_items_dispatch_idx
    ON execution_work_items (state, next_attempt_at, operation_id)
    WHERE state IN ('pending', 'claimed');

CREATE TABLE portfolio_execution_commits (
    operation_id UUID PRIMARY KEY REFERENCES execution_operations(id),
    execution_batch_hash TEXT NOT NULL UNIQUE
        CHECK (execution_batch_hash ~ '^[0-9a-f]{64}$'),
    basket_id TEXT NOT NULL REFERENCES basket_portfolio_states(basket_id),
    ledger_version_before TEXT NOT NULL
        CHECK (length(ledger_version_before) BETWEEN 1 AND 256),
    ledger_version_after TEXT NOT NULL UNIQUE
        CHECK (length(ledger_version_after) BETWEEN 1 AND 256),
    committed_at TIMESTAMPTZ NOT NULL
);

CREATE TRIGGER portfolio_execution_commits_immutable
    BEFORE UPDATE OR DELETE ON portfolio_execution_commits
    FOR EACH ROW EXECUTE FUNCTION alphabasket_reject_mutation();
