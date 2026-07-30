use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked, ID as IX_SYSVAR_ID,
};
use sha2::{Digest, Sha256};

use crate::constants::{
    DEPOSIT_FEE_BPS, DEPOSIT_INTENT_DOMAIN, EARLY_WITHDRAWAL_FEE_BPS, ED25519_ID,
    EXECUTION_BATCH_VERSION, MANAGEMENT_FEE_PERIOD_SECS, MATURE_HOLDING_PERIOD_SECS,
    MATURE_WITHDRAWAL_FEE_BPS, MAX_MANAGEMENT_FEE_PERIODS, POSITION_RESERVED_BYTES,
    RECONSTITUTION_DOMAIN, SHARE_SCALE, WITHDRAWAL_INTENT_DOMAIN,
};
use crate::errors::EscrowError;
use crate::events::{
    BasketReconstituted, BasketStatusUpdated, DepositSettled, FinalSettlementRecorded,
    ManagementFeeAccrued, ProtocolFeeSharesWithdrawn, WithdrawalSettled,
};
use crate::instructions::create_basket::{
    canonical_composition_bytes, validate_basket_items, verify_composer_signature,
};
use crate::math::{
    cost_basis_for_shares, fee_ceil, fee_floor, management_fee_shares_for_elapsed,
    minimum_after_slippage, share_price_from_nav, shares_for_value, value_for_shares,
};
use crate::state::{
    Basket, BasketStatus, CompleteDepositArgs, CompleteProtocolFeeWithdrawalArgs,
    CompleteWithdrawalArgs, CompositionDraft, Config, EligibilityList, FinalSettlementArgs,
    Position, ReconstitutionArgs, SettlementAction, SettlementReceipt, WithdrawalKind,
};

#[derive(Accounts)]
pub struct AccrueManagementFee<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"basket", basket.basket_id.as_ref()],
        bump = basket.bump,
    )]
    pub basket: Account<'info, Basket>,
}

#[derive(Accounts)]
#[instruction(args: CompleteDepositArgs)]
pub struct CompleteDeposit<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = backend_signer,
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"basket", basket.basket_id.as_ref()],
        bump = basket.bump,
    )]
    pub basket: Account<'info, Basket>,
    #[account(
        init_if_needed,
        payer = backend_signer,
        seeds = [b"position", basket.key().as_ref(), args.user.as_ref()],
        bump,
        space = 8 + Position::INIT_SPACE,
    )]
    pub position: Account<'info, Position>,
    #[account(
        init,
        payer = backend_signer,
        seeds = [b"receipt", args.execution_batch_hash.as_ref()],
        bump,
        space = 8 + SettlementReceipt::INIT_SPACE,
    )]
    pub receipt: Account<'info, SettlementReceipt>,
    #[account(mut)]
    pub backend_signer: Signer<'info>,
    /// CHECK: constrained to the native instructions sysvar.
    #[account(address = IX_SYSVAR_ID)]
    pub ix_sysvar: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: CompleteWithdrawalArgs)]
pub struct CompleteWithdrawal<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = backend_signer,
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
        seeds = [b"position", basket.key().as_ref(), args.user.as_ref()],
        bump = position.bump,
    )]
    pub position: Account<'info, Position>,
    #[account(
        init,
        payer = backend_signer,
        seeds = [b"receipt", args.execution_batch_hash.as_ref()],
        bump,
        space = 8 + SettlementReceipt::INIT_SPACE,
    )]
    pub receipt: Account<'info, SettlementReceipt>,
    #[account(mut)]
    pub backend_signer: Signer<'info>,
    /// CHECK: constrained to the native instructions sysvar.
    #[account(address = IX_SYSVAR_ID)]
    pub ix_sysvar: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: CompleteProtocolFeeWithdrawalArgs)]
pub struct CompleteProtocolFeeWithdrawal<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = backend_signer,
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"basket", basket.basket_id.as_ref()],
        bump = basket.bump,
    )]
    pub basket: Account<'info, Basket>,
    #[account(
        init,
        payer = backend_signer,
        seeds = [b"receipt", args.execution_batch_hash.as_ref()],
        bump,
        space = 8 + SettlementReceipt::INIT_SPACE,
    )]
    pub receipt: Account<'info, SettlementReceipt>,
    #[account(mut)]
    pub backend_signer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BackendBasketAction<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = backend_signer,
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"basket", basket.basket_id.as_ref()],
        bump = basket.bump,
    )]
    pub basket: Account<'info, Basket>,
    pub backend_signer: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(args: ReconstitutionArgs)]
pub struct CompleteReconstitution<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = backend_signer,
        has_one = composer_signer,
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"basket", basket.basket_id.as_ref()],
        bump = basket.bump,
    )]
    pub basket: Account<'info, Basket>,
    #[account(
        seeds = [
            b"composition_draft",
            args.composition_hash.as_ref(),
            args.composition_nonce.to_le_bytes().as_ref(),
        ],
        bump = composition_draft.bump,
        constraint = composition_draft.composer == composer_signer.key() @ EscrowError::UnauthorizedCompositionSigner,
    )]
    pub composition_draft: Account<'info, CompositionDraft>,
    #[account(
        seeds = [
            b"eligibility",
            args.eligibility_hash.as_ref(),
            args.eligibility_nonce.to_le_bytes().as_ref(),
        ],
        bump = eligibility_list.bump,
        constraint = eligibility_list.composer == composer_signer.key() @ EscrowError::UnauthorizedCompositionSigner,
    )]
    pub eligibility_list: Account<'info, EligibilityList>,
    pub backend_signer: Signer<'info>,
    pub composer_signer: Signer<'info>,
    /// CHECK: constrained to the native instructions sysvar.
    #[account(address = IX_SYSVAR_ID)]
    pub ix_sysvar: UncheckedAccount<'info>,
}

