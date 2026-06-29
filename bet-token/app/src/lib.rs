#![no_std]

use awesome_sails_access_control::{AccessControl, DEFAULT_ADMIN_ROLE, RoleId, RolesStorage};
use awesome_sails_storage::{InfallibleStorage, InfallibleStorageMut, StorageMut, StorageRefCell};
use awesome_sails_utils::math::NonZero;
use awesome_sails_utils::pause::{PausableRef, Pause};
use awesome_sails_vft::{
    Vft,
    utils::{Balance, Balances},
};
use awesome_sails_vft_admin::VftAdmin;
use awesome_sails_vft_metadata::{Metadata, VftMetadata};
use sails_rs::gstd::services::Service;
use sails_rs::prelude::*;
use sails_rs::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
};

const MAX_MIGRATION_BATCH_SIZE: usize = 250;
const UTC_DAY_MS: u64 = 24 * 60 * 60 * 1000;
const UTC_HOUR_MS: u64 = 60 * 60 * 1000;

#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct ClaimConfig {
    pub base_claim_amount: U256,
    pub max_claim_amount: U256,
    pub streak_step: U256,
    pub streak_cap_days: u32,
    pub claim_period: u64,
    pub day_start_offset_ms: u64,
    pub claim_paused: bool,
}

impl ClaimConfig {
    fn default_for_decimals(decimals: u8) -> Self {
        let unit = Self::token_unit(decimals).expect("token decimals are too large");

        Self {
            base_claim_amount: U256::from(500u32)
                .checked_mul(unit)
                .expect("default base claim amount overflow"),
            max_claim_amount: U256::from(600u32)
                .checked_mul(unit)
                .expect("default max claim amount overflow"),
            streak_step: U256::from(10u32)
                .checked_mul(unit)
                .expect("default claim streak step overflow"),
            streak_cap_days: 11,
            claim_period: UTC_HOUR_MS,
            day_start_offset_ms: 0,
            claim_paused: false,
        }
    }

    fn token_unit(decimals: u8) -> Option<U256> {
        let mut unit = U256::one();
        for _ in 0..decimals {
            unit = unit.checked_mul(U256::from(10u8))?;
        }

        Some(unit)
    }

    fn validate(&self) -> Result<(), ClaimError> {
        if self.claim_period == 0 {
            return Err(ClaimError::InvalidClaimPeriod);
        }

        if self.base_claim_amount > self.max_claim_amount {
            return Err(ClaimError::InvalidClaimBounds);
        }

        if self.day_start_offset_ms >= UTC_DAY_MS {
            return Err(ClaimError::InvalidDayStartOffset);
        }

        Ok(())
    }
}

impl Default for ClaimConfig {
    fn default() -> Self {
        Self::default_for_decimals(0)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct ClaimState {
    pub last_claim_at: Option<u64>,
    pub streak_days: u32,
    pub total_claimed: U256,
    pub claim_count: u32,
}

#[derive(Debug, Default)]
pub struct ClaimStates {
    states: BTreeMap<ActorId, ClaimState>,
}

#[derive(Debug, Default)]
pub struct AllowedSpenders {
    spenders: BTreeSet<ActorId>,
}

#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct ClaimPreview {
    pub amount: U256,
    pub streak_days: u32,
    pub next_claim_at: Option<u64>,
    pub can_claim_now: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct ImportedBalance {
    pub user: ActorId,
    pub balance: U256,
}

#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct ImportedClaimState {
    pub user: ActorId,
    pub state: ClaimState,
}

#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo, thiserror::Error)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum ClaimError {
    #[error("claim is disabled")]
    ClaimDisabled,
    #[error("transfers are disabled")]
    TransfersDisabled,
    #[error("transfer failed")]
    TransferFailed,
    #[error("spender is not allowed")]
    SpenderNotAllowed,
    #[error("transfer_from failed")]
    TransferFromFailed,
    #[error("claim period is invalid")]
    InvalidClaimPeriod,
    #[error("day start offset is invalid")]
    InvalidDayStartOffset,
    #[error("claim bounds are invalid")]
    InvalidClaimBounds,
    #[error("claim is too early until {next_claim_at}")]
    ClaimTooEarly { next_claim_at: u64 },
    #[error("reward overflow")]
    RewardOverflow,
    #[error("reward is too large for token balance type")]
    RewardTooLarge,
    #[error("claim recipient is invalid")]
    InvalidClaimRecipient,
    #[error("claim amount is invalid")]
    InvalidClaimAmount,
    #[error("balance storage borrow failed")]
    BalanceStorageBorrowFailed,
    #[error("balance mint operation failed")]
    MintOperationFailed,
    #[error("event emission failed")]
    EventEmitFailed,
    #[error("claim configuration is forbidden")]
    AccessDenied,
    #[error("mint amount is invalid")]
    InvalidMintAmount,
    #[error("role management failed")]
    RoleManagementFailed,
    #[error("migration import requires paused token and paused claim flow")]
    MigrationRequiresPause,
    #[error("migration batch is too large")]
    MigrationBatchTooLarge,
}

