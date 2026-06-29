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