#[derive(Default)]
struct WithdrawalBreakdown {
    cost_basis: u64,
    realized_profit: u64,
    early_exit_value: u64,
    mature_exit_value: u64,
}

pub fn accrue_management_fee_handler(ctx: Context<AccrueManagementFee>) -> Result<()> {
    require!(
        matches!(
            ctx.accounts.basket.status,
            BasketStatus::Active | BasketStatus::Reconstituting | BasketStatus::Resolving
        ),
        EscrowError::InvalidBasketStatus
    );
    accrue_management_fee_internal(&mut ctx.accounts.basket, Clock::get()?.unix_timestamp)?;
    Ok(())
}

pub(crate) fn accrue_management_fee_internal(
    basket: &mut Account<Basket>,
    now: i64,
) -> Result<u64> {
    let user_shares = basket
        .total_shares_outstanding
        .checked_sub(basket.protocol_fee_shares)
        .ok_or(EscrowError::MathOverflow)?;
    if basket.total_shares_outstanding == 0 || user_shares == 0 {
        basket.last_management_fee_at = now;
        basket.management_fee_accrual_remainder = 0;
        return Ok(0);
    }
    if basket.last_management_fee_at == 0 {
        basket.last_management_fee_at = now;
        basket.management_fee_accrual_remainder = 0;
        return Ok(0);
    }

    let elapsed = now
        .checked_sub(basket.last_management_fee_at)
        .ok_or(EscrowError::MathOverflow)?;
    require!(elapsed >= 0, EscrowError::InvalidSettlementValues);
    if elapsed == 0 {
        return Ok(0);
    }
    let periods = u64::try_from(elapsed / MANAGEMENT_FEE_PERIOD_SECS)
        .map_err(|_| error!(EscrowError::MathOverflow))?;
    require!(
        periods <= MAX_MANAGEMENT_FEE_PERIODS,
        EscrowError::ManagementFeeCatchUpTooLarge
    );

    let mut total_minted = 0u64;
    let mut remaining_seconds = elapsed;
    while remaining_seconds > 0 {
        let interval_seconds = remaining_seconds.min(MANAGEMENT_FEE_PERIOD_SECS);
        let (minted, remainder) = management_fee_shares_for_elapsed(
            basket.total_shares_outstanding,
            interval_seconds,
            basket.management_fee_accrual_remainder,
        )?;
        basket.management_fee_accrual_remainder = remainder;
        basket.total_shares_outstanding = basket
            .total_shares_outstanding
            .checked_add(minted)
            .ok_or(EscrowError::MathOverflow)?;
        basket.protocol_fee_shares = basket
            .protocol_fee_shares
            .checked_add(minted)
            .ok_or(EscrowError::MathOverflow)?;
        total_minted = total_minted
            .checked_add(minted)
            .ok_or(EscrowError::MathOverflow)?;
        remaining_seconds = remaining_seconds
            .checked_sub(interval_seconds)
            .ok_or(EscrowError::MathOverflow)?;
    }
    basket.last_management_fee_at = now;
    basket.updated_at = now;

    emit!(ManagementFeeAccrued {
        basket: basket.key(),
        periods,
        elapsed_seconds: elapsed,
        shares_minted: total_minted,
        protocol_fee_shares: basket.protocol_fee_shares,
        total_shares_outstanding: basket.total_shares_outstanding,
        accrued_through: basket.last_management_fee_at,
    });
    Ok(total_minted)
}

