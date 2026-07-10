use anchor_lang::prelude::*;

use crate::constants::{MAX_BASKET_ITEMS, MAX_MARKET_ID_LEN, POSITION_RESERVED_BYTES};

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

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
/// Tagged representation of a supported basket position.
pub enum PositionKind {
    PredictionMarket { outcome: u8, ctf_token_id: [u8; 32] },
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
/// One weighted asset in a Composer-signed basket composition.
pub struct BasketAsset {
    #[max_len(MAX_MARKET_ID_LEN)]
    pub market_id: String,
    pub kind: PositionKind,
    pub weight_bps: u16,
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
    pub items: Vec<BasketAsset>,
    pub creator: Pubkey,
    pub creator_fee_destination: Pubkey,
    pub performance_fee_bps: Option<u16>,
    pub is_perpetual: bool,
    pub reconstitution_cadence_secs: i64,
    pub composition_nonce: u64,
    pub composition_expiry: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
/// User intent and backend result used to complete a deposit.
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
/// User intent and backend result used to complete a withdrawal.
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
/// Backend result used to redeem protocol-owned dilution shares.
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
    pub items: Vec<BasketAsset>,
    pub composition_nonce: u64,
    pub composition_expiry: i64,
}
