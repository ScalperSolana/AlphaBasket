SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE ledger_accounts (
    id UUID PRIMARY KEY,
    account_key TEXT NOT NULL UNIQUE CHECK (length(account_key) BETWEEN 1 AND 256),
    asset_code TEXT NOT NULL CHECK (length(asset_code) BETWEEN 1 AND 128),
    kind TEXT NOT NULL CHECK (
        kind IN (
            'available', 'reserved', 'bridge_in_flight',
            'position', 'fee', 'unallocated'
        )
    ),
    basket_id UUID,
    execution_wallet_id UUID,
    created_at TIMESTAMPTZ NOT NULL,
    CHECK (
        kind NOT IN ('available', 'reserved', 'bridge_in_flight', 'position')
        OR (basket_id IS NOT NULL AND execution_wallet_id IS NOT NULL)
    )
);

CREATE INDEX ledger_accounts_basket_asset_idx
    ON ledger_accounts (basket_id, asset_code)
    WHERE basket_id IS NOT NULL;

CREATE INDEX ledger_accounts_wallet_asset_idx
    ON ledger_accounts (execution_wallet_id, asset_code)
    WHERE execution_wallet_id IS NOT NULL;

CREATE TABLE ledger_transactions (
    id UUID PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE
        CHECK (length(idempotency_key) BETWEEN 1 AND 256),
    reference_type TEXT NOT NULL CHECK (length(reference_type) BETWEEN 1 AND 128),
    reference_id TEXT NOT NULL CHECK (length(reference_id) BETWEEN 1 AND 256),
    occurred_at TIMESTAMPTZ NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(metadata) = 'object'),
    fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
    database_txid BIGINT NOT NULL DEFAULT txid_current(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ledger_transactions_reference_idx
    ON ledger_transactions (reference_type, reference_id);

CREATE TABLE ledger_entries (
    transaction_id UUID NOT NULL REFERENCES ledger_transactions(id),
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    account_id UUID NOT NULL REFERENCES ledger_accounts(id),
    side TEXT NOT NULL CHECK (side IN ('debit', 'credit')),
    amount NUMERIC(78, 0) NOT NULL CHECK (amount > 0),
    PRIMARY KEY (transaction_id, sequence)
);

CREATE INDEX ledger_entries_account_idx
    ON ledger_entries (account_id, transaction_id);

CREATE FUNCTION alphabasket_reject_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER ledger_accounts_immutable
    BEFORE UPDATE OR DELETE ON ledger_accounts
    FOR EACH ROW EXECUTE FUNCTION alphabasket_reject_mutation();

CREATE TRIGGER ledger_transactions_immutable
    BEFORE UPDATE OR DELETE ON ledger_transactions
    FOR EACH ROW EXECUTE FUNCTION alphabasket_reject_mutation();

CREATE TRIGGER ledger_entries_immutable
    BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION alphabasket_reject_mutation();

CREATE FUNCTION alphabasket_lock_ledger_account()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    creating_txid BIGINT;
BEGIN
    SELECT database_txid
      INTO creating_txid
      FROM ledger_transactions
     WHERE id = NEW.transaction_id;

    IF creating_txid IS NULL OR creating_txid <> txid_current() THEN
        RAISE EXCEPTION 'ledger transaction % is sealed', NEW.transaction_id
            USING ERRCODE = '55000';
    END IF;

    PERFORM 1
      FROM ledger_accounts
     WHERE id = NEW.account_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ledger account % does not exist', NEW.account_id
            USING ERRCODE = '23503';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER ledger_entry_locks_account
    BEFORE INSERT ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION alphabasket_lock_ledger_account();

CREATE FUNCTION alphabasket_validate_ledger_transaction()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF (SELECT count(*) FROM ledger_entries WHERE transaction_id = NEW.id) < 2 THEN
        RAISE EXCEPTION 'ledger transaction % requires at least two entries', NEW.id
            USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT account.asset_code
          FROM ledger_entries AS entry
          JOIN ledger_accounts AS account ON account.id = entry.account_id
         WHERE entry.transaction_id = NEW.id
         GROUP BY account.asset_code
        HAVING sum(CASE WHEN entry.side = 'debit' THEN entry.amount ELSE 0 END)
             <> sum(CASE WHEN entry.side = 'credit' THEN entry.amount ELSE 0 END)
    ) THEN
        RAISE EXCEPTION 'ledger transaction % is not balanced per asset', NEW.id
            USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT account.id
          FROM ledger_accounts AS account
          JOIN ledger_entries AS changed ON changed.account_id = account.id
         WHERE changed.transaction_id = NEW.id
           AND account.kind <> 'unallocated'
         GROUP BY account.id
        HAVING (
            SELECT COALESCE(sum(
                CASE WHEN all_entries.side = 'debit'
                     THEN all_entries.amount ELSE -all_entries.amount END
            ), 0)
              FROM ledger_entries AS all_entries
             WHERE all_entries.account_id = account.id
        ) < 0
    ) THEN
        RAISE EXCEPTION 'ledger transaction % creates a negative account balance', NEW.id
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_transaction_balanced
    AFTER INSERT ON ledger_transactions
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION alphabasket_validate_ledger_transaction();

