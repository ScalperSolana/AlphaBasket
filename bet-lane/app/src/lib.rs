#![no_std]

use awesome_sails_access_control::{AccessControl, DEFAULT_ADMIN_ROLE, RoleId, RolesStorage};
use awesome_sails_storage::{InfallibleStorage, InfallibleStorageMut, StorageRefCell};
use awesome_sails_utils::pause::Pause;
use bet_token_client::{BetTokenClient, BetTokenClientProgram, bet_token::BetToken};
use polymarket_mirror_client::{
    BasketAssetKind as MirrorBasketAssetKind, BasketStatus as MirrorBasketStatus, PolymarketMirror,
    PolymarketMirrorProgram, SettlementStatus as MirrorSettlementStatus,
    basket_market::BasketMarket,
};
use sails_rs::client::Program as _;
use sails_rs::gstd::{exec, services::Service};
use sails_rs::prelude::*;
use sails_rs::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
};
use schnorrkel::{PublicKey, Signature};

pub const PAUSER_ROLE: RoleId = [1u8; 32];
pub const CONFIG_ROLE: RoleId = [2u8; 32];

const MAX_PAGE_SIZE: u32 = 100;
const MAX_MIGRATION_BATCH_SIZE: usize = 250;

#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct BetLaneConfig {
    pub min_bet: U256,
    pub max_bet: U256,
    pub payouts_allowed_while_paused: bool,
    pub quote_signer: ActorId,
}

#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct BetLaneDependencies {
    pub basket_program_id: ActorId,
    pub bet_token_id: ActorId,
}

impl Default for BetLaneConfig {
    fn default() -> Self {
        Self {
            min_bet: 10.into(),
            max_bet: 10_000.into(),
            payouts_allowed_while_paused: true,
            quote_signer: ActorId::zero(),
        }
    }
}

impl BetLaneConfig {
    fn validate(&self) -> Result<(), BetLaneError> {
        if self.min_bet.is_zero() || self.max_bet.is_zero() || self.min_bet > self.max_bet {
            return Err(BetLaneError::InvalidConfig);
        }

        Ok(())
    }
}

impl BetLaneDependencies {
    fn validate(&self) -> Result<(), BetLaneError> {
        if self.basket_program_id == ActorId::zero() || self.bet_token_id == ActorId::zero() {
            return Err(BetLaneError::InvalidConfig);
        }

        Ok(())
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct Position {
    pub shares: U256,
    pub claimed: bool,
    pub index_at_creation_bps: u16,
}

#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct UserPositionView {
    pub basket_id: u64,
    pub position: Position,
}

#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct BetQuotePayload {
    pub target_program_id: ActorId,
    pub user: ActorId,
    pub basket_id: u64,
    pub amount: U256,
    pub quoted_index_bps: u16,
    pub deadline_ms: u64,
    pub nonce: u128,
}

#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct SignedBetQuote {
    pub payload: BetQuotePayload,
    pub signature: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct ImportedPosition {
    pub basket_id: u64,
    pub user: ActorId,
    pub shares: U256,
    pub claimed: bool,
    pub index_at_creation_bps: u16,
}

#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct ImportedQuoteNonce {
    pub user: ActorId,
    pub nonce: u128,
}

#[derive(Debug, Default)]
pub struct PositionStore {
    positions: BTreeMap<(u64, ActorId), Position>,
}

#[derive(Debug, Default)]
pub struct UsedQuoteNonceStore {
    nonces: BTreeSet<(ActorId, u128)>,
}

#[derive(Debug, Default)]
pub struct PendingOperations {
    pending_bets: BTreeSet<(u64, ActorId)>,
    pending_claims: BTreeSet<(u64, ActorId)>,
}

