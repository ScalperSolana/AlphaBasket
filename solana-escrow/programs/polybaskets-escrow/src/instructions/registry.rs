use anchor_lang::prelude::*;
use sha2::{Digest, Sha256};

use crate::constants::{
    MAX_ALLOWLISTED_TOKENS, MAX_BPS, MAX_ELIGIBILITY_VALIDITY_SECS, MAX_ELIGIBLE_MARKETS,
    MAX_MARKET_ID_LEN, MAX_PERP_ELIGIBLE_MARKETS, MAX_PRICE_ATTESTATION_VALIDITY_SECS,
    PRICE_ATTESTATION_DOMAIN,
};
use crate::errors::EscrowError;
use crate::events::{
    CompositionDraftPublished, EligibilityListPublished, PerpEligibilityListPublished,
    PriceAttestationSubmitted, TokenAllowlistUpdated,
};
use crate::instructions::create_basket::{
    canonical_composition_bytes, validate_basket_items, verify_composer_signature,
};
use crate::state::{
    AllowedToken, CompositionDraft, Config, EligibilityList, EligibleMarket, PerpEligibilityList,
    PerpEligibleMarket, PriceAttestation, PublishCompositionDraftArgs, PublishEligibilityListArgs,
    PublishPerpEligibilityListArgs, RegisterTokenArgs, SpotPriceSource, SubmitPriceAttestationArgs,
    TokenAllowlist, TokenAssetClass, TradingAvailability,
};

#[derive(Accounts)]
#[instruction(args: PublishEligibilityListArgs)]
pub struct PublishEligibilityList<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = composer_signer,
    )]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = composer_signer,
        seeds = [
            b"eligibility",
            args.list_hash.as_ref(),
            args.nonce.to_le_bytes().as_ref(),
        ],
        bump,
        space = 8 + EligibilityList::INIT_SPACE,
    )]
    pub eligibility_list: Account<'info, EligibilityList>,
    #[account(mut)]
    pub composer_signer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: PublishPerpEligibilityListArgs)]
pub struct PublishPerpEligibilityList<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = composer_signer,
    )]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = composer_signer,
        seeds = [
            b"perp_eligibility",
            args.list_hash.as_ref(),
            args.nonce.to_le_bytes().as_ref(),
        ],
        bump,
        space = 8 + PerpEligibilityList::INIT_SPACE,
    )]
    pub perp_eligibility_list: Account<'info, PerpEligibilityList>,
    #[account(mut)]
    pub composer_signer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: PublishCompositionDraftArgs)]
pub struct PublishCompositionDraft<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = composer_signer,
    )]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = composer_signer,
        seeds = [
            b"composition_draft",
            args.composition_hash.as_ref(),
            args.composition_nonce.to_le_bytes().as_ref(),
        ],
        bump,
        space = 8 + CompositionDraft::INIT_SPACE,
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
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: RegisterTokenArgs)]
pub struct RegisterToken<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = admin,
    )]
    pub config: Account<'info, Config>,
    #[account(
        init_if_needed,
        payer = admin,
        seeds = [b"token_allowlist"],
        bump,
        space = 8 + TokenAllowlist::INIT_SPACE,
    )]
    pub token_allowlist: Account<'info, TokenAllowlist>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: SubmitPriceAttestationArgs)]
pub struct SubmitPriceAttestation<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = composer_signer,
    )]
    pub config: Account<'info, Config>,
    #[account(
        seeds = [b"token_allowlist"],
        bump = token_allowlist.bump,
    )]
    pub token_allowlist: Account<'info, TokenAllowlist>,
    #[account(
        init_if_needed,
        payer = composer_signer,
        seeds = [b"price_attestation", args.token_mint.as_ref()],
        bump,
        space = 8 + PriceAttestation::INIT_SPACE,
    )]
    pub price_attestation: Account<'info, PriceAttestation>,
    #[account(mut)]
    pub composer_signer: Signer<'info>,
    /// CHECK: constrained to the native instructions sysvar by address.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub ix_sysvar: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn publish_eligibility_list_handler(
    ctx: Context<PublishEligibilityList>,
    args: PublishEligibilityListArgs,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, EscrowError::Paused);
    require!(
        args.list_hash != [0u8; 32] && args.nonce > 0,
        EscrowError::InvalidEligibilityList
    );
    validate_eligible_markets(&args.markets)?;
    let now = Clock::get()?.unix_timestamp;
    require!(
        args.expires_at > now
            && args.expires_at
                <= now
                    .checked_add(MAX_ELIGIBILITY_VALIDITY_SECS)
                    .ok_or(EscrowError::MathOverflow)?,
        EscrowError::InvalidEligibilityList
    );
    let canonical = canonical_eligibility_bytes(&args.markets)?;
    require!(
        Sha256::digest(&canonical).as_slice() == args.list_hash,
        EscrowError::InvalidEligibilityList
    );

    let list = &mut ctx.accounts.eligibility_list;
    list.list_hash = args.list_hash;
    list.nonce = args.nonce;
    list.composer = ctx.accounts.composer_signer.key();
    list.published_at = now;
    list.expires_at = args.expires_at;
    list.markets = args.markets;
    list.bump = ctx.bumps.eligibility_list;

    emit!(EligibilityListPublished {
        eligibility_list: list.key(),
        list_hash: list.list_hash,
        nonce: list.nonce,
        market_count: u16::try_from(list.markets.len())
            .map_err(|_| EscrowError::InvalidEligibilityList)?,
        expires_at: list.expires_at,
    });
    Ok(())
}

