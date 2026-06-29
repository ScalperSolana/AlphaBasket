use anchor_lang::prelude::*;

/// Basis-points denominator.
pub const MAX_BPS: u16 = 10_000;

/// Settlement challenge window: the delay (in seconds) that must elapse between
/// propose_settlement and finalize_settlement.
#[constant]
pub const CHALLENGE_WINDOW_SECS: i64 = 12;

/// Canonical message length for a signed entry-index quote.
pub const QUOTE_MSG_LEN: usize = 82;

/// Ed25519 native signature-verification program.
pub const ED25519_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");
