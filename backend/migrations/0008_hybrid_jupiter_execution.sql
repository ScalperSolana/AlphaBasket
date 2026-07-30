SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE execution_gateway_requests
    DROP CONSTRAINT execution_gateway_requests_request_kind_check,
    ADD CONSTRAINT execution_gateway_requests_request_kind_check
        CHECK (request_kind IN (
            'fak_order',
            'pusd_transfer',
            'solana_split',
            'jupiter_swap'
        ));

ALTER TABLE basket_portfolio_states
    ADD COLUMN idle_usdc_units NUMERIC(20, 0) NOT NULL DEFAULT 0
        CHECK (idle_usdc_units >= 0);

ALTER TABLE basket_holding_projections
    DROP CONSTRAINT basket_holding_projections_token_id_check,
    ADD COLUMN asset_kind TEXT NOT NULL DEFAULT 'prediction_market'
        CHECK (asset_kind IN ('prediction_market', 'spot')),
    ADD COLUMN token_decimals SMALLINT
        CHECK (token_decimals IS NULL OR token_decimals BETWEEN 0 AND 18),
    ADD CONSTRAINT basket_holding_projections_token_id_check CHECK (
        (asset_kind = 'prediction_market'
         AND token_id ~ '^(0|[1-9][0-9]*)$'
         AND token_decimals IS NULL)
        OR
        (asset_kind = 'spot'
         AND token_id ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
         AND token_decimals IS NOT NULL)
    );

ALTER TABLE execution_wallets
    ADD COLUMN solana_address TEXT
        CHECK (
            solana_address IS NULL
            OR solana_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
        );

CREATE TABLE wallet_asset_reconciliation_projections (
    wallet_id TEXT NOT NULL REFERENCES execution_wallets(wallet_id),
    asset_kind TEXT NOT NULL CHECK (
        asset_kind IN ('pusd', 'usdc', 'prediction_market', 'spot')
    ),
    asset_id TEXT NOT NULL CHECK (length(asset_id) BETWEEN 1 AND 128),
    attributed_units NUMERIC(78, 0) NOT NULL CHECK (attributed_units >= 0),
    actual_units NUMERIC(78, 0) NOT NULL CHECK (actual_units >= 0),
    source_version TEXT NOT NULL CHECK (length(source_version) BETWEEN 1 AND 256),
    observed_at_ms NUMERIC(20, 0) NOT NULL CHECK (observed_at_ms >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (wallet_id, asset_kind, asset_id)
);

CREATE INDEX wallet_asset_reconciliation_observed_idx
    ON wallet_asset_reconciliation_projections (observed_at_ms);

CREATE TABLE execution_gateway_capital_source_claims (
    source_kind TEXT NOT NULL CHECK (
        source_kind IN ('bridge_receipt', 'jupiter_swap')
    ),
    source_reference TEXT NOT NULL
        CHECK (length(source_reference) BETWEEN 1 AND 256),
    request_key TEXT NOT NULL
        CHECK (length(request_key) BETWEEN 1 AND 256),
    request_hash CHAR(64) NOT NULL
        CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    amount_units NUMERIC(78, 0) NOT NULL CHECK (amount_units > 0),
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (source_kind, source_reference)
);
