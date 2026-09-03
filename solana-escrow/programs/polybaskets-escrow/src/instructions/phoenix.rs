//! Phoenix perpetual settlement.
//!
//! Three instructions, all of which **record** rather than execute. Phoenix
//! trading happens off chain through the Rise SDK; this program never CPIs into
//! Phoenix and holds no Phoenix account.
//!
//! Every figure arrives as an argument that the backend read back from real
//! post-execution Phoenix state. Nothing here is computed: no NAV, no fees, no
//! PnL, no concentration checks. The handlers validate, record, and copy two
//! already-verified numbers onto the composition item they belong to.
//!
//! Why recording rather than executing: Phoenix's own program owns the position
//! and the collateral. Re-deriving either on chain would mean a second
//! implementation of Phoenix's margin engine, which would eventually disagree
//! with the first.

use anchor_lang::prelude::*;

use crate::constants::{
    MAX_MARKET_ID_LEN, MAX_PERP_ATTESTATION_AGE_SECS, MAX_PERP_CLOCK_SKEW_SECS,
    MAX_PERP_LEVERAGE_BPS, MAX_PERP_SETTLEMENT_AGE_SECS, MIN_PERP_LEVERAGE_BPS,
    PHOENIX_CROSS_SUBACCOUNT_INDEX, PHOENIX_USER_PDA_INDEX,
};
use crate::errors::EscrowError;
use crate::events::{PerpEventAttested, PhoenixTradeSettled, PhoenixTraderOnboarded};
use crate::state::{
    AttestPerpEventArgs, Basket, BasketStatus, CompletePhoenixTradeArgs, Config,
    OnboardTraderAccountArgs, PerpEligibilityList, PerpEventAttestation, PerpSettlementReceipt,
    PerpTradeSide, PositionKind, TraderAccountRegistry,
};

