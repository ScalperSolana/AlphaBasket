use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::constants::USDC_DECIMALS;
use crate::errors::EscrowError;
use crate::state::Config;

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = admin,
        seeds = [b"config"],
        bump,
        space = 8 + Config::INIT_SPACE,
    )]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = admin,
        seeds = [b"treasury-usdc"],
        bump,
        token::mint = usdc_mint,
        token::authority = admin,
        token::token_program = token_program,
    )]
    pub treasury_usdc: InterfaceAccount<'info, TokenAccount>,
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_handler(
    ctx: Context<Initialize>,
    oracle_authority: Pubkey,
    quote_signer: Pubkey,
) -> Result<()> {
    require!(
        ctx.accounts.usdc_mint.decimals == USDC_DECIMALS,
        EscrowError::UnsupportedMintDecimals
    );

    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.oracle_authority = oracle_authority;
    config.quote_signer = quote_signer;
    config.usdc_mint = ctx.accounts.usdc_mint.key();
    config.treasury_usdc = ctx.accounts.treasury_usdc.key();
    config.paused = false;
    config.bump = ctx.bumps.config;
    Ok(())
}