#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo, thiserror::Error)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum BetLaneError {
    #[error("access denied")]
    AccessDenied,
    #[error("bet lane is paused")]
    Paused,
    #[error("invalid configuration")]
    InvalidConfig,
    #[error("amount must be greater than zero")]
    InvalidAmount,
    #[error("amount is below min bet")]
    AmountBelowMinBet,
    #[error("amount is above max bet")]
    AmountAboveMaxBet,
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
    #[error("basket query failed")]
    BasketQueryFailed,
    #[error("basket not found")]
    BasketNotFound,
    #[error("basket is not active")]
    BasketNotActive,
    #[error("basket does not accept BET")]
    BasketAssetMismatch,
    #[error("settlement query failed")]
    SettlementQueryFailed,
    #[error("settlement not found")]
    SettlementNotFound,
    #[error("settlement not finalized")]
    SettlementNotFinalized,
    #[error("nothing to claim")]
    NothingToClaim,
    #[error("already claimed")]
    AlreadyClaimed,
    #[error("operation already in progress")]
    OperationInProgress,
    #[error("bet token transfer_from failed")]
    BetTokenTransferFromFailed,
    #[error("bet token payout transfer failed")]
    BetTokenPayoutFailed,
    #[error("bet token refund transfer failed")]
    BetTokenRefundFailed,
    #[error("math overflow")]
    MathOverflow,
    #[error("page size is invalid")]
    InvalidPageSize,
    #[error("event emission failed")]
    EventEmitFailed,
    #[error("role management failed")]
    RoleManagementFailed,
    #[error("migration import requires paused mode")]
    MigrationRequiresPause,
    #[error("migration batch is too large")]
    MigrationBatchTooLarge,
}

pub struct BetLaneService<'a> {
    roles: StorageRefCell<'a, RolesStorage>,
    access_control: awesome_sails_access_control::AccessControlExposure<
        AccessControl<'a, StorageRefCell<'a, RolesStorage>>,
    >,
    basket_program_id: StorageRefCell<'a, ActorId>,
    bet_token_id: StorageRefCell<'a, ActorId>,
    config: StorageRefCell<'a, BetLaneConfig>,
    positions: StorageRefCell<'a, PositionStore>,
    used_quote_nonces: StorageRefCell<'a, UsedQuoteNonceStore>,
    pending_operations: StorageRefCell<'a, PendingOperations>,
    pause: &'a Pause,
}

impl<'a> BetLaneService<'a> {
    pub fn new(
        roles: StorageRefCell<'a, RolesStorage>,
        access_control: awesome_sails_access_control::AccessControlExposure<
            AccessControl<'a, StorageRefCell<'a, RolesStorage>>,
        >,
        basket_program_id: StorageRefCell<'a, ActorId>,
        bet_token_id: StorageRefCell<'a, ActorId>,
        config: StorageRefCell<'a, BetLaneConfig>,
        positions: StorageRefCell<'a, PositionStore>,
        used_quote_nonces: StorageRefCell<'a, UsedQuoteNonceStore>,
        pending_operations: StorageRefCell<'a, PendingOperations>,
        pause: &'a Pause,
    ) -> Self {
        Self {
            roles,
            access_control,
            basket_program_id,
            bet_token_id,
            config,
            positions,
            used_quote_nonces,
            pending_operations,
            pause,
        }
    }
}

#[service(events = Event)]
impl<'a> BetLaneService<'a> {
    #[export]
    pub fn basket_program_id(&self) -> ActorId {
        *InfallibleStorage::get(&self.basket_program_id)
    }

    #[export]
    pub fn bet_token_id(&self) -> ActorId {
        *InfallibleStorage::get(&self.bet_token_id)
    }

    #[export]
    pub fn get_config(&self) -> BetLaneConfig {
        InfallibleStorage::get(&self.config).clone()
    }

    #[export]
    pub fn quote_signer(&self) -> ActorId {
        InfallibleStorage::get(&self.config).quote_signer
    }

    #[export]
    pub fn get_dependencies(&self) -> BetLaneDependencies {
        BetLaneDependencies {
            basket_program_id: *InfallibleStorage::get(&self.basket_program_id),
            bet_token_id: *InfallibleStorage::get(&self.bet_token_id),
        }
    }

    #[export]
    pub fn is_paused(&self) -> bool {
        self.pause.is_paused()
    }

    #[export]
    pub fn get_position(&self, user: ActorId, basket_id: u64) -> Position {
        InfallibleStorage::get(&self.positions)
            .positions
            .get(&(basket_id, user))
            .cloned()
            .unwrap_or_default()
    }

