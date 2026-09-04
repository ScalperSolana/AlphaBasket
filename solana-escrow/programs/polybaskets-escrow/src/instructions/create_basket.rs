use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked, ID as IX_SYSVAR_ID,
};
use sha2::{Digest, Sha256};

use crate::constants::{
    COMPOSITION_DOMAIN, DEFAULT_CREATOR_PERFORMANCE_FEE_BPS, ED25519_ID, MAX_BASKET_ITEMS, MAX_BPS,
    MAX_CREATOR_PERFORMANCE_FEE_BPS, MAX_MARKET_ID_LEN, MAX_MIXED_WEIGHT_BPS,
    MAX_PERP_LEVERAGE_BPS, MAX_SINGLE_SOURCE_WEIGHT_BPS, MIN_PERP_LEVERAGE_BPS,
    PHOENIX_CROSS_SUBACCOUNT_INDEX,
};
use crate::errors::EscrowError;
use crate::events::BasketCreated;
use crate::state::{
    Basket, BasketAsset, BasketStatus, CompositionDraft, Config, CreateBasketArgs, EligibilityList,
    PerpDirection, PerpEligibilityList, PositionKind, TokenAllowlist,
};

#[derive(Accounts)]
#[instruction(args: CreateBasketArgs)]
pub struct CreateBasket<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = composer_signer,
    )]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = composer_signer,
        seeds = [b"basket", args.basket_id.as_ref()],
        bump,
        space = 8 + Basket::INIT_SPACE,
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
    #[account(mut)]
    pub composer_signer: Signer<'info>,
    /// CHECK: constrained to the native instructions sysvar.
    #[account(address = IX_SYSVAR_ID)]
    pub ix_sysvar: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn create_basket_handler(ctx: Context<CreateBasket>, args: CreateBasketArgs) -> Result<()> {
    require!(!ctx.accounts.config.paused, EscrowError::Paused);
    require!(
        args.creator != Pubkey::default() && args.creator_fee_destination != Pubkey::default(),
        EscrowError::ZeroAuthority
    );
    require!(args.composition_hash != [0u8; 32], EscrowError::ZeroHash);
    let performance_fee_bps = args
        .performance_fee_bps
        .unwrap_or(DEFAULT_CREATOR_PERFORMANCE_FEE_BPS);
    require!(
        performance_fee_bps <= MAX_CREATOR_PERFORMANCE_FEE_BPS,
        EscrowError::InvalidBasisPoints
    );
    if args.is_perpetual {
        require!(
            args.reconstitution_cadence_secs > 0,
            EscrowError::InvalidSettlementValues
        );
    } else {
        require!(
            args.reconstitution_cadence_secs == 0,
            EscrowError::InvalidSettlementValues
        );
    }
    let now = Clock::get()?.unix_timestamp;
    require!(
        args.composition_expiry > now,
        EscrowError::CompositionAuthorizationExpired
    );
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
        args.is_perpetual,
    )?;
    let composition_bytes = canonical_composition_bytes(&ctx.accounts.composition_draft.items)?;
    require!(
        Sha256::digest(&composition_bytes).as_slice() == args.composition_hash,
        EscrowError::CompositionHashMismatch
    );
    let message = create_composition_message(&args, performance_fee_bps);
    verify_composer_signature(
        &ctx.accounts.ix_sysvar,
        &ctx.accounts.config.composer_signer,
        &message,
    )?;

    let basket = &mut ctx.accounts.basket;
    basket.basket_id = args.basket_id;
    basket.composer = ctx.accounts.composer_signer.key();
    basket.creator = args.creator;
    basket.creator_fee_destination = args.creator_fee_destination;
    basket.protocol_fee_destination = ctx.accounts.config.protocol_treasury;
    basket.status = BasketStatus::Active;
    basket.composition_hash = args.composition_hash;
    basket.composition_version = 1;
    basket.last_composition_nonce = args.composition_nonce;
    basket.performance_fee_bps = performance_fee_bps;
    basket.is_perpetual = args.is_perpetual;
    basket.reconstitution_cadence_secs = args.reconstitution_cadence_secs;
    basket.total_shares_outstanding = 0;
    basket.protocol_fee_shares = 0;
    basket.last_management_fee_at = 0;
    basket.management_fee_accrual_remainder = 0;
    basket.has_initialized_share_price = false;
    basket.last_settlement_nonce = 0;
    basket.gross_deposited_value = 0;
    basket.final_report_hash = [0u8; 32];
    basket.final_nav_value = 0;
    basket.final_share_snapshot = 0;
    basket.final_shares_consumed = 0;
    basket.created_at = now;
    basket.last_reconstitution_at = now;
    basket.updated_at = now;
    basket.items = ctx.accounts.composition_draft.items.clone();
    basket.bump = ctx.bumps.basket;

    emit!(BasketCreated {
        basket: basket.key(),
        basket_id: basket.basket_id,
        composer: basket.composer,
        creator: basket.creator,
        composition_hash: basket.composition_hash,
        performance_fee_bps: basket.performance_fee_bps,
    });
    Ok(())
}

