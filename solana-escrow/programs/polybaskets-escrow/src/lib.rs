//! PolyBaskets escrow program.
use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;

pub use constants::*;
pub use errors::*;
pub use events::*;
pub use instructions::*;
pub use state::*;

declare_id!("hJYvvev2BT4tnPzDqK9veY7sT2XyAHctMGGBYVnkG8Q");

#[program]
pub mod polybaskets_escrow {
    use super::*;

    /// One-time global config. `admin` is the upgrade/governance key.
    pub fn initialize(
        ctx: Context<Initialize>,
        oracle_authority: Pubkey,
        quote_signer: Pubkey,
    ) -> Result<()> {
        instructions::initialize::initialize_handler(ctx, oracle_authority, quote_signer)
    }

    /// Rotate the oracle authority and/or quote signer. Admin only.
    pub fn set_authorities(
        ctx: Context<AdminOnly>,
        new_oracle_authority: Option<Pubkey>,
        new_quote_signer: Option<Pubkey>,
    ) -> Result<()> {
        instructions::admin::set_authorities_handler(ctx, new_oracle_authority, new_quote_signer)
    }

    /// Emergency pause switch (blocks stake + claim). Admin only.
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        instructions::admin::set_paused_handler(ctx, paused)
    }

    /// Create a basket and its dedicated USDC vault, storing its composition.
    pub fn create_basket(
        ctx: Context<CreateBasket>,
        basket_id: [u8; 32],
        items: Vec<BasketItem>,
    ) -> Result<()> {
        instructions::create_basket::create_basket_handler(ctx, basket_id, items)
    }

    /// Stake USDC into a basket at an Ed25519-signed entry index.
    pub fn stake(
        ctx: Context<Stake>,
        amount: u64,
        entry_index_bps: u16,
        nonce: u64,
        expiry: i64,
    ) -> Result<()> {
        instructions::stake::stake_handler(ctx, amount, entry_index_bps, nonce, expiry)
    }

    /// House liquidity: anyone may fund a basket vault to cover net winnings.
    pub fn fund_basket(ctx: Context<FundBasket>, amount: u64) -> Result<()> {
        instructions::fund_basket::fund_basket_handler(ctx, amount)
    }

    /// Propose the settlement index for a basket, opening the challenge window.
    pub fn propose_settlement(
        ctx: Context<ProposeSettlement>,
        settlement_index_bps: u16,
    ) -> Result<()> {
        instructions::settlement::propose_settlement_handler(ctx, settlement_index_bps)
    }

    /// Finalize a proposed settlement once the challenge window has elapsed.
    pub fn finalize_settlement(ctx: Context<FinalizeSettlement>) -> Result<()> {
        instructions::settlement::finalize_settlement_handler(ctx)
    }

    /// Claim a settled position. Payout = stake * settlement / entry.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        instructions::claim::claim_handler(ctx)
    }

    /// After every recorded position has claimed, transfer the exact remaining
    /// basket-vault surplus to the configured USDC treasury account.
    pub fn sweep_surplus(ctx: Context<SweepSurplus>) -> Result<()> {
        instructions::sweep_surplus::sweep_surplus_handler(ctx)
    }
}
