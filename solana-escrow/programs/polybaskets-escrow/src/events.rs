use anchor_lang::prelude::*;

#[event]
pub struct BasketCreated {
    pub basket_id: [u8; 32],
    pub creator: Pubkey,
}

#[event]
pub struct Staked {
    pub basket_id: [u8; 32],
    pub owner: Pubkey,
    pub amount: u64,
    pub entry_index_bps: u16,
}

#[event]
pub struct VaultFunded {
    pub basket_id: [u8; 32],
    pub amount: u64,
}

#[event]
pub struct SettlementProposed {
    pub basket_id: [u8; 32],
    pub settlement_index_bps: u16,
    pub proposed_at: i64,
    pub finalize_after: i64,
}

#[event]
pub struct Settled {
    pub basket_id: [u8; 32],
    pub settlement_index_bps: u16,
}

#[event]
pub struct Claimed {
    pub basket_id: [u8; 32],
    pub owner: Pubkey,
    pub payout: u64,
}
