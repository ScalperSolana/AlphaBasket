use anchor_lang::prelude::*;

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
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_handler(
    ctx: Context<Initialize>,
    oracle_authority: Pubkey,
    quote_signer: Pubkey,
    usdc_mint: Pubkey,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.oracle_authority = oracle_authority;
    config.quote_signer = quote_signer;
    config.usdc_mint = usdc_mint;
    config.paused = false;
    config.bump = ctx.bumps.config;
    Ok(())
}
