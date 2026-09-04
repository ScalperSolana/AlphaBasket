use anchor_lang::prelude::*;

/// Basis-points denominator.
pub const MAX_BPS: u16 = 10_000;
/// The internal share and accounting-value precision.
pub const ACCOUNTING_DECIMALS: u8 = 6;
pub const SHARE_SCALE: u64 = 1_000_000;

/// Product and accounting rules.
pub const MAX_SINGLE_SOURCE_WEIGHT_BPS: u16 = 3_000;
pub const MAX_MIXED_WEIGHT_BPS: u16 = 2_000;
pub const DEPOSIT_FEE_BPS: u16 = 50;
pub const MANAGEMENT_FEE_BPS: u16 = 35;
pub const EARLY_WITHDRAWAL_FEE_BPS: u16 = 200;
pub const MATURE_WITHDRAWAL_FEE_BPS: u16 = 100;
pub const MAX_CREATOR_PERFORMANCE_FEE_BPS: u16 = 2_000;
pub const DEFAULT_CREATOR_PERFORMANCE_FEE_BPS: u16 = 1_000;
pub const MANAGEMENT_FEE_PERIOD_SECS: i64 = 30 * 24 * 60 * 60;
pub const MATURE_HOLDING_PERIOD_SECS: i64 = 60 * 24 * 60 * 60;
pub const MAX_MANAGEMENT_FEE_PERIODS: u64 = 600;
pub const POSITION_RESERVED_BYTES: usize = 64;
pub const REGISTRY_RESERVED_BYTES: usize = 64;
pub const EXECUTION_BATCH_VERSION: u8 = 1;
pub const MAX_ELIGIBILITY_VALIDITY_SECS: i64 = 15 * 60;
pub const MAX_PRICE_ATTESTATION_VALIDITY_SECS: i64 = 5 * 60;

/// Native Ed25519 signature-verification program.
pub const ED25519_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");
/// Compact domains keep four-position creation transactions below Solana's
/// packet limit while remaining unambiguous and versioned.
pub const COMPOSITION_DOMAIN: &[u8] = b"AB_CREATE_V2";
pub const RECONSTITUTION_DOMAIN: &[u8] = b"AB_RECON_V2";
pub const PRICE_ATTESTATION_DOMAIN: &[u8] = b"ALPHABASKET_SPOT_PRICE_V1";
pub const DEPOSIT_INTENT_DOMAIN: &[u8] = b"ALPHABASKET_DEPOSIT_INTENT_V1";
pub const WITHDRAWAL_INTENT_DOMAIN: &[u8] = b"ALPHABASKET_WITHDRAWAL_INTENT_V1";

/// Perpetual-futures settings.
///
/// Phoenix positions are recorded, never executed on chain: the program takes
/// already-executed, vault-delta-verified figures and validates them. It never
/// CPIs into Phoenix.
///
/// How far in the past an executed Phoenix trade may be and still be settleable.
/// Later than this is a reconciliation problem, not a settlement.
pub const MAX_PERP_SETTLEMENT_AGE_SECS: i64 = 300;
/// How far in the past an autonomous Phoenix event may be and still be attestable.
/// Far more generous than settlement: Phoenix acts on positions without being
/// asked, an observer may have been offline, and losing the record is worse than
/// recording it late.
pub const MAX_PERP_ATTESTATION_AGE_SECS: i64 = 86_400;
/// Tolerance for a caller-supplied timestamp being ahead of the cluster clock.
pub const MAX_PERP_CLOCK_SKEW_SECS: i64 = 60;
/// Lower bound for a recorded leverage figure: 1.00x.
pub const MIN_PERP_LEVERAGE_BPS: u16 = 10_000;
/// Upper bound for a recorded leverage figure. A bounds check, not a risk rule:
/// Phoenix enforces the real limit through per-market leverage tiers, which the
/// backend reads live. Set well above Phoenix's highest observed first tier (25x)
/// so this program never becomes the reason a legitimate trade cannot be recorded.
pub const MAX_PERP_LEVERAGE_BPS: u16 = 50_000;
/// Phoenix's cross-margin subaccount index. **Never used for a position.** A loss
/// there can consume collateral backing an unrelated position, which breaks the
/// invariant that every basket item is independently valuable.
pub const PHOENIX_CROSS_SUBACCOUNT_INDEX: u8 = 0;
/// Phoenix trader PDA index used for user portfolios. Phoenix only activates
/// `pda_index = 0` while exchange gating is enabled.
pub const PHOENIX_USER_PDA_INDEX: u8 = 0;

pub const MAX_BASKET_ITEMS: usize = 16;
pub const MAX_ELIGIBLE_MARKETS: usize = 16;
/// Perpetuals get their own allowlist rather than reusing `EligibleMarket`, whose
/// `outcome` and `ctf_token_id` are Polymarket/CTF fields with no meaning for a
/// perpetual. Spot does not reuse it either; it has `TokenAllowlist`.
pub const MAX_PERP_ELIGIBLE_MARKETS: usize = 16;
pub const MAX_ALLOWLISTED_TOKENS: usize = 64;
pub const MAX_MARKET_ID_LEN: usize = 64;

pub const ZERO_PUBKEY: Pubkey = Pubkey::new_from_array([0u8; 32]);