    #[export]
    pub fn is_quote_nonce_used(&self, user: ActorId, nonce: u128) -> bool {
        InfallibleStorage::get(&self.used_quote_nonces)
            .nonces
            .contains(&(user, nonce))
    }

    #[export]
    pub fn get_positions(
        &self,
        user: ActorId,
        offset: u32,
        limit: u32,
    ) -> Result<Vec<UserPositionView>, BetLaneError> {
        Self::validate_page_size(limit)?;

        let result = InfallibleStorage::get(&self.positions)
            .positions
            .iter()
            .filter(|((_, account), position)| *account == user && !position.shares.is_zero())
            .skip(offset as usize)
            .take(limit as usize)
            .map(|((basket_id, _), position)| UserPositionView {
                basket_id: *basket_id,
                position: position.clone(),
            })
            .collect();

        Ok(result)
    }

    #[export]
    pub fn get_position_count(&self) -> u64 {
        InfallibleStorage::get(&self.positions).positions.len() as u64
    }

    #[export]
    pub fn get_used_quote_nonce_count(&self) -> u64 {
        InfallibleStorage::get(&self.used_quote_nonces).nonces.len() as u64
    }

    #[export(unwrap_result)]
    pub async fn place_bet(
        &mut self,
        basket_id: u64,
        amount: U256,
        signed_quote: SignedBetQuote,
    ) -> Result<U256, BetLaneError> {
        self.ensure_not_paused()?;
        self.validate_bet_amount(amount)?;
        let caller = Syscall::message_source();
        let verified_quote = self.verify_bet_quote(caller, basket_id, amount, &signed_quote)?;

        let basket = self
            .mirror_actor()
            .basket_market()
            .get_basket(basket_id)
            .await
            .map_err(|_| BetLaneError::BasketQueryFailed)?
            .map_err(|_| BetLaneError::BasketNotFound)?;

        if basket.status != MirrorBasketStatus::Active {
            return Err(BetLaneError::BasketNotActive);
        }
        if basket.asset_kind != MirrorBasketAssetKind::Bet {
            return Err(BetLaneError::BasketAssetMismatch);
        }

        let program_id = Syscall::program_id();
        let current_position = InfallibleStorage::get(&self.positions)
            .positions
            .get(&(basket_id, caller))
            .cloned()
            .unwrap_or_default();

        let user_total = current_position
            .shares
            .checked_add(amount)
            .ok_or(BetLaneError::MathOverflow)?;
        self.validate_total_exposure(user_total)?;
        self.insert_pending_bet(basket_id, caller)?;
        self.consume_quote_nonce(caller, verified_quote.nonce)?;

        let next_index_at_creation_bps = if current_position.shares.is_zero() {
            verified_quote.quoted_index_bps
        } else {
            let old_weighted = current_position
                .shares
                .checked_mul(U256::from(current_position.index_at_creation_bps))
                .ok_or(BetLaneError::MathOverflow)?;
            let new_weighted = amount
                .checked_mul(U256::from(verified_quote.quoted_index_bps))
                .ok_or(BetLaneError::MathOverflow)?;
            let weighted_total = old_weighted
                .checked_add(new_weighted)
                .ok_or(BetLaneError::MathOverflow)?;
            let avg_index = weighted_total
                .checked_div(user_total)
                .ok_or(BetLaneError::MathOverflow)?;

            if avg_index > U256::from(u16::MAX) {
                return Err(BetLaneError::MathOverflow);
            }

            avg_index.as_u32() as u16
        };

        self.bet_token_actor()
            .bet_token()
            .transfer_from(caller, program_id, amount)
            .await
            .map_err(|_| BetLaneError::BetTokenTransferFromFailed)
            .inspect_err(|_| self.clear_pending_bet(basket_id, caller))?;

        let basket_after_transfer_result = self
            .mirror_actor()
            .basket_market()
            .get_basket(basket_id)
            .await;

        let basket_after_transfer = match basket_after_transfer_result {
            Ok(Ok(basket)) => basket,
            Ok(Err(_)) => {
                let _ = self.refund_after_failed_bet(caller, amount).await;
                self.clear_pending_bet(basket_id, caller);
                return Err(BetLaneError::BasketNotFound);
            }
            Err(_) => {
                let _ = self.refund_after_failed_bet(caller, amount).await;
                self.clear_pending_bet(basket_id, caller);
                return Err(BetLaneError::BasketQueryFailed);
            }
        };

        if basket_after_transfer.status != MirrorBasketStatus::Active {
            self.refund_after_failed_bet(caller, amount).await?;
            self.clear_pending_bet(basket_id, caller);
            return Err(BetLaneError::BasketNotActive);
        }
        if basket_after_transfer.asset_kind != MirrorBasketAssetKind::Bet {
            self.refund_after_failed_bet(caller, amount).await?;
            self.clear_pending_bet(basket_id, caller);
            return Err(BetLaneError::BasketAssetMismatch);
        }

        InfallibleStorageMut::get_mut(&mut self.positions)
            .positions
            .insert(
                (basket_id, caller),
                Position {
                    shares: user_total,
                    claimed: current_position.claimed,
                    index_at_creation_bps: next_index_at_creation_bps,
                },
            );
        self.clear_pending_bet(basket_id, caller);

        let _ = self.emit_event(Event::BetPlaced {
            basket_id,
            user: caller,
            amount,
            user_total,
            quoted_index_bps: verified_quote.quoted_index_bps,
            position_index_at_creation_bps: next_index_at_creation_bps,
            quote_nonce: verified_quote.nonce,
        });

        Ok(amount)
    }

