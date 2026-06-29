use anchor_lang::prelude::*;

use crate::state::Config;

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}

/// Update the oracle authority and/or quote signer.
pub fn set_authorities_handler(
    ctx: Context<AdminOnly>,
    new_oracle_authority: Option<Pubkey>,
    new_quote_signer: Option<Pubkey>,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    if let Some(oracle) = new_oracle_authority {
        config.oracle_authority = oracle;
    }
    if let Some(signer) = new_quote_signer {
        config.quote_signer = signer;
    }
    Ok(())
}

/// Emergency pause switch.
pub fn set_paused_handler(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
    ctx.accounts.config.paused = paused;
    Ok(())
}
