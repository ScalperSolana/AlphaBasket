use anchor_lang::prelude::*;

use crate::constants::{
    MAX_ALLOWLISTED_TOKENS, MAX_BASKET_ITEMS, MAX_ELIGIBLE_MARKETS, MAX_MARKET_ID_LEN,
    MAX_PERP_ELIGIBLE_MARKETS, POSITION_RESERVED_BYTES, REGISTRY_RESERVED_BYTES,
};

#[account]
#[derive(InitSpace)]
/// Singleton protocol configuration and authority registry.
pub struct Config {
    pub admin: Pubkey,
    pub pending_admin: Option<Pubkey>,
    pub composer_signer: Pubkey,
    pub backend_signer: Pubkey,
    pub protocol_treasury: Pubkey,
    pub settlement_mint: Pubkey,
    pub max_slippage_bps: u16,
    pub accounting_decimals: u8,
    pub paused: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
/// Lifecycle states for a basket.
pub enum BasketStatus {
    Active,
    Reconstituting,
    Resolving,
    Redeemable,
    Closed,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
/// Settlement receipt operation type.
pub enum SettlementAction {
    Deposit,
    UserWithdrawal,
    ProtocolFeeWithdrawal,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
/// Whether a redemption occurs while active or against a final snapshot.
pub enum WithdrawalKind {
    Active,
    Final,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
/// Direction of a perpetual position.
///
/// A dedicated enum rather than a bool or a signed size: a bool has no natural
/// reading ("true" is not obviously long), and a signed magnitude conflates
/// direction with size, so a zero-size position would have no direction at all.
pub enum PerpDirection {
    Long,
    Short,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug, InitSpace)]
/// Tagged representation of a supported basket position.
///
/// Adding `Perp` does not change `PositionKind::INIT_SPACE`: the variant is 20
/// bytes against `PredictionMarket`'s 33, so the maximum is unchanged and no
/// existing `Basket` or `CompositionDraft` needs a realloc.
pub enum PositionKind {
    PredictionMarket {
        outcome: u8,
        ctf_token_id: [u8; 32],
    },
    Spot {
        token_mint: Pubkey,
    },
    /// A Phoenix perpetual. `entry_mark_price` and `margin_posted` are the only
    /// fields a settlement updates, and both are read back from real
    /// post-execution Phoenix state rather than from a quote.
    Perp {
        direction: PerpDirection,
        leverage_bps: u16,
        entry_mark_price: u64,
        margin_posted: u64,
        /// Phoenix isolated subaccount index. Always greater than zero;
        /// subaccount 0 is Phoenix's cross-margin account and is never used to
        /// hold a position.
        phoenix_subaccount: u8,
    },
}

impl PositionKind {
    pub fn is_perp(&self) -> bool {
        matches!(self, PositionKind::Perp { .. })
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
/// One weighted asset in a Composer-signed basket composition.
pub struct BasketAsset {
    #[max_len(MAX_MARKET_ID_LEN)]
    pub market_id: String,
    pub kind: PositionKind,
    pub weight_bps: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
/// One prediction market admitted by the Composer's unchanged six-point screen.
/// Weights are deliberately absent: creators choose them after eligibility is signed.
pub struct EligibleMarket {
    #[max_len(MAX_MARKET_ID_LEN)]
    pub market_id: String,
    pub outcome: u8,
    pub ctf_token_id: [u8; 32],
}

#[account]
#[derive(InitSpace)]
/// Short-lived Composer-published market list used by basket creation/reconstitution.
pub struct EligibilityList {
    pub list_hash: [u8; 32],
    pub nonce: u64,
    pub composer: Pubkey,
    pub published_at: i64,
    pub expires_at: i64,
    #[max_len(MAX_ELIGIBLE_MARKETS)]
    pub markets: Vec<EligibleMarket>,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug, InitSpace)]
/// One Phoenix perpetual market the Composer has admitted.
///
/// Deliberately not `EligibleMarket`: that type's `outcome` and `ctf_token_id`
/// are Polymarket/CTF fields with no meaning for a perpetual, and spot has its own
/// `TokenAllowlist`. Weights are absent for the same reason as `EligibleMarket` —
/// creators choose them after eligibility is signed.
pub struct PerpEligibleMarket {
    /// Phoenix market symbol, e.g. "SOL". Read live from Phoenix exchange metadata.
    #[max_len(MAX_MARKET_ID_LEN)]
    pub market_id: String,
}

#[account]
#[derive(InitSpace)]
/// Short-lived Composer-published perpetual market list, the perp counterpart to
/// `EligibilityList`. Seeded at `b"perp_eligibility"` so it cannot collide with
/// the prediction-market list at `b"eligibility"`.
pub struct PerpEligibilityList {
    pub list_hash: [u8; 32],
    pub nonce: u64,
    pub composer: Pubkey,
    pub published_at: i64,
    pub expires_at: i64,
    #[max_len(MAX_PERP_ELIGIBLE_MARKETS)]
    pub markets: Vec<PerpEligibleMarket>,
    pub bump: u8,
}

impl PerpEligibilityList {
    pub fn contains(&self, market_id: &str) -> bool {
        self.markets
            .iter()
            .any(|market| market.market_id == market_id)
    }
}

#[account]
#[derive(InitSpace)]
/// Composer-published creator selection. Splitting variable-size items into a
/// prior transaction keeps create/reconstitution transactions under Solana's
/// packet limit without weakening Ed25519 authorization.
pub struct CompositionDraft {
    pub composition_hash: [u8; 32],
    pub eligibility_hash: [u8; 32],
    pub eligibility_nonce: u64,
    pub composition_nonce: u64,
    pub composer: Pubkey,
    pub published_at: i64,
    #[max_len(MAX_BASKET_ITEMS)]
    pub items: Vec<BasketAsset>,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum TokenAssetClass {
    Crypto,
    TokenizedEquity,
    Other,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum TradingAvailability {
    TwentyFourSeven,
    TwentyFourFive,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum SpotPriceSource {
    Pyth { feed_id: [u8; 32] },
    Switchboard { feed: Pubkey },
    SignedTwap,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub struct AllowedToken {
    pub token_mint: Pubkey,
    pub jupiter_verified: bool,
    pub asset_class: TokenAssetClass,
    pub availability: TradingAvailability,
    pub price_source: SpotPriceSource,
    pub backing_attestation_hash: [u8; 32],
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[account]
#[derive(InitSpace)]
/// Admin-maintained spot-token registry. Disabling an entry blocks new
/// compositions but never changes or liquidates an existing basket.
pub struct TokenAllowlist {
    pub registered_by: Pubkey,
    #[max_len(MAX_ALLOWLISTED_TOKENS)]
    pub tokens: Vec<AllowedToken>,
    pub updated_at: i64,
    pub reserved: [u8; REGISTRY_RESERVED_BYTES],
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
/// Latest Composer-signed TWAP fallback for a token without a robust oracle.
pub struct PriceAttestation {
    pub token_mint: Pubkey,
    /// Six-decimal settlement-value price, matching the accounting engine.
    pub price_value: u64,
    pub confidence_bps: u16,
    pub observed_at: i64,
    pub valid_until: i64,
    pub nonce: u64,
    pub signer: Pubkey,
    pub attestation_hash: [u8; 32],
    pub reserved: [u8; REGISTRY_RESERVED_BYTES],
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
/// Basket composition, lifecycle, and aggregate share accounting.
pub struct Basket {
    pub basket_id: [u8; 32],
    pub composer: Pubkey,
    pub creator: Pubkey,
    pub creator_fee_destination: Pubkey,
    pub protocol_fee_destination: Pubkey,
    pub status: BasketStatus,
    pub composition_hash: [u8; 32],
    pub composition_version: u32,
    pub last_composition_nonce: u64,
    pub performance_fee_bps: u16,
    pub is_perpetual: bool,
    pub reconstitution_cadence_secs: i64,
    pub total_shares_outstanding: u64,
    pub protocol_fee_shares: u64,
    pub last_management_fee_at: i64,
    pub management_fee_accrual_remainder: u128,
    pub has_initialized_share_price: bool,
    pub last_settlement_nonce: u64,
    pub gross_deposited_value: u64,
    pub final_report_hash: [u8; 32],
    pub final_nav_value: u64,
    pub final_share_snapshot: u64,
    pub final_shares_consumed: u64,
    pub created_at: i64,
    pub last_reconstitution_at: i64,
    pub updated_at: i64,
    #[max_len(MAX_BASKET_ITEMS)]
    pub items: Vec<BasketAsset>,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
/// A user's shares, performance-fee basis, and weighted holding timestamp.
/// `cost_basis_value` is the aggregate HWM/equalization basis of the remaining
/// shares. Partial redemptions remove only their proportional basis; they do
/// not raise the per-share basis of unredeemed shares unless those shares also
/// crystallize a performance fee.
pub struct Position {
    pub owner: Pubkey,
    pub basket: Pubkey,
    pub shares_owned: u64,
    pub cost_basis_value: u64,
    pub gross_deposited_value: u64,
    pub last_intent_nonce: u64,
    pub weighted_deposit_timestamp: i64,
    pub reserved: [u8; POSITION_RESERVED_BYTES],
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
/// Immutable replay-protected record of a completed accounting settlement.
pub struct SettlementReceipt {
    pub intent_hash: [u8; 32],
    pub intent_nonce: u64,
    pub basket: Pubkey,
    pub user: Pubkey,
    pub destination: Pubkey,
    pub action: SettlementAction,
    /// Version of the canonical external-execution batch encoding.
    pub execution_version: u8,
    /// Hash of all fill markets, outcomes, amounts, prices, and external references.
    pub execution_batch_hash: [u8; 32],
    /// Timestamp at which the external execution batch completed.
    pub executed_at: i64,
    pub nav_report_hash: [u8; 32],
    pub share_delta: u64,
    pub share_price: u64,
    /// Actual value credited for a deposit or realized for a withdrawal.
    pub gross_value: u64,
    pub protocol_fee: u64,
    pub creator_fee: u64,
    pub withdrawn_cost_basis: u64,
    pub realized_profit: u64,
    pub early_exit_value: u64,
    pub mature_exit_value: u64,
    pub user_value_out: u64,
    pub settlement_nonce: u64,
    pub settled_at: i64,
    pub bump: u8,
}

// ---------------------------------------------------------------------------
// Phoenix perpetuals
//
// Every account below is created with `init`, never `init_if_needed`, and keyed
// on the hash of the specific execution, event, or wallet. That is the replay
// protection: a second attempt to record the same thing fails in the runtime
// before any handler code runs.
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
/// Whether a recorded Phoenix trade opened or closed a position.
pub enum PerpTradeSide {
    Open,
    Close,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
/// Outcome of a Phoenix execution, derived from post-execution position state.
///
/// There is deliberately no `Rejected` variant. A rejected order posted no margin
/// and opened no position, so there is nothing to settle: the backend surfaces it
/// as a failure and never reaches `complete_phoenix_trade`. Accepting `Rejected`
/// here would create a receipt asserting a trade happened when it did not.
pub enum PerpFillStatus {
    Filled,
    PartiallyFilled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
/// The kind of unprompted action Phoenix took on a position.
///
/// Phoenix's own wire names are `adl` and `risk_engine_cancel_order`.
pub enum PerpEventKind {
    /// Auto-deleveraging: forcible reduction of a *profitable* counterparty's
    /// position. Distinct from liquidation, which closes the risky account.
    Adl,
    /// Phoenix cancelled a risk-increasing resting order before liquidating.
    AutonomousCancel,
}

#[account]
#[derive(InitSpace)]
/// Proof that an execution wallet was onboarded to Phoenix exactly once.
/// Seeds: `[b"perp_trader", execution_wallet]`.
pub struct TraderAccountRegistry {
    pub execution_wallet: Pubkey,
    pub phoenix_trader_pda: Pubkey,
    pub phoenix_pda_index: u8,
    pub onboarded_at: i64,
    pub onboarding_signature: [u8; 64],
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
/// Immutable record of one already-executed Phoenix trade.
/// Seeds: `[b"perp_receipt", execution_hash]`.
///
/// Named and seeded apart from `SettlementReceipt`, which records accounting
/// settlements at `[b"receipt", execution_batch_hash]` and has an unrelated shape.
pub struct PerpSettlementReceipt {
    pub execution_hash: [u8; 32],
    pub request_hash: [u8; 32],
    pub idempotency_key: [u8; 32],
    pub basket: Pubkey,
    pub execution_wallet: Pubkey,
    #[max_len(MAX_MARKET_ID_LEN)]
    pub market_id: String,
    pub side: PerpTradeSide,
    pub direction: PerpDirection,
    pub fill_status: PerpFillStatus,
    pub phoenix_subaccount: u8,
    pub leverage_bps: u16,
    pub requested_collateral_units: u64,
    /// Read from post-execution Phoenix state, never from a quote.
    pub actual_margin_posted_units: u64,
    /// Read from post-execution Phoenix state, never from a quote.
    pub entry_mark_price: u64,
    pub settlement_nonce: u64,
    pub executed_at: i64,
    pub executed_slot: u64,
    pub recorded_at: i64,
    pub recorded_slot: u64,
    pub transaction_signature: [u8; 64],
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
/// Record of an autonomous Phoenix action against a basket position.
/// Seeds: `[b"perp_event", event_hash]`.
pub struct PerpEventAttestation {
    pub event_hash: [u8; 32],
    pub basket: Pubkey,
    pub event_kind: PerpEventKind,
    #[max_len(MAX_MARKET_ID_LEN)]
    pub market_id: String,
    pub phoenix_subaccount: u8,
    /// Hash of the full Phoenix event payload, which is too large and too
    /// venue-specific to store on chain.
    pub detail_hash: [u8; 32],
    pub observed_at: i64,
    pub observed_slot: u64,
    pub recorded_at: i64,
    pub recorded_slot: u64,
    pub attestation_nonce: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PublishPerpEligibilityListArgs {
    pub list_hash: [u8; 32],
    pub nonce: u64,
    pub expires_at: i64,
    pub markets: Vec<PerpEligibleMarket>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
/// One-time Phoenix onboarding record for an execution wallet.
pub struct OnboardTraderAccountArgs {
    pub execution_wallet: Pubkey,
    pub phoenix_trader_pda: Pubkey,
    pub phoenix_pda_index: u8,
    pub onboarded_at: i64,
    pub onboarding_signature: [u8; 64],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
/// An already-executed, vault-delta-verified Phoenix trade.
///
/// Every figure was computed off chain and read back from real post-execution
/// Phoenix state. This program validates and records; it computes no NAV, no fees
/// and no PnL.
pub struct CompletePhoenixTradeArgs {
    pub execution_hash: [u8; 32],
    pub request_hash: [u8; 32],
    pub idempotency_key: [u8; 32],
    pub settlement_nonce: u64,
    pub basket_id: [u8; 32],
    /// Bound the same way `complete_deposit` binds: the basket's live
    /// `composition_version`. The hash is checked as well, because unlike a
    /// deposit this instruction writes into `items`.
    pub expected_composition_version: u32,
    pub expected_composition_hash: [u8; 32],
    #[allow(clippy::doc_markdown)]
    /// Phoenix market symbol, read live from exchange metadata by the backend.
    pub market_id: String,
    pub side: PerpTradeSide,
    pub direction: PerpDirection,
    pub phoenix_subaccount: u8,
    pub leverage_bps: u16,
    pub execution_wallet: Pubkey,
    pub requested_collateral_units: u64,
    /// Collateral actually resident in the isolated subaccount after execution.
    pub actual_margin_posted_units: u64,
    /// Entry price of the resulting position. Zero means "no position left to
    /// price" and is accepted only on a close.
    pub entry_mark_price: u64,
    pub fill_status: PerpFillStatus,
    pub executed_at: i64,
    pub executed_slot: u64,
    pub transaction_signature: [u8; 64],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
/// An autonomous Phoenix action. Callable unprompted, with no matching trade.
pub struct AttestPerpEventArgs {
    pub event_hash: [u8; 32],
    pub basket_id: [u8; 32],
    pub event_kind: PerpEventKind,
    pub market_id: String,
    pub phoenix_subaccount: u8,
    pub detail_hash: [u8; 32],
    pub observed_at: i64,
    pub observed_slot: u64,
    pub attestation_nonce: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
/// Initialization parameters for operational authorities and accounting policy.
pub struct InitializeArgs {
    pub composer_signer: Pubkey,
    pub backend_signer: Pubkey,
    pub protocol_treasury: Pubkey,
    pub settlement_mint: Pubkey,
    pub max_slippage_bps: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
/// Composer-authorized basket creation parameters.
pub struct CreateBasketArgs {
    pub basket_id: [u8; 32],
    pub composition_hash: [u8; 32],
    pub eligibility_hash: [u8; 32],
    pub eligibility_nonce: u64,
    pub creator: Pubkey,
    pub creator_fee_destination: Pubkey,
    pub performance_fee_bps: Option<u16>,
    pub is_perpetual: bool,
    pub reconstitution_cadence_secs: i64,
    pub composition_nonce: u64,
    pub composition_expiry: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
/// User intent and backend result used to complete a deposit. The gross amount
/// and minimum shares are user-authorized; `net_deposit_value` is the actual
/// value credited by external execution and backs the minted shares.
pub struct CompleteDepositArgs {
    pub user: Pubkey,
    pub intent_nonce: u64,
    pub intent_expiry: i64,
    pub expected_composition_version: u32,
    pub gross_amount: u64,
    pub min_shares_out: u64,
    pub quote_hash: [u8; 32],
    pub execution_version: u8,
    pub execution_batch_hash: [u8; 32],
    pub executed_at: i64,
    pub nav_report_hash: [u8; 32],
    pub settlement_nonce: u64,
    pub basket_nav_value: u64,
    pub share_price: u64,
    pub net_deposit_value: u64,
    pub shares_credited: u64,
    pub protocol_fee: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
/// User intent and backend result used to complete a withdrawal. The share
/// amount and minimum value are user-authorized; `gross_realized_value` is the
/// actual external execution value used for fee and proceeds accounting.
pub struct CompleteWithdrawalArgs {
    pub user: Pubkey,
    pub intent_nonce: u64,
    pub intent_expiry: i64,
    pub expected_composition_version: u32,
    pub share_amount: u64,
    pub min_value_out: u64,
    pub destination: Pubkey,
    pub quote_hash: [u8; 32],
    pub execution_version: u8,
    pub execution_batch_hash: [u8; 32],
    pub executed_at: i64,
    pub nav_report_hash: [u8; 32],
    pub settlement_nonce: u64,
    pub basket_nav_value: u64,
    pub share_price: u64,
    pub gross_realized_value: u64,
    pub protocol_fee: u64,
    pub creator_fee: u64,
    pub user_value_out: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
/// Backend result used to redeem protocol-owned dilution shares. The gross
/// realized value is the actual external execution value.
pub struct CompleteProtocolFeeWithdrawalArgs {
    pub execution_version: u8,
    pub execution_batch_hash: [u8; 32],
    pub executed_at: i64,
    pub nav_report_hash: [u8; 32],
    pub settlement_nonce: u64,
    pub share_amount: u64,
    pub basket_nav_value: u64,
    pub share_price: u64,
    pub gross_realized_value: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
/// Final basket NAV and share-supply snapshot.
pub struct FinalSettlementArgs {
    pub final_report_hash: [u8; 32],
    pub final_nav_value: u64,
    pub final_share_snapshot: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
/// Composer-authorized replacement composition.
pub struct ReconstitutionArgs {
    pub composition_hash: [u8; 32],
    pub eligibility_hash: [u8; 32],
    pub eligibility_nonce: u64,
    pub composition_nonce: u64,
    pub composition_expiry: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PublishEligibilityListArgs {
    pub list_hash: [u8; 32],
    pub nonce: u64,
    pub expires_at: i64,
    pub markets: Vec<EligibleMarket>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PublishCompositionDraftArgs {
    pub composition_hash: [u8; 32],
    pub eligibility_hash: [u8; 32],
    pub eligibility_nonce: u64,
    pub composition_nonce: u64,
    pub items: Vec<BasketAsset>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RegisterTokenArgs {
    pub token_mint: Pubkey,
    pub jupiter_verified: bool,
    pub asset_class: TokenAssetClass,
    pub availability: TradingAvailability,
    pub price_source: SpotPriceSource,
    pub backing_attestation_hash: [u8; 32],
    pub enabled: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SubmitPriceAttestationArgs {
    pub token_mint: Pubkey,
    pub price_value: u64,
    pub confidence_bps: u16,
    pub observed_at: i64,
    pub valid_until: i64,
    pub nonce: u64,
}