    #[export(unwrap_result)]
    pub async fn claim(&mut self, basket_id: u64) -> Result<U256, BetLaneError> {
        let caller = Syscall::message_source();
        let config = InfallibleStorage::get(&self.config).clone();

        if self.pause.is_paused() && !config.payouts_allowed_while_paused {
            return Err(BetLaneError::Paused);
        }

        self.insert_pending_claim(basket_id, caller)?;

        let position = InfallibleStorage::get(&self.positions)
            .positions
            .get(&(basket_id, caller))
            .cloned()
            .unwrap_or_default();

        if position.shares.is_zero() {
            self.clear_pending_claim(basket_id, caller);
            return Err(BetLaneError::NothingToClaim);
        }
        if position.claimed {
            self.clear_pending_claim(basket_id, caller);
            return Err(BetLaneError::AlreadyClaimed);
        }

        let settlement = self
            .mirror_actor()
            .basket_market()
            .get_settlement(basket_id)
            .await
            .map_err(|_| {
                self.clear_pending_claim(basket_id, caller);
                BetLaneError::SettlementQueryFailed
            })?
            .map_err(|_| {
                self.clear_pending_claim(basket_id, caller);
                BetLaneError::SettlementNotFound
            })?;

        let basket = self
            .mirror_actor()
            .basket_market()
            .get_basket(basket_id)
            .await
            .map_err(|_| {
                self.clear_pending_claim(basket_id, caller);
                BetLaneError::BasketQueryFailed
            })?
            .map_err(|_| {
                self.clear_pending_claim(basket_id, caller);
                BetLaneError::BasketNotFound
            })?;

        if basket.asset_kind != MirrorBasketAssetKind::Bet {
            self.clear_pending_claim(basket_id, caller);
            return Err(BetLaneError::BasketAssetMismatch);
        }

        if settlement.status != MirrorSettlementStatus::Finalized {
            self.clear_pending_claim(basket_id, caller);
            return Err(BetLaneError::SettlementNotFinalized);
        }

        let payout = self.compute_payout(&position, settlement.payout_per_share)?;

        if !payout.is_zero() {
            if self
                .bet_token_actor()
                .bet_token()
                .transfer(caller, payout)
                .await
                .is_err()
            {
                self.clear_pending_claim(basket_id, caller);
                return Err(BetLaneError::BetTokenPayoutFailed);
            }
        }

        {
            let mut positions = InfallibleStorageMut::get_mut(&mut self.positions);
            let stored_position = positions
                .positions
                .get_mut(&(basket_id, caller))
                .ok_or(BetLaneError::NothingToClaim)?;
            if stored_position.claimed {
                return Err(BetLaneError::AlreadyClaimed);
            }
            stored_position.claimed = true;
        }
        self.clear_pending_claim(basket_id, caller);

        let _ = self.emit_event(Event::Claimed {
            basket_id,
            user: caller,
            amount: payout,
        });

        Ok(payout)
    }