/// Rejects a timestamp that is too old, or further in the future than clock skew
/// allows. Both directions matter: a stale figure describes a position that has
/// since moved, and a future one cannot have been observed yet.
fn assert_within_window(
    timestamp: i64,
    now: i64,
    max_age: i64,
    stale_error: EscrowError,
) -> Result<()> {
    require!(
        timestamp <= now.saturating_add(MAX_PERP_CLOCK_SKEW_SECS),
        EscrowError::TimestampInFuture
    );
    // `require!` cannot take a runtime error value, only a literal path.
    if timestamp < now.saturating_sub(max_age) {
        return Err(stale_error.into());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// onboard_trader_account
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(args: OnboardTraderAccountArgs)]
pub struct OnboardTraderAccount<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = backend_signer,
    )]
    pub config: Account<'info, Config>,
    /// `init`, never `init_if_needed`: onboarding the same wallet twice fails in
    /// the runtime, which is the guarantee this account exists to provide.
    #[account(
        init,
        payer = backend_signer,
        seeds = [b"perp_trader", args.execution_wallet.as_ref()],
        bump,
        space = 8 + TraderAccountRegistry::INIT_SPACE,
    )]
    pub registry: Account<'info, TraderAccountRegistry>,
    #[account(mut)]
    pub backend_signer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn onboard_trader_account_handler(
    ctx: Context<OnboardTraderAccount>,
    args: OnboardTraderAccountArgs,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, EscrowError::Paused);
    require!(
        args.execution_wallet != Pubkey::default() && args.phoenix_trader_pda != Pubkey::default(),
        EscrowError::ZeroAuthority
    );
    // Phoenix only activates `pda_index = 0` for user portfolios while exchange
    // gating is enabled. Accepting another index would record an onboarding that
    // does not correspond to a usable Phoenix account.
    require!(
        args.phoenix_pda_index == PHOENIX_USER_PDA_INDEX,
        EscrowError::UnsupportedTraderPdaIndex
    );

    let now = Clock::get()?.unix_timestamp;
    assert_within_window(
        args.onboarded_at,
        now,
        MAX_PERP_ATTESTATION_AGE_SECS,
        EscrowError::StalePerpAttestation,
    )?;

    let registry = &mut ctx.accounts.registry;
    registry.execution_wallet = args.execution_wallet;
    registry.phoenix_trader_pda = args.phoenix_trader_pda;
    registry.phoenix_pda_index = args.phoenix_pda_index;
    registry.onboarded_at = args.onboarded_at;
    registry.onboarding_signature = args.onboarding_signature;
    registry.bump = ctx.bumps.registry;

    emit!(PhoenixTraderOnboarded {
        registry: registry.key(),
        execution_wallet: registry.execution_wallet,
        phoenix_trader_pda: registry.phoenix_trader_pda,
        onboarded_at: registry.onboarded_at,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// complete_phoenix_trade
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(args: CompletePhoenixTradeArgs)]
pub struct CompletePhoenixTrade<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = backend_signer,
    )]
    pub config: Account<'info, Config>,
    /// Mutable, but only one item's fields move.
    ///
    /// `Basket.items` is the live composition. A settlement finds the one `Perp`
    /// item for its market and updates that item in place; `composition_hash`,
    /// `composition_version` and every other item are left exactly as they were,
    /// because a fill is not a composition change.
    ///
    /// Boxed: `Account<'info, T>` holds its deserialized `T` in the instruction's
    /// stack frame, and a 16-item composition does not fit in 4096 bytes
    /// alongside the rest of this context.
    #[account(
        mut,
        seeds = [b"basket", basket.basket_id.as_ref()],
        bump = basket.bump,
        constraint = basket.basket_id == args.basket_id @ EscrowError::MismatchedBasket,
    )]
    pub basket: Box<Account<'info, Basket>>,
    #[account(
        seeds = [
            b"perp_eligibility",
            perp_eligibility_list.list_hash.as_ref(),
            perp_eligibility_list.nonce.to_le_bytes().as_ref(),
        ],
        bump = perp_eligibility_list.bump,
        constraint = perp_eligibility_list.composer == config.composer_signer
            @ EscrowError::UnauthorizedCompositionSigner,
    )]
    pub perp_eligibility_list: Box<Account<'info, PerpEligibilityList>>,
    /// Proves the execution wallet was onboarded to Phoenix exactly once.
    #[account(
        seeds = [b"perp_trader", args.execution_wallet.as_ref()],
        bump = trader_registry.bump,
        constraint = trader_registry.execution_wallet == args.execution_wallet
            @ EscrowError::TraderRegistryMismatch,
    )]
    pub trader_registry: Account<'info, TraderAccountRegistry>,
    /// `init`, never `init_if_needed`: a second attempt to record the same
    /// execution fails in the runtime.
    #[account(
        init,
        payer = backend_signer,
        seeds = [b"perp_receipt", args.execution_hash.as_ref()],
        bump,
        space = 8 + PerpSettlementReceipt::INIT_SPACE,
    )]
    pub receipt: Account<'info, PerpSettlementReceipt>,
    #[account(mut)]
    pub backend_signer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Records an already-executed, vault-delta-verified Phoenix trade.
