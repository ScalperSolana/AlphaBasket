use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TransferChecked};

use crate::errors::EscrowError;
use crate::events::BasketSurplusSwept;
use crate::state::{Basket, BasketStatus, Config};

#[derive(Accounts)]
pub struct SweepSurplus<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = admin,
        has_one = treasury_usdc,
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"basket", basket.basket_id.as_ref()],
        bump = basket.bump,
    )]
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
        constraint = treasury_usdc.owner == admin.key() @ EscrowError::WrongTokenOwner,
        constraint = treasury_usdc.mint == config.usdc_mint @ EscrowError::WrongMint,
    )]
    pub treasury_usdc: InterfaceAccount<'info, TokenAccount>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    pub admin: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn sweep_surplus_handler(ctx: Context<SweepSurplus>) -> Result<()> {
    require!(
        ctx.accounts.basket.status == BasketStatus::Settled,
        EscrowError::NotSettled
    );
    require!(
        ctx.accounts.basket.claimed_positions == ctx.accounts.basket.total_positions,
        EscrowError::OutstandingClaims
    );

    let amount = ctx.accounts.vault.amount;
    let basket_id = ctx.accounts.basket.basket_id;
    let basket_bump = ctx.accounts.basket.bump;

    if amount > 0 {
        let signer_seeds: &[&[&[u8]]] = &[&[b"basket", basket_id.as_ref(), &[basket_bump]]];
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.treasury_usdc.to_account_info(),
                    authority: ctx.accounts.basket.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
            ctx.accounts.usdc_mint.decimals,
        )?;
    }

    emit!(BasketSurplusSwept {
        basket_id,
        treasury: ctx.accounts.treasury_usdc.key(),
        amount,
    });
    Ok(())
}