pub struct BetTokenService<
    'a,
    A = PausableRef<'a, awesome_sails_vft::utils::Allowances>,
    B = PausableRef<'a, Balances>,
> {
    roles: StorageRefCell<'a, RolesStorage>,
    access_control: awesome_sails_access_control::AccessControlExposure<
        AccessControl<'a, StorageRefCell<'a, RolesStorage>>,
    >,
    claim_config: StorageRefCell<'a, ClaimConfig>,
    claim_states: StorageRefCell<'a, ClaimStates>,
    allowed_spenders: StorageRefCell<'a, AllowedSpenders>,
    metadata: &'a Metadata,
    vft: awesome_sails_vft::VftExposure<Vft<'a, A, B>>,
    balances: B,
    raw_balances: StorageRefCell<'a, Balances>,
    pause: &'a Pause,
}

impl<'a, A, B> BetTokenService<'a, A, B> {
    pub fn new(
        roles: StorageRefCell<'a, RolesStorage>,
        access_control: awesome_sails_access_control::AccessControlExposure<
            AccessControl<'a, StorageRefCell<'a, RolesStorage>>,
        >,
        claim_config: StorageRefCell<'a, ClaimConfig>,
        claim_states: StorageRefCell<'a, ClaimStates>,
        allowed_spenders: StorageRefCell<'a, AllowedSpenders>,
        metadata: &'a Metadata,
        vft: awesome_sails_vft::VftExposure<Vft<'a, A, B>>,
        balances: B,
        raw_balances: StorageRefCell<'a, Balances>,
        pause: &'a Pause,
    ) -> Self {
        Self {
            roles,
            access_control,
            claim_config,
            claim_states,
            allowed_spenders,
            metadata,
            vft,
            balances,
            raw_balances,
            pause,
        }
    }
}

