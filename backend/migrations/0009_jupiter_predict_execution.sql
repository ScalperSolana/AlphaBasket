SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Jupiter Predict execution: prediction markets traded Solana-natively through
-- Jupiter's Prediction API instead of Polygon/CLOB. The gateway journals these
-- orders like Jupiter swaps, and a withdrawal split may claim a finalized
-- predict sale as a capital source.

ALTER TABLE execution_gateway_requests
    DROP CONSTRAINT execution_gateway_requests_request_kind_check,
    ADD CONSTRAINT execution_gateway_requests_request_kind_check
        CHECK (request_kind IN (
            'fak_order',
            'pusd_transfer',
            'solana_split',
            'jupiter_swap',
            'predict_order'
        ));

ALTER TABLE execution_gateway_capital_source_claims
    DROP CONSTRAINT execution_gateway_capital_source_claims_source_kind_check,
    ADD CONSTRAINT execution_gateway_capital_source_claims_source_kind_check
        CHECK (source_kind IN ('bridge_receipt', 'jupiter_swap', 'predict_order'));

-- Maps an on-chain composition item (its CTF token id) to the Jupiter Predict
-- market that trades it. On-chain identity stays Polymarket-native
-- (conditionId/ctfTokenId, already deployed); Jupiter serves those same markets
-- under its own market ids, so execution and pricing need this link. Rows are
-- written by the resolver when it can prove a mapping (direct market probe or
-- catalog match) and may be seeded by an operator for markets the catalog scan
-- cannot correlate.
CREATE TABLE predict_market_links (
    token_id TEXT PRIMARY KEY CHECK (token_id ~ '^(0|[1-9][0-9]*)$'),
    condition_id TEXT CHECK (
        condition_id IS NULL OR condition_id ~ '^0x[0-9a-f]{64}$'
    ),
    jupiter_market_id TEXT NOT NULL CHECK (
        length(jupiter_market_id) BETWEEN 1 AND 128
    ),
    is_yes BOOLEAN NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('operator', 'market_probe', 'catalog')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX predict_market_links_market_idx
    ON predict_market_links (jupiter_market_id);