    #[export(unwrap_result)]
    pub fn pause(&mut self) -> Result<(), BetLaneError> {
        self.require_role(PAUSER_ROLE, Syscall::message_source())?;
        if self.pause.pause() {
            self.emit_event(Event::Paused)
                .map_err(|_| BetLaneError::EventEmitFailed)?;
        }
        Ok(())
    }

    #[export(unwrap_result)]
    pub fn resume(&mut self) -> Result<(), BetLaneError> {
        self.require_role(PAUSER_ROLE, Syscall::message_source())?;
        if self.pause.resume() {
            self.emit_event(Event::Resumed)
                .map_err(|_| BetLaneError::EventEmitFailed)?;
        }
        Ok(())
    }

    #[export(unwrap_result)]
    pub fn set_config(&mut self, config: BetLaneConfig) -> Result<(), BetLaneError> {
        self.require_role(CONFIG_ROLE, Syscall::message_source())?;
        config.validate()?;
        InfallibleStorageMut::replace(&mut self.config, config.clone());
        self.emit_event(Event::ConfigUpdated(config))
            .map_err(|_| BetLaneError::EventEmitFailed)?;
        Ok(())
    }

    #[export(unwrap_result)]
    pub fn rotate_quote_signer(&mut self, new_quote_signer: ActorId) -> Result<(), BetLaneError> {
        self.require_role(CONFIG_ROLE, Syscall::message_source())?;

        let previous_quote_signer = {
            let mut config = InfallibleStorageMut::get_mut(&mut self.config);
            let previous_quote_signer = config.quote_signer;
            config.quote_signer = new_quote_signer;
            previous_quote_signer
        };

        self.emit_event(Event::QuoteSignerRotated {
            previous_quote_signer,
            new_quote_signer,
        })
        .map_err(|_| BetLaneError::EventEmitFailed)?;
        Ok(())
    }

    #[export(unwrap_result)]
    pub fn set_dependencies(
        &mut self,
        dependencies: BetLaneDependencies,
    ) -> Result<(), BetLaneError> {
        self.require_role(CONFIG_ROLE, Syscall::message_source())?;
        dependencies.validate()?;

        InfallibleStorageMut::replace(&mut self.basket_program_id, dependencies.basket_program_id);
        InfallibleStorageMut::replace(&mut self.bet_token_id, dependencies.bet_token_id);

        self.emit_event(Event::DependenciesUpdated(dependencies))
            .map_err(|_| BetLaneError::EventEmitFailed)?;
        Ok(())
    }

    #[export(unwrap_result)]
    pub fn import_positions(
        &mut self,
        positions: Vec<ImportedPosition>,
    ) -> Result<u32, BetLaneError> {
        self.require_role(DEFAULT_ADMIN_ROLE, Syscall::message_source())?;
        self.ensure_paused_for_migration()?;
        let count = Self::validate_migration_batch_size(&positions)?;

        for imported in positions {
            Self::validate_index_at_creation(imported.index_at_creation_bps)?;
            InfallibleStorageMut::get_mut(&mut self.positions)
                .positions
                .insert(
                    (imported.basket_id, imported.user),
                    Position {
                        shares: imported.shares,
                        claimed: imported.claimed,
                        index_at_creation_bps: imported.index_at_creation_bps,
                    },
                );
        }

        self.emit_event(Event::MigrationPositionsImported { count })
            .map_err(|_| BetLaneError::EventEmitFailed)?;

        Ok(count)
    }