pub fn complete_deposit_handler(
    ctx: Context<CompleteDeposit>,
    args: CompleteDepositArgs,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(!ctx.accounts.config.paused, EscrowError::Paused);
    require!(
        ctx.accounts.basket.status == BasketStatus::Active,
        EscrowError::InvalidBasketStatus
    );
    require!(
        args.user != Pubkey::default() && args.gross_amount > 0 && args.min_shares_out > 0,
        EscrowError::InvalidSettlementValues
    );
    require!(args.intent_expiry >= now, EscrowError::IntentExpired);
    require!(args.quote_hash != [0u8; 32], EscrowError::ZeroHash);
    validate_execution_batch(
        args.execution_version,
        &args.execution_batch_hash,
        args.executed_at,
        now,
    )?;
    require!(
        args.expected_composition_version == ctx.accounts.basket.composition_version,
        EscrowError::CompositionVersionMismatch
    );
    accrue_management_fee_internal(&mut ctx.accounts.basket, now)?;

    initialize_position_if_needed(
        &mut ctx.accounts.position,
        args.user,
        ctx.accounts.basket.key(),
        ctx.bumps.position,
    );
    validate_position_and_nonce(
        &ctx.accounts.position,
        args.user,
        ctx.accounts.basket.key(),
        args.intent_nonce,
    )?;
    let intent_message = deposit_intent_message(ctx.accounts.basket.key(), &args);
    verify_user_intent_signature(&ctx.accounts.ix_sysvar, &args.user, &intent_message)?;
    let intent_hash: [u8; 32] = Sha256::digest(&intent_message).into();

    require!(args.nav_report_hash != [0u8; 32], EscrowError::ZeroHash);
    require!(
        args.settlement_nonce > ctx.accounts.basket.last_settlement_nonce,
        EscrowError::SettlementNonceNotIncreasing
    );
    require!(
        args.share_price > 0 && args.shares_credited > 0,
        EscrowError::InvalidSettlementValues
    );
    let supply_before = ctx.accounts.basket.total_shares_outstanding;
    if !ctx.accounts.basket.has_initialized_share_price {
        require!(supply_before == 0, EscrowError::InvalidSettlementValues);
        require!(
            args.share_price == SHARE_SCALE,
            EscrowError::SharePriceMismatch
        );
    } else {
        require!(supply_before > 0, EscrowError::SharePriceAlreadyInitialized);
        let expected_price = share_price_from_nav(args.basket_nav_value, supply_before)?;
        require!(
            args.share_price == expected_price,
            EscrowError::SharePriceMismatch
        );
    }

    let expected_fee = fee_ceil(args.gross_amount, DEPOSIT_FEE_BPS)?;
    require!(args.protocol_fee == expected_fee, EscrowError::FeeMismatch);
    let expected_net = args
        .gross_amount
        .checked_sub(args.protocol_fee)
        .ok_or(EscrowError::MathOverflow)?;
    let minimum_net = minimum_after_slippage(expected_net, ctx.accounts.config.max_slippage_bps)?;
    require!(
        args.net_deposit_value <= expected_net,
        EscrowError::InvalidSettlementValues
    );
    require!(
        args.net_deposit_value >= minimum_net,
        EscrowError::SlippageExceeded
    );
    let expected_shares = shares_for_value(args.net_deposit_value, args.share_price)?;
    require!(
        args.shares_credited == expected_shares,
        EscrowError::ShareArithmeticMismatch
    );
    require!(
        args.shares_credited >= args.min_shares_out,
        EscrowError::SlippageExceeded
    );

    let new_basket_gross_deposited = ctx
        .accounts
        .basket
        .gross_deposited_value
        .checked_add(args.gross_amount)
        .ok_or(EscrowError::MathOverflow)?;
    let new_user_gross_deposited = ctx
        .accounts
        .position
        .gross_deposited_value
        .checked_add(args.gross_amount)
        .ok_or(EscrowError::MathOverflow)?;

    let basket = &mut ctx.accounts.basket;
    basket.gross_deposited_value = new_basket_gross_deposited;
    basket.total_shares_outstanding = basket
        .total_shares_outstanding
        .checked_add(args.shares_credited)
        .ok_or(EscrowError::MathOverflow)?;
    if !basket.has_initialized_share_price {
        basket.has_initialized_share_price = true;
        basket.last_management_fee_at = now;
    }
    basket.last_settlement_nonce = args.settlement_nonce;
    basket.updated_at = now;

    let position = &mut ctx.accounts.position;
    let weighted_deposit_timestamp = weighted_average_timestamp(
        position.cost_basis_value,
        position.weighted_deposit_timestamp,
        args.net_deposit_value,
        now,
    )?;
    position.gross_deposited_value = new_user_gross_deposited;
    position.shares_owned = position
        .shares_owned
        .checked_add(args.shares_credited)
        .ok_or(EscrowError::MathOverflow)?;
    position.cost_basis_value = position
        .cost_basis_value
        .checked_add(args.net_deposit_value)
        .ok_or(EscrowError::MathOverflow)?;
    position.weighted_deposit_timestamp = weighted_deposit_timestamp;
    position.last_intent_nonce = args.intent_nonce;

    initialize_receipt(
        &mut ctx.accounts.receipt,
        intent_hash,
        args.intent_nonce,
        basket.key(),
        args.user,
        args.user,
        SettlementAction::Deposit,
        args.execution_version,
        &args.execution_batch_hash,
        args.executed_at,
        &args.nav_report_hash,
        args.shares_credited,
        args.share_price,
        args.net_deposit_value,
        args.protocol_fee,
        0,
        0,
        0,
        0,
        0,
        0,
        args.settlement_nonce,
        now,
        ctx.bumps.receipt,
    );

    emit!(DepositSettled {
        intent_hash,
        intent_nonce: args.intent_nonce,
        receipt: ctx.accounts.receipt.key(),
        basket: basket.key(),
        user: args.user,
        execution_batch_hash: args.execution_batch_hash,
        executed_at: args.executed_at,
        net_invested_value: args.net_deposit_value,
        shares_credited: args.shares_credited,
        protocol_fee: args.protocol_fee,
    });
    Ok(())
}

