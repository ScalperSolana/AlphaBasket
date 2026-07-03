use anchor_lang::prelude::*;

#[error_code]
pub enum EscrowError {
    #[msg("Program is paused")]
    Paused,
    #[msg("Basket is not active")]
    BasketNotActive,
    #[msg("Basket is already settled")]
    AlreadySettled,
    #[msg("Basket is not settled yet")]
    NotSettled,
    #[msg("No settlement has been proposed for this basket")]
    NoActiveProposal,
    #[msg("Challenge window has not elapsed; finalize is not yet allowed")]
    ChallengeWindowActive,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Deposit is too small after fees")]
    DepositTooSmall,
    #[msg("This deposit would exceed the 10,000 USDC basket cap")]
    BasketDepositLimitExceeded,
    #[msg("This deposit would exceed the 500 USDC per-user basket cap")]
    UserDepositLimitExceeded,
    #[msg("The configured settlement mint must use six decimals")]
    UnsupportedMintDecimals,
    #[msg("Index must be within 1..=10000")]
    InvalidIndex,
    #[msg("Signed quote has expired")]
    QuoteExpired,
    #[msg("Quote nonce was already used")]
    QuoteNonceReused,
    #[msg("Missing Ed25519 quote signature instruction")]
    MissingQuoteSignature,
    #[msg("Malformed Ed25519 quote signature instruction")]
    MalformedQuoteSignature,
    #[msg("Quote was not signed by the configured quote signer")]
    UnauthorizedQuoteSigner,
    #[msg("Signed quote does not match the staking parameters")]
    QuoteMismatch,
    #[msg("Position already claimed")]
    AlreadyClaimed,
    #[msg("All positions must be claimed before the basket surplus can be swept")]
    OutstandingClaims,
    #[msg("Vault has insufficient USDC to cover this payout")]
    InsufficientVaultLiquidity,
    #[msg("Token account has the wrong mint")]
    WrongMint,
    #[msg("Token account has the wrong owner")]
    WrongTokenOwner,
    #[msg("Position does not belong to this basket")]
    PositionBasketMismatch,
    #[msg("Basket items are missing, too many, or malformed")]
    InvalidBasketItems,
    #[msg("Basket item weights must sum to 10000 bps")]
    InvalidBasketWeights,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