/// Publishes the Composer-screened Phoenix perpetual market list.
///
/// Mirrors `publish_eligibility_list_handler`, including the same validity bound
/// and the same hash-over-canonical-bytes check, so neither list can be published
/// with contents that disagree with the hash the Composer signed.
pub fn publish_perp_eligibility_list_handler(
    ctx: Context<PublishPerpEligibilityList>,
    args: PublishPerpEligibilityListArgs,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, EscrowError::Paused);
    require!(
        args.list_hash != [0u8; 32] && args.nonce > 0,
        EscrowError::InvalidPerpEligibilityList
    );
    validate_perp_eligible_markets(&args.markets)?;
    let now = Clock::get()?.unix_timestamp;
    require!(
        args.expires_at > now
            && args.expires_at
                <= now
                    .checked_add(MAX_ELIGIBILITY_VALIDITY_SECS)
                    .ok_or(EscrowError::MathOverflow)?,
        EscrowError::InvalidPerpEligibilityList
    );
    let canonical = canonical_perp_eligibility_bytes(&args.markets)?;
    require!(
        Sha256::digest(&canonical).as_slice() == args.list_hash,
        EscrowError::InvalidPerpEligibilityList
    );

    let list = &mut ctx.accounts.perp_eligibility_list;
    list.list_hash = args.list_hash;
    list.nonce = args.nonce;
    list.composer = ctx.accounts.composer_signer.key();
    list.published_at = now;
    list.expires_at = args.expires_at;
    list.markets = args.markets;
    list.bump = ctx.bumps.perp_eligibility_list;

    emit!(PerpEligibilityListPublished {
        perp_eligibility_list: list.key(),
        list_hash: list.list_hash,
        nonce: list.nonce,
        market_count: u16::try_from(list.markets.len())
            .map_err(|_| EscrowError::InvalidPerpEligibilityList)?,
        expires_at: list.expires_at,
    });
    Ok(())
}

pub(crate) fn validate_perp_eligible_markets(markets: &[PerpEligibleMarket]) -> Result<()> {
    require!(
        !markets.is_empty() && markets.len() <= MAX_PERP_ELIGIBLE_MARKETS,
        EscrowError::InvalidPerpEligibilityList
    );
    for (index, market) in markets.iter().enumerate() {
        require!(
            !market.market_id.is_empty() && market.market_id.len() <= MAX_MARKET_ID_LEN,
            EscrowError::InvalidPerpEligibilityList
        );
        for other in markets.iter().skip(index + 1) {
            require!(
                market.market_id != other.market_id,
                EscrowError::InvalidPerpEligibilityList
            );
        }
    }
    Ok(())
}

pub(crate) fn canonical_perp_eligibility_bytes(markets: &[PerpEligibleMarket]) -> Result<Vec<u8>> {
    let market_count =
        u16::try_from(markets.len()).map_err(|_| EscrowError::InvalidPerpEligibilityList)?;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&market_count.to_le_bytes());
    for market in markets {
        let market_id = market.market_id.as_bytes();
        let market_len =
            u16::try_from(market_id.len()).map_err(|_| EscrowError::InvalidPerpEligibilityList)?;
        bytes.extend_from_slice(&market_len.to_le_bytes());
        bytes.extend_from_slice(market_id);
    }
    Ok(bytes)
}