    #[export(unwrap_result)]
    pub fn import_quote_nonces(
        &mut self,
        nonces: Vec<ImportedQuoteNonce>,
    ) -> Result<u32, BetLaneError> {
        self.require_role(DEFAULT_ADMIN_ROLE, Syscall::message_source())?;
        self.ensure_paused_for_migration()?;
        let count = Self::validate_migration_batch_size(&nonces)?;

        for imported in nonces {
            InfallibleStorageMut::get_mut(&mut self.used_quote_nonces)
                .nonces
                .insert((imported.user, imported.nonce));
        }

        self.emit_event(Event::MigrationQuoteNoncesImported { count })
            .map_err(|_| BetLaneError::EventEmitFailed)?;

        Ok(count)
    }

    #[export(unwrap_result)]
    pub fn add_admin(&mut self, account: ActorId) -> Result<(), BetLaneError> {
        self.access_control
            .grant_role(DEFAULT_ADMIN_ROLE, account)
            .map_err(|_| BetLaneError::RoleManagementFailed)
    }

    #[export(unwrap_result)]
    pub fn grant_role(&mut self, role_id: RoleId, account: ActorId) -> Result<(), BetLaneError> {
        self.access_control
            .grant_role(role_id, account)
            .map_err(|_| BetLaneError::RoleManagementFailed)
    }

    #[export(unwrap_result)]
    pub fn revoke_role(&mut self, role_id: RoleId, account: ActorId) -> Result<(), BetLaneError> {
        self.access_control
            .revoke_role(role_id, account)
            .map_err(|_| BetLaneError::RoleManagementFailed)
    }

    fn ensure_not_paused(&self) -> Result<(), BetLaneError> {
        if self.pause.is_paused() {
            Err(BetLaneError::Paused)
        } else {
            Ok(())
        }
    }

    fn validate_bet_amount(&self, amount: U256) -> Result<(), BetLaneError> {
        let config = InfallibleStorage::get(&self.config);
        if amount.is_zero() {
            return Err(BetLaneError::InvalidAmount);
        }
        if amount < config.min_bet {
            return Err(BetLaneError::AmountBelowMinBet);
        }
        if amount > config.max_bet {
            return Err(BetLaneError::AmountAboveMaxBet);
        }
        Ok(())
    }

    fn validate_total_exposure(&self, total_exposure: U256) -> Result<(), BetLaneError> {
        let config = InfallibleStorage::get(&self.config);
        if total_exposure > config.max_bet {
            Err(BetLaneError::AmountAboveMaxBet)
        } else {
            Ok(())
        }
    }

    fn validate_page_size(limit: u32) -> Result<(), BetLaneError> {
        if limit == 0 || limit > MAX_PAGE_SIZE {
            Err(BetLaneError::InvalidPageSize)
        } else {
            Ok(())
        }
    }

    fn validate_migration_batch_size<T>(items: &[T]) -> Result<u32, BetLaneError> {
        if items.len() > MAX_MIGRATION_BATCH_SIZE {
            Err(BetLaneError::MigrationBatchTooLarge)
        } else {
            Ok(items.len() as u32)
        }
    }

    fn validate_index_at_creation(index_at_creation_bps: u16) -> Result<(), BetLaneError> {
        if index_at_creation_bps == 0 || index_at_creation_bps > 10_000 {
            Err(BetLaneError::InvalidIndexAtCreation)
        } else {
            Ok(())
        }
    }

    fn verify_bet_quote(
        &self,
        caller: ActorId,
        basket_id: u64,
        amount: U256,
        signed_quote: &SignedBetQuote,
    ) -> Result<BetQuotePayload, BetLaneError> {
        let quote_signer = InfallibleStorage::get(&self.config).quote_signer;
        if quote_signer == ActorId::zero() {
            return Err(BetLaneError::QuoteSignerNotConfigured);
        }

        let payload = signed_quote.payload.clone();
        Self::validate_index_at_creation(payload.quoted_index_bps)?;

        if payload.target_program_id != exec::program_id() {
            return Err(BetLaneError::QuoteTargetMismatch);
        }
        if payload.user != caller {
            return Err(BetLaneError::QuoteUserMismatch);
        }
        if payload.basket_id != basket_id {
            return Err(BetLaneError::QuoteBasketMismatch);
        }
        if payload.amount != amount {
            return Err(BetLaneError::QuoteAmountMismatch);
        }
        if payload.deadline_ms < exec::block_timestamp() {
            return Err(BetLaneError::QuoteExpired);
        }
        if InfallibleStorage::get(&self.used_quote_nonces)
            .nonces
            .contains(&(caller, payload.nonce))
        {
            return Err(BetLaneError::QuoteNonceAlreadyUsed);
        }

        let message = Self::quote_signing_message(&payload);
        Self::verify_quote_signature(&signed_quote.signature, &message, quote_signer)?;

        Ok(payload)
    }

