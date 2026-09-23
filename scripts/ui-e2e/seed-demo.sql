-- Demo projections so the UI has something to render without a chain behind it.
--
-- These stand in for what the indexer and NAV worker write. Everything is tagged
-- with source_slot 999000000 so it can be removed in one go:
--
--   DELETE FROM solana_account_projections WHERE source_slot = 999000000;
--
-- nav_snapshots is append-only, so its demo rows stay; the test inserts a fresh
-- sequence before every quote because the quote path rejects a snapshot older
-- than API_MAXIMUM_NAV_AGE_MS.
--
-- Idempotent: safe to run on every test.

INSERT INTO solana_account_projections
  (address, owner, lamports, account_kind, account_data, content_hash, source_slot, is_active)
VALUES
(
  'Ba5kEtPerp1111111111111111111111111111111111',
  '5mzLoAijdzAQV5D7QXe6TTGZ9TkWQanygfnb5VPPxFSm',
  2030000, 'Basket',
  '{
    "basketId": "demo0perp0000000000000000000000000000000000000000000000000000001",
    "status": {"active": {}},
    "compositionVersion": 1,
    "compositionHash": "aa",
    "performanceFeeBps": 1000,
    "protocolFeeDestination": "FWRvqaezac9noSy2WsPSNoZZs2Vc2peA4TRLkjziS7Vq",
    "isPerpetual": true,
    "totalSharesOutstanding": "2500000000",
    "hasInitializedSharePrice": true,
    "items": [
      {"marketId":"SOL","weightBps":2500,"kind":{"perp":{"direction":{"long":{}},"leverageBps":30000,"entryMarkPrice":"106340000","marginPosted":"624510000","phoenixSubaccount":1}}},
      {"marketId":"BTC","weightBps":2500,"kind":{"perp":{"direction":{"long":{}},"leverageBps":20000,"entryMarkPrice":"98420000000","marginPosted":"625000000","phoenixSubaccount":2}}},
      {"marketId":"ETH","weightBps":2500,"kind":{"perp":{"direction":{"short":{}},"leverageBps":20000,"entryMarkPrice":"3180500000","marginPosted":"624880000","phoenixSubaccount":3}}},
      {"marketId":"HYPE","weightBps":2500,"kind":{"perp":{"direction":{"long":{}},"leverageBps":30000,"entryMarkPrice":"41230000","marginPosted":"0","phoenixSubaccount":4}}}
    ]
  }'::jsonb,
  repeat('a1', 32), 999000000, true
),
(
  'Ba5kEtSpot1111111111111111111111111111111111',
  '5mzLoAijdzAQV5D7QXe6TTGZ9TkWQanygfnb5VPPxFSm',
  2030000, 'Basket',
  '{
    "basketId": "demo0spot0000000000000000000000000000000000000000000000000000002",
    "status": {"active": {}},
    "compositionVersion": 3,
    "compositionHash": "bb",
    "performanceFeeBps": 500,
    "protocolFeeDestination": "FWRvqaezac9noSy2WsPSNoZZs2Vc2peA4TRLkjziS7Vq",
    "isPerpetual": true,
    "totalSharesOutstanding": "8100000000",
    "hasInitializedSharePrice": true,
    "items": [
      {"marketId":"SOL","weightBps":3000,"kind":{"spot":{"tokenMint":"So11111111111111111111111111111111111111112"}}},
      {"marketId":"JUP","weightBps":2500,"kind":{"spot":{"tokenMint":"JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"}}},
      {"marketId":"BONK","weightBps":2500,"kind":{"spot":{"tokenMint":"DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"}}},
      {"marketId":"USDC","weightBps":2000,"kind":{"spot":{"tokenMint":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"}}}
    ]
  }'::jsonb,
  repeat('b2', 32), 999000000, true
),
(
  'Ba5kEtFresh111111111111111111111111111111111',
  '5mzLoAijdzAQV5D7QXe6TTGZ9TkWQanygfnb5VPPxFSm',
  2030000, 'Basket',
  '{
    "basketId": "demo0new00000000000000000000000000000000000000000000000000000003",
    "status": {"active": {}},
    "compositionVersion": 1,
    "compositionHash": "cc",
    "performanceFeeBps": 1500,
    "protocolFeeDestination": "FWRvqaezac9noSy2WsPSNoZZs2Vc2peA4TRLkjziS7Vq",
    "isPerpetual": true,
    "totalSharesOutstanding": "0",
    "hasInitializedSharePrice": false,
    "items": [
      {"marketId":"SUI","weightBps":2500,"kind":{"perp":{"direction":{"long":{}},"leverageBps":10000,"entryMarkPrice":"0","marginPosted":"0","phoenixSubaccount":1}}},
      {"marketId":"DOGE","weightBps":2500,"kind":{"perp":{"direction":{"short":{}},"leverageBps":10000,"entryMarkPrice":"0","marginPosted":"0","phoenixSubaccount":2}}},
      {"marketId":"XRP","weightBps":2500,"kind":{"perp":{"direction":{"long":{}},"leverageBps":20000,"entryMarkPrice":"0","marginPosted":"0","phoenixSubaccount":3}}},
      {"marketId":"BNB","weightBps":2500,"kind":{"perp":{"direction":{"long":{}},"leverageBps":20000,"entryMarkPrice":"0","marginPosted":"0","phoenixSubaccount":4}}}
    ]
  }'::jsonb,
  repeat('c3', 32), 999000000, true
),
-- A prediction-market basket served through the Jupiter Predict venue.
(
  'Ba5kEtPred1111111111111111111111111111111111',
  '5mzLoAijdzAQV5D7QXe6TTGZ9TkWQanygfnb5VPPxFSm',
  2030000, 'Basket',
  '{
    "basketId": "demo0pred0000000000000000000000000000000000000000000000000000004",
    "status": {"active": {}},
    "compositionVersion": 1,
    "compositionHash": "dd",
    "performanceFeeBps": 1000,
    "protocolFeeDestination": "FWRvqaezac9noSy2WsPSNoZZs2Vc2peA4TRLkjziS7Vq",
    "isPerpetual": true,
    "totalSharesOutstanding": "4000000000",
    "hasInitializedSharePrice": true,
    "items": [
      {"marketId":"fed-cut-march","weightBps":2500,"kind":{"predictionMarket":{"outcome":0,"ctfTokenId":"1111111111111111111111111111111111111111111111111111111111111111"}}},
      {"marketId":"btc-150k-2026","weightBps":2500,"kind":{"predictionMarket":{"outcome":0,"ctfTokenId":"2222222222222222222222222222222222222222222222222222222222222222"}}},
      {"marketId":"eth-flips-btc","weightBps":2500,"kind":{"predictionMarket":{"outcome":1,"ctfTokenId":"3333333333333333333333333333333333333333333333333333333333333333"}}},
      {"marketId":"sol-ath-q4","weightBps":2500,"kind":{"predictionMarket":{"outcome":0,"ctfTokenId":"4444444444444444444444444444444444444444444444444444444444444444"}}}
    ]
  }'::jsonb,
  repeat('d4', 32), 999000000, true
),
(
  'EYugyCZZfHyvpEmkCEVwKNBuHeNHxLSinnoeL5gxXc1F',
  '5mzLoAijdzAQV5D7QXe6TTGZ9TkWQanygfnb5VPPxFSm',
  154000, 'Position',
  '{"owner":"5qjit4c1K9XS8pTCkki2Cc8mzoWQb2kgNSpZtu2XGJAg","basket":"Ba5kEtPred1111111111111111111111111111111111","sharesOwned":"1000000000","costBasisValue":"1000000000","gross_deposited_value":"1000000000","weightedDepositTimestamp":"1788000000","lastIntentNonce":"1"}'::jsonb,
  repeat('3c', 32), 999000000, true
),
-- The quote path needs the protocol Config.
(
  'C0nf1gDemo1111111111111111111111111111111111',
  '5mzLoAijdzAQV5D7QXe6TTGZ9TkWQanygfnb5VPPxFSm',
  1500000, 'Config',
  '{"maxSlippageBps":1000,"settlementMint":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","paused":false,"protocolTreasury":"FWRvqaezac9noSy2WsPSNoZZs2Vc2peA4TRLkjziS7Vq"}'::jsonb,
  repeat('09', 32), 999000000, true
),
-- Positions for the test wallet 5qjit4c1K9XS8pTCkki2Cc8mzoWQb2kgNSpZtu2XGJAg
-- (derived in run.mjs from a fixed seed), at the real Position PDAs so the
-- quote path finds them.
(
  '7GdRXJwLuLTPhq17LE3yaz88FgK6cHxDNAV5wHtnobNm',
  '5mzLoAijdzAQV5D7QXe6TTGZ9TkWQanygfnb5VPPxFSm',
  154000, 'Position',
  '{"owner":"5qjit4c1K9XS8pTCkki2Cc8mzoWQb2kgNSpZtu2XGJAg","basket":"Ba5kEtSpot1111111111111111111111111111111111","sharesOwned":"3000000000","costBasisValue":"3000000000","gross_deposited_value":"3000000000","weightedDepositTimestamp":"1788000000","lastIntentNonce":"1"}'::jsonb,
  repeat('1a', 32), 999000000, true
),
(
  'DVkXVwfLVhnjEaS5iNEfP2dwkprcGFdV53VC4gfEYzW9',
  '5mzLoAijdzAQV5D7QXe6TTGZ9TkWQanygfnb5VPPxFSm',
  154000, 'Position',
  '{"owner":"5qjit4c1K9XS8pTCkki2Cc8mzoWQb2kgNSpZtu2XGJAg","basket":"Ba5kEtPerp1111111111111111111111111111111111","sharesOwned":"1200000000","costBasisValue":"1200000000","gross_deposited_value":"1200000000","weightedDepositTimestamp":"1788000000","lastIntentNonce":"1"}'::jsonb,
  repeat('2b', 32), 999000000, true
)
ON CONFLICT DO NOTHING;

-- The read plane keys NAV by the hex basketId; the quote path keys it by the
-- basket address. Seed the read-plane rows here; run.mjs appends fresh
-- address-keyed rows before quoting.
INSERT INTO nav_snapshots (basket_id, sequence, snapshot_hash, observed_at_ms, snapshot)
VALUES
(
  'demo0perp0000000000000000000000000000000000000000000000000000001', 1,
  repeat('f6', 32), 1788500000000,
  '{"grossNavPusdUnits":"2712500000","sharePriceUnits":"1085000"}'::jsonb
),
(
  'demo0spot0000000000000000000000000000000000000000000000000000002', 1,
  repeat('07', 32), 1788500000000,
  '{"grossNavPusdUnits":"7857000000","sharePriceUnits":"970000"}'::jsonb
),
(
  'demo0pred0000000000000000000000000000000000000000000000000000004', 1,
  repeat('4d', 32), 1788500000000,
  '{"grossNavPusdUnits":"4200000000","sharePriceUnits":"1050000"}'::jsonb
)
ON CONFLICT DO NOTHING;
