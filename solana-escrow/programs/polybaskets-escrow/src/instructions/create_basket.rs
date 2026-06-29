use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::events::BasketCreated;
use crate::state::{Basket, BasketStatus, Config};

#[derive(Accounts)]
#[instruction(basket_id: [u8; 32])]
pub struct CreateBasket<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = creator,
        seeds = [b"basket", basket_id.as_ref()],
        bump,
        space = 8 + Basket::INIT_SPACE,
    )]
    pub basket: Account<'info, Basket>,
    #[account(
        init,
        payer = creator,
        seeds = [b"vault", basket_id.as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = basket,
        token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Allows anyone to create a basket vault.
pub fn create_basket_handler(ctx: Context<CreateBasket>, basket_id: [u8; 32]) -> Result<()> {
    let basket = &mut ctx.accounts.basket;
    basket.basket_id = basket_id;
    basket.creator = ctx.accounts.creator.key();
    basket.status = BasketStatus::Active;
    basket.settlement_index_bps = 0;
    basket.proposed_index_bps = 0;
    basket.settlement_proposed_at = 0;
    basket.total_staked = 0;
    basket.created_at = Clock::get()?.unix_timestamp;
    basket.bump = ctx.bumps.basket;
    basket.vault_bump = ctx.bumps.vault;

    emit!(BasketCreated {
        basket_id,
        creator: basket.creator,
    });
    Ok(())
}
