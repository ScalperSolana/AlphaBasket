use anchor_lang::prelude::*;

use crate::constants::{CHALLENGE_WINDOW_SECS, MAX_BPS};
use crate::errors::EscrowError;
use crate::events::{Settled, SettlementProposed};
use crate::state::{Basket, BasketStatus, Config};

#[derive(Accounts)]
pub struct ProposeSettlement<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = oracle_authority)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"basket", basket.basket_id.as_ref()], bump = basket.bump)]
    pub basket: Account<'info, Basket>,
    pub oracle_authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct FinalizeSettlement<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = oracle_authority)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"basket", basket.basket_id.as_ref()], bump = basket.bump)]
    pub basket: Account<'info, Basket>,
    pub oracle_authority: Signer<'info>,
}

/// Propose the settlement index, opening the challenge window.
pub fn propose_settlement_handler(
    ctx: Context<ProposeSettlement>,
    settlement_index_bps: u16,
) -> Result<()> {
    require!(settlement_index_bps <= MAX_BPS, EscrowError::InvalidIndex);
    let basket = &mut ctx.accounts.basket;
    require!(
        basket.status != BasketStatus::Settled,
        EscrowError::AlreadySettled
    );
    let now = Clock::get()?.unix_timestamp;
    basket.status = BasketStatus::Proposed;
    basket.proposed_index_bps = settlement_index_bps;
    basket.settlement_proposed_at = now;

    let finalize_after = now
        .checked_add(CHALLENGE_WINDOW_SECS)
        .ok_or(EscrowError::MathOverflow)?;
    emit!(SettlementProposed {
        basket_id: basket.basket_id,
        settlement_index_bps,
        proposed_at: now,
        finalize_after,
    });
    Ok(())
}

/// Finalize a proposed settlement once the challenge window has elapsed.
pub fn finalize_settlement_handler(ctx: Context<FinalizeSettlement>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let basket = &mut ctx.accounts.basket;
    require!(
        basket.status == BasketStatus::Proposed,
        EscrowError::NoActiveProposal
    );

    let finalize_after = basket
        .settlement_proposed_at
        .checked_add(CHALLENGE_WINDOW_SECS)
        .ok_or(EscrowError::MathOverflow)?;
    require!(now >= finalize_after, EscrowError::ChallengeWindowActive);

    basket.status = BasketStatus::Settled;
    basket.settlement_index_bps = basket.proposed_index_bps;

    emit!(Settled {
        basket_id: basket.basket_id,
        settlement_index_bps: basket.settlement_index_bps,
    });
    Ok(())
}