#[service(events = Event)]
impl<'a, A, B> BetTokenService<'a, A, B>
where
    A: StorageMut<Item = awesome_sails_vft::utils::Allowances>,
    B: StorageMut<Item = Balances>,
{
    #[export]
    pub fn name(&self) -> String {
        self.metadata.name().into()
    }

    #[export]
    pub fn symbol(&self) -> String {
        self.metadata.symbol().into()
    }

    #[export]
    pub fn decimals(&self) -> u8 {
        self.metadata.decimals()
    }

    #[export(unwrap_result)]
    pub fn approve(&mut self, spender: ActorId, value: U256) -> Result<bool, ()> {
        let owner = Syscall::message_source();
        let changed = self.vft.approve(spender, value).map_err(|_| ())?;

        self.emit_event(Event::Approved {
            owner,
            spender,
            value,
            changed,
        })
        .map_err(|_| ())?;

        Ok(changed)
    }

    #[export(unwrap_result)]
    pub fn transfer(&mut self, to: ActorId, value: U256) -> Result<bool, ClaimError> {
        let sender = Syscall::message_source();

        let sender_is_admin =
            InfallibleStorage::get(&self.roles).has_role(DEFAULT_ADMIN_ROLE, sender);
        let sender_is_allowed_spender = InfallibleStorage::get(&self.allowed_spenders)
            .spenders
            .contains(&sender);

        if !sender_is_admin && !sender_is_allowed_spender {
            return Err(ClaimError::TransfersDisabled);
        }

        self.vft
            .transfer(to, value)
            .map_err(|_| ClaimError::TransferFailed)
    }

    #[export(unwrap_result)]
    pub fn transfer_from(
        &mut self,
        from: ActorId,
        to: ActorId,
        value: U256,
    ) -> Result<bool, ClaimError> {
        let spender = Syscall::message_source();

        if spender == from {
            return Err(ClaimError::TransfersDisabled);
        }

        if !InfallibleStorage::get(&self.allowed_spenders)
            .spenders
            .contains(&spender)
        {
            return Err(ClaimError::SpenderNotAllowed);
        }

        self.vft
            .transfer_from(from, to, value)
            .map_err(|_| ClaimError::TransferFromFailed)
    }

    #[export(unwrap_result)]
    pub fn allowance(&self, owner: ActorId, spender: ActorId) -> Result<U256, ()> {
        self.vft.allowance(owner, spender).map_err(|_| ())
    }

    #[export(unwrap_result)]
    pub fn balance_of(&self, account: ActorId) -> Result<U256, ()> {
        self.vft.balance_of(account).map_err(|_| ())
    }

    #[export(unwrap_result)]
    pub fn total_supply(&self) -> Result<U256, ()> {
        self.vft.total_supply().map_err(|_| ())
    }

    #[export]
    pub fn get_claim_config(&self) -> ClaimConfig {
        InfallibleStorage::get(&self.claim_config).clone()
    }

    #[export]
    pub fn get_claim_state(&self, user: ActorId) -> ClaimState {
        InfallibleStorage::get(&self.claim_states)
            .states
            .get(&user)
            .cloned()
            .unwrap_or_default()
    }

    #[export]
    pub fn get_claim_state_count(&self) -> u64 {
        InfallibleStorage::get(&self.claim_states).states.len() as u64
    }

    #[export]
    pub fn get_claim_preview(&self, user: ActorId) -> ClaimPreview {
        let now = Syscall::block_timestamp();
        let config = InfallibleStorage::get(&self.claim_config).clone();
        let state = InfallibleStorage::get(&self.claim_states)
            .states
            .get(&user)
            .cloned()
            .unwrap_or_default();

        let next_claim_at = state
            .last_claim_at
            .map(|last_claim_at| self.next_claim_at(&config, last_claim_at));
        let can_claim_now =
            !config.claim_paused && next_claim_at.is_none_or(|allowed_at| now >= allowed_at);

        let streak_days = self.next_streak_days(&config, &state, now);
        let amount = self
            .reward_for_streak(&config, streak_days)
            .unwrap_or_default();

        ClaimPreview {
            amount,
            streak_days,
            next_claim_at,
            can_claim_now,
        }
    }

    #[export(unwrap_result)]
    pub fn claim(&mut self) -> Result<ClaimState, ClaimError> {
        let caller = Syscall::message_source();
        let now = Syscall::block_timestamp();
        let config = InfallibleStorage::get(&self.claim_config).clone();

        if config.claim_paused {
            return Err(ClaimError::ClaimDisabled);
        }

        let state = InfallibleStorage::get(&self.claim_states)
            .states
            .get(&caller)
            .cloned()
            .unwrap_or_default();

        if let Some(last_claim_at) = state.last_claim_at {
            let next_claim_at = self.next_claim_at(&config, last_claim_at);
            if now < next_claim_at {
                return Err(ClaimError::ClaimTooEarly { next_claim_at });
            }
        }

        let streak_days = self.next_streak_days(&config, &state, now);
        let claim_amount = self.reward_for_streak(&config, streak_days)?;
        let balance = Balance::try_from(claim_amount).map_err(|_| ClaimError::RewardTooLarge)?;
        let recipient = caller
            .try_into()
            .map_err(|_| ClaimError::InvalidClaimRecipient)?;
        let mint_amount = balance
            .try_into()
            .map_err(|_| ClaimError::InvalidClaimAmount)?;

        self.balances
            .get_mut()
            .map_err(|_| ClaimError::BalanceStorageBorrowFailed)?
            .mint(recipient, mint_amount)
            .map_err(|_| ClaimError::MintOperationFailed)?;

        let reset = state.last_claim_at.is_some() && streak_days == 1 && state.streak_days > 0;
        let updated_state = ClaimState {
            last_claim_at: Some(now),
            streak_days,
            total_claimed: state
                .total_claimed
                .checked_add(claim_amount)
                .ok_or(ClaimError::RewardOverflow)?,
            claim_count: state.claim_count.saturating_add(1),
        };

        InfallibleStorageMut::get_mut(&mut self.claim_states)
            .states
            .insert(caller, updated_state.clone());

        self.emit_event(Event::Claimed {
            user: caller,
            amount: claim_amount,
            streak_days,
            claimed_at: now,
        })
        .map_err(|_| ClaimError::EventEmitFailed)?;

        self.emit_event(Event::StreakUpdated {
            user: caller,
            streak_days,
            reset,
        })
        .map_err(|_| ClaimError::EventEmitFailed)?;

        Ok(updated_state)
    }

    #[export(unwrap_result)]
    pub fn set_claim_config(&mut self, config: ClaimConfig) -> Result<(), ClaimError> {
        self.require_role(DEFAULT_ADMIN_ROLE, Syscall::message_source())?;
        config.validate()?;

        InfallibleStorageMut::replace(&mut self.claim_config, config.clone());

        self.emit_event(Event::ClaimConfigUpdated(config))
            .map_err(|_| ClaimError::EventEmitFailed)?;

        Ok(())
    }

    #[export(unwrap_result)]
    pub fn set_claim_day_start_offset(
        &mut self,
        day_start_offset_ms: u64,
    ) -> Result<(), ClaimError> {
        self.require_role(DEFAULT_ADMIN_ROLE, Syscall::message_source())?;

        let mut config = InfallibleStorage::get(&self.claim_config).clone();
        config.day_start_offset_ms = day_start_offset_ms;
        config.validate()?;

        InfallibleStorageMut::replace(&mut self.claim_config, config.clone());

        self.emit_event(Event::ClaimConfigUpdated(config))
            .map_err(|_| ClaimError::EventEmitFailed)?;

        Ok(())
    }

    #[export(unwrap_result)]
    pub fn pause_claim(&mut self) -> Result<(), ClaimError> {
        self.require_role(DEFAULT_ADMIN_ROLE, Syscall::message_source())?;

        let mut config = InfallibleStorage::get(&self.claim_config).clone();
        if !config.claim_paused {
            config.claim_paused = true;
            InfallibleStorageMut::replace(&mut self.claim_config, config);
            self.emit_event(Event::ClaimPaused)
                .map_err(|_| ClaimError::EventEmitFailed)?;
        }

        Ok(())
    }

    #[export(unwrap_result)]
    pub fn resume_claim(&mut self) -> Result<(), ClaimError> {
        self.require_role(DEFAULT_ADMIN_ROLE, Syscall::message_source())?;

        let mut config = InfallibleStorage::get(&self.claim_config).clone();
        if config.claim_paused {
            config.claim_paused = false;
            InfallibleStorageMut::replace(&mut self.claim_config, config);
            self.emit_event(Event::ClaimResumed)
                .map_err(|_| ClaimError::EventEmitFailed)?;
        }

        Ok(())
    }

    #[export]
    pub fn is_claim_paused(&self) -> bool {
        InfallibleStorage::get(&self.claim_config).claim_paused
    }

    #[export(unwrap_result)]
    pub fn allow_spender(&mut self, spender: ActorId) -> Result<(), ClaimError> {
        self.require_role(DEFAULT_ADMIN_ROLE, Syscall::message_source())?;

        if InfallibleStorageMut::get_mut(&mut self.allowed_spenders)
            .spenders
            .insert(spender)
        {
            self.emit_event(Event::SpenderAllowed(spender))
                .map_err(|_| ClaimError::RoleManagementFailed)?;
        }

        Ok(())
    }

    #[export(unwrap_result)]
    pub fn disallow_spender(&mut self, spender: ActorId) -> Result<(), ClaimError> {
        self.require_role(DEFAULT_ADMIN_ROLE, Syscall::message_source())?;

        if InfallibleStorageMut::get_mut(&mut self.allowed_spenders)
            .spenders
            .remove(&spender)
        {
            self.emit_event(Event::SpenderDisallowed(spender))
                .map_err(|_| ClaimError::RoleManagementFailed)?;
        }

        Ok(())
    }

    #[export]
    pub fn is_spender_allowed(&self, spender: ActorId) -> bool {
        InfallibleStorage::get(&self.allowed_spenders)
            .spenders
            .contains(&spender)
    }

    #[export(unwrap_result)]
    pub fn add_admin(&mut self, account: ActorId) -> Result<(), ClaimError> {
        self.access_control
            .grant_role(DEFAULT_ADMIN_ROLE, account)
            .map_err(|_| ClaimError::RoleManagementFailed)
    }

    #[export(unwrap_result)]
    pub fn admin_mint(&mut self, to: ActorId, value: U256) -> Result<(), ClaimError> {
        self.require_role(DEFAULT_ADMIN_ROLE, Syscall::message_source())?;

        let balance = Balance::try_from(value).map_err(|_| ClaimError::InvalidMintAmount)?;
        let recipient = to
            .try_into()
            .map_err(|_| ClaimError::InvalidClaimRecipient)?;
        let mint_amount = balance
            .try_into()
            .map_err(|_| ClaimError::InvalidMintAmount)?;

        self.balances
            .get_mut()
            .map_err(|_| ClaimError::BalanceStorageBorrowFailed)?
            .mint(recipient, mint_amount)
            .map_err(|_| ClaimError::MintOperationFailed)?;

        Ok(())
    }

    #[export(unwrap_result)]
    pub fn import_balances(&mut self, balances: Vec<ImportedBalance>) -> Result<u32, ClaimError> {
        self.require_role(DEFAULT_ADMIN_ROLE, Syscall::message_source())?;
        self.ensure_migration_paused()?;
        let count = Self::validate_migration_batch_size(&balances)?;

        let mut balances_store = InfallibleStorageMut::get_mut(&mut self.raw_balances);

        for imported in balances {
            let user =
                NonZero::try_from(imported.user).map_err(|_| ClaimError::InvalidClaimRecipient)?;

            balances_store.burn_all(user);

            if imported.balance.is_zero() {
                continue;
            }

            let value =
                Balance::try_from(imported.balance).map_err(|_| ClaimError::RewardTooLarge)?;
            let value = NonZero::try_from(value).map_err(|_| ClaimError::InvalidClaimAmount)?;
            balances_store
                .mint(user, value)
                .map_err(|_| ClaimError::MintOperationFailed)?;
        }
        drop(balances_store);

        self.emit_event(Event::MigrationBalancesImported { count })
            .map_err(|_| ClaimError::EventEmitFailed)?;

        Ok(count)
    }

    #[export(unwrap_result)]
    pub fn import_claim_states(
        &mut self,
        claim_states: Vec<ImportedClaimState>,
    ) -> Result<u32, ClaimError> {
        self.require_role(DEFAULT_ADMIN_ROLE, Syscall::message_source())?;
        self.ensure_migration_paused()?;
        let count = Self::validate_migration_batch_size(&claim_states)?;

        {
            let states = &mut InfallibleStorageMut::get_mut(&mut self.claim_states).states;
            for imported in claim_states {
                states.insert(imported.user, imported.state);
            }
        }

        self.emit_event(Event::MigrationClaimStatesImported { count })
            .map_err(|_| ClaimError::EventEmitFailed)?;

        Ok(count)
    }

    #[export(unwrap_result)]
    pub fn grant_role(&mut self, role_id: RoleId, account: ActorId) -> Result<(), ClaimError> {
        self.access_control
            .grant_role(role_id, account)
            .map_err(|_| ClaimError::RoleManagementFailed)
    }

    #[export(unwrap_result)]
    pub fn revoke_role(&mut self, role_id: RoleId, account: ActorId) -> Result<(), ClaimError> {
        self.access_control
            .revoke_role(role_id, account)
            .map_err(|_| ClaimError::RoleManagementFailed)
    }

    fn next_streak_days(&self, config: &ClaimConfig, state: &ClaimState, now: u64) -> u32 {
        match state.last_claim_at {
            None => 1,
            Some(last_claim_at) => {
                let current_claim_day = self.claim_day_id(config, now);
                let last_claim_day = self.claim_day_id(config, last_claim_at);

                if current_claim_day > last_claim_day + 1 {
                    1
                } else if current_claim_day == last_claim_day {
                    state.streak_days.max(1)
                } else {
                    state
                        .streak_days
                        .saturating_add(1)
                        .min(config.streak_cap_days.max(1))
                }
            }
        }
    }

    fn reward_for_streak(
        &self,
        config: &ClaimConfig,
        streak_days: u32,
    ) -> Result<U256, ClaimError> {
        let streak_index = U256::from(streak_days.saturating_sub(1));
        let bonus = config
            .streak_step
            .checked_mul(streak_index)
            .ok_or(ClaimError::RewardOverflow)?;
        let reward = config
            .base_claim_amount
            .checked_add(bonus)
            .ok_or(ClaimError::RewardOverflow)?;

        Ok(reward.min(config.max_claim_amount))
    }

    fn claim_day_id(&self, config: &ClaimConfig, timestamp: u64) -> i128 {
        (i128::from(timestamp) - i128::from(config.day_start_offset_ms))
            .div_euclid(i128::from(UTC_DAY_MS))
    }

    fn next_claim_at(&self, config: &ClaimConfig, last_claim_at: u64) -> u64 {
        let next_claim_period =
            i128::from(last_claim_at).div_euclid(i128::from(config.claim_period)) + 1;
        let next_claim_at = next_claim_period * i128::from(config.claim_period);

        next_claim_at.max(0) as u64
    }

    fn require_role(&self, role_id: RoleId, account: ActorId) -> Result<(), ClaimError> {
        let roles = InfallibleStorage::get(&self.roles);
        if roles.has_role(role_id, account) || roles.has_role(DEFAULT_ADMIN_ROLE, account) {
            Ok(())
        } else {
            Err(ClaimError::AccessDenied)
        }
    }

    fn ensure_migration_paused(&self) -> Result<(), ClaimError> {
        if self.pause.is_paused() && InfallibleStorage::get(&self.claim_config).claim_paused {
            Ok(())
        } else {
            Err(ClaimError::MigrationRequiresPause)
        }
    }

    fn validate_migration_batch_size<T>(items: &[T]) -> Result<u32, ClaimError> {
        if items.len() > MAX_MIGRATION_BATCH_SIZE {
            Err(ClaimError::MigrationBatchTooLarge)
        } else {
            Ok(items.len() as u32)
        }
    }
}

