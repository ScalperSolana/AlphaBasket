use anchor_lang::prelude::*;

use crate::constants::{ACCOUNTING_DECIMALS, MAX_BPS, ZERO_PUBKEY};
use crate::errors::EscrowError;
use crate::events::ConfigInitialized;
use crate::state::{Config, InitializeArgs};

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
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ EscrowError::Unauthorized,
    )]
    pub program: Program<'info, crate::program::PolybasketsEscrow>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(admin.key())
            @ EscrowError::Unauthorized,
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_handler(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
    require!(
        args.composer_signer != ZERO_PUBKEY
            && args.backend_signer != ZERO_PUBKEY
            && args.protocol_treasury != ZERO_PUBKEY
            && args.settlement_mint != ZERO_PUBKEY,
        EscrowError::ZeroAuthority
    );
    require!(
        args.max_slippage_bps <= MAX_BPS,
        EscrowError::InvalidBasisPoints
    );

    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.pending_admin = None;
    config.composer_signer = args.composer_signer;
    config.backend_signer = args.backend_signer;
    config.protocol_treasury = args.protocol_treasury;
    config.settlement_mint = args.settlement_mint;
    config.max_slippage_bps = args.max_slippage_bps;
    config.accounting_decimals = ACCOUNTING_DECIMALS;
    config.paused = false;
    config.bump = ctx.bumps.config;

    emit!(ConfigInitialized {
        admin: config.admin,
        composer_signer: config.composer_signer,
        backend_signer: config.backend_signer,
        protocol_treasury: config.protocol_treasury,
    });
    Ok(())
}
