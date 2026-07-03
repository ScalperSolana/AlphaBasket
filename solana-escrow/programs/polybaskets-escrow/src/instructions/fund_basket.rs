use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TransferChecked};

use crate::errors::EscrowError;
use crate::events::VaultFunded;
use crate::state::{Basket, Config};

#[derive(Accounts)]
pub struct FundBasket<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [b"basket", basket.basket_id.as_ref()], bump = basket.bump)]
    pub basket: Account<'info, Basket>,
    #[account(
        mut,
        seeds = [b"vault", basket.basket_id.as_ref()],
        bump = basket.vault_bump,
        constraint = vault.mint == config.usdc_mint @ EscrowError::WrongMint,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        constraint = funder_usdc.owner == funder.key() @ EscrowError::WrongTokenOwner,
        constraint = funder_usdc.mint == config.usdc_mint @ EscrowError::WrongMint,
    )]
    pub funder_usdc: InterfaceAccount<'info, TokenAccount>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub funder: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

/// Allows anyone to fund the basket vault.
pub fn fund_basket_handler(ctx: Context<FundBasket>, amount: u64) -> Result<()> {
    require!(amount > 0, EscrowError::ZeroAmount);
    let decimals = ctx.accounts.usdc_mint.decimals;
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.funder_usdc.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.funder.to_account_info(),
            },
        ),
        amount,
        decimals,
    )?;
    emit!(VaultFunded {
        basket_id: ctx.accounts.basket.basket_id,
        amount,
    });
    Ok(())
}
