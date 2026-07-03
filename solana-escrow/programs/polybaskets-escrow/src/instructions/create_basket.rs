use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::constants::MAX_BPS;
use crate::errors::EscrowError;
use crate::events::BasketCreated;
use crate::state::{Basket, BasketItem, BasketStatus, Config, MAX_BASKET_ITEMS, MAX_MARKET_ID_LEN};

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
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Create a basket + vault, storing its composition on-chain.
pub fn create_basket_handler(
    ctx: Context<CreateBasket>,
    basket_id: [u8; 32],
    items: Vec<BasketItem>,
) -> Result<()> {
    require!(
        !items.is_empty() && items.len() <= MAX_BASKET_ITEMS,
        EscrowError::InvalidBasketItems
    );

    let mut total_weight: u32 = 0;
    for item in &items {
        require!(
            !item.market_id.is_empty() && item.market_id.len() <= MAX_MARKET_ID_LEN,
            EscrowError::InvalidBasketItems
        );
        require!(item.outcome <= 1, EscrowError::InvalidBasketItems);
        require!(
            (1..=MAX_BPS).contains(&item.weight_bps),
            EscrowError::InvalidBasketItems
        );
        total_weight = total_weight
            .checked_add(item.weight_bps as u32)
            .ok_or(EscrowError::MathOverflow)?;
    }
    require!(
        total_weight == MAX_BPS as u32,
        EscrowError::InvalidBasketWeights
    );

    let basket = &mut ctx.accounts.basket;
    basket.basket_id = basket_id;
    basket.creator = ctx.accounts.creator.key();
    basket.status = BasketStatus::Active;
    basket.settlement_index_bps = 0;
    basket.proposed_index_bps = 0;
    basket.settlement_proposed_at = 0;
    basket.total_staked = 0;
    basket.total_deposited = 0;
    basket.total_positions = 0;
    basket.claimed_positions = 0;
    basket.created_at = Clock::get()?.unix_timestamp;
    basket.items = items;
    basket.bump = ctx.bumps.basket;
    basket.vault_bump = ctx.bumps.vault;

    emit!(BasketCreated {
        basket_id,
        creator: basket.creator,
    });
    Ok(())
}