CREATE TABLE outbox_events (
    id UUID PRIMARY KEY,
    topic TEXT NOT NULL CHECK (length(topic) BETWEEN 1 AND 256),
    aggregate_type TEXT NOT NULL CHECK (length(aggregate_type) BETWEEN 1 AND 128),
    aggregate_id TEXT NOT NULL CHECK (length(aggregate_id) BETWEEN 1 AND 256),
    dedupe_key TEXT NOT NULL UNIQUE CHECK (length(dedupe_key) BETWEEN 1 AND 256),
    content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    payload JSONB NOT NULL,
    headers JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(headers) = 'object'),
    occurred_at TIMESTAMPTZ NOT NULL,
    available_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'leased', 'published', 'dead')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    lease_owner TEXT,
    lease_token UUID,
    lease_until TIMESTAMPTZ,
    published_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
        (status = 'leased' AND lease_owner IS NOT NULL
                           AND lease_token IS NOT NULL
                           AND lease_until IS NOT NULL)
        OR
        (status <> 'leased' AND lease_owner IS NULL
                            AND lease_token IS NULL
                            AND lease_until IS NULL)
    ),
    CHECK (
        (status = 'published' AND published_at IS NOT NULL)
        OR (status <> 'published' AND published_at IS NULL)
    )
);

CREATE INDEX outbox_events_claim_idx
    ON outbox_events (available_at, occurred_at, id)
    WHERE status IN ('pending', 'leased');

CREATE TABLE workflow_runs (
    workflow_id TEXT PRIMARY KEY CHECK (length(workflow_id) BETWEEN 1 AND 512),
    run_id TEXT NOT NULL UNIQUE CHECK (length(run_id) BETWEEN 1 AND 256),
    workflow_name TEXT NOT NULL CHECK (length(workflow_name) BETWEEN 1 AND 256),
    task_queue TEXT NOT NULL CHECK (length(task_queue) BETWEEN 1 AND 256),
    idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 256),
    status TEXT NOT NULL CHECK (
        status IN ('starting', 'running', 'completed', 'failed', 'cancelled')
    ),
    input JSONB NOT NULL,
    result JSONB,
    last_error TEXT,
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
        (status IN ('completed', 'failed', 'cancelled') AND completed_at IS NOT NULL)
        OR (status IN ('starting', 'running') AND completed_at IS NULL)
    )
);

CREATE INDEX workflow_runs_status_idx ON workflow_runs (status, updated_at);

CREATE TABLE signer_audit_log (
    id UUID PRIMARY KEY,
    role TEXT NOT NULL CHECK (
        role IN (
            'composer', 'solana_completion', 'nav_quote',
            'polymarket_order', 'solana_settlement'
        )
    ),
    key_reference TEXT,
    algorithm TEXT CHECK (algorithm IN ('ed25519', 'secp256k1')),
    domain TEXT NOT NULL,
    action TEXT NOT NULL,
    network TEXT NOT NULL,
    payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
    outcome TEXT NOT NULL CHECK (outcome IN ('signed', 'denied', 'failed')),
    reason TEXT,
    occurred_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX signer_audit_log_role_time_idx
    ON signer_audit_log (role, occurred_at DESC);