pub fn complete_withdrawal_handler(
    ctx: Context<CompleteWithdrawal>,
    args: CompleteWithdrawalArgs,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(!ctx.accounts.config.paused, EscrowError::Paused);
    require!(
        matches!(
            ctx.accounts.basket.status,
            BasketStatus::Active | BasketStatus::Redeemable
        ),
        EscrowError::InvalidBasketStatus
    );
    require!(
        args.user != Pubkey::default()
            && args.destination != Pubkey::default()
            && args.share_amount > 0,
        EscrowError::InvalidSettlementValues
    );
    require!(args.intent_expiry >= now, EscrowError::IntentExpired);
    require!(args.quote_hash != [0u8; 32], EscrowError::ZeroHash);
    validate_execution_batch(
        args.execution_version,
        &args.execution_batch_hash,
        args.executed_at,
        now,
    )?;
    require!(
        args.expected_composition_version == ctx.accounts.basket.composition_version,
        EscrowError::CompositionVersionMismatch
    );
    if ctx.accounts.basket.status == BasketStatus::Active {
        accrue_management_fee_internal(&mut ctx.accounts.basket, now)?;
    }

    validate_position_and_nonce(
        &ctx.accounts.position,
        args.user,
        ctx.accounts.basket.key(),
        args.intent_nonce,
    )?;
    require!(
        args.share_amount <= ctx.accounts.position.shares_owned,
        EscrowError::InsufficientShares
    );
    let intent_message = withdrawal_intent_message(ctx.accounts.basket.key(), &args);
    verify_user_intent_signature(&ctx.accounts.ix_sysvar, &args.user, &intent_message)?;
    let intent_hash: [u8; 32] = Sha256::digest(&intent_message).into();

    require!(args.nav_report_hash != [0u8; 32], EscrowError::ZeroHash);
    require!(
        args.settlement_nonce > ctx.accounts.basket.last_settlement_nonce,
        EscrowError::SettlementNonceNotIncreasing
    );

    let kind = if ctx.accounts.basket.status == BasketStatus::Redeemable {
        WithdrawalKind::Final
    } else {
        WithdrawalKind::Active
    };
    match kind {
        WithdrawalKind::Active => {
            let expected_price = share_price_from_nav(
                args.basket_nav_value,
                ctx.accounts.basket.total_shares_outstanding,
            )?;
            require!(
                args.share_price == expected_price,
                EscrowError::SharePriceMismatch
            );
            let expected_gross = value_for_shares(args.share_amount, args.share_price)?;
            require!(
                args.gross_realized_value
                    >= minimum_after_slippage(
                        expected_gross,
                        ctx.accounts.config.max_slippage_bps,
                    )?,
                EscrowError::SlippageExceeded
            );
        }
        WithdrawalKind::Final => {
            require!(
                ctx.accounts.basket.status == BasketStatus::Redeemable,
                EscrowError::InvalidBasketStatus
            );
            require!(
                args.basket_nav_value == ctx.accounts.basket.final_nav_value,
                EscrowError::InvalidSettlementValues
            );
            let expected_price = share_price_from_nav(
                ctx.accounts.basket.final_nav_value,
                ctx.accounts.basket.final_share_snapshot,
            )?;
            require!(
                args.share_price == expected_price,
                EscrowError::SharePriceMismatch
            );
            let expected_gross = pro_rata_value(
                ctx.accounts.basket.final_nav_value,
                args.share_amount,
                ctx.accounts.basket.final_share_snapshot,
            )?;
            require!(
                args.gross_realized_value == expected_gross,
                EscrowError::InvalidSettlementValues
            );
        }
    }

    let breakdown = weighted_average_withdrawal_breakdown(
        ctx.accounts.position.cost_basis_value,
        ctx.accounts.position.shares_owned,
        ctx.accounts.position.weighted_deposit_timestamp,
        args.share_amount,
        args.gross_realized_value,
        now,
    )?;
    let expected_creator_fee = fee_floor(
        breakdown.realized_profit,
        ctx.accounts.basket.performance_fee_bps,
    )?;
    require!(
        args.creator_fee == expected_creator_fee,
        EscrowError::CreatorFeeMismatch
    );
    let early_fee = fee_ceil(breakdown.early_exit_value, EARLY_WITHDRAWAL_FEE_BPS)?;
    let mature_fee = fee_ceil(breakdown.mature_exit_value, MATURE_WITHDRAWAL_FEE_BPS)?;
    let expected_protocol_fee = early_fee
        .checked_add(mature_fee)
        .ok_or(EscrowError::MathOverflow)?;
    require!(
        args.protocol_fee == expected_protocol_fee,
        EscrowError::FeeMismatch
    );
    let expected_user_value = args
        .gross_realized_value
        .checked_sub(args.protocol_fee)
        .and_then(|value| value.checked_sub(args.creator_fee))
        .ok_or(EscrowError::MathOverflow)?;
    require!(
        args.user_value_out == expected_user_value,
        EscrowError::InvalidSettlementValues
    );
    require!(
        args.user_value_out >= args.min_value_out,
        EscrowError::SlippageExceeded
    );

    let basket = &mut ctx.accounts.basket;
    basket.total_shares_outstanding = basket
        .total_shares_outstanding
        .checked_sub(args.share_amount)
        .ok_or(EscrowError::MathOverflow)?;
    basket.last_settlement_nonce = args.settlement_nonce;
    if kind == WithdrawalKind::Final {
        basket.final_shares_consumed = basket
            .final_shares_consumed
            .checked_add(args.share_amount)
            .ok_or(EscrowError::MathOverflow)?;
    }
    basket.updated_at = now;

    let position = &mut ctx.accounts.position;
    position.shares_owned = position
        .shares_owned
        .checked_sub(args.share_amount)
        .ok_or(EscrowError::MathOverflow)?;
    position.cost_basis_value = position
        .cost_basis_value
        .checked_sub(breakdown.cost_basis)
        .ok_or(EscrowError::MathOverflow)?;
    if position.shares_owned == 0 {
        position.weighted_deposit_timestamp = 0;
    }
    position.last_intent_nonce = args.intent_nonce;

    initialize_receipt(
        &mut ctx.accounts.receipt,
        intent_hash,
        args.intent_nonce,
        basket.key(),
        args.user,
        args.destination,
        SettlementAction::UserWithdrawal,
        args.execution_version,
        &args.execution_batch_hash,
        args.executed_at,
        &args.nav_report_hash,
        args.share_amount,
        args.share_price,
        args.gross_realized_value,
        args.protocol_fee,
        args.creator_fee,
        breakdown.cost_basis,
        breakdown.realized_profit,
        breakdown.early_exit_value,
        breakdown.mature_exit_value,
        args.user_value_out,
        args.settlement_nonce,
        now,
        ctx.bumps.receipt,
    );

    if basket.total_shares_outstanding == 0 {
        basket.status = BasketStatus::Closed;
    }
    emit!(WithdrawalSettled {
        intent_hash,
        intent_nonce: args.intent_nonce,
        receipt: ctx.accounts.receipt.key(),
        basket: basket.key(),
        user: args.user,
        destination: args.destination,
        execution_batch_hash: args.execution_batch_hash,
        executed_at: args.executed_at,
        shares_decremented: args.share_amount,
        user_value_out: args.user_value_out,
        protocol_fee: args.protocol_fee,
        creator_fee: args.creator_fee,
        withdrawn_cost_basis: breakdown.cost_basis,
        realized_profit: breakdown.realized_profit,
        early_exit_value: breakdown.early_exit_value,
        mature_exit_value: breakdown.mature_exit_value,
        kind,
    });
    Ok(())
}