#[event]
#[derive(Clone, Debug, PartialEq, Eq, Encode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum Event {
    Approved {
        owner: ActorId,
        spender: ActorId,
        value: U256,
        changed: bool,
    },
    Claimed {
        user: ActorId,
        amount: U256,
        streak_days: u32,
        claimed_at: u64,
    },
    StreakUpdated {
        user: ActorId,
        streak_days: u32,
        reset: bool,
    },
    ClaimConfigUpdated(ClaimConfig),
    ClaimPaused,
    ClaimResumed,
    SpenderAllowed(ActorId),
    SpenderDisallowed(ActorId),
    MigrationBalancesImported {
        count: u32,
    },
    MigrationClaimStatesImported {
        count: u32,
    },
}

#[derive(Default)]
pub struct Program {
    roles: RefCell<RolesStorage>,
    allowances: RefCell<awesome_sails_vft::utils::Allowances>,
    balances: RefCell<Balances>,
    pause: Pause,
    metadata: Metadata,
    claim_config: RefCell<ClaimConfig>,
    claim_states: RefCell<ClaimStates>,
    allowed_spenders: RefCell<AllowedSpenders>,
}

impl Program {
    fn access_control_service(&self) -> AccessControl<'_> {
        AccessControl::new(StorageRefCell::new(&self.roles))
    }

    fn allowances(&self) -> PausableRef<'_, awesome_sails_vft::utils::Allowances> {
        PausableRef::new(&self.pause, StorageRefCell::new(&self.allowances))
    }

    fn balances(&self) -> PausableRef<'_, Balances> {
        PausableRef::new(&self.pause, StorageRefCell::new(&self.balances))
    }

    fn vft_service(&self) -> Vft<'_> {
        Vft::new(self.allowances(), self.balances())
    }
}