pub fn publish_composition_draft_handler(
    ctx: Context<PublishCompositionDraft>,
    args: PublishCompositionDraftArgs,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, EscrowError::Paused);
    require!(
        args.composition_hash != [0u8; 32]
            && args.eligibility_hash != [0u8; 32]
            && args.eligibility_nonce > 0
            && args.composition_nonce > 0,
        EscrowError::InvalidBasketItems
    );
    let now = Clock::get()?.unix_timestamp;
    require!(
        ctx.accounts.eligibility_list.list_hash == args.eligibility_hash
            && ctx.accounts.eligibility_list.nonce == args.eligibility_nonce
            && ctx.accounts.eligibility_list.published_at <= now
            && ctx.accounts.eligibility_list.expires_at > now,
        EscrowError::InvalidEligibilityList
    );
    validate_basket_items(
        &args.items,
        &ctx.accounts.eligibility_list,
        ctx.remaining_accounts,
    )?;
    let canonical = canonical_composition_bytes(&args.items)?;
    require!(
        Sha256::digest(&canonical).as_slice() == args.composition_hash,
        EscrowError::CompositionHashMismatch
    );

    let draft = &mut ctx.accounts.composition_draft;
    draft.composition_hash = args.composition_hash;
    draft.eligibility_hash = args.eligibility_hash;
    draft.eligibility_nonce = args.eligibility_nonce;
    draft.composition_nonce = args.composition_nonce;
    draft.composer = ctx.accounts.composer_signer.key();
    draft.published_at = now;
    draft.items = args.items;
    draft.bump = ctx.bumps.composition_draft;

    emit!(CompositionDraftPublished {
        composition_draft: draft.key(),
        composition_hash: draft.composition_hash,
        eligibility_hash: draft.eligibility_hash,
        eligibility_nonce: draft.eligibility_nonce,
        composition_nonce: draft.composition_nonce,
        item_count: u16::try_from(draft.items.len())
            .map_err(|_| EscrowError::InvalidBasketItems)?,
    });
    Ok(())
}

pub fn register_token_handler(ctx: Context<RegisterToken>, args: RegisterTokenArgs) -> Result<()> {
    require!(
        args.token_mint != Pubkey::default(),
        EscrowError::InvalidTokenMetadata
    );
    if args.enabled {
        require!(args.jupiter_verified, EscrowError::InvalidTokenMetadata);
    }
    match args.price_source {
        SpotPriceSource::Pyth { feed_id } => {
            require!(feed_id != [0u8; 32], EscrowError::InvalidTokenMetadata);
        }
        SpotPriceSource::Switchboard { feed } => {
            require!(feed != Pubkey::default(), EscrowError::InvalidTokenMetadata);
        }
        SpotPriceSource::SignedTwap => {}
    }
    if args.asset_class == TokenAssetClass::TokenizedEquity {
        require!(
            args.backing_attestation_hash != [0u8; 32],
            EscrowError::InvalidTokenMetadata
        );
        require!(
            matches!(
                args.availability,
                TradingAvailability::TwentyFourSeven | TradingAvailability::TwentyFourFive
            ),
            EscrowError::InvalidTokenMetadata
        );
    }

    let now = Clock::get()?.unix_timestamp;
    let allowlist = &mut ctx.accounts.token_allowlist;
    let is_new = allowlist.registered_by == Pubkey::default();
    if is_new {
        allowlist.registered_by = ctx.accounts.admin.key();
        allowlist.tokens = Vec::new();
        allowlist.reserved = [0u8; crate::constants::REGISTRY_RESERVED_BYTES];
        allowlist.bump = ctx.bumps.token_allowlist;
    }
    if let Some(entry) = allowlist
        .tokens
        .iter_mut()
        .find(|entry| entry.token_mint == args.token_mint)
    {
        entry.jupiter_verified = args.jupiter_verified;
        entry.asset_class = args.asset_class;
        entry.availability = args.availability;
        entry.price_source = args.price_source;
        entry.backing_attestation_hash = args.backing_attestation_hash;
        entry.enabled = args.enabled;
        entry.updated_at = now;
    } else {
        require!(
            allowlist.tokens.len() < MAX_ALLOWLISTED_TOKENS,
            EscrowError::InvalidTokenMetadata
        );
        allowlist.tokens.push(AllowedToken {
            token_mint: args.token_mint,
            jupiter_verified: args.jupiter_verified,
            asset_class: args.asset_class,
            availability: args.availability,
            price_source: args.price_source,
            backing_attestation_hash: args.backing_attestation_hash,
            enabled: args.enabled,
            created_at: now,
            updated_at: now,
        });
    }
    allowlist.updated_at = now;

    emit!(TokenAllowlistUpdated {
        token_allowlist: allowlist.key(),
        token_mint: args.token_mint,
        enabled: args.enabled,
        jupiter_verified: args.jupiter_verified,
    });
    Ok(())
}