pub fn complete_protocol_fee_withdrawal_handler(
    ctx: Context<CompleteProtocolFeeWithdrawal>,
    args: CompleteProtocolFeeWithdrawalArgs,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(!ctx.accounts.config.paused, EscrowError::Paused);
    require!(args.share_amount > 0, EscrowError::ZeroAmount);
    require!(args.nav_report_hash != [0u8; 32], EscrowError::ZeroHash);
    validate_execution_batch(
        args.execution_version,
        &args.execution_batch_hash,
        args.executed_at,
        now,
    )?;
    require!(
        args.settlement_nonce > ctx.accounts.basket.last_settlement_nonce,
        EscrowError::SettlementNonceNotIncreasing
    );
    if ctx.accounts.basket.status != BasketStatus::Redeemable {
        require!(
            matches!(
                ctx.accounts.basket.status,
                BasketStatus::Active | BasketStatus::Reconstituting | BasketStatus::Resolving
            ),
            EscrowError::InvalidBasketStatus
        );
        accrue_management_fee_internal(&mut ctx.accounts.basket, now)?;
    }
    require!(
        args.share_amount <= ctx.accounts.basket.protocol_fee_shares,
        EscrowError::InsufficientProtocolFeeShares
    );

    match ctx.accounts.basket.status {
        BasketStatus::Redeemable => {
            require!(
                args.basket_nav_value == ctx.accounts.basket.final_nav_value,
                EscrowError::InvalidSettlementValues
            );
            let expected_price = share_price_from_nav(
                ctx.accounts.basket.final_nav_value,
                ctx.accounts.basket.final_share_snapshot,
            )?;
            require!(
                args.share_price == expected_price,
                EscrowError::SharePriceMismatch
            );
            let expected_gross = pro_rata_value(
                ctx.accounts.basket.final_nav_value,
                args.share_amount,
                ctx.accounts.basket.final_share_snapshot,
            )?;
            require!(
                args.gross_realized_value == expected_gross,
                EscrowError::InvalidSettlementValues
            );
        }
        _ => {
            let expected_price = share_price_from_nav(
                args.basket_nav_value,
                ctx.accounts.basket.total_shares_outstanding,
            )?;
            require!(
                args.share_price == expected_price,
                EscrowError::SharePriceMismatch
            );
            let expected_gross = value_for_shares(args.share_amount, args.share_price)?;
            require!(
                args.gross_realized_value
                    >= minimum_after_slippage(
                        expected_gross,
                        ctx.accounts.config.max_slippage_bps,
                    )?,
                EscrowError::SlippageExceeded
            );
        }
    }

    let basket = &mut ctx.accounts.basket;
    basket.protocol_fee_shares = basket
        .protocol_fee_shares
        .checked_sub(args.share_amount)
        .ok_or(EscrowError::MathOverflow)?;
    basket.total_shares_outstanding = basket
        .total_shares_outstanding
        .checked_sub(args.share_amount)
        .ok_or(EscrowError::MathOverflow)?;
    if basket.status == BasketStatus::Redeemable {
        basket.final_shares_consumed = basket
            .final_shares_consumed
            .checked_add(args.share_amount)
            .ok_or(EscrowError::MathOverflow)?;
    }
    basket.last_settlement_nonce = args.settlement_nonce;
    basket.updated_at = now;

    initialize_receipt(
        &mut ctx.accounts.receipt,
        [0u8; 32],
        0,
        basket.key(),
        basket.protocol_fee_destination,
        basket.protocol_fee_destination,
        SettlementAction::ProtocolFeeWithdrawal,
        args.execution_version,
        &args.execution_batch_hash,
        args.executed_at,
        &args.nav_report_hash,
        args.share_amount,
        args.share_price,
        args.gross_realized_value,
        0,
        0,
        0,
        0,
        0,
        0,
        args.gross_realized_value,
        args.settlement_nonce,
        now,
        ctx.bumps.receipt,
    );
    if basket.total_shares_outstanding == 0 {
        basket.status = BasketStatus::Closed;
    }
    emit!(ProtocolFeeSharesWithdrawn {
        receipt: ctx.accounts.receipt.key(),
        basket: basket.key(),
        destination: basket.protocol_fee_destination,
        execution_batch_hash: args.execution_batch_hash,
        executed_at: args.executed_at,
        shares_redeemed: args.share_amount,
        gross_value: args.gross_realized_value,
    });
    Ok(())
}

