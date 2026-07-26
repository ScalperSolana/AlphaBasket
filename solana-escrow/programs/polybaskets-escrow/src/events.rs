use anchor_lang::prelude::*;

use crate::state::WithdrawalKind;

#[event]
pub struct ConfigInitialized {
    pub admin: Pubkey,
    pub composer_signer: Pubkey,
    pub backend_signer: Pubkey,
    pub protocol_treasury: Pubkey,
}

#[event]
pub struct AuthoritiesUpdated {
    pub admin: Pubkey,
    pub composer_signer: Pubkey,
    pub backend_signer: Pubkey,
    pub protocol_treasury: Pubkey,
}

#[event]
pub struct AdminTransferProposed {
    pub current_admin: Pubkey,
    pub pending_admin: Pubkey,
}

#[event]
pub struct AdminTransferAccepted {
    pub previous_admin: Pubkey,
    pub new_admin: Pubkey,
}

#[event]
pub struct AdminTransferCancelled {
    pub admin: Pubkey,
    pub cancelled_admin: Pubkey,
}

#[event]
pub struct PauseUpdated {
    pub paused: bool,
}

#[event]
pub struct LimitsUpdated {
    pub max_slippage_bps: u16,
}

#[event]
pub struct BasketCreated {
    pub basket: Pubkey,
    pub basket_id: [u8; 32],
    pub composer: Pubkey,
    pub creator: Pubkey,
    pub composition_hash: [u8; 32],
    pub performance_fee_bps: u16,
}

#[event]
pub struct EligibilityListPublished {
    pub eligibility_list: Pubkey,
    pub list_hash: [u8; 32],
    pub nonce: u64,
    pub market_count: u16,
    pub expires_at: i64,
}

#[event]
pub struct CompositionDraftPublished {
    pub composition_draft: Pubkey,
    pub composition_hash: [u8; 32],
    pub eligibility_hash: [u8; 32],
    pub eligibility_nonce: u64,
    pub composition_nonce: u64,
    pub item_count: u16,
}

#[event]
pub struct TokenAllowlistUpdated {
    pub token_allowlist: Pubkey,
    pub token_mint: Pubkey,
    pub enabled: bool,
    pub jupiter_verified: bool,
}

#[event]
pub struct PriceAttestationSubmitted {
    pub price_attestation: Pubkey,
    pub token_mint: Pubkey,
    pub price_value: u64,
    pub confidence_bps: u16,
    pub observed_at: i64,
    pub valid_until: i64,
    pub nonce: u64,
    pub attestation_hash: [u8; 32],
}

#[event]
pub struct DepositSettled {
    pub intent_hash: [u8; 32],
    pub intent_nonce: u64,
    pub receipt: Pubkey,
    pub basket: Pubkey,
    pub user: Pubkey,
    pub execution_batch_hash: [u8; 32],
    pub executed_at: i64,
    pub net_invested_value: u64,
    pub shares_credited: u64,
    pub protocol_fee: u64,
}

#[event]
pub struct WithdrawalSettled {
    pub intent_hash: [u8; 32],
    pub intent_nonce: u64,
    pub receipt: Pubkey,
    pub basket: Pubkey,
    pub user: Pubkey,
    pub destination: Pubkey,
    pub execution_batch_hash: [u8; 32],
    pub executed_at: i64,
    pub shares_decremented: u64,
    pub user_value_out: u64,
    pub protocol_fee: u64,
    pub creator_fee: u64,
    pub withdrawn_cost_basis: u64,
    pub realized_profit: u64,
    pub early_exit_value: u64,
    pub mature_exit_value: u64,
    pub kind: WithdrawalKind,
}

#[event]
pub struct ManagementFeeAccrued {
    pub basket: Pubkey,
    pub periods: u64,
    pub elapsed_seconds: i64,
    pub shares_minted: u64,
    pub protocol_fee_shares: u64,
    pub total_shares_outstanding: u64,
    pub accrued_through: i64,
}

#[event]
pub struct ProtocolFeeSharesWithdrawn {
    pub receipt: Pubkey,
    pub basket: Pubkey,
    pub destination: Pubkey,
    pub execution_batch_hash: [u8; 32],
    pub executed_at: i64,
    pub shares_redeemed: u64,
    pub gross_value: u64,
}

#[event]
pub struct BasketStatusUpdated {
    pub basket: Pubkey,
    pub status: crate::state::BasketStatus,
}

#[event]
pub struct BasketReconstituted {
    pub basket: Pubkey,
    pub composition_hash: [u8; 32],
    pub composition_version: u32,
}

#[event]
pub struct FinalSettlementRecorded {
    pub basket: Pubkey,
    pub final_report_hash: [u8; 32],
    pub final_nav_value: u64,
    pub final_share_snapshot: u64,
}
