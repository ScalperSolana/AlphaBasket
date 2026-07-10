use anchor_lang::prelude::*;

use crate::constants::{MAX_BPS, ZERO_PUBKEY};
use crate::errors::EscrowError;
use crate::events::{
    AdminTransferAccepted, AdminTransferCancelled, AdminTransferProposed, AuthoritiesUpdated,
    LimitsUpdated, PauseUpdated,
};
use crate::state::Config;

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        constraint = config.pending_admin == Some(pending_admin.key())
            @ EscrowError::AdminTransferNotPending,
    )]
    pub config: Account<'info, Config>,
    pub pending_admin: Signer<'info>,
}

pub fn set_authorities_handler(
    ctx: Context<AdminOnly>,
    new_composer_signer: Option<Pubkey>,
    new_backend_signer: Option<Pubkey>,
    new_protocol_treasury: Option<Pubkey>,
) -> Result<()> {
    for key in [
        new_composer_signer,
        new_backend_signer,
        new_protocol_treasury,
    ]
    .into_iter()
    .flatten()
    {
        require!(key != ZERO_PUBKEY, EscrowError::ZeroAuthority);
    }

    let config = &mut ctx.accounts.config;
    if let Some(key) = new_composer_signer {
        config.composer_signer = key;
    }
    if let Some(key) = new_backend_signer {
        config.backend_signer = key;
    }
    if let Some(key) = new_protocol_treasury {
        config.protocol_treasury = key;
    }

    emit!(AuthoritiesUpdated {
        admin: config.admin,
        composer_signer: config.composer_signer,
        backend_signer: config.backend_signer,
        protocol_treasury: config.protocol_treasury,
    });
    Ok(())
}

pub fn propose_admin_handler(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
    require!(
        new_admin != ZERO_PUBKEY && new_admin != ctx.accounts.config.admin,
        EscrowError::ZeroAuthority
    );
    let config = &mut ctx.accounts.config;
    config.pending_admin = Some(new_admin);
    emit!(AdminTransferProposed {
        current_admin: config.admin,
        pending_admin: new_admin,
    });
    Ok(())
}

pub fn accept_admin_handler(ctx: Context<AcceptAdmin>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let previous_admin = config.admin;
    let new_admin = ctx.accounts.pending_admin.key();
    config.admin = new_admin;
    config.pending_admin = None;
    emit!(AdminTransferAccepted {
        previous_admin,
        new_admin,
    });
    Ok(())
}

pub fn cancel_admin_transfer_handler(ctx: Context<AdminOnly>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let cancelled_admin = config
        .pending_admin
        .take()
        .ok_or(EscrowError::AdminTransferNotPending)?;
    emit!(AdminTransferCancelled {
        admin: config.admin,
        cancelled_admin,
    });
    Ok(())
}

pub fn set_limits_handler(ctx: Context<AdminOnly>, max_slippage_bps: u16) -> Result<()> {
    require!(max_slippage_bps <= MAX_BPS, EscrowError::InvalidBasisPoints);
    let config = &mut ctx.accounts.config;
    config.max_slippage_bps = max_slippage_bps;
    emit!(LimitsUpdated { max_slippage_bps });
    Ok(())
}

pub fn set_paused_handler(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
    ctx.accounts.config.paused = paused;
    emit!(PauseUpdated { paused });
    Ok(())
}