#[sails_rs::program]
impl Program {
    pub fn create(
        admin: ActorId,
        name: String,
        symbol: String,
        decimals: u8,
        claim_config: Option<ClaimConfig>,
    ) -> Self {
        let mut roles = RolesStorage::default();
        roles.grant_initial_admin(admin);
        let mut allowances = awesome_sails_vft::utils::Allowances::default();
        let mut balances = Balances::default();
        let _ = allowances.allocate_next_shard();
        let _ = balances.allocate_next_shard();

        let claim_config =
            claim_config.unwrap_or_else(|| ClaimConfig::default_for_decimals(decimals));
        claim_config
            .validate()
            .expect("invalid initial claim configuration");

        Self {
            roles: RefCell::new(roles),
            allowances: RefCell::new(allowances),
            balances: RefCell::new(balances),
            pause: Pause::default(),
            metadata: Metadata::new(name, symbol, decimals),
            claim_config: RefCell::new(claim_config),
            claim_states: RefCell::new(Default::default()),
            allowed_spenders: RefCell::new(Default::default()),
        }
    }

    pub fn bet_token(&self) -> BetTokenService<'_> {
        BetTokenService::new(
            StorageRefCell::new(&self.roles),
            self.access_control_service().expose(b"AccessControl"),
            StorageRefCell::new(&self.claim_config),
            StorageRefCell::new(&self.claim_states),
            StorageRefCell::new(&self.allowed_spenders),
            &self.metadata,
            self.vft_service().expose(b"Vft"),
            self.balances(),
            StorageRefCell::new(&self.balances),
            &self.pause,
        )
    }

    pub fn access_control(&self) -> AccessControl<'_> {
        self.access_control_service()
    }

    pub fn vft_admin(&self) -> VftAdmin<'_> {
        VftAdmin::new(
            self.access_control_service().expose(b"AccessControl"),
            self.allowances(),
            self.balances(),
            &self.pause,
            self.vft_service().expose(b"Vft"),
        )
    }

    pub fn metadata(&self) -> VftMetadata<&Metadata> {
        VftMetadata::new(&self.metadata)
    }
}
