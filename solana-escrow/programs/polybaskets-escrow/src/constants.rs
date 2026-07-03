use anchor_lang::prelude::*;

/// Basis-points denominator.
pub const MAX_BPS: u16 = 10_000;

/// Protocol fee charged on each user deposit (2%).
pub const DEPOSIT_FEE_BPS: u16 = 200;

/// Protocol fee charged on each settled-position payout (2%).
pub const WITHDRAWAL_FEE_BPS: u16 = 200;

/// The risk limits below are denominated in a six-decimal USDC mint.
pub const USDC_DECIMALS: u8 = 6;

/// Maximum gross user deposits accepted by a single basket: 10,000 USDC.
pub const MAX_BASKET_DEPOSIT_UNITS: u64 = 10_000 * 1_000_000;

/// Maximum cumulative gross deposits accepted from one wallet per basket: 500 USDC.
pub const MAX_USER_DEPOSIT_UNITS: u64 = 500 * 1_000_000;

/// Settlement challenge window: the delay (in seconds) that must elapse between
/// propose_settlement and finalize_settlement. 12 minutes in production.
#[constant]
pub const CHALLENGE_WINDOW_SECS: i64 = 12 * 60;

/// Canonical message length for a signed entry-index quote.
pub const QUOTE_MSG_LEN: usize = 82;

/// Ed25519 native signature-verification program.
pub const ED25519_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");