pub fn submit_price_attestation_handler(
    ctx: Context<SubmitPriceAttestation>,
    args: SubmitPriceAttestationArgs,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, EscrowError::Paused);
    require!(
        ctx.accounts.token_allowlist.tokens.iter().any(|entry| {
            entry.token_mint == args.token_mint
                && entry.enabled
                && entry.jupiter_verified
                && matches!(entry.price_source, SpotPriceSource::SignedTwap)
        }),
        EscrowError::InvalidPriceAttestation
    );
    let now = Clock::get()?.unix_timestamp;
    require!(
        args.price_value > 0
            && args.confidence_bps <= MAX_BPS
            && args.observed_at > 0
            && args.observed_at <= now
            && now
                .checked_sub(args.observed_at)
                .ok_or(EscrowError::MathOverflow)?
                <= MAX_PRICE_ATTESTATION_VALIDITY_SECS
            && args.valid_until > now
            && args
                .valid_until
                .checked_sub(args.observed_at)
                .ok_or(EscrowError::MathOverflow)?
                <= MAX_PRICE_ATTESTATION_VALIDITY_SECS
            && args.nonce > 0,
        EscrowError::InvalidPriceAttestation
    );
    let current = &ctx.accounts.price_attestation;
    if current.token_mint != Pubkey::default() {
        require!(
            current.token_mint == args.token_mint,
            EscrowError::InvalidPriceAttestation
        );
        require!(
            args.nonce > current.nonce,
            EscrowError::PriceAttestationNonceNotIncreasing
        );
    }

    let message = price_attestation_message(&args);
    verify_composer_signature(
        &ctx.accounts.ix_sysvar,
        &ctx.accounts.config.composer_signer,
        &message,
    )?;
    let hash = Sha256::digest(&message);

    let attestation = &mut ctx.accounts.price_attestation;
    attestation.token_mint = args.token_mint;
    attestation.price_value = args.price_value;
    attestation.confidence_bps = args.confidence_bps;
    attestation.observed_at = args.observed_at;
    attestation.valid_until = args.valid_until;
    attestation.nonce = args.nonce;
    attestation.signer = ctx.accounts.composer_signer.key();
    attestation
        .attestation_hash
        .copy_from_slice(hash.as_slice());
    attestation.reserved = [0u8; crate::constants::REGISTRY_RESERVED_BYTES];
    attestation.bump = ctx.bumps.price_attestation;

    emit!(PriceAttestationSubmitted {
        price_attestation: attestation.key(),
        token_mint: attestation.token_mint,
        price_value: attestation.price_value,
        confidence_bps: attestation.confidence_bps,
        observed_at: attestation.observed_at,
        valid_until: attestation.valid_until,
        nonce: attestation.nonce,
        attestation_hash: attestation.attestation_hash,
    });
    Ok(())
}

pub(crate) fn validate_eligible_markets(markets: &[EligibleMarket]) -> Result<()> {
    require!(
        markets.len() <= MAX_ELIGIBLE_MARKETS,
        EscrowError::InvalidEligibilityList
    );
    for (index, market) in markets.iter().enumerate() {
        require!(
            !market.market_id.is_empty()
                && market.market_id.len() <= MAX_MARKET_ID_LEN
                && market.outcome <= 1
                && market.ctf_token_id != [0u8; 32],
            EscrowError::InvalidEligibilityList
        );
        for other in markets.iter().skip(index + 1) {
            require!(
                market.market_id != other.market_id && market.ctf_token_id != other.ctf_token_id,
                EscrowError::InvalidEligibilityList
            );
        }
    }
    Ok(())
}

pub(crate) fn canonical_eligibility_bytes(markets: &[EligibleMarket]) -> Result<Vec<u8>> {
    let market_count =
        u16::try_from(markets.len()).map_err(|_| EscrowError::InvalidEligibilityList)?;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&market_count.to_le_bytes());
    for market in markets {
        let market_id = market.market_id.as_bytes();
        let market_len =
            u16::try_from(market_id.len()).map_err(|_| EscrowError::InvalidEligibilityList)?;
        bytes.extend_from_slice(&market_len.to_le_bytes());
        bytes.extend_from_slice(market_id);
        bytes.push(market.outcome);
        bytes.extend_from_slice(&market.ctf_token_id);
    }
    Ok(bytes)
}

pub(crate) fn price_attestation_message(args: &SubmitPriceAttestationArgs) -> Vec<u8> {
    let mut message = Vec::new();
    message.extend_from_slice(PRICE_ATTESTATION_DOMAIN);
    message.extend_from_slice(crate::ID.as_ref());
    message.extend_from_slice(args.token_mint.as_ref());
    message.extend_from_slice(&args.price_value.to_le_bytes());
    message.extend_from_slice(&args.confidence_bps.to_le_bytes());
    message.extend_from_slice(&args.observed_at.to_le_bytes());
    message.extend_from_slice(&args.valid_until.to_le_bytes());
    message.extend_from_slice(&args.nonce.to_le_bytes());
    message
}