/// Validates a composition.
///
/// `extra_accounts` carries the registries only some asset classes need, in a
/// fixed order: the `TokenAllowlist` first when the basket holds spot, then the
/// `PerpEligibilityList` when it holds perpetuals. The length must match exactly,
/// so a caller cannot pass an unrelated account and have it ignored.
pub(crate) fn validate_basket_items(
    items: &[BasketAsset],
    eligibility_list: &EligibilityList,
    extra_accounts: &[AccountInfo],
    is_perpetual: bool,
) -> Result<()> {
    require!(
        !items.is_empty() && items.len() <= MAX_BASKET_ITEMS,
        EscrowError::InvalidBasketItems
    );

    let has_prediction = items
        .iter()
        .any(|item| matches!(&item.kind, PositionKind::PredictionMarket { .. }));
    let has_spot = items
        .iter()
        .any(|item| matches!(&item.kind, PositionKind::Spot { .. }));
    let has_perp = items.iter().any(|item| item.kind.is_perp());

    // A perpetual basket is never mixed with spot or prediction markets. Perps
    // carry leverage and a liquidation price; blending them with unlevered
    // positions would make a single basket share mean two different things about
    // risk, and the NAV of the mixed basket would not be decomposable.
    require!(
        !(has_perp && (has_prediction || has_spot)),
        EscrowError::MixedAssetClassBasket
    );

    // A perpetual position has no resolution date, so a basket holding one can
    // never be resolved and must reconstitute on a cadence instead. Without this
    // a perp basket created with `is_perpetual = false` could reach
    // `begin_resolution`, which would move it to `Resolving` and then
    // `Redeemable` against a final NAV, while the underlying Phoenix positions
    // were still open and still moving.
    require!(
        !has_perp || is_perpetual,
        EscrowError::PerpBasketMustBePerpetual
    );

    let weight_cap = if has_prediction && has_spot {
        MAX_MIXED_WEIGHT_BPS
    } else {
        MAX_SINGLE_SOURCE_WEIGHT_BPS
    };
    if !has_prediction {
        require!(
            eligibility_list.markets.is_empty(),
            EscrowError::InvalidEligibilityList
        );
    }
    require!(
        extra_accounts.len() == usize::from(has_spot) + usize::from(has_perp),
        EscrowError::TokenNotAllowlisted
    );
    let perp_eligibility = if has_perp {
        Some(load_perp_eligibility_account(
            extra_accounts
                .last()
                .ok_or(EscrowError::InvalidPerpEligibilityList)?,
        )?)
    } else {
        None
    };

    let mut total_weight: u32 = 0;
    for (index, item) in items.iter().enumerate() {
        require!(
            !item.market_id.is_empty()
                && item.market_id.len() <= MAX_MARKET_ID_LEN
                && item.weight_bps > 0,
            EscrowError::InvalidBasketItems
        );
        require!(
            item.weight_bps <= weight_cap,
            EscrowError::MarketWeightExceeded
        );

        match &item.kind {
            PositionKind::PredictionMarket {
                outcome,
                ctf_token_id,
            } => {
                require!(
                    *outcome <= 1 && *ctf_token_id != [0u8; 32],
                    EscrowError::InvalidBasketItems
                );
                require!(
                    eligibility_list.markets.iter().any(|eligible| {
                        eligible.market_id == item.market_id
                            && eligible.outcome == *outcome
                            && eligible.ctf_token_id == *ctf_token_id
                    }),
                    EscrowError::MarketNotEligible
                );
            }
            PositionKind::Spot { token_mint } => {
                require!(
                    *token_mint != Pubkey::default(),
                    EscrowError::InvalidBasketItems
                );
                let account = extra_accounts
                    .first()
                    .ok_or(EscrowError::TokenNotAllowlisted)?;
                validate_spot_allowlist_account(account, token_mint)?;
            }
            PositionKind::Perp {
                leverage_bps,
                phoenix_subaccount,
                ..
            } => {
                // Isolated margin only. Phoenix's subaccount 0 is the shared
                // cross-margin account: a loss there can consume collateral
                // backing an unrelated position, which breaks the invariant that
                // every basket item is independently valuable.
                require!(
                    *phoenix_subaccount != PHOENIX_CROSS_SUBACCOUNT_INDEX,
                    EscrowError::SubaccountZeroNotAllowed
                );
                require!(
                    *leverage_bps >= MIN_PERP_LEVERAGE_BPS
                        && *leverage_bps <= MAX_PERP_LEVERAGE_BPS,
                    EscrowError::PerpLeverageOutOfBounds
                );
                let list = perp_eligibility
                    .as_ref()
                    .ok_or(EscrowError::InvalidPerpEligibilityList)?;
                require!(
                    list.contains(&item.market_id),
                    EscrowError::MarketNotEligible
                );
            }
        }

        for other in items.iter().skip(index + 1) {
            match (&item.kind, &other.kind) {
                (
                    PositionKind::PredictionMarket { ctf_token_id, .. },
                    PositionKind::PredictionMarket {
                        ctf_token_id: other_ctf_token_id,
                        ..
                    },
                ) => {
                    require!(
                        item.market_id != other.market_id && ctf_token_id != other_ctf_token_id,
                        EscrowError::InvalidBasketItems
                    );
                }
                (
                    PositionKind::Spot { token_mint },
                    PositionKind::Spot {
                        token_mint: other_token_mint,
                    },
                ) => {
                    require!(
                        token_mint != other_token_mint,
                        EscrowError::InvalidBasketItems
                    );
                }
                (
                    PositionKind::Perp {
                        phoenix_subaccount, ..
                    },
                    PositionKind::Perp {
                        phoenix_subaccount: other_subaccount,
                        ..
                    },
                ) => {
                    // Two items sharing one isolated subaccount would share
                    // collateral, which is the thing isolation exists to prevent.
                    require!(
                        item.market_id != other.market_id && phoenix_subaccount != other_subaccount,
                        EscrowError::InvalidBasketItems
                    );
                }
                _ => {}
            }
        }
        total_weight = total_weight
            .checked_add(item.weight_bps as u32)
            .ok_or(EscrowError::MathOverflow)?;
    }
    require!(
        total_weight == MAX_BPS as u32,
        EscrowError::InvalidBasketWeights
    );
    Ok(())
}

