use anchor_lang::prelude::*;
use protocol_core::CoreError;

/// Program errors. The first block mirrors `protocol_core::CoreError`
/// one-to-one so a failing check reports the same name on-chain as in the
/// crates; program-only errors follow.
#[error_code]
#[derive(PartialEq, Eq)]
pub enum KryonError {
    MathOverflow,
    DivisionByZero,
    InvalidAmount,
    InvalidPrice,
    InvalidConfig,
    StaleOracle,
    OracleConfidenceTooWide,
    AccountInsolvent,
    InsufficientCollateral,
    NotLiquidatable,
    Unauthorized,
    AlreadyInitialized,
    AssetDisabled,
    PositionNotFound,
    DirectionMismatch,
    PriceOutsideBand,
    OpenInterestExceeded,
    LiquidationWouldNotImproveHealth,
    InsuranceFundInsufficient,
    OrderExpired,
    OrderCancelled,
    OrderOverfilled,
    SelfTrade,
    OracleQuorumNotMet,
    OracleDeviationTooWide,
    DuplicateOracleSource,
    TooManyPositions,
    DepositCapExceeded,
    IsolatedMarginDisabled,
    AggregateOiPolicyExceeded,
    NoBadDebtToOffset,
    PositionNotInProfit,

    // --- program-only ---
    #[msg("The exchange is paused")]
    Paused,
    #[msg("Signer is not an operator")]
    NotOperator,
    #[msg("No pending admin, or signer is not it")]
    NotPendingAdmin,
    #[msg("Only the program upgrade authority may initialize the exchange")]
    NotUpgradeAuthority,
    #[msg("Collateral balance slots are full")]
    TooManyBalances,
    #[msg("A settlement collateral already exists")]
    SettlementCollateralExists,
    #[msg("Mint has a Token-2022 extension we do not support")]
    UnsupportedMintExtension,
    #[msg("The vault did not receive the exact amount")]
    TransferAmountMismatch,
    #[msg("Remaining accounts do not match what the health check needs")]
    InvalidRemainingAccounts,
    #[msg("Oracle account is not the expected Pyth feed account")]
    InvalidOracleAccount,
    #[msg("Oracle update is not fully verified")]
    OracleNotFullyVerified,
    #[msg("Delegate expiry must be in the future")]
    InvalidDelegateExpiry,
    #[msg("Instruction is not an Ed25519 program instruction")]
    Ed25519WrongProgram,
    #[msg("Ed25519 instruction is malformed")]
    Ed25519Malformed,
    #[msg("Ed25519 offsets must point at the same instruction (u16::MAX)")]
    Ed25519OffsetIndex,
    #[msg("Ed25519 public key does not match the order signer")]
    Ed25519PubkeyMismatch,
    #[msg("Ed25519 message does not match the encoded order")]
    Ed25519MessageMismatch,
    #[msg("Order signer is neither the owner nor a live delegate")]
    InvalidOrderSigner,
    #[msg("Order domain does not match this exchange")]
    DomainMismatch,
    #[msg("Order flags have unknown bits set")]
    InvalidOrderFlags,
    #[msg("Reduce-only order would increase exposure")]
    ReduceOnlyViolation,
    #[msg("Session does not allow increasing exposure")]
    SessionExposureBlocked,
    #[msg("Order record is not reclaimable yet")]
    NotReclaimable,
    #[msg("Session window is invalid or rewrites the past")]
    InvalidSessionWindow,
    #[msg("User still has open positions or balances")]
    AccountNotEmpty,
    #[msg("A liquidatable account may only reduce at or better than the mark")]
    LiquidatableReduceOffMark,
    #[msg("post_mark is rate-limited per market")]
    PostMarkTooSoon,
    #[msg("Market is halted: a scheduled session with a stale oracle")]
    MarketHalted,
    #[msg("The insurance fund is not initialized")]
    InsuranceNotInitialized,
    #[msg("An unstake request is already pending")]
    UnstakePending,
    #[msg("Not enough shares")]
    InsufficientShares,
    #[msg("No pending unstake request")]
    NoPendingUnstake,
    #[msg("The unstake cooldown has not passed")]
    UnstakeLocked,
    #[msg("An owner cannot liquidate their own account")]
    SelfLiquidation,
}

impl From<CoreError> for KryonError {
    fn from(e: CoreError) -> Self {
        match e {
            CoreError::MathOverflow => Self::MathOverflow,
            CoreError::DivisionByZero => Self::DivisionByZero,
            CoreError::InvalidAmount => Self::InvalidAmount,
            CoreError::InvalidPrice => Self::InvalidPrice,
            CoreError::InvalidConfig => Self::InvalidConfig,
            CoreError::StaleOracle => Self::StaleOracle,
            CoreError::OracleConfidenceTooWide => Self::OracleConfidenceTooWide,
            CoreError::AccountInsolvent => Self::AccountInsolvent,
            CoreError::InsufficientCollateral => Self::InsufficientCollateral,
            CoreError::NotLiquidatable => Self::NotLiquidatable,
            CoreError::Unauthorized => Self::Unauthorized,
            CoreError::AlreadyInitialized => Self::AlreadyInitialized,
            CoreError::AssetDisabled => Self::AssetDisabled,
            CoreError::PositionNotFound => Self::PositionNotFound,
            CoreError::DirectionMismatch => Self::DirectionMismatch,
            CoreError::PriceOutsideBand => Self::PriceOutsideBand,
            CoreError::OpenInterestExceeded => Self::OpenInterestExceeded,
            CoreError::LiquidationWouldNotImproveHealth => Self::LiquidationWouldNotImproveHealth,
            CoreError::InsuranceFundInsufficient => Self::InsuranceFundInsufficient,
            CoreError::OrderExpired => Self::OrderExpired,
            CoreError::OrderCancelled => Self::OrderCancelled,
            CoreError::OrderOverfilled => Self::OrderOverfilled,
            CoreError::SelfTrade => Self::SelfTrade,
            CoreError::OracleQuorumNotMet => Self::OracleQuorumNotMet,
            CoreError::OracleDeviationTooWide => Self::OracleDeviationTooWide,
            CoreError::DuplicateOracleSource => Self::DuplicateOracleSource,
            CoreError::TooManyPositions => Self::TooManyPositions,
            CoreError::DepositCapExceeded => Self::DepositCapExceeded,
            CoreError::IsolatedMarginDisabled => Self::IsolatedMarginDisabled,
            CoreError::AggregateOiPolicyExceeded => Self::AggregateOiPolicyExceeded,
            CoreError::NoBadDebtToOffset => Self::NoBadDebtToOffset,
            CoreError::PositionNotInProfit => Self::PositionNotInProfit,
        }
    }
}

/// `?`-friendly conversion from a crate result.
pub trait CoreResultExt<T> {
    fn core(self) -> Result<T>;
}

impl<T> CoreResultExt<T> for core::result::Result<T, CoreError> {
    #[inline]
    fn core(self) -> Result<T> {
        self.map_err(|e| error!(KryonError::from(e)))
    }
}