pub fn begin_reconstitution_handler(ctx: Context<BackendBasketAction>) -> Result<()> {
    require!(
        ctx.accounts.basket.is_perpetual,
        EscrowError::BasketNotPerpetual
    );
    require!(
        ctx.accounts.basket.status == BasketStatus::Active,
        EscrowError::InvalidBasketStatus
    );
    let now = Clock::get()?.unix_timestamp;
    accrue_management_fee_internal(&mut ctx.accounts.basket, now)?;
    let next_reconstitution = ctx
        .accounts
        .basket
        .last_reconstitution_at
        .checked_add(ctx.accounts.basket.reconstitution_cadence_secs)
        .ok_or(EscrowError::MathOverflow)?;
    require!(now >= next_reconstitution, EscrowError::InvalidBasketStatus);
    let basket = &mut ctx.accounts.basket;
    basket.status = BasketStatus::Reconstituting;
    basket.updated_at = now;
    emit!(BasketStatusUpdated {
        basket: basket.key(),
        status: basket.status,
    });
    Ok(())
}

pub fn complete_reconstitution_handler(
    ctx: Context<CompleteReconstitution>,
    args: ReconstitutionArgs,
) -> Result<()> {
    require!(
        ctx.accounts.basket.status == BasketStatus::Reconstituting,
        EscrowError::InvalidBasketStatus
    );
    let now = Clock::get()?.unix_timestamp;
    accrue_management_fee_internal(&mut ctx.accounts.basket, now)?;
    require!(args.composition_hash != [0u8; 32], EscrowError::ZeroHash);
    require!(
        ctx.accounts.eligibility_list.list_hash == args.eligibility_hash
            && ctx.accounts.eligibility_list.nonce == args.eligibility_nonce
            && ctx.accounts.eligibility_list.published_at <= now
            && ctx.accounts.eligibility_list.expires_at > now,
        EscrowError::InvalidEligibilityList
    );
    require!(
        ctx.accounts.composition_draft.composition_hash == args.composition_hash
            && ctx.accounts.composition_draft.eligibility_hash == args.eligibility_hash
            && ctx.accounts.composition_draft.eligibility_nonce == args.eligibility_nonce
            && ctx.accounts.composition_draft.composition_nonce == args.composition_nonce,
        EscrowError::CompositionHashMismatch
    );
    validate_basket_items(
        &ctx.accounts.composition_draft.items,
        &ctx.accounts.eligibility_list,
        ctx.remaining_accounts,
    )?;
    require!(
        args.composition_expiry > now,
        EscrowError::CompositionAuthorizationExpired
    );
    require!(
        args.composition_nonce > ctx.accounts.basket.last_composition_nonce,
        EscrowError::CompositionNonceNotIncreasing
    );
    let composition = canonical_composition_bytes(&ctx.accounts.composition_draft.items)?;
    require!(
        Sha256::digest(&composition).as_slice() == args.composition_hash,
        EscrowError::CompositionHashMismatch
    );
    let next_version = ctx
        .accounts
        .basket
        .composition_version
        .checked_add(1)
        .ok_or(EscrowError::MathOverflow)?;
    let mut message = Vec::new();
    message.extend_from_slice(RECONSTITUTION_DOMAIN);
    message.extend_from_slice(crate::ID.as_ref());
    message.extend_from_slice(&ctx.accounts.basket.basket_id);
    message.extend_from_slice(&next_version.to_le_bytes());
    message.extend_from_slice(&args.eligibility_hash);
    message.extend_from_slice(&args.eligibility_nonce.to_le_bytes());
    message.extend_from_slice(&args.composition_nonce.to_le_bytes());
    message.extend_from_slice(&args.composition_expiry.to_le_bytes());
    verify_composer_signature(
        &ctx.accounts.ix_sysvar,
        &ctx.accounts.config.composer_signer,
        &message,
    )?;

    let basket = &mut ctx.accounts.basket;
    basket.composition_hash = args.composition_hash;
    basket.composition_version = next_version;
    basket.last_composition_nonce = args.composition_nonce;
    basket.items = ctx.accounts.composition_draft.items.clone();
    basket.status = BasketStatus::Active;
    basket.last_reconstitution_at = now;
    basket.updated_at = now;
    emit!(BasketReconstituted {
        basket: basket.key(),
        composition_hash: basket.composition_hash,
        composition_version: basket.composition_version,
    });
    Ok(())
}

pub fn begin_resolution_handler(ctx: Context<BackendBasketAction>) -> Result<()> {
    require!(
        !ctx.accounts.basket.is_perpetual,
        EscrowError::InvalidBasketStatus
    );
    require!(
        ctx.accounts.basket.status == BasketStatus::Active,
        EscrowError::InvalidBasketStatus
    );
    let now = Clock::get()?.unix_timestamp;
    accrue_management_fee_internal(&mut ctx.accounts.basket, now)?;
    let basket = &mut ctx.accounts.basket;
    basket.status = BasketStatus::Resolving;
    basket.updated_at = now;
    emit!(BasketStatusUpdated {
        basket: basket.key(),
        status: basket.status,
    });
    Ok(())
}