pub(crate) fn canonical_composition_bytes(items: &[BasketAsset]) -> Result<Vec<u8>> {
    let item_count = u16::try_from(items.len()).map_err(|_| EscrowError::InvalidBasketItems)?;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&item_count.to_le_bytes());
    for item in items {
        let market = item.market_id.as_bytes();
        let market_len =
            u16::try_from(market.len()).map_err(|_| EscrowError::InvalidBasketItems)?;
        bytes.extend_from_slice(&market_len.to_le_bytes());
        bytes.extend_from_slice(market);
        match &item.kind {
            PositionKind::PredictionMarket {
                outcome,
                ctf_token_id,
            } => {
                bytes.push(0);
                bytes.push(*outcome);
                bytes.extend_from_slice(ctf_token_id);
            }
            PositionKind::Spot { token_mint } => {
                bytes.push(1);
                bytes.extend_from_slice(token_mint.as_ref());
            }
            PositionKind::Perp {
                direction,
                leverage_bps,
                phoenix_subaccount,
                // `entry_mark_price` and `margin_posted` are deliberately absent.
                //
                // They are *state*, not composition: `complete_phoenix_trade`
                // writes both in place as fills land. Hashing them would mean the
                // composition hash stopped matching the composition after the
                // first trade, and every later reconstitution would be comparing
                // against a hash that no longer described anything.
                //
                // What remains is exactly what the Composer approved and nothing
                // this program ever rewrites.
                ..
            } => {
                bytes.push(2);
                bytes.push(match direction {
                    PerpDirection::Long => 0,
                    PerpDirection::Short => 1,
                });
                bytes.extend_from_slice(&leverage_bps.to_le_bytes());
                bytes.push(*phoenix_subaccount);
            }
        }
        bytes.extend_from_slice(&item.weight_bps.to_le_bytes());
    }
    Ok(bytes)
}

fn create_composition_message(args: &CreateBasketArgs, performance_fee_bps: u16) -> Vec<u8> {
    let mut message = Vec::new();
    message.extend_from_slice(COMPOSITION_DOMAIN);
    message.extend_from_slice(crate::ID.as_ref());
    message.extend_from_slice(&args.basket_id);
    message.extend_from_slice(args.creator.as_ref());
    message.extend_from_slice(args.creator_fee_destination.as_ref());
    message.extend_from_slice(&args.eligibility_hash);
    message.extend_from_slice(&args.eligibility_nonce.to_le_bytes());
    message.extend_from_slice(&performance_fee_bps.to_le_bytes());
    message.push(u8::from(args.is_perpetual));
    message.extend_from_slice(&args.reconstitution_cadence_secs.to_le_bytes());
    message.extend_from_slice(&args.composition_nonce.to_le_bytes());
    message.extend_from_slice(&args.composition_expiry.to_le_bytes());
    message
}

