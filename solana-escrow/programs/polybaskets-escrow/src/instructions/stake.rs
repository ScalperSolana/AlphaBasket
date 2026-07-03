use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked, ID as IX_SYSVAR_ID,
};
use anchor_spl::token::Token;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TransferChecked};

use crate::constants::{
    DEPOSIT_FEE_BPS, MAX_BASKET_DEPOSIT_UNITS, MAX_USER_DEPOSIT_UNITS, USDC_DECIMALS,
};
use crate::constants::{ED25519_ID, MAX_BPS, QUOTE_MSG_LEN};
use crate::errors::EscrowError;
use crate::events::Staked;
use crate::math::fee_ceil;
use crate::state::{Basket, BasketStatus, Config, Position};

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
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
        init_if_needed,
        payer = staker,
        seeds = [b"position", basket.basket_id.as_ref(), staker.key().as_ref()],
        bump,
        space = 8 + Position::INIT_SPACE,
    )]
    pub position: Account<'info, Position>,
    #[account(
        mut,
        constraint = staker_usdc.owner == staker.key() @ EscrowError::WrongTokenOwner,
        constraint = staker_usdc.mint == config.usdc_mint @ EscrowError::WrongMint,
    )]
    pub staker_usdc: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        constraint = treasury_usdc.owner == config.admin @ EscrowError::WrongTokenOwner,
        constraint = treasury_usdc.mint == config.usdc_mint @ EscrowError::WrongMint,
    )]
    pub treasury_usdc: InterfaceAccount<'info, TokenAccount>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub staker: Signer<'info>,
    /// CHECK: Instructions sysvar, validated by address; read for Ed25519 introspection.
    #[account(address = IX_SYSVAR_ID)]
    pub ix_sysvar: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Allows anyone to stake in the basket vault.
pub fn stake_handler(
    ctx: Context<Stake>,
    amount: u64,
    entry_index_bps: u16,
    nonce: u64,
    expiry: i64,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, EscrowError::Paused);
    require!(
        ctx.accounts.basket.status == BasketStatus::Active,
        EscrowError::BasketNotActive
    );
    require!(amount > 0, EscrowError::ZeroAmount);
    require!(
        ctx.accounts.usdc_mint.decimals == USDC_DECIMALS,
        EscrowError::UnsupportedMintDecimals
    );
    require!(
        (1..=MAX_BPS).contains(&entry_index_bps),
        EscrowError::InvalidIndex
    );
    require!(
        expiry > Clock::get()?.unix_timestamp,
        EscrowError::QuoteExpired
    );

    verify_entry_quote(
        &ctx.accounts.ix_sysvar,
        &ctx.accounts.config.quote_signer,
        &ctx.accounts.basket.basket_id,
        &ctx.accounts.staker.key(),
        entry_index_bps,
        nonce,
        expiry,
    )?;

    let position = &mut ctx.accounts.position;
    require!(
        nonce > position.last_quote_nonce,
        EscrowError::QuoteNonceReused
    );

    let deposit_fee = fee_ceil(amount, DEPOSIT_FEE_BPS)?;
    let net_amount = amount
        .checked_sub(deposit_fee)
        .ok_or(EscrowError::MathOverflow)?;
    require!(net_amount > 0, EscrowError::DepositTooSmall);

    let new_basket_deposited = ctx
        .accounts
        .basket
        .total_deposited
        .checked_add(amount)
        .ok_or(EscrowError::MathOverflow)?;
    require!(
        new_basket_deposited <= MAX_BASKET_DEPOSIT_UNITS,
        EscrowError::BasketDepositLimitExceeded
    );

    let new_user_deposited = position
        .deposited_amount
        .checked_add(amount)
        .ok_or(EscrowError::MathOverflow)?;
    require!(
        new_user_deposited <= MAX_USER_DEPOSIT_UNITS,
        EscrowError::UserDepositLimitExceeded
    );

    let decimals = ctx.accounts.usdc_mint.decimals;
    // Credit only the post-fee amount to the position vault.
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.staker_usdc.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.staker.to_account_info(),
            },
        ),
        net_amount,
        decimals,
    )?;
    // Deposit fees leave user custody and reach the configured treasury in the
    // same atomic transaction.
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.staker_usdc.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.treasury_usdc.to_account_info(),
                authority: ctx.accounts.staker.to_account_info(),
            },
        ),
        deposit_fee,
        decimals,
    )?;

    if position.stake_amount == 0 {
        position.owner = ctx.accounts.staker.key();
        position.basket = ctx.accounts.basket.key();
        position.entry_index_bps = entry_index_bps;
        position.claimed = false;
        position.bump = ctx.bumps.position;
        position.stake_amount = net_amount;
        position.deposited_amount = amount;
        ctx.accounts.basket.total_positions = ctx
            .accounts
            .basket
            .total_positions
            .checked_add(1)
            .ok_or(EscrowError::MathOverflow)?;
    } else {
        let old_stake = position.stake_amount as u128;
        let add_stake = net_amount as u128;
        let weighted = old_stake
            .checked_mul(position.entry_index_bps as u128)
            .and_then(|v| v.checked_add(add_stake.checked_mul(entry_index_bps as u128)?))
            .and_then(|num| num.checked_div(old_stake.checked_add(add_stake)?))
            .ok_or(EscrowError::MathOverflow)?;
        position.entry_index_bps =
            u16::try_from(weighted).map_err(|_| EscrowError::MathOverflow)?;
        position.stake_amount = position
            .stake_amount
            .checked_add(net_amount)
            .ok_or(EscrowError::MathOverflow)?;
        position.deposited_amount = new_user_deposited;
    }
    position.last_quote_nonce = nonce;

    let basket = &mut ctx.accounts.basket;
    basket.total_staked = basket
        .total_staked
        .checked_add(net_amount)
        .ok_or(EscrowError::MathOverflow)?;
    basket.total_deposited = new_basket_deposited;

    emit!(Staked {
        basket_id: basket.basket_id,
        owner: ctx.accounts.staker.key(),
        gross_amount: amount,
        fee_amount: deposit_fee,
        net_amount,
        entry_index_bps: position.entry_index_bps,
    });
    Ok(())
}