pub fn record_final_settlement_handler(
    ctx: Context<BackendBasketAction>,
    args: FinalSettlementArgs,
) -> Result<()> {
    require!(
        ctx.accounts.basket.status == BasketStatus::Resolving,
        EscrowError::InvalidBasketStatus
    );
    let now = Clock::get()?.unix_timestamp;
    accrue_management_fee_internal(&mut ctx.accounts.basket, now)?;
    require!(args.final_report_hash != [0u8; 32], EscrowError::ZeroHash);
    require!(
        args.final_share_snapshot == ctx.accounts.basket.total_shares_outstanding,
        EscrowError::FinalSnapshotMismatch
    );
    if args.final_share_snapshot == 0 {
        require!(
            args.final_nav_value == 0,
            EscrowError::InvalidSettlementValues
        );
    }

    let basket = &mut ctx.accounts.basket;
    basket.final_report_hash = args.final_report_hash;
    basket.final_nav_value = args.final_nav_value;
    basket.final_share_snapshot = args.final_share_snapshot;
    basket.final_shares_consumed = 0;
    basket.status = if args.final_share_snapshot == 0 {
        BasketStatus::Closed
    } else {
        BasketStatus::Redeemable
    };
    basket.updated_at = now;
    emit!(FinalSettlementRecorded {
        basket: basket.key(),
        final_report_hash: basket.final_report_hash,
        final_nav_value: basket.final_nav_value,
        final_share_snapshot: basket.final_share_snapshot,
    });
    Ok(())
}

fn weighted_average_withdrawal_breakdown(
    cost_basis_value: u64,
    shares_owned: u64,
    weighted_deposit_timestamp: i64,
    shares_to_consume: u64,
    gross_value: u64,
    now: i64,
) -> Result<WithdrawalBreakdown> {
    require!(
        weighted_deposit_timestamp > 0 && weighted_deposit_timestamp <= now,
        EscrowError::InvalidSettlementValues
    );
    let cost_basis = cost_basis_for_shares(cost_basis_value, shares_to_consume, shares_owned)?;
    let age = now
        .checked_sub(weighted_deposit_timestamp)
        .ok_or(EscrowError::MathOverflow)?;
    let mut breakdown = WithdrawalBreakdown {
        cost_basis,
        realized_profit: gross_value.saturating_sub(cost_basis),
        ..WithdrawalBreakdown::default()
    };
    if age >= MATURE_HOLDING_PERIOD_SECS {
        breakdown.mature_exit_value = gross_value;
    } else {
        breakdown.early_exit_value = gross_value;
    }
    Ok(breakdown)
}

fn weighted_average_timestamp(
    existing_cost_basis: u64,
    existing_timestamp: i64,
    added_cost_basis: u64,
    now: i64,
) -> Result<i64> {
    require!(
        added_cost_basis > 0 && now > 0,
        EscrowError::InvalidSettlementValues
    );
    if existing_cost_basis == 0 {
        return Ok(now);
    }
    require!(
        existing_timestamp > 0 && existing_timestamp <= now,
        EscrowError::InvalidSettlementValues
    );
    let total_cost_basis = existing_cost_basis
        .checked_add(added_cost_basis)
        .ok_or(EscrowError::MathOverflow)?;
    let weighted = (u128::try_from(existing_timestamp).map_err(|_| EscrowError::MathOverflow)?)
        .checked_mul(existing_cost_basis as u128)
        .and_then(|value| {
            value.checked_add(
                u128::try_from(now)
                    .ok()?
                    .checked_mul(added_cost_basis as u128)?,
            )
        })
        .and_then(|value| value.checked_div(total_cost_basis as u128))
        .ok_or(EscrowError::MathOverflow)?;
    i64::try_from(weighted).map_err(|_| error!(EscrowError::MathOverflow))
}

fn initialize_position_if_needed(
    position: &mut Account<Position>,
    user: Pubkey,
    basket: Pubkey,
    bump: u8,
) {
    if position.owner == Pubkey::default() {
        position.owner = user;
        position.basket = basket;
        position.shares_owned = 0;
        position.cost_basis_value = 0;
        position.gross_deposited_value = 0;
        position.last_intent_nonce = 0;
        position.weighted_deposit_timestamp = 0;
        position.reserved = [0u8; POSITION_RESERVED_BYTES];
        position.bump = bump;
    }
}

fn validate_position_and_nonce(
    position: &Account<Position>,
    user: Pubkey,
    basket: Pubkey,
    intent_nonce: u64,
) -> Result<()> {
    require!(
        position.owner == user && position.basket == basket,
        EscrowError::PositionMismatch
    );
    let expected_nonce = position
        .last_intent_nonce
        .checked_add(1)
        .ok_or(EscrowError::MathOverflow)?;
    require!(
        intent_nonce == expected_nonce,
        EscrowError::IntentNonceMismatch
    );
    Ok(())
}

fn deposit_intent_message(basket: Pubkey, args: &CompleteDepositArgs) -> Vec<u8> {
    let mut message = Vec::new();
    message.extend_from_slice(DEPOSIT_INTENT_DOMAIN);
    message.extend_from_slice(crate::ID.as_ref());
    message.extend_from_slice(basket.as_ref());
    message.extend_from_slice(args.user.as_ref());
    message.extend_from_slice(&args.intent_nonce.to_le_bytes());
    message.extend_from_slice(&args.intent_expiry.to_le_bytes());
    message.extend_from_slice(&args.expected_composition_version.to_le_bytes());
    message.extend_from_slice(&args.gross_amount.to_le_bytes());
    message.extend_from_slice(&args.min_shares_out.to_le_bytes());
    message.extend_from_slice(&args.quote_hash);
    message
}

