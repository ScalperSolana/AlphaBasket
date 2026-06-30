use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub oracle_authority: Pubkey,
    pub quote_signer: Pubkey,
    pub usdc_mint: Pubkey,
    pub paused: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub enum BasketStatus {
    Active,
    Proposed,
    Settled,
}

/// Max markets per basket (caps the on-chain Basket account size).
pub const MAX_BASKET_ITEMS: usize = 16;
/// Max length of a stored Polymarket market identifier.
pub const MAX_MARKET_ID_LEN: usize = 64;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct BasketItem {
    #[max_len(MAX_MARKET_ID_LEN)]
    pub market_id: String,
    pub outcome: u8,
    pub weight_bps: u16,
}

#[account]
#[derive(InitSpace)]
pub struct Basket {
    pub basket_id: [u8; 32],
    pub creator: Pubkey,
    pub status: BasketStatus,
    pub settlement_index_bps: u16,
    pub proposed_index_bps: u16,
    pub settlement_proposed_at: i64,
    pub total_staked: u64,
    pub created_at: i64,
    #[max_len(MAX_BASKET_ITEMS)]
    pub items: Vec<BasketItem>,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub owner: Pubkey,
    pub basket: Pubkey,
    pub stake_amount: u64,
    pub entry_index_bps: u16,
    pub last_quote_nonce: u64,
    pub claimed: bool,
    pub bump: u8,
}
