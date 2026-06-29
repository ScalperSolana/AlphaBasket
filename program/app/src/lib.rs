#![no_std]

use freebet_ledger_client::{
    FreebetLedger, FreebetLedgerProgram,
    freebet_ledger::FreebetLedger as FreebetLedgerServiceClient,
};
use parity_scale_codec::{Decode, Encode};
use sails_rs::client::Program as _;
use sails_rs::collections::BTreeMap;
use sails_rs::gstd::exec;
use sails_rs::prelude::*;
use scale_info::TypeInfo;
use schnorrkel::{PublicKey, Signature};

const MAX_ITEMS_PER_BASKET: usize = 32;
const MAX_NAME_LEN: usize = 128;
const MAX_AGENT_NAME_LEN: usize = 20;
const MIN_AGENT_NAME_LEN: usize = 3;
const AGENT_RENAME_COOLDOWN_MS: u64 = 7 * 24 * 60 * 60 * 1000;
const MAX_DESCRIPTION_LEN: usize = 512;
const MAX_MARKET_ID_LEN: usize = 128;
const MAX_SLUG_LEN: usize = 128;
const MAX_SETTLEMENT_PAYLOAD_LEN: usize = 4_096;
const MAX_MIGRATION_BATCH_SIZE: usize = 250;
const DEFAULT_BET_CUTOFF_MS: u64 = 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum Outcome {
    YES,
    NO,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum BasketStatus {
    Active,
    SettlementPending,
    Settled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum BasketAssetKind {
    Vara,
    Bet,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum SettlementStatus {
    Proposed,
    Finalized,
}

#[derive(Debug, Clone, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct BasketItem {
    pub poly_market_id: String,
    pub poly_slug: String,
    pub weight_bps: u16,
    pub selected_outcome: Outcome,
    pub end_timestamp: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct Basket {
    pub id: u64,
    pub creator: ActorId,
    pub name: String,
    pub description: String,
    pub items: Vec<BasketItem>,
    pub created_at: u64,
    pub status: BasketStatus,
    pub asset_kind: BasketAssetKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct Position {
    pub basket_id: u64,
    pub user: ActorId,
    pub shares: u128,
    pub claimed: bool,
    pub index_at_creation_bps: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct AgentInfo {
    pub address: ActorId,
    pub name: String,
    pub registered_at: u64,
    pub name_updated_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct ItemResolution {
    pub item_index: u8,
    pub resolved: Outcome,
    pub poly_slug: String,
    pub poly_condition_id: Option<String>,
    pub poly_price_yes: u16,
    pub poly_price_no: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct Settlement {
    pub basket_id: u64,
    pub proposer: ActorId,
    pub item_resolutions: Vec<ItemResolution>,
    pub payout_per_share: u128,
    pub payload: String,
    pub proposed_at: u64,
    pub challenge_deadline: u64,
    pub finalized_at: Option<u64>,
    pub status: SettlementStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct BasketMarketInit {
    pub admin_role: ActorId,
    pub settler_role: ActorId,
    pub liveness_ms: u64,
    pub quote_signer: ActorId,
    pub bet_cutoff_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct BasketMarketConfig {
    pub admin_role: ActorId,
    pub settler_role: ActorId,
    pub liveness_ms: u64,
    pub vara_enabled: bool,
    pub min_items_per_basket: u32,
    pub quote_signer: ActorId,
    pub bet_cutoff_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct VaraBetQuotePayload {
    pub target_program_id: ActorId,
    pub user: ActorId,
    pub basket_id: u64,
    pub amount: u128,
    pub quoted_index_bps: u16,
    pub earliest_end_timestamp: u64,
    pub deadline_ms: u64,
    pub nonce: u128,
}

#[derive(Debug, Clone, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct SignedVaraBetQuote {
    pub payload: VaraBetQuotePayload,
    pub signature: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum MigrationEntityKind {
    Baskets,
    Settlements,
    Positions,
    Agents,
}

#[derive(Debug, Clone, PartialEq, Eq, Encode, Decode, TypeInfo, thiserror::Error)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum BasketMarketError {
    #[error("access denied")]
    Unauthorized,
    #[error("basket market is paused")]
    Paused,
    #[error("migration import requires paused mode")]
    MigrationRequiresPause,
    #[error("migration batch is too large")]
    MigrationBatchTooLarge,
    #[error("basket not found")]
    BasketNotFound,
    #[error("basket is not active")]
    BasketNotActive,
    #[error("basket asset kind does not match this flow")]
    BasketAssetMismatch,
    #[error("basket must have at least one item")]
    NoItems,
    #[error("basket does not contain enough markets")]
    NotEnoughItems,
    #[error("basket weights must sum to exactly 10000 and each weight must be in range")]
    InvalidWeights,
    #[error("basket contains duplicate market/outcome items")]
    DuplicateBasketItem,
    #[error("basket has too many items")]
    TooManyItems,
    #[error("basket name is too long")]
    NameTooLong,
    #[error("basket description is too long")]
    DescriptionTooLong,
    #[error("market id is too long")]
    MarketIdTooLong,
    #[error("slug is too long")]
    SlugTooLong,
    #[error("settlement payload is too long")]
    PayloadTooLong,
    #[error("vara support is disabled")]
    VaraDisabled,
    #[error("settlement already exists")]
    SettlementAlreadyExists,
    #[error("settlement not found")]
    SettlementNotFound,
    #[error("settlement is not proposed")]
    SettlementNotProposed,
    #[error("settlement is not finalized")]
    SettlementNotFinalized,
    #[error("challenge deadline not passed")]
    ChallengeDeadlineNotPassed,
    #[error("index at creation must be between 1 and 10000")]
    InvalidIndexAtCreation,
    #[error("quote signer is not configured")]
    QuoteSignerNotConfigured,
    #[error("quote target program does not match")]
    QuoteTargetMismatch,
    #[error("quote user does not match caller")]
    QuoteUserMismatch,
    #[error("quote basket does not match call")]
    QuoteBasketMismatch,
    #[error("quote amount does not match call")]
    QuoteAmountMismatch,
    #[error("quote has expired")]
    QuoteExpired,
    #[error("quote nonce already used")]
    QuoteNonceAlreadyUsed,
    #[error("quote signature bytes are invalid")]
    InvalidQuoteSignature,
    #[error("quote signer public key is invalid")]
    InvalidQuoteSigner,
    #[error("quote verification failed")]
    QuoteVerificationFailed,
    #[error("basket is too close to market expiry")]
    BetCutoffReached,
    #[error("quote market expiry does not match basket")]
    QuoteExpiryMismatch,
    #[error("bet amount must be greater than zero")]
    InvalidBetAmount,
    #[error("freebet amount must be greater than zero")]
    InvalidFreebetAmount,
    #[error("item resolutions count does not match basket items")]
    InvalidResolutionCount,
    #[error("duplicate item_index in settlement resolutions")]
    DuplicateResolutionIndex,
    #[error("resolution item_index is out of bounds")]
    ResolutionIndexOutOfBounds,
    #[error("resolution slug does not match basket item")]
    ResolutionSlugMismatch,
    #[error("resolution price values must be within 0..=10000")]
    InvalidResolution,
    #[error("already claimed")]
    AlreadyClaimed,
    #[error("nothing to claim")]
    NothingToClaim,
    #[error("native payout transfer failed")]
    TransferFailed,
    #[error("freebet ledger is not configured")]
    FreebetLedgerNotConfigured,
    #[error("freebet ledger return failed")]
    FreebetLedgerReturnFailed,
    #[error("math overflow")]
    MathOverflow,
    #[error("event emission failed")]
    EventEmitFailed,
    #[error("invalid config")]
    InvalidConfig,
    #[error("agent name too short")]
    AgentNameTooShort,
    #[error("agent name too long")]
    AgentNameTooLong,
    #[error("agent name invalid")]
    AgentNameInvalid,
    #[error("agent name taken")]
    AgentNameTaken,
    #[error("rename cooldown active")]
    AgentRenameCooldown,
}

#[event]
#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum Event {
    BasketCreated {
        basket_id: u64,
        creator: ActorId,
        asset_kind: BasketAssetKind,
    },
    VaraBetPlaced {
        basket_id: u64,
        user: ActorId,
        amount: u128,
        user_total: u128,
        index_at_creation_bps: u16,
        quote_nonce: u128,
    },
    FreebetBetPlaced {
        basket_id: u64,
        user: ActorId,
        amount: u128,
        user_total: u128,
        index_at_creation_bps: u16,
        quote_nonce: u128,
    },
    SettlementProposed {
        basket_id: u64,
        asset_kind: BasketAssetKind,
        proposer: ActorId,
        payout_per_share: u128,
        challenge_deadline: u64,
    },
    SettlementFinalized {
        basket_id: u64,
        asset_kind: BasketAssetKind,
        finalized_at: u64,
        payout_per_share: u128,
    },
    Claimed {
        basket_id: u64,
        user: ActorId,
        amount: u128,
    },
    AdminVaraWithdrawn {
        to: ActorId,
        amount: u128,
    },
    AgentRegistered {
        agent: ActorId,
        name: String,
    },
    AgentRenamed {
        agent: ActorId,
        old_name: String,
        new_name: String,
    },
    VaraSupportUpdated {
        enabled: bool,
    },
    ConfigUpdated {
        config: BasketMarketConfig,
    },
    Paused,
    Resumed,
    MigrationBatchImported {
        entity: MigrationEntityKind,
        count: u32,
    },
}

#[derive(Debug, Clone, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct State {
    pub baskets: BTreeMap<u64, Basket>,
    pub positions: BTreeMap<(u64, ActorId), Position>,
    pub freebet_positions: BTreeMap<(u64, ActorId), Position>,
    pub freebet_ledger_id: ActorId,
    pub settlements: BTreeMap<u64, Settlement>,
    pub agents: Vec<AgentInfo>,
    pub next_basket_id: u64,
    pub paused: bool,
    pub config: BasketMarketConfig,
    pub used_quote_nonces: BTreeMap<(ActorId, u128), bool>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            baskets: BTreeMap::new(),
            positions: BTreeMap::new(),
            freebet_positions: BTreeMap::new(),
            freebet_ledger_id: ActorId::zero(),
            settlements: BTreeMap::new(),
            agents: Vec::new(),
            next_basket_id: 0,
            paused: false,
            config: BasketMarketConfig {
                admin_role: ActorId::zero(),
                settler_role: ActorId::zero(),
                liveness_ms: 86_400_000,
                vara_enabled: false,
                min_items_per_basket: 2,
                quote_signer: ActorId::zero(),
                bet_cutoff_ms: DEFAULT_BET_CUTOFF_MS,
            },
            used_quote_nonces: BTreeMap::new(),
        }
    }
}

struct BasketMarketService<'a> {
    state: &'a mut State,
}

impl<'a> BasketMarketService<'a> {
    pub fn new(state: &'a mut State) -> Self {
        Self { state }
    }

    fn basket(&self, basket_id: u64) -> Result<&Basket, BasketMarketError> {
        self.state
            .baskets
            .get(&basket_id)
            .ok_or(BasketMarketError::BasketNotFound)
    }

    fn basket_mut(&mut self, basket_id: u64) -> Result<&mut Basket, BasketMarketError> {
        self.state
            .baskets
            .get_mut(&basket_id)
            .ok_or(BasketMarketError::BasketNotFound)
    }

    fn settlement(&self, basket_id: u64) -> Result<&Settlement, BasketMarketError> {
        self.state
            .settlements
            .get(&basket_id)
            .ok_or(BasketMarketError::SettlementNotFound)
    }

    fn settlement_mut(&mut self, basket_id: u64) -> Result<&mut Settlement, BasketMarketError> {
        self.state
            .settlements
            .get_mut(&basket_id)
            .ok_or(BasketMarketError::SettlementNotFound)
    }

    fn position(&self, basket_id: u64, user: ActorId) -> Option<&Position> {
        self.state.positions.get(&(basket_id, user))
    }

    fn position_mut(&mut self, basket_id: u64, user: ActorId) -> Option<&mut Position> {
        self.state.positions.get_mut(&(basket_id, user))
    }

    fn freebet_position(&self, basket_id: u64, user: ActorId) -> Option<&Position> {
        self.state.freebet_positions.get(&(basket_id, user))
    }

    fn ensure_freebet_ledger(&self) -> Result<(), BasketMarketError> {
        let ledger_id = self.state.freebet_ledger_id;
        if ledger_id == ActorId::zero() {
            return Err(BasketMarketError::FreebetLedgerNotConfigured);
        }
        if sails_rs::gstd::msg::source() != ledger_id {
            return Err(BasketMarketError::Unauthorized);
        }

        Ok(())
    }

    fn ensure_admin(&self) -> Result<(), BasketMarketError> {
        if sails_rs::gstd::msg::source() != self.state.config.admin_role {
            return Err(BasketMarketError::Unauthorized);
        }

        Ok(())
    }

    fn ensure_settler(&self) -> Result<(), BasketMarketError> {
        if sails_rs::gstd::msg::source() != self.state.config.settler_role {
            return Err(BasketMarketError::Unauthorized);
        }

        Ok(())
    }

    fn ensure_not_paused(&self) -> Result<(), BasketMarketError> {
        if self.state.paused {
            Err(BasketMarketError::Paused)
        } else {
            Ok(())
        }
    }

    fn ensure_paused(&self) -> Result<(), BasketMarketError> {
        if self.state.paused {
            Ok(())
        } else {
            Err(BasketMarketError::MigrationRequiresPause)
        }
    }

    fn validate_config(config: &BasketMarketConfig) -> Result<(), BasketMarketError> {
        if config.admin_role == ActorId::zero()
            || config.settler_role == ActorId::zero()
            || config.min_items_per_basket == 0
            || config.min_items_per_basket as usize > MAX_ITEMS_PER_BASKET
            || config.quote_signer == ActorId::zero()
            || config.bet_cutoff_ms == 0
        {
            return Err(BasketMarketError::InvalidConfig);
        }

        Ok(())
    }

    fn validate_items(
        items: &[BasketItem],
        min_items_per_basket: u32,
        bet_cutoff_ms: u64,
    ) -> Result<(), BasketMarketError> {
        if items.is_empty() {
            return Err(BasketMarketError::NoItems);
        }
        if items.len() < min_items_per_basket as usize {
            return Err(BasketMarketError::NotEnoughItems);
        }
        if items.len() > MAX_ITEMS_PER_BASKET {
            return Err(BasketMarketError::TooManyItems);
        }

        let mut total_weight = 0u32;
        for (index, item) in items.iter().enumerate() {
            if item.weight_bps == 0 || item.weight_bps > 10_000 {
                return Err(BasketMarketError::InvalidWeights);
            }
            if item.poly_market_id.len() > MAX_MARKET_ID_LEN {
                return Err(BasketMarketError::MarketIdTooLong);
            }
            if item.poly_slug.len() > MAX_SLUG_LEN {
                return Err(BasketMarketError::SlugTooLong);
            }
            if item.end_timestamp <= exec::block_timestamp().saturating_add(bet_cutoff_ms) {
                return Err(BasketMarketError::BetCutoffReached);
            }
            if items.iter().skip(index + 1).any(|other| {
                other.poly_market_id == item.poly_market_id
                    && other.selected_outcome == item.selected_outcome
            }) {
                return Err(BasketMarketError::DuplicateBasketItem);
            }

            total_weight = total_weight
                .checked_add(item.weight_bps as u32)
                .ok_or(BasketMarketError::MathOverflow)?;
        }

        if total_weight != 10_000 {
            return Err(BasketMarketError::InvalidWeights);
        }

        Ok(())
    }

    fn validate_index_at_creation(index_at_creation_bps: u16) -> Result<(), BasketMarketError> {
        if !(1..=10_000).contains(&index_at_creation_bps) {
            return Err(BasketMarketError::InvalidIndexAtCreation);
        }

        Ok(())
    }

    fn earliest_end_timestamp(basket: &Basket) -> Result<u64, BasketMarketError> {
        basket
            .items
            .iter()
            .map(|item| item.end_timestamp)
            .min()
            .ok_or(BasketMarketError::NoItems)
    }

    fn ensure_bet_cutoff_open(
        basket: &Basket,
        configured_cutoff_ms: u64,
    ) -> Result<u64, BasketMarketError> {
        let earliest_end_timestamp = Self::earliest_end_timestamp(basket)?;
        let cutoff = earliest_end_timestamp
            .checked_sub(configured_cutoff_ms)
            .ok_or(BasketMarketError::BetCutoffReached)?;

        if exec::block_timestamp() >= cutoff {
            return Err(BasketMarketError::BetCutoffReached);
        }

        Ok(earliest_end_timestamp)
    }

    fn verify_vara_bet_quote(
        &self,
        caller: ActorId,
        basket: &Basket,
        amount: u128,
        signed_quote: &SignedVaraBetQuote,
    ) -> Result<VaraBetQuotePayload, BasketMarketError> {
        let quote_signer = self.state.config.quote_signer;
        if quote_signer == ActorId::zero() {
            return Err(BasketMarketError::QuoteSignerNotConfigured);
        }

        let payload = signed_quote.payload.clone();
        Self::validate_index_at_creation(payload.quoted_index_bps)?;

        if payload.target_program_id != exec::program_id() {
            return Err(BasketMarketError::QuoteTargetMismatch);
        }
        if payload.user != caller {
            return Err(BasketMarketError::QuoteUserMismatch);
        }
        if payload.basket_id != basket.id {
            return Err(BasketMarketError::QuoteBasketMismatch);
        }
        if payload.amount != amount {
            return Err(BasketMarketError::QuoteAmountMismatch);
        }
        if payload.deadline_ms < exec::block_timestamp() {
            return Err(BasketMarketError::QuoteExpired);
        }
        if self
            .state
            .used_quote_nonces
            .contains_key(&(caller, payload.nonce))
        {
            return Err(BasketMarketError::QuoteNonceAlreadyUsed);
        }

        let earliest_end_timestamp = Self::earliest_end_timestamp(basket)?;
        if payload.earliest_end_timestamp != earliest_end_timestamp {
            return Err(BasketMarketError::QuoteExpiryMismatch);
        }

        let message = Self::quote_signing_message(&payload);
        Self::verify_quote_signature(&signed_quote.signature, &message, quote_signer)?;

        Ok(payload)
    }

    fn quote_signing_message(payload: &VaraBetQuotePayload) -> Vec<u8> {
        let raw_payload = [b"BasketMarketVaraQuoteV1".encode(), payload.encode()].concat();
        let mut wrapped =
            Vec::with_capacity(b"<Bytes>".len() + raw_payload.len() + b"</Bytes>".len());
        wrapped.extend_from_slice(b"<Bytes>");
        wrapped.extend_from_slice(&raw_payload);
        wrapped.extend_from_slice(b"</Bytes>");
        wrapped
    }

    fn verify_quote_signature(
        signature: &[u8],
        message: &[u8],
        signer: ActorId,
    ) -> Result<(), BasketMarketError> {
        let signature = Signature::from_bytes(signature)
            .map_err(|_| BasketMarketError::InvalidQuoteSignature)?;
        let signer_bytes: [u8; 32] = signer.into();
        let public_key =
            PublicKey::from_bytes(&signer_bytes).map_err(|_| BasketMarketError::InvalidQuoteSigner)?;

        public_key
            .verify_simple(b"substrate", message, &signature)
            .map(|_| ())
            .map_err(|_| BasketMarketError::QuoteVerificationFailed)
    }

    fn consume_quote_nonce(
        &mut self,
        user: ActorId,
        nonce: u128,
    ) -> Result<(), BasketMarketError> {
        if self.state.used_quote_nonces.contains_key(&(user, nonce)) {
            return Err(BasketMarketError::QuoteNonceAlreadyUsed);
        }

        self.state.used_quote_nonces.insert((user, nonce), true);
        Ok(())
    }

    fn calculate_position_payout(
        position: &Position,
        payout_per_share: u128,
    ) -> Result<u128, BasketMarketError> {
        Self::validate_index_at_creation(position.index_at_creation_bps)?;
        if payout_per_share == 0 {
            return Ok(0);
        }

        position
            .shares
            .checked_mul(payout_per_share)
            .and_then(|value| value.checked_div(position.index_at_creation_bps as u128))
            .ok_or(BasketMarketError::MathOverflow)
    }

    fn add_position(
        positions: &mut BTreeMap<(u64, ActorId), Position>,
        basket_id: u64,
        user: ActorId,
        shares: u128,
        index_at_creation_bps: u16,
    ) -> Result<(u128, u16), BasketMarketError> {
        if let Some(position) = positions.get_mut(&(basket_id, user)) {
            let old_shares = position.shares;
            let user_total = old_shares
                .checked_add(shares)
                .ok_or(BasketMarketError::MathOverflow)?;

            let old_weighted_index = old_shares
                .checked_mul(position.index_at_creation_bps as u128)
                .ok_or(BasketMarketError::MathOverflow)?;
            let new_weighted_index = shares
                .checked_mul(index_at_creation_bps as u128)
                .ok_or(BasketMarketError::MathOverflow)?;
            let total_weighted_index = old_weighted_index
                .checked_add(new_weighted_index)
                .ok_or(BasketMarketError::MathOverflow)?;
            let average_index = total_weighted_index
                .checked_div(user_total)
                .ok_or(BasketMarketError::MathOverflow)?;
            let stored_index_at_creation_bps =
                u16::try_from(average_index).map_err(|_| BasketMarketError::MathOverflow)?;

            position.shares = user_total;
            position.index_at_creation_bps = stored_index_at_creation_bps;
            Ok((user_total, stored_index_at_creation_bps))
        } else {
            positions.insert(
                (basket_id, user),
                Position {
                    basket_id,
                    user,
                    shares,
                    claimed: false,
                    index_at_creation_bps,
                },
            );
            Ok((shares, index_at_creation_bps))
        }
    }

    fn agent_index(&self, address: ActorId) -> Option<usize> {
        self.state.agents.iter().position(|a| a.address == address)
    }

    fn is_agent_name_taken(&self, name: &str, exclude: Option<ActorId>) -> bool {
        self.state
            .agents
            .iter()
            .any(|a| a.name == name && exclude.map_or(true, |ex| a.address != ex))
    }

    fn validate_agent_name(name: &str) -> Result<(), BasketMarketError> {
        if name.len() < MIN_AGENT_NAME_LEN {
            return Err(BasketMarketError::AgentNameTooShort);
        }
        if name.len() > MAX_AGENT_NAME_LEN {
            return Err(BasketMarketError::AgentNameTooLong);
        }
        let bytes = name.as_bytes();
        if bytes[0] == b'-' || bytes[bytes.len() - 1] == b'-' {
            return Err(BasketMarketError::AgentNameInvalid);
        }
        for &b in bytes {
            if !(b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
                return Err(BasketMarketError::AgentNameInvalid);
            }
        }
        Ok(())
    }

    fn validate_basket_metadata(name: &str, description: &str) -> Result<(), BasketMarketError> {
        if name.len() > MAX_NAME_LEN {
            return Err(BasketMarketError::NameTooLong);
        }
        if description.len() > MAX_DESCRIPTION_LEN {
            return Err(BasketMarketError::DescriptionTooLong);
        }

        Ok(())
    }

    fn validate_resolution_prices(resolution: &ItemResolution) -> Result<(), BasketMarketError> {
        if resolution.poly_price_yes > 10_000 || resolution.poly_price_no > 10_000 {
            return Err(BasketMarketError::InvalidResolution);
        }

        Ok(())
    }

    fn validate_migration_batch_size<T>(items: &[T]) -> Result<u32, BasketMarketError> {
        if items.len() > MAX_MIGRATION_BATCH_SIZE {
            return Err(BasketMarketError::MigrationBatchTooLarge);
        }

        Ok(items.len() as u32)
    }

    fn calculate_payout_per_share(
        basket: &Basket,
        item_resolutions: &[ItemResolution],
    ) -> Result<u128, BasketMarketError> {
        if item_resolutions.len() != basket.items.len() {
            return Err(BasketMarketError::InvalidResolutionCount);
        }

        let mut seen = vec![false; basket.items.len()];
        let mut total_weight_value = 0u64;

        for resolution in item_resolutions {
            Self::validate_resolution_prices(resolution)?;

            let item_index = resolution.item_index as usize;
            let item = basket
                .items
                .get(item_index)
                .ok_or(BasketMarketError::ResolutionIndexOutOfBounds)?;

            if seen[item_index] {
                return Err(BasketMarketError::DuplicateResolutionIndex);
            }
            seen[item_index] = true;

            if resolution.poly_slug != item.poly_slug {
                return Err(BasketMarketError::ResolutionSlugMismatch);
            }

            let resolved_value = if resolution.resolved == item.selected_outcome {
                item.weight_bps as u64
            } else {
                0
            };

            total_weight_value = total_weight_value
                .checked_add(resolved_value)
                .ok_or(BasketMarketError::MathOverflow)?;
        }

        if seen.iter().any(|covered| !covered) {
            return Err(BasketMarketError::InvalidResolutionCount);
        }

        Ok(total_weight_value as u128)
    }

    fn freebet_ledger_actor(
        ledger_id: ActorId,
    ) -> sails_rs::client::Actor<FreebetLedgerProgram, sails_rs::client::GstdEnv> {
        FreebetLedgerProgram::client(ledger_id)
    }
}

#[sails_rs::service(events = Event)]
impl<'a> BasketMarketService<'a> {
    #[export(unwrap_result)]
    pub fn create_basket(
        &mut self,
        name: String,
        description: String,
        items: Vec<BasketItem>,
        asset_kind: BasketAssetKind,
    ) -> Result<u64, BasketMarketError> {
        self.ensure_not_paused()?;
        BasketMarketService::validate_basket_metadata(&name, &description)?;
        BasketMarketService::validate_items(
            &items,
            self.state.config.min_items_per_basket,
            self.state.config.bet_cutoff_ms,
        )?;

        if asset_kind == BasketAssetKind::Vara && !self.state.config.vara_enabled {
            return Err(BasketMarketError::VaraDisabled);
        }

        let creator = sails_rs::gstd::msg::source();
        let created_at = sails_rs::gstd::exec::block_timestamp();
        let basket_id = self.state.next_basket_id;

        self.state.baskets.insert(
            basket_id,
            Basket {
                id: basket_id,
                creator,
                name,
                description,
                items,
                created_at,
                status: BasketStatus::Active,
                asset_kind,
            },
        );
        self.state.next_basket_id = self
            .state
            .next_basket_id
            .checked_add(1)
            .ok_or(BasketMarketError::MathOverflow)?;

        self.emit_event(Event::BasketCreated {
            basket_id,
            creator,
            asset_kind,
        })
        .map_err(|_| BasketMarketError::EventEmitFailed)?;

        Ok(basket_id)
    }

    #[export(unwrap_result)]
    pub fn bet_on_basket(
        &mut self,
        basket_id: u64,
        signed_quote: SignedVaraBetQuote,
    ) -> Result<u128, BasketMarketError> {
        self.ensure_not_paused()?;
        let basket = self.basket(basket_id)?.clone();

        if basket.asset_kind != BasketAssetKind::Vara {
            return Err(BasketMarketError::BasketAssetMismatch);
        }
        if !self.state.config.vara_enabled {
            return Err(BasketMarketError::VaraDisabled);
        }
        if basket.status != BasketStatus::Active {
            return Err(BasketMarketError::BasketNotActive);
        }

        let value = sails_rs::gstd::msg::value();
        if value == 0 {
            return Err(BasketMarketError::InvalidBetAmount);
        }

        let user = sails_rs::gstd::msg::source();
        BasketMarketService::ensure_bet_cutoff_open(&basket, self.state.config.bet_cutoff_ms)?;
        let quote = self.verify_vara_bet_quote(user, &basket, value, &signed_quote)?;
        self.consume_quote_nonce(user, quote.nonce)?;
        let shares = value;
        let (user_total, stored_index_at_creation_bps) = BasketMarketService::add_position(
            &mut self.state.positions,
            basket_id,
            user,
            shares,
            quote.quoted_index_bps,
        )?;

        self.emit_event(Event::VaraBetPlaced {
            basket_id,
            user,
            amount: shares,
            user_total,
            index_at_creation_bps: stored_index_at_creation_bps,
            quote_nonce: quote.nonce,
        })
        .map_err(|_| BasketMarketError::EventEmitFailed)?;

        Ok(shares)
    }

    #[export(unwrap_result)]
    pub fn admin_withdraw_vara(
        &mut self,
        to: ActorId,
        amount: u128,
    ) -> Result<u128, BasketMarketError> {
        self.ensure_admin()?;
        if amount == 0 {
            return Err(BasketMarketError::InvalidBetAmount);
        }

        sails_rs::gstd::msg::send_bytes(to, b"", amount)
            .map_err(|_| BasketMarketError::TransferFailed)?;

        self.emit_event(Event::AdminVaraWithdrawn { to, amount })
            .map_err(|_| BasketMarketError::EventEmitFailed)?;

        Ok(amount)
    }

    #[export(unwrap_result)]
    pub fn bet_on_basket_from_freebet_ledger(
        &mut self,
        user: ActorId,
        basket_id: u64,
        signed_quote: SignedVaraBetQuote,
    ) -> Result<u128, BasketMarketError> {
        self.ensure_not_paused()?;
        self.ensure_freebet_ledger()?;
        let basket = self.basket(basket_id)?.clone();

        if basket.asset_kind != BasketAssetKind::Vara {
            return Err(BasketMarketError::BasketAssetMismatch);
        }
        if !self.state.config.vara_enabled {
            return Err(BasketMarketError::VaraDisabled);
        }
        if basket.status != BasketStatus::Active {
            return Err(BasketMarketError::BasketNotActive);
        }

        let amount = sails_rs::gstd::msg::value();
        if amount == 0 {
            return Err(BasketMarketError::InvalidFreebetAmount);
        }
        BasketMarketService::ensure_bet_cutoff_open(&basket, self.state.config.bet_cutoff_ms)?;
        let quote = self.verify_vara_bet_quote(user, &basket, amount, &signed_quote)?;
        self.consume_quote_nonce(user, quote.nonce)?;

        let (user_total, stored_index_at_creation_bps) = BasketMarketService::add_position(
            &mut self.state.freebet_positions,
            basket_id,
            user,
            amount,
            quote.quoted_index_bps,
        )?;

        self.emit_event(Event::FreebetBetPlaced {
            basket_id,
            user,
            amount,
            user_total,
            index_at_creation_bps: stored_index_at_creation_bps,
            quote_nonce: quote.nonce,
        })
        .map_err(|_| BasketMarketError::EventEmitFailed)?;

        Ok(amount)
    }

    #[export(unwrap_result)]
    pub fn propose_settlement(
        &mut self,
        basket_id: u64,
        item_resolutions: Vec<ItemResolution>,
        payload: String,
    ) -> Result<(), BasketMarketError> {
        self.ensure_not_paused()?;
        self.ensure_settler()?;
        if payload.len() > MAX_SETTLEMENT_PAYLOAD_LEN {
            return Err(BasketMarketError::PayloadTooLong);
        }

        let basket = self.basket(basket_id)?;
        if basket.status != BasketStatus::Active {
            return Err(BasketMarketError::BasketNotActive);
        }
        let asset_kind = basket.asset_kind;

        if self.state.settlements.contains_key(&basket_id) {
            return Err(BasketMarketError::SettlementAlreadyExists);
        }

        let payout_per_share =
            BasketMarketService::calculate_payout_per_share(basket, &item_resolutions)?;
        let proposed_at = sails_rs::gstd::exec::block_timestamp();
        let challenge_deadline = proposed_at
            .checked_add(self.state.config.liveness_ms)
            .ok_or(BasketMarketError::MathOverflow)?;
        let proposer = sails_rs::gstd::msg::source();

        self.state.settlements.insert(
            basket_id,
            Settlement {
                basket_id,
                proposer,
                item_resolutions,
                payout_per_share,
                payload,
                proposed_at,
                challenge_deadline,
                finalized_at: None,
                status: SettlementStatus::Proposed,
            },
        );
        self.basket_mut(basket_id)?.status = BasketStatus::SettlementPending;

        self.emit_event(Event::SettlementProposed {
            basket_id,
            asset_kind,
            proposer,
            payout_per_share,
            challenge_deadline,
        })
        .map_err(|_| BasketMarketError::EventEmitFailed)?;

        Ok(())
    }

    #[export(unwrap_result)]
    pub fn finalize_settlement(&mut self, basket_id: u64) -> Result<(), BasketMarketError> {
        self.ensure_not_paused()?;
        let now = sails_rs::gstd::exec::block_timestamp();
        let payout_per_share = {
            let settlement = self.settlement_mut(basket_id)?;

            if settlement.status != SettlementStatus::Proposed {
                return Err(BasketMarketError::SettlementNotProposed);
            }
            if now < settlement.challenge_deadline {
                return Err(BasketMarketError::ChallengeDeadlineNotPassed);
            }

            settlement.status = SettlementStatus::Finalized;
            settlement.finalized_at = Some(now);
            settlement.payout_per_share
        };

        let basket = self.basket_mut(basket_id)?;
        basket.status = BasketStatus::Settled;
        let asset_kind = basket.asset_kind;

        self.emit_event(Event::SettlementFinalized {
            basket_id,
            asset_kind,
            finalized_at: now,
            payout_per_share,
        })
        .map_err(|_| BasketMarketError::EventEmitFailed)?;

        Ok(())
    }

    #[export(unwrap_result)]
    pub async fn claim(&mut self, basket_id: u64) -> Result<u128, BasketMarketError> {
        self.ensure_not_paused()?;
        let basket = self.basket(basket_id)?;
        if basket.asset_kind != BasketAssetKind::Vara {
            return Err(BasketMarketError::BasketAssetMismatch);
        }

        let settlement = self.settlement(basket_id)?;
        if settlement.status != SettlementStatus::Finalized {
            return Err(BasketMarketError::SettlementNotFinalized);
        }

        let user = sails_rs::gstd::msg::source();
        let payout_per_share = settlement.payout_per_share;
        let native_position = self.position(basket_id, user).cloned();
        let freebet_position = self.freebet_position(basket_id, user).cloned();

        if native_position.is_none() && freebet_position.is_none() {
            return Err(BasketMarketError::NothingToClaim);
        }

        let native_claimed = native_position
            .as_ref()
            .map(|position| position.claimed)
            .unwrap_or(true);
        let freebet_claimed = freebet_position
            .as_ref()
            .map(|position| position.claimed)
            .unwrap_or(true);
        if native_claimed && freebet_claimed {
            return Err(BasketMarketError::AlreadyClaimed);
        }

        let native_payout = if let Some(position) = native_position.as_ref() {
            if position.claimed {
                0
            } else {
                BasketMarketService::calculate_position_payout(position, payout_per_share)?
            }
        } else {
            0
        };

        let (freebet_credit_return, freebet_profit) =
            if let Some(position) = freebet_position.as_ref() {
                if position.claimed {
                    (0, 0)
                } else {
                    let gross =
                        BasketMarketService::calculate_position_payout(position, payout_per_share)?;
                    (
                        gross.min(position.shares),
                        gross.saturating_sub(position.shares),
                    )
                }
            } else {
                (0, 0)
            };

        let payout = native_payout
            .checked_add(freebet_profit)
            .ok_or(BasketMarketError::MathOverflow)?;

        if freebet_credit_return > 0 {
            let ledger_id = self.state.freebet_ledger_id;
            if ledger_id == ActorId::zero() {
                return Err(BasketMarketError::FreebetLedgerNotConfigured);
            } else {
                BasketMarketService::freebet_ledger_actor(ledger_id)
                    .freebet_ledger()
                    .return_freebet(user, basket_id)
                    .with_value(freebet_credit_return)
                    .await
                    .map_err(|_| BasketMarketError::FreebetLedgerReturnFailed)?;
            }
        }
        if payout > 0 {
            sails_rs::gstd::msg::send_bytes(user, b"", payout)
                .map_err(|_| BasketMarketError::TransferFailed)?;
        }

        if let Some(position) = self.position_mut(basket_id, user) {
            if !position.claimed {
                position.claimed = true;
            }
        }
        if let Some(position) = self.state.freebet_positions.get_mut(&(basket_id, user)) {
            if !position.claimed {
                position.claimed = true;
            }
        }
        self.emit_event(Event::Claimed {
            basket_id,
            user,
            amount: payout,
        })
        .map_err(|_| BasketMarketError::EventEmitFailed)?;

        Ok(payout)
    }

    /// Register an agent with a display name, or rename if already registered.
    /// Input is normalized to lowercase. Names must be 3-20 chars, alphanumeric
    /// and hyphens only, no leading/trailing hyphens. Rename has a 7-day cooldown.
    #[export(unwrap_result)]
    pub fn register_agent(&mut self, name: String) -> Result<(), BasketMarketError> {
        self.ensure_not_paused()?;
        let name = name.to_ascii_lowercase();
        BasketMarketService::validate_agent_name(&name)?;

        let caller = sails_rs::gstd::msg::source();
        let now = sails_rs::gstd::exec::block_timestamp();

        if let Some(idx) = self.agent_index(caller) {
            let agent = &self.state.agents[idx];
            // No-op if renaming to the same name
            if agent.name == name {
                return Ok(());
            }
            if now < agent.name_updated_at + AGENT_RENAME_COOLDOWN_MS {
                return Err(BasketMarketError::AgentRenameCooldown);
            }
            if self.is_agent_name_taken(&name, Some(caller)) {
                return Err(BasketMarketError::AgentNameTaken);
            }
            let old_name = self.state.agents[idx].name.clone();
            self.state.agents[idx].name = name.clone();
            self.state.agents[idx].name_updated_at = now;
            self.emit_event(Event::AgentRenamed {
                agent: caller,
                old_name,
                new_name: name,
            })
            .map_err(|_| BasketMarketError::EventEmitFailed)?;
        } else {
            if self.is_agent_name_taken(&name, None) {
                return Err(BasketMarketError::AgentNameTaken);
            }
            self.state.agents.push(AgentInfo {
                address: caller,
                name: name.clone(),
                registered_at: now,
                name_updated_at: now,
            });
            self.emit_event(Event::AgentRegistered {
                agent: caller,
                name,
            })
            .map_err(|_| BasketMarketError::EventEmitFailed)?;
        }

        Ok(())
    }

    #[export]
    pub fn get_agent(&self, address: ActorId) -> Option<AgentInfo> {
        self.state
            .agents
            .iter()
            .find(|a| a.address == address)
            .cloned()
    }

    #[export]
    pub fn get_all_agents(&self) -> Vec<AgentInfo> {
        self.state.agents.clone()
    }

    #[export]
    pub fn get_agent_count(&self) -> u64 {
        self.state.agents.len() as u64
    }

    #[export]
    pub fn get_basket(&self, basket_id: u64) -> Result<Basket, BasketMarketError> {
        Ok(self.basket(basket_id)?.clone())
    }

    #[export]
    pub fn get_positions(&self, user: ActorId) -> Vec<Position> {
        self.state
            .positions
            .values()
            .filter(|position| position.user == user)
            .cloned()
            .collect()
    }

    #[export]
    pub fn get_freebet_ledger(&self) -> ActorId {
        self.state.freebet_ledger_id
    }

    #[export(unwrap_result)]
    pub fn set_freebet_ledger(&mut self, ledger_id: ActorId) -> Result<(), BasketMarketError> {
        self.ensure_admin()?;
        if ledger_id == ActorId::zero() {
            return Err(BasketMarketError::InvalidConfig);
        }
        self.state.freebet_ledger_id = ledger_id;
        self.emit_event(Event::ConfigUpdated {
            config: self.state.config.clone(),
        })
        .map_err(|_| BasketMarketError::EventEmitFailed)?;
        Ok(())
    }

    #[export]
    pub fn get_freebet_positions(&self, user: ActorId) -> Vec<Position> {
        self.state
            .freebet_positions
            .values()
            .filter(|position| position.user == user)
            .cloned()
            .collect()
    }

    #[export]
    pub fn get_settlement(&self, basket_id: u64) -> Result<Settlement, BasketMarketError> {
        Ok(self.settlement(basket_id)?.clone())
    }

    #[export]
    pub fn get_basket_count(&self) -> u64 {
        self.state.baskets.len() as u64
    }

    #[export]
    pub fn is_paused(&self) -> bool {
        self.state.paused
    }

    #[export]
    pub fn get_config(&self) -> BasketMarketConfig {
        self.state.config.clone()
    }

    #[export]
    pub fn is_vara_enabled(&self) -> bool {
        self.state.config.vara_enabled
    }

    #[export(unwrap_result)]
    pub fn set_vara_enabled(&mut self, enabled: bool) -> Result<(), BasketMarketError> {
        self.ensure_admin()?;
        self.state.config.vara_enabled = enabled;
        self.emit_event(Event::VaraSupportUpdated { enabled })
            .map_err(|_| BasketMarketError::EventEmitFailed)?;
        Ok(())
    }

    #[export(unwrap_result)]
    pub fn set_config(&mut self, config: BasketMarketConfig) -> Result<(), BasketMarketError> {
        self.ensure_admin()?;
        BasketMarketService::validate_config(&config)?;

        let vara_enabled_changed = self.state.config.vara_enabled != config.vara_enabled;
        self.state.config = config.clone();

        self.emit_event(Event::ConfigUpdated {
            config: config.clone(),
        })
        .map_err(|_| BasketMarketError::EventEmitFailed)?;

        if vara_enabled_changed {
            self.emit_event(Event::VaraSupportUpdated {
                enabled: config.vara_enabled,
            })
            .map_err(|_| BasketMarketError::EventEmitFailed)?;
        }

        Ok(())
    }

    #[export(unwrap_result)]
    pub fn pause(&mut self) -> Result<(), BasketMarketError> {
        self.ensure_admin()?;
        if !self.state.paused {
            self.state.paused = true;
            self.emit_event(Event::Paused)
                .map_err(|_| BasketMarketError::EventEmitFailed)?;
        }
        Ok(())
    }

    #[export(unwrap_result)]
    pub fn resume(&mut self) -> Result<(), BasketMarketError> {
        self.ensure_admin()?;
        if self.state.paused {
            self.state.paused = false;
            self.emit_event(Event::Resumed)
                .map_err(|_| BasketMarketError::EventEmitFailed)?;
        }
        Ok(())
    }

    #[export(unwrap_result)]
    pub fn import_baskets(&mut self, baskets: Vec<Basket>) -> Result<u32, BasketMarketError> {
        self.ensure_admin()?;
        self.ensure_paused()?;
        let count = BasketMarketService::validate_migration_batch_size(&baskets)?;

        for basket in baskets {
            self.state.next_basket_id = self.state.next_basket_id.max(basket.id.saturating_add(1));
            self.state.baskets.insert(basket.id, basket);
        }

        self.emit_event(Event::MigrationBatchImported {
            entity: MigrationEntityKind::Baskets,
            count,
        })
        .map_err(|_| BasketMarketError::EventEmitFailed)?;

        Ok(count)
    }

    #[export(unwrap_result)]
    pub fn import_settlements(
        &mut self,
        settlements: Vec<Settlement>,
    ) -> Result<u32, BasketMarketError> {
        self.ensure_admin()?;
        self.ensure_paused()?;
        let count = BasketMarketService::validate_migration_batch_size(&settlements)?;

        for settlement in settlements {
            self.state
                .settlements
                .insert(settlement.basket_id, settlement);
        }

        self.emit_event(Event::MigrationBatchImported {
            entity: MigrationEntityKind::Settlements,
            count,
        })
        .map_err(|_| BasketMarketError::EventEmitFailed)?;

        Ok(count)
    }

    #[export(unwrap_result)]
    pub fn import_positions(&mut self, positions: Vec<Position>) -> Result<u32, BasketMarketError> {
        self.ensure_admin()?;
        self.ensure_paused()?;
        let count = BasketMarketService::validate_migration_batch_size(&positions)?;

        for position in positions {
            self.state
                .positions
                .insert((position.basket_id, position.user), position);
        }

        self.emit_event(Event::MigrationBatchImported {
            entity: MigrationEntityKind::Positions,
            count,
        })
        .map_err(|_| BasketMarketError::EventEmitFailed)?;

        Ok(count)
    }

    #[export(unwrap_result)]
    pub fn import_agents(&mut self, agents: Vec<AgentInfo>) -> Result<u32, BasketMarketError> {
        self.ensure_admin()?;
        self.ensure_paused()?;
        let count = BasketMarketService::validate_migration_batch_size(&agents)?;

        for imported in agents {
            if let Some(existing) = self
                .state
                .agents
                .iter_mut()
                .find(|agent| agent.address == imported.address)
            {
                *existing = imported;
            } else {
                self.state.agents.push(imported);
            }
        }

        self.emit_event(Event::MigrationBatchImported {
            entity: MigrationEntityKind::Agents,
            count,
        })
        .map_err(|_| BasketMarketError::EventEmitFailed)?;

        Ok(count)
    }
}

pub struct BasketMarketProgram {
    state: State,
}

#[sails_rs::program]
impl BasketMarketProgram {
    pub fn new(init: BasketMarketInit) -> Self {
        BasketMarketService::validate_config(&BasketMarketConfig {
            admin_role: init.admin_role,
            settler_role: init.settler_role,
            liveness_ms: init.liveness_ms,
                vara_enabled: false,
                min_items_per_basket: 2,
                quote_signer: init.quote_signer,
                bet_cutoff_ms: init.bet_cutoff_ms,
            })
        .expect("invalid initial config");

        Self {
            state: State {
                baskets: BTreeMap::new(),
                positions: BTreeMap::new(),
                freebet_positions: BTreeMap::new(),
                freebet_ledger_id: ActorId::zero(),
                settlements: BTreeMap::new(),
                agents: Vec::new(),
                next_basket_id: 0,
                paused: false,
                config: BasketMarketConfig {
                    admin_role: init.admin_role,
                    settler_role: init.settler_role,
                    liveness_ms: init.liveness_ms,
                    vara_enabled: false,
                    min_items_per_basket: 2,
                    quote_signer: init.quote_signer,
                    bet_cutoff_ms: init.bet_cutoff_ms,
                },
                used_quote_nonces: BTreeMap::new(),
            },
        }
    }

    pub fn basket_market(&mut self) -> BasketMarketService<'_> {
        BasketMarketService::new(&mut self.state)
    }
}