    fn quote_signing_message(payload: &BetQuotePayload) -> Vec<u8> {
        let raw_payload = [b"BetLaneQuoteV1".encode(), payload.encode()].concat();
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
    ) -> Result<(), BetLaneError> {
        let signature =
            Signature::from_bytes(signature).map_err(|_| BetLaneError::InvalidQuoteSignature)?;
        let signer_bytes: [u8; 32] = signer.into();
        let public_key =
            PublicKey::from_bytes(&signer_bytes).map_err(|_| BetLaneError::InvalidQuoteSigner)?;

        public_key
            .verify_simple(b"substrate", message, &signature)
            .map(|_| ())
            .map_err(|_| BetLaneError::QuoteVerificationFailed)
    }

    fn consume_quote_nonce(&mut self, user: ActorId, nonce: u128) -> Result<(), BetLaneError> {
        let used_nonces = &mut InfallibleStorageMut::get_mut(&mut self.used_quote_nonces).nonces;
        if !used_nonces.insert((user, nonce)) {
            return Err(BetLaneError::QuoteNonceAlreadyUsed);
        }
        Ok(())
    }

    fn compute_payout(
        &self,
        position: &Position,
        settlement_payout_per_share: u128,
    ) -> Result<U256, BetLaneError> {
        if position.index_at_creation_bps == 0 {
            return Err(BetLaneError::InvalidIndexAtCreation);
        }
        if settlement_payout_per_share == 0 || position.shares.is_zero() {
            return Ok(U256::zero());
        }

        position
            .shares
            .checked_mul(U256::from(settlement_payout_per_share))
            .ok_or(BetLaneError::MathOverflow)?
            .checked_div(U256::from(position.index_at_creation_bps))
            .ok_or(BetLaneError::MathOverflow)
    }

    fn require_role(&self, role_id: RoleId, account: ActorId) -> Result<(), BetLaneError> {
        let roles = InfallibleStorage::get(&self.roles);
        if roles.has_role(role_id, account) || roles.has_role(DEFAULT_ADMIN_ROLE, account) {
            Ok(())
        } else {
            Err(BetLaneError::AccessDenied)
        }
    }

    fn ensure_paused_for_migration(&self) -> Result<(), BetLaneError> {
        if self.pause.is_paused() {
            Ok(())
        } else {
            Err(BetLaneError::MigrationRequiresPause)
        }
    }

    fn insert_pending_bet(&mut self, basket_id: u64, account: ActorId) -> Result<(), BetLaneError> {
        let mut pending_operations = InfallibleStorageMut::get_mut(&mut self.pending_operations);
        if pending_operations
            .pending_bets
            .contains(&(basket_id, account))
            || pending_operations
                .pending_claims
                .contains(&(basket_id, account))
        {
            return Err(BetLaneError::OperationInProgress);
        }

        pending_operations.pending_bets.insert((basket_id, account));
        Ok(())
    }

    fn clear_pending_bet(&mut self, basket_id: u64, account: ActorId) {
        InfallibleStorageMut::get_mut(&mut self.pending_operations)
            .pending_bets
            .remove(&(basket_id, account));
    }

    fn insert_pending_claim(
        &mut self,
        basket_id: u64,
        account: ActorId,
    ) -> Result<(), BetLaneError> {
        let mut pending_operations = InfallibleStorageMut::get_mut(&mut self.pending_operations);
        if pending_operations
            .pending_bets
            .contains(&(basket_id, account))
            || pending_operations
                .pending_claims
                .contains(&(basket_id, account))
        {
            return Err(BetLaneError::OperationInProgress);
        }

        pending_operations
            .pending_claims
            .insert((basket_id, account));
        Ok(())
    }

