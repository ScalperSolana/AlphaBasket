use anchor_lang::prelude::*;

#[error_code]
pub enum EscrowError {
    #[msg("Program is paused")]
    Paused,
    #[msg("Authority is not allowed to perform this action")]
    Unauthorized,
    #[msg("No matching admin transfer is pending")]
    AdminTransferNotPending,
    #[msg("Configured authority cannot be the zero public key")]
    ZeroAuthority,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Hash value cannot be all zeroes")]
    ZeroHash,
    #[msg("Composer signature instruction is missing")]
    MissingCompositionSignature,
    #[msg("Composer signature instruction is malformed")]
    MalformedCompositionSignature,
    #[msg("Composition was signed by an unauthorized key")]
    UnauthorizedCompositionSigner,
    #[msg("Signed composition payload does not match the instruction")]
    CompositionSignatureMismatch,
    #[msg("Composition hash does not match the canonical basket items")]
    CompositionHashMismatch,
    #[msg("Composition authorization has expired")]
    CompositionAuthorizationExpired,
    #[msg("Fee or slippage basis points are outside configured bounds")]
    InvalidBasisPoints,
    #[msg("Basket items are missing, duplicated, too many, or malformed")]
    InvalidBasketItems,
    #[msg("Basket item weights must sum to 10000 bps")]
    InvalidBasketWeights,
    #[msg("A basket item exceeds the per-market weight cap")]
    MarketWeightExceeded,
    #[msg("Basket status does not allow this action")]
    InvalidBasketStatus,
    #[msg("Only perpetual baskets can be reconstituted")]
    BasketNotPerpetual,
    #[msg("User intent signature instruction is missing")]
    MissingIntentSignature,
    #[msg("User intent signature instruction is malformed")]
    MalformedIntentSignature,
    #[msg("Intent signature was produced by the wrong user")]
    UnauthorizedIntentSigner,
    #[msg("Signed user intent does not match the completion")]
    IntentSignatureMismatch,
    #[msg("User intent has expired")]
    IntentExpired,
    #[msg("User intent nonce must be exactly the next position nonce")]
    IntentNonceMismatch,
    #[msg("Position belongs to a different basket or user")]
    PositionMismatch,
    #[msg("This deposit would exceed the 10,000 USDC basket cap")]
    BasketDepositLimitExceeded,
    #[msg("This deposit would exceed the 500 USDC per-user basket cap")]
    UserDepositLimitExceeded,
    #[msg("Insufficient shares")]
    InsufficientShares,
    #[msg("Position has reached the maximum number of deposit lots")]
    TooManyDepositLots,
    #[msg("Completion uses a stale composition version")]
    CompositionVersionMismatch,
    #[msg("Protocol fee does not match basket rules")]
    FeeMismatch,
    #[msg("Settlement result is below the user's minimum accepted value")]
    SlippageExceeded,
    #[msg("Minimum output does not enforce the requested slippage tolerance")]
    InvalidMinimumOutput,
    #[msg("Settlement values are internally inconsistent")]
    InvalidSettlementValues,
    #[msg("Credited shares do not match net value and share price")]
    ShareArithmeticMismatch,
    #[msg("Share price does not match the supplied basket NAV and outstanding shares")]
    SharePriceMismatch,
    #[msg("Settlement nonce must increase for every basket completion")]
    SettlementNonceNotIncreasing,
    #[msg("Composition nonce must increase for every basket composition")]
    CompositionNonceNotIncreasing,
    #[msg("Final settlement snapshot does not match outstanding shares")]
    FinalSnapshotMismatch,
    #[msg("Creator performance fee does not match realized profit")]
    CreatorFeeMismatch,
    #[msg("Management-fee catch-up exceeds the supported safety bound")]
    ManagementFeeCatchUpTooLarge,
    #[msg("Requested protocol fee shares exceed the accrued balance")]
    InsufficientProtocolFeeShares,
    #[msg("Arithmetic overflow or underflow")]
    MathOverflow,
}
