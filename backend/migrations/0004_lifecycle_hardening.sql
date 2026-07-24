SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE lifecycle_runs (
    id UUID PRIMARY KEY,
    run_key TEXT NOT NULL UNIQUE CHECK (length(run_key) BETWEEN 1 AND 256),
    request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    kind TEXT NOT NULL CHECK (kind IN ('reconstitution', 'resolution')),
    basket_id TEXT NOT NULL CHECK (length(basket_id) BETWEEN 32 AND 128),
    state TEXT NOT NULL CHECK (state IN (
        'created', 'onchain_started', 'external_execution_completed',
        'onchain_completed'
    )),
    checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(checkpoint) = 'object'),
    version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    CHECK ((state = 'onchain_completed') = (completed_at IS NOT NULL))
);

CREATE INDEX lifecycle_runs_active_idx
    ON lifecycle_runs (kind, updated_at, basket_id)
    WHERE state <> 'onchain_completed';

CREATE TABLE distributed_leases (
    lease_key TEXT PRIMARY KEY CHECK (length(lease_key) BETWEEN 1 AND 256),
    owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 256),
    token UUID NOT NULL,
    acquired_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    CHECK (expires_at > acquired_at)
);

CREATE INDEX distributed_leases_expiry_idx ON distributed_leases (expires_at);

ALTER TABLE execution_wallets
    ADD COLUMN max_concurrent_operations INTEGER NOT NULL DEFAULT 1
        CHECK (max_concurrent_operations = 1);

CREATE TABLE wallet_operation_leases (
    wallet_id TEXT NOT NULL REFERENCES execution_wallets(wallet_id),
    operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 256),
    owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 256),
    token UUID NOT NULL,
    acquired_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (wallet_id, operation_id),
    UNIQUE (token),
    CHECK (expires_at > acquired_at)
);

CREATE INDEX wallet_operation_leases_active_idx
    ON wallet_operation_leases (wallet_id, expires_at);

CREATE TABLE reconciliation_runs (
    id UUID PRIMARY KEY,
    scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 128),
    observed_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('healthy', 'degraded', 'critical')),
    snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE basket_asset_reconciliation_projections (
    basket_id TEXT PRIMARY KEY CHECK (length(basket_id) BETWEEN 1 AND 128),
    ledger_attributed_pusd_units NUMERIC(78, 0) NOT NULL CHECK (ledger_attributed_pusd_units >= 0),
    wallet_attributed_pusd_units NUMERIC(78, 0) NOT NULL CHECK (wallet_attributed_pusd_units >= 0),
    ledger_source_version TEXT NOT NULL CHECK (length(ledger_source_version) BETWEEN 1 AND 256),
    wallet_source_version TEXT NOT NULL CHECK (length(wallet_source_version) BETWEEN 1 AND 256),
    observed_at_ms NUMERIC(20, 0) NOT NULL CHECK (observed_at_ms >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX reconciliation_runs_scope_time_idx
    ON reconciliation_runs (scope, observed_at DESC);

CREATE TRIGGER reconciliation_runs_immutable
    BEFORE UPDATE OR DELETE ON reconciliation_runs
    FOR EACH ROW EXECUTE FUNCTION alphabasket_reject_mutation();

CREATE TABLE reconciliation_findings (
    id UUID PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES reconciliation_runs(id),
    dedupe_key TEXT NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 256),
    basket_id TEXT CHECK (basket_id IS NULL OR length(basket_id) BETWEEN 1 AND 128),
    code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 128),
    severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
    expected_value TEXT,
    actual_value TEXT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
    observed_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (run_id, dedupe_key)
);

CREATE INDEX reconciliation_findings_basket_time_idx
    ON reconciliation_findings (basket_id, observed_at DESC)
    WHERE basket_id IS NOT NULL;

CREATE TRIGGER reconciliation_findings_immutable
    BEFORE UPDATE OR DELETE ON reconciliation_findings
    FOR EACH ROW EXECUTE FUNCTION alphabasket_reject_mutation();

CREATE TABLE canary_budget_usage (
    environment TEXT NOT NULL CHECK (length(environment) BETWEEN 1 AND 64),
    usage_day DATE NOT NULL,
    operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 256),
    amount_units NUMERIC(78, 0) NOT NULL CHECK (amount_units > 0),
    recorded_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (environment, operation_id)
);

CREATE INDEX canary_budget_usage_day_idx
    ON canary_budget_usage (environment, usage_day);

CREATE TRIGGER canary_budget_usage_immutable
    BEFORE UPDATE OR DELETE ON canary_budget_usage
    FOR EACH ROW EXECUTE FUNCTION alphabasket_reject_mutation();