fn withdrawal_intent_message(basket: Pubkey, args: &CompleteWithdrawalArgs) -> Vec<u8> {
    let mut message = Vec::new();
    message.extend_from_slice(WITHDRAWAL_INTENT_DOMAIN);
    message.extend_from_slice(crate::ID.as_ref());
    message.extend_from_slice(basket.as_ref());
    message.extend_from_slice(args.user.as_ref());
    message.extend_from_slice(&args.intent_nonce.to_le_bytes());
    message.extend_from_slice(&args.intent_expiry.to_le_bytes());
    message.extend_from_slice(&args.expected_composition_version.to_le_bytes());
    message.extend_from_slice(&args.share_amount.to_le_bytes());
    message.extend_from_slice(&args.min_value_out.to_le_bytes());
    message.extend_from_slice(args.destination.as_ref());
    message.extend_from_slice(&args.quote_hash);
    message
}

fn verify_user_intent_signature(
    ix_sysvar: &AccountInfo,
    user: &Pubkey,
    expected_message: &[u8],
) -> Result<()> {
    let current_index = load_current_index_checked(ix_sysvar)? as usize;
    require!(current_index >= 1, EscrowError::MissingIntentSignature);
    let ed_ix = load_instruction_at_checked(current_index - 1, ix_sysvar)?;
    require!(
        ed_ix.program_id == ED25519_ID,
        EscrowError::MissingIntentSignature
    );

    let data = &ed_ix.data;
    require!(
        data.len() >= 16 && data[0] == 1 && data[1] == 0,
        EscrowError::MalformedIntentSignature
    );
    let read_u16 = |offset: usize| -> Result<u16> {
        let bytes = data
            .get(offset..offset + 2)
            .ok_or(EscrowError::MalformedIntentSignature)?;
        Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
    };
    require!(
        read_u16(4)? == u16::MAX && read_u16(8)? == u16::MAX && read_u16(14)? == u16::MAX,
        EscrowError::MalformedIntentSignature
    );
    let pubkey_offset = read_u16(6)? as usize;
    let message_offset = read_u16(10)? as usize;
    let message_size = read_u16(12)? as usize;
    let pubkey_bytes = data
        .get(pubkey_offset..pubkey_offset + 32)
        .ok_or(EscrowError::MalformedIntentSignature)?;
    require!(
        pubkey_bytes == user.as_ref(),
        EscrowError::UnauthorizedIntentSigner
    );
    let message = data
        .get(message_offset..message_offset + message_size)
        .ok_or(EscrowError::MalformedIntentSignature)?;
    require!(
        message == expected_message,
        EscrowError::IntentSignatureMismatch
    );
    Ok(())
}

fn validate_execution_batch(
    version: u8,
    batch_hash: &[u8; 32],
    executed_at: i64,
    now: i64,
) -> Result<()> {
    require!(
        version == EXECUTION_BATCH_VERSION,
        EscrowError::InvalidExecutionVersion
    );
    require!(*batch_hash != [0u8; 32], EscrowError::ZeroHash);
    require!(
        executed_at > 0 && executed_at <= now,
        EscrowError::InvalidExecutionTimestamp
    );
    Ok(())
}

fn pro_rata_value(total_value: u64, shares: u64, total_shares: u64) -> Result<u64> {
    require!(total_shares > 0, EscrowError::FinalSnapshotMismatch);
    let value = (total_value as u128)
        .checked_mul(shares as u128)
        .and_then(|amount| amount.checked_div(total_shares as u128))
        .ok_or(EscrowError::MathOverflow)?;
    u64::try_from(value).map_err(|_| error!(EscrowError::MathOverflow))
}

#[allow(clippy::too_many_arguments)]
fn initialize_receipt(
    receipt: &mut Account<SettlementReceipt>,
    intent_hash: [u8; 32],
    intent_nonce: u64,
    basket: Pubkey,
    user: Pubkey,
    destination: Pubkey,
    action: SettlementAction,
    execution_version: u8,
    execution_batch_hash: &[u8; 32],
    executed_at: i64,
    nav_report_hash: &[u8; 32],
    share_delta: u64,
    share_price: u64,
    gross_value: u64,
    protocol_fee: u64,
    creator_fee: u64,
    withdrawn_cost_basis: u64,
    realized_profit: u64,
    early_exit_value: u64,
    mature_exit_value: u64,
    user_value_out: u64,
    settlement_nonce: u64,
    settled_at: i64,
    bump: u8,
) {
    receipt.intent_hash = intent_hash;
    receipt.intent_nonce = intent_nonce;
    receipt.basket = basket;
    receipt.user = user;
    receipt.destination = destination;
    receipt.action = action;
    receipt.execution_version = execution_version;
    receipt.execution_batch_hash = *execution_batch_hash;
    receipt.executed_at = executed_at;
    receipt.nav_report_hash = *nav_report_hash;
    receipt.share_delta = share_delta;
    receipt.share_price = share_price;
    receipt.gross_value = gross_value;
    receipt.protocol_fee = protocol_fee;
    receipt.creator_fee = creator_fee;
    receipt.withdrawn_cost_basis = withdrawn_cost_basis;
    receipt.realized_profit = realized_profit;
    receipt.early_exit_value = early_exit_value;
    receipt.mature_exit_value = mature_exit_value;
    receipt.user_value_out = user_value_out;
    receipt.settlement_nonce = settlement_nonce;
    receipt.settled_at = settled_at;
    receipt.bump = bump;
}
