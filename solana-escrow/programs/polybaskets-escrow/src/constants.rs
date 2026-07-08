use anchor_lang::prelude::*;

/// Basis-points denominator.
pub const MAX_BPS: u16 = 10_000;
/// The internal share and accounting-value precision.
pub const ACCOUNTING_DECIMALS: u8 = 6;
pub const SHARE_SCALE: u64 = 1_000_000;

/// Product limits from the v2 specification.
pub const MAX_BASKET_DEPOSIT_UNITS: u64 = 10_000 * SHARE_SCALE;
pub const MAX_USER_DEPOSIT_UNITS: u64 = 500 * SHARE_SCALE;
pub const MAX_MARKET_WEIGHT_BPS: u16 = 4_000;
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
pub const EXECUTION_BATCH_VERSION: u8 = 1;

/// Native Ed25519 signature-verification program.
pub const ED25519_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");
pub const COMPOSITION_DOMAIN: &[u8] = b"ALPHABASKET_COMPOSITION_V1";
pub const RECONSTITUTION_DOMAIN: &[u8] = b"ALPHABASKET_RECONSTITUTION_V1";
pub const DEPOSIT_INTENT_DOMAIN: &[u8] = b"ALPHABASKET_DEPOSIT_INTENT_V1";
pub const WITHDRAWAL_INTENT_DOMAIN: &[u8] = b"ALPHABASKET_WITHDRAWAL_INTENT_V1";

pub const MAX_BASKET_ITEMS: usize = 16;
pub const MAX_MARKET_ID_LEN: usize = 64;

pub const ZERO_PUBKEY: Pubkey = Pubkey::new_from_array([0u8; 32]);