///
/// Signed by `backend_signer` alone. The Composer already approved this position
/// when they signed the composition that put the `Perp` item into the basket; a
/// fill landing is a state update on something already authorized, the same
/// bucket as `complete_deposit`. Requiring a Composer co-signature on every
/// margin change would not be workable.
pub fn complete_phoenix_trade_handler(
    ctx: Context<CompletePhoenixTrade>,
    args: CompletePhoenixTradeArgs,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, EscrowError::Paused);

    // --- isolated margin only ---------------------------------------------
    require!(
        args.phoenix_subaccount != PHOENIX_CROSS_SUBACCOUNT_INDEX,
        EscrowError::SubaccountZeroNotAllowed
    );

    // --- attested value bounds --------------------------------------------
    require!(
        !args.market_id.is_empty() && args.market_id.len() <= MAX_MARKET_ID_LEN,
        EscrowError::MarketIdTooLong
    );
    require!(
        args.leverage_bps >= MIN_PERP_LEVERAGE_BPS && args.leverage_bps <= MAX_PERP_LEVERAGE_BPS,
        EscrowError::PerpLeverageOutOfBounds
    );
    // An open must leave a priced, collateralized position behind. A close need
    // not: flattening a position leaves nothing to price and sweeps the isolated
    // collateral back to the parent, so both figures legitimately read zero.
    // Requiring them unconditionally would make a full close impossible to settle.
    if args.side == PerpTradeSide::Open {
        require!(args.entry_mark_price > 0, EscrowError::ZeroEntryMarkPrice);
        require!(
            args.actual_margin_posted_units > 0,
            EscrowError::ZeroMarginPosted
        );
    }

    let now = Clock::get()?.unix_timestamp;
    let basket_key = ctx.accounts.basket.key();
    let basket = &mut ctx.accounts.basket;

    // A fill may only land on a live basket. A basket mid-reconstitution is about
    // to have `items` replaced, and one resolving or closed has had its final NAV
    // snapshotted — a settlement after that would move a figure the final report
    // already accounted for.
    require!(
        basket.status == BasketStatus::Active,
        EscrowError::InvalidBasketStatus
    );

    // Bound to the live composition, the same way `complete_deposit` binds. A
    // reconstitution landing between execution and settlement bumps the version
    // and fails this check, which is intended: the item this fill belongs to may
    // have been re-weighted or removed outright.
    require!(
        basket.composition_version == args.expected_composition_version,
        EscrowError::CompositionVersionMismatch
    );
    require!(
        basket.composition_hash == args.expected_composition_hash,
        EscrowError::CompositionHashMismatch
    );
    require!(
        args.settlement_nonce > basket.last_settlement_nonce,
        EscrowError::SettlementNonceNotIncreasing
    );

    let eligibility = &ctx.accounts.perp_eligibility_list;
    require!(
        eligibility.expires_at > now,
        EscrowError::InvalidPerpEligibilityList
    );
    require!(
        eligibility.contains(&args.market_id),
        EscrowError::MarketNotEligible
    );

    assert_within_window(
        args.executed_at,
        now,
        MAX_PERP_SETTLEMENT_AGE_SECS,
        EscrowError::StalePerpExecution,
    )?;

    // --- update the one item this fill belongs to --------------------------
    let index = basket
        .items
        .iter()
        .position(|item| item.market_id == args.market_id)
        .ok_or(EscrowError::MarketNotInComposition)?;

    match &mut basket.items[index].kind {
        PositionKind::Perp {
            entry_mark_price,
            margin_posted,
            phoenix_subaccount,
            ..
        } => {
            // The composition item must name the same isolated subaccount the
            // trade actually used, or this fill belongs to a different position.
            require!(
                *phoenix_subaccount == args.phoenix_subaccount,
                EscrowError::SubaccountMismatch
            );

            // Both figures are post-execution reads, not quotes. `margin_posted`
            // is written on either side — after a close it is the residual
            // collateral, which is the true posted amount.
            *margin_posted = args.actual_margin_posted_units;

            // A zero entry price means the position is gone, not that it is worth
            // nothing. Overwriting the last real entry price with zero would
            // destroy the only record of where the position was opened, so the
            // previous value stands until a new position replaces it.
            if args.entry_mark_price > 0 {
                *entry_mark_price = args.entry_mark_price;
            }
        }
        // `validate_basket_items` rejects a mixed basket at creation and at every
        // reconstitution, so a non-perp item at a perp market cannot exist. The
        // compiler cannot know that, and an unchecked branch would silently no-op.
        _ => return Err(EscrowError::MixedAssetClassBasket.into()),
    }

    // `direction` and `leverage_bps` are deliberately not written. They are terms
    // of the position the Composer approved, not outcomes of a fill; a fill that
    // appeared to change them would mean the backend traded something other than
    // what the composition specifies, and that should surface as a mismatch
    // rather than be absorbed into the basket.

    basket.last_settlement_nonce = args.settlement_nonce;
    basket.updated_at = now;

    let receipt = &mut ctx.accounts.receipt;
    receipt.execution_hash = args.execution_hash;
    receipt.request_hash = args.request_hash;
    receipt.idempotency_key = args.idempotency_key;
    receipt.basket = basket_key;
    receipt.execution_wallet = args.execution_wallet;
    receipt.market_id = args.market_id.clone();
    receipt.side = args.side;
    receipt.direction = args.direction;
    receipt.fill_status = args.fill_status;
    receipt.phoenix_subaccount = args.phoenix_subaccount;
    receipt.leverage_bps = args.leverage_bps;
    receipt.requested_collateral_units = args.requested_collateral_units;
    receipt.actual_margin_posted_units = args.actual_margin_posted_units;
    receipt.entry_mark_price = args.entry_mark_price;
    receipt.settlement_nonce = args.settlement_nonce;
    receipt.executed_at = args.executed_at;
    receipt.executed_slot = args.executed_slot;
    receipt.recorded_at = now;
    receipt.recorded_slot = Clock::get()?.slot;
    receipt.transaction_signature = args.transaction_signature;
    receipt.bump = ctx.bumps.receipt;

    emit!(PhoenixTradeSettled {
        receipt: receipt.key(),
        basket: basket_key,
        execution_hash: receipt.execution_hash,
        market_id: args.market_id,
        phoenix_subaccount: receipt.phoenix_subaccount,
        actual_margin_posted_units: receipt.actual_margin_posted_units,
        entry_mark_price: receipt.entry_mark_price,
        settlement_nonce: receipt.settlement_nonce,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// attest_perp_event
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(args: AttestPerpEventArgs)]
pub struct AttestPerpEvent<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = backend_signer,
    )]
    pub config: Account<'info, Config>,
    /// Read-only. An autonomous event changes Phoenix's view of the position, but
    /// this program has no verified post-event margin or entry price to write —
    /// those come from a vault-delta read, which only the settlement path performs.
    #[account(
        seeds = [b"basket", basket.basket_id.as_ref()],
        bump = basket.bump,
        constraint = basket.basket_id == args.basket_id @ EscrowError::MismatchedBasket,
    )]
    pub basket: Box<Account<'info, Basket>>,
    /// `init`, never `init_if_needed`: the same event observed twice — over both
    /// the trader-state stream and the notification stream, for instance —
    /// records once.
    #[account(
        init,
        payer = backend_signer,
        seeds = [b"perp_event", args.event_hash.as_ref()],
        bump,
        space = 8 + PerpEventAttestation::INIT_SPACE,
    )]
    pub attestation: Account<'info, PerpEventAttestation>,
    #[account(mut)]
    pub backend_signer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Records an autonomous Phoenix action against a basket position.
