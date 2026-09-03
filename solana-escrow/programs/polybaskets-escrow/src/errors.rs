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
    #[msg("Selected prediction market is absent from the signed eligibility list")]
    MarketNotEligible,
    #[msg("Eligibility list is malformed, stale, or does not match its hash")]
    InvalidEligibilityList,
    #[msg("Spot token is not enabled in the on-chain allowlist")]
    TokenNotAllowlisted,
    #[msg("Token allowlist metadata is invalid")]
    InvalidTokenMetadata,
    #[msg("Signed spot-price attestation is malformed, stale, or unsupported")]
    InvalidPriceAttestation,
    #[msg("Spot-price attestation nonce must increase")]
    PriceAttestationNonceNotIncreasing,
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
    #[msg("Insufficient shares")]
    InsufficientShares,
    #[msg("The initial $1 share price has already been consumed")]
    SharePriceAlreadyInitialized,
    #[msg("Completion uses a stale composition version")]
    CompositionVersionMismatch,
    #[msg("Protocol fee does not match basket rules")]
    FeeMismatch,
    #[msg("Settlement result exceeds the protocol or user slippage limit")]
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
    #[msg("Execution batch uses an unsupported encoding version")]
    InvalidExecutionVersion,
    #[msg("Execution timestamp must be a valid past or current Unix timestamp")]
    InvalidExecutionTimestamp,
    #[msg("Requested protocol fee shares exceed the accrued balance")]
    InsufficientProtocolFeeShares,
    #[msg("Arithmetic overflow or underflow")]
    MathOverflow,

    // --- Phoenix perpetuals ------------------------------------------------
    #[msg("A perpetual basket may not contain spot or prediction-market items")]
    MixedAssetClassBasket,
    #[msg("Phoenix subaccount 0 is cross-margin and may never hold a position")]
    SubaccountZeroNotAllowed,
    #[msg("Recorded leverage is outside the supported bounds")]
    PerpLeverageOutOfBounds,
    #[msg("Perp eligibility list is malformed, stale, or does not match its hash")]
    InvalidPerpEligibilityList,
    #[msg("Basket composition contains no perpetual item for this market")]
    MarketNotInComposition,
    #[msg("Composition item names a different Phoenix subaccount than the trade")]
    SubaccountMismatch,
    #[msg("Trader registry does not belong to this execution wallet")]
    TraderRegistryMismatch,
    #[msg("Phoenix trader PDA index is not the supported user index")]
    UnsupportedTraderPdaIndex,
    #[msg("Recorded entry mark price must be non-zero when opening a position")]
    ZeroEntryMarkPrice,
    #[msg("Recorded margin must be non-zero when opening a position")]
    ZeroMarginPosted,
    #[msg("Phoenix execution timestamp is too old to settle")]
    StalePerpExecution,
    #[msg("Phoenix event timestamp is too old to attest")]
    StalePerpAttestation,
    #[msg("Timestamp is further in the future than clock skew allows")]
    TimestampInFuture,
    #[msg("Referenced basket does not match the basket this record belongs to")]
    MismatchedBasket,
    #[msg("Market identifier exceeds the maximum supported length")]
    MarketIdTooLong,
}