    fn clear_pending_claim(&mut self, basket_id: u64, account: ActorId) {
        InfallibleStorageMut::get_mut(&mut self.pending_operations)
            .pending_claims
            .remove(&(basket_id, account));
    }

    async fn refund_after_failed_bet(
        &self,
        user: ActorId,
        amount: U256,
    ) -> Result<(), BetLaneError> {
        self.bet_token_actor()
            .bet_token()
            .transfer(user, amount)
            .await
            .map_err(|_| BetLaneError::BetTokenRefundFailed)?;
        Ok(())
    }

    fn bet_token_actor(
        &self,
    ) -> sails_rs::client::Actor<BetTokenClientProgram, sails_rs::client::GstdEnv> {
        BetTokenClientProgram::client(*InfallibleStorage::get(&self.bet_token_id))
    }

    fn mirror_actor(
        &self,
    ) -> sails_rs::client::Actor<PolymarketMirrorProgram, sails_rs::client::GstdEnv> {
        PolymarketMirrorProgram::client(*InfallibleStorage::get(&self.basket_program_id))
    }
}

#[event]
#[derive(Clone, Debug, PartialEq, Eq, Encode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum Event {
    BetPlaced {
        basket_id: u64,
        user: ActorId,
        amount: U256,
        user_total: U256,
        quoted_index_bps: u16,
        position_index_at_creation_bps: u16,
        quote_nonce: u128,
    },
    Claimed {
        basket_id: u64,
        user: ActorId,
        amount: U256,
    },
    Paused,
    Resumed,
    ConfigUpdated(BetLaneConfig),
    DependenciesUpdated(BetLaneDependencies),
    QuoteSignerRotated {
        previous_quote_signer: ActorId,
        new_quote_signer: ActorId,
    },
    MigrationPositionsImported {
        count: u32,
    },
    MigrationQuoteNoncesImported {
        count: u32,
    },
}

#[derive(Default)]
pub struct Program {
    roles: RefCell<RolesStorage>,
    basket_program_id: RefCell<ActorId>,
    bet_token_id: RefCell<ActorId>,
    config: RefCell<BetLaneConfig>,
    positions: RefCell<PositionStore>,
    used_quote_nonces: RefCell<UsedQuoteNonceStore>,
    pending_operations: RefCell<PendingOperations>,
    pause: Pause,
}

impl Program {
    fn access_control_service(&self) -> AccessControl<'_> {
        AccessControl::new(StorageRefCell::new(&self.roles))
    }
}

#[sails_rs::program]
impl Program {
    pub fn create(
        admin: ActorId,
        basket_program_id: ActorId,
        bet_token_id: ActorId,
        config: Option<BetLaneConfig>,
    ) -> Self {
        let mut roles = RolesStorage::default();
        roles.grant_initial_admin(admin);

        let config = config.unwrap_or_default();
        config.validate().expect("invalid initial bet lane config");
        BetLaneDependencies {
            basket_program_id,
            bet_token_id,
        }
        .validate()
        .expect("invalid initial bet lane dependencies");

        Self {
            roles: RefCell::new(roles),
            basket_program_id: RefCell::new(basket_program_id),
            bet_token_id: RefCell::new(bet_token_id),
            config: RefCell::new(config),
            positions: RefCell::new(Default::default()),
            used_quote_nonces: RefCell::new(Default::default()),
            pending_operations: RefCell::new(Default::default()),
            pause: Pause::default(),
        }
    }

    pub fn bet_lane(&self) -> BetLaneService<'_> {
        BetLaneService::new(
            StorageRefCell::new(&self.roles),
            self.access_control_service().expose(b"AccessControl"),
            StorageRefCell::new(&self.basket_program_id),
            StorageRefCell::new(&self.bet_token_id),
            StorageRefCell::new(&self.config),
            StorageRefCell::new(&self.positions),
            StorageRefCell::new(&self.used_quote_nonces),
            StorageRefCell::new(&self.pending_operations),
            &self.pause,
        )
    }

    pub fn access_control(&self) -> AccessControl<'_> {
        self.access_control_service()
    }
}