///
/// **Callable unprompted.** Phoenix auto-deleverages profitable counterparties
/// and cancels risk-increasing resting orders without being asked. Consequences,
/// all deliberate:
///
/// * No matching receipt. An ADL can land with no related trade at all.
/// * No composition or eligibility check. The event can arrive after a
///   reconstitution has already moved the market out of the basket; it still
///   happened and must still be recorded.
/// * No `paused` gate. Pausing stops AlphaBasket from acting; it does not stop
///   Phoenix. Dropping events while paused would lose exactly the records needed
///   to understand why the pause mattered.
pub fn attest_perp_event_handler(
    ctx: Context<AttestPerpEvent>,
    args: AttestPerpEventArgs,
) -> Result<()> {
    require!(
        args.phoenix_subaccount != PHOENIX_CROSS_SUBACCOUNT_INDEX,
        EscrowError::SubaccountZeroNotAllowed
    );
    require!(
        !args.market_id.is_empty() && args.market_id.len() <= MAX_MARKET_ID_LEN,
        EscrowError::MarketIdTooLong
    );

    let now = Clock::get()?.unix_timestamp;
    assert_within_window(
        args.observed_at,
        now,
        MAX_PERP_ATTESTATION_AGE_SECS,
        EscrowError::StalePerpAttestation,
    )?;

    let attestation = &mut ctx.accounts.attestation;
    attestation.event_hash = args.event_hash;
    attestation.basket = ctx.accounts.basket.key();
    attestation.event_kind = args.event_kind;
    attestation.market_id = args.market_id.clone();
    attestation.phoenix_subaccount = args.phoenix_subaccount;
    attestation.detail_hash = args.detail_hash;
    attestation.observed_at = args.observed_at;
    attestation.observed_slot = args.observed_slot;
    attestation.recorded_at = now;
    attestation.recorded_slot = Clock::get()?.slot;
    attestation.attestation_nonce = args.attestation_nonce;
    attestation.bump = ctx.bumps.attestation;

    emit!(PerpEventAttested {
        attestation: attestation.key(),
        basket: attestation.basket,
        event_hash: attestation.event_hash,
        market_id: args.market_id,
        phoenix_subaccount: attestation.phoenix_subaccount,
        observed_at: attestation.observed_at,
    });
    Ok(())
}