fn validate_spot_allowlist_account(account: &AccountInfo, token_mint: &Pubkey) -> Result<()> {
    require_keys_eq!(*account.owner, crate::ID, EscrowError::TokenNotAllowlisted);
    let (expected, _) = Pubkey::find_program_address(&[b"token_allowlist"], &crate::ID);
    require_keys_eq!(account.key(), expected, EscrowError::TokenNotAllowlisted);
    let data = account
        .try_borrow_data()
        .map_err(|_| error!(EscrowError::TokenNotAllowlisted))?;
    let entry = TokenAllowlist::try_deserialize(&mut data.as_ref())
        .map_err(|_| error!(EscrowError::TokenNotAllowlisted))?;
    require!(
        entry.tokens.iter().any(|token| {
            token.token_mint == *token_mint && token.enabled && token.jupiter_verified
        }),
        EscrowError::TokenNotAllowlisted
    );
    Ok(())
}

/// Loads and checks a `PerpEligibilityList` passed through `remaining_accounts`.
///
/// Mirrors `validate_spot_allowlist_account`: prove the owner, prove the address
/// is the real PDA for the list's own hash and nonce, then deserialize. Without
/// the address check a caller could hand over any account of the right shape.
fn load_perp_eligibility_account(account: &AccountInfo) -> Result<PerpEligibilityList> {
    require_keys_eq!(
        *account.owner,
        crate::ID,
        EscrowError::InvalidPerpEligibilityList
    );
    let data = account
        .try_borrow_data()
        .map_err(|_| error!(EscrowError::InvalidPerpEligibilityList))?;
    let list = PerpEligibilityList::try_deserialize(&mut data.as_ref())
        .map_err(|_| error!(EscrowError::InvalidPerpEligibilityList))?;

    let (expected, _) = Pubkey::find_program_address(
        &[
            b"perp_eligibility",
            list.list_hash.as_ref(),
            list.nonce.to_le_bytes().as_ref(),
        ],
        &crate::ID,
    );
    require_keys_eq!(
        account.key(),
        expected,
        EscrowError::InvalidPerpEligibilityList
    );

    let now = Clock::get()?.unix_timestamp;
    require!(
        list.published_at <= now && list.expires_at > now,
        EscrowError::InvalidPerpEligibilityList
    );
    Ok(list)
}

pub(crate) fn verify_composer_signature(
    ix_sysvar: &AccountInfo,
    composer: &Pubkey,
    expected_message: &[u8],
) -> Result<()> {
    let current_index = load_current_index_checked(ix_sysvar)? as usize;
    require!(current_index >= 1, EscrowError::MissingCompositionSignature);
    let ed_ix = load_instruction_at_checked(current_index - 1, ix_sysvar)?;
    require!(
        ed_ix.program_id == ED25519_ID,
        EscrowError::MissingCompositionSignature
    );

    let data = &ed_ix.data;
    require!(
        data.len() >= 16 && data[0] == 1 && data[1] == 0,
        EscrowError::MalformedCompositionSignature
    );
    let read_u16 = |offset: usize| -> Result<u16> {
        let bytes = data
            .get(offset..offset + 2)
            .ok_or(EscrowError::MalformedCompositionSignature)?;
        Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
    };

    // Require signature, key, and message bytes to live in this same Ed25519
    // instruction, preventing cross-instruction byte substitution.
    require!(
        read_u16(4)? == u16::MAX && read_u16(8)? == u16::MAX && read_u16(14)? == u16::MAX,
        EscrowError::MalformedCompositionSignature
    );
    let pubkey_offset = read_u16(6)? as usize;
    let message_offset = read_u16(10)? as usize;
    let message_size = read_u16(12)? as usize;
    let pubkey_bytes = data
        .get(pubkey_offset..pubkey_offset + 32)
        .ok_or(EscrowError::MalformedCompositionSignature)?;
    require!(
        pubkey_bytes == composer.as_ref(),
        EscrowError::UnauthorizedCompositionSigner
    );
    let message = data
        .get(message_offset..message_offset + message_size)
        .ok_or(EscrowError::MalformedCompositionSignature)?;
    require!(
        message == expected_message,
        EscrowError::CompositionSignatureMismatch
    );
    Ok(())
}