/// Parse + validate the Ed25519 verify instruction that authorizes the entry index
fn verify_entry_quote(
    ix_sysvar: &AccountInfo,
    quote_signer: &Pubkey,
    basket_id: &[u8; 32],
    owner: &Pubkey,
    entry_index_bps: u16,
    nonce: u64,
    expiry: i64,
) -> Result<()> {
    let current_index = load_current_index_checked(ix_sysvar)? as usize;
    require!(current_index >= 1, EscrowError::MissingQuoteSignature);
    let ed_ix = load_instruction_at_checked(current_index - 1, ix_sysvar)?;

    require!(
        ed_ix.program_id == ED25519_ID,
        EscrowError::MissingQuoteSignature
    );

    let data = &ed_ix.data;
    require!(data.len() >= 16, EscrowError::MalformedQuoteSignature);
    require!(data[0] == 1, EscrowError::MalformedQuoteSignature);

    let read_u16 = |offset: usize| -> Result<u16> {
        let bytes = data
            .get(offset..offset + 2)
            .ok_or(EscrowError::MalformedQuoteSignature)?;
        Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
    };

    // The native Ed25519 program can source the signature, public key, and
    // message from other transaction instructions. Require all three to come
    // from this exact instruction; otherwise an attacker could make Ed25519
    // verify unrelated bytes while presenting an unsigned quote to this parser.
    let signature_instruction_index = read_u16(4)?;
    let public_key_instruction_index = read_u16(8)?;
    let message_instruction_index = read_u16(14)?;
    require!(
        signature_instruction_index == u16::MAX
            && public_key_instruction_index == u16::MAX
            && message_instruction_index == u16::MAX,
        EscrowError::MalformedQuoteSignature
    );

    let pubkey_offset = read_u16(6)? as usize;
    let msg_offset = read_u16(10)? as usize;
    let msg_size = read_u16(12)? as usize;

    let pubkey_bytes = data
        .get(pubkey_offset..pubkey_offset + 32)
        .ok_or(EscrowError::MalformedQuoteSignature)?;
    require!(
        pubkey_bytes == quote_signer.as_ref(),
        EscrowError::UnauthorizedQuoteSigner
    );

    require!(
        msg_size == QUOTE_MSG_LEN,
        EscrowError::MalformedQuoteSignature
    );
    let msg = data
        .get(msg_offset..msg_offset + msg_size)
        .ok_or(EscrowError::MalformedQuoteSignature)?;

    let mut expected = Vec::with_capacity(QUOTE_MSG_LEN);
    expected.extend_from_slice(basket_id);
    expected.extend_from_slice(owner.as_ref());
    expected.extend_from_slice(&entry_index_bps.to_le_bytes());
    expected.extend_from_slice(&nonce.to_le_bytes());
    expected.extend_from_slice(&expiry.to_le_bytes());

    require!(msg == expected.as_slice(), EscrowError::QuoteMismatch);
    Ok(())
}
