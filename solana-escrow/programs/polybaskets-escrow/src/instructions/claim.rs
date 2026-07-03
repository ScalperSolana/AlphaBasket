use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TransferChecked};

use crate::constants::WITHDRAWAL_FEE_BPS;
use crate::errors::EscrowError;
use crate::events::Claimed;
use crate::math::fee_ceil;
use crate::state::{Basket, BasketStatus, Config, Position};

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = treasury_usdc,
    )]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"basket", basket.basket_id.as_ref()], bump = basket.bump)]
    pub basket: Account<'info, Basket>,
    #[account(
        mut,
        seeds = [b"vault", basket.basket_id.as_ref()],
        bump = basket.vault_bump,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"position", basket.basket_id.as_ref(), claimer.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == claimer.key() @ EscrowError::WrongTokenOwner,
        constraint = position.basket == basket.key() @ EscrowError::PositionBasketMismatch,
    )]
    pub position: Account<'info, Position>,
    #[account(
        mut,
        constraint = claimer_usdc.owner == claimer.key() @ EscrowError::WrongTokenOwner,
        constraint = claimer_usdc.mint == config.usdc_mint @ EscrowError::WrongMint,
    )]
    pub claimer_usdc: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        constraint = treasury_usdc.owner == config.admin @ EscrowError::WrongTokenOwner,
        constraint = treasury_usdc.mint == config.usdc_mint @ EscrowError::WrongMint,
    )]
    pub treasury_usdc: InterfaceAccount<'info, TokenAccount>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    pub claimer: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

/// Allows anyone to claim their payout from a settled basket.
pub fn claim_handler(ctx: Context<Claim>) -> Result<()> {
    require!(!ctx.accounts.config.paused, EscrowError::Paused);
    require!(
        ctx.accounts.basket.status == BasketStatus::Settled,
        EscrowError::NotSettled
    );
    let position = &mut ctx.accounts.position;
    require!(!position.claimed, EscrowError::AlreadyClaimed);
    require!(position.entry_index_bps >= 1, EscrowError::InvalidIndex);

    let payout_u128 = (position.stake_amount as u128)
        .checked_mul(ctx.accounts.basket.settlement_index_bps as u128)
        .and_then(|v| v.checked_div(position.entry_index_bps as u128))
        .ok_or(EscrowError::MathOverflow)?;
    let gross_payout = u64::try_from(payout_u128).map_err(|_| EscrowError::MathOverflow)?;
    let withdrawal_fee = fee_ceil(gross_payout, WITHDRAWAL_FEE_BPS)?;
    let net_payout = gross_payout
        .checked_sub(withdrawal_fee)
        .ok_or(EscrowError::MathOverflow)?;

    position.claimed = true;
    ctx.accounts.basket.claimed_positions = ctx
        .accounts
        .basket
        .claimed_positions
        .checked_add(1)
        .ok_or(EscrowError::MathOverflow)?;

    if gross_payout > 0 {
        require!(
            ctx.accounts.vault.amount >= gross_payout,
            EscrowError::InsufficientVaultLiquidity
        );

        let basket_id = ctx.accounts.basket.basket_id;
        let basket_bump = ctx.accounts.basket.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[b"basket", basket_id.as_ref(), &[basket_bump]]];
        let decimals = ctx.accounts.usdc_mint.decimals;

        if net_payout > 0 {
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.usdc_mint.to_account_info(),
                        to: ctx.accounts.claimer_usdc.to_account_info(),
                        authority: ctx.accounts.basket.to_account_info(),
                    },
                    signer_seeds,
                ),
                net_payout,
                decimals,
            )?;
        }
        if withdrawal_fee > 0 {
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
                withdrawal_fee,
                decimals,
            )?;
        }
    }

    emit!(Claimed {
        basket_id: ctx.accounts.basket.basket_id,
        owner: ctx.accounts.claimer.key(),
        gross_payout,
        fee_amount: withdrawal_fee,
        net_payout,
    });
    Ok(())
}
