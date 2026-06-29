#![no_std]

use parity_scale_codec::{Decode, Encode};
use sails_rs::collections::BTreeMap;
use sails_rs::prelude::*;
use scale_info::TypeInfo;

const DAY_MS: u64 = 86_400_000;
const DEFAULT_DAY_BOUNDARY_OFFSET_MS: u64 = 43_200_000;
const MAX_WINNERS_PER_DAY: usize = 128;
const MAX_PAGE_SIZE: u32 = 100;

#[derive(Debug, Clone, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct DailyContestConfig {
    pub admin_role: ActorId,
    pub settler_role: ActorId,
    pub prize_payouts: Vec<u128>,
    pub grace_period_ms: u64,
    pub day_boundary_offset_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct WinnerInput {
    pub account: ActorId,
    pub realized_profit: i128,
}

#[derive(Debug, Clone, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct WinnerPayout {
    pub account: ActorId,
    pub realized_profit: i128,
    pub reward: u128,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum DayStatus {
    Settled,
    NoWinner,
}

#[derive(Debug, Clone, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct ContestDay {
    pub day_id: u64,
    pub status: DayStatus,
    pub winners: Vec<WinnerPayout>,
    pub total_reward: u128,
    pub settled_at: u64,
    pub settled_by: ActorId,
    pub result_hash: [u8; 32],
    pub evidence_hash: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct Pagination {
    pub offset: u32,
    pub limit: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Encode, Decode, TypeInfo, thiserror::Error)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum DailyContestError {
    #[error("access denied")]
    Unauthorized,
    #[error("invalid configuration")]
    InvalidConfig,
    #[error("funding amount must be greater than zero")]
    InvalidFundingAmount,
    #[error("day has not closed yet")]
    DayNotClosed,
    #[error("day already settled")]
    DayAlreadySettled,
    #[error("day not found")]
    DayNotFound,
    #[error("winner list too large")]
    TooManyWinners,
    #[error("winner list must be strictly sorted by account")]
    WinnersNotSorted,
    #[error("duplicate winner account")]
    DuplicateWinner,
    #[error("all winners must carry the same realized profit")]
    WinnerProfitMismatch,
    #[error("insufficient reward pool")]
    InsufficientRewardPool,
    #[error("transfer failed")]
    TransferFailed,
    #[error("math overflow")]
    MathOverflow,
    #[error("invalid page size")]
    InvalidPageSize,
    #[error("value is not accepted for this route")]
    ValueNotAllowed,
    #[error("event emission failed")]
    EventEmitFailed,
}

#[event]
#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum Event {
    Funded {
        from: ActorId,
        amount: u128,
        reward_pool: u128,
    },
    DaySettled {
        day_id: u64,
        winner_count: u32,
        total_reward: u128,
        settled_at: u64,
        result_hash: [u8; 32],
        evidence_hash: [u8; 32],
    },
    WinnersPaid {
        day_id: u64,
        payouts: Vec<WinnerPayout>,
    },
    ConfigUpdated {
        config: DailyContestConfig,
    },
    FundsWithdrawn {
        to: ActorId,
        amount: u128,
        reward_pool: u128,
    },
}

#[derive(Debug, Clone, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct State {
    pub days: BTreeMap<u64, ContestDay>,
    pub reward_pool: u128,
    pub config: DailyContestConfig,
}

impl Default for State {
    fn default() -> Self {
        Self {
            days: BTreeMap::new(),
            reward_pool: 0,
            config: DailyContestConfig {
                admin_role: ActorId::zero(),
                settler_role: ActorId::zero(),
                prize_payouts: Vec::new(),
                grace_period_ms: 0,
                day_boundary_offset_ms: DEFAULT_DAY_BOUNDARY_OFFSET_MS,
            },
        }
    }
}

struct DailyContestService<'a> {
    state: &'a mut State,
}

impl<'a> DailyContestService<'a> {
    pub fn new(state: &'a mut State) -> Self {
        Self { state }
    }

    fn ensure_admin_or_settler(&self) -> Result<(), DailyContestError> {
        let caller = sails_rs::gstd::msg::source();
        if caller != self.state.config.admin_role && caller != self.state.config.settler_role {
            return Err(DailyContestError::Unauthorized);
        }

        Ok(())
    }

    fn ensure_admin(&self) -> Result<(), DailyContestError> {
        if sails_rs::gstd::msg::source() != self.state.config.admin_role {
            return Err(DailyContestError::Unauthorized);
        }

        Ok(())
    }

    fn ensure_zero_value(&self) -> Result<(), DailyContestError> {
        if sails_rs::gstd::msg::value() != 0 {
            return Err(DailyContestError::ValueNotAllowed);
        }

        Ok(())
    }

    fn account_balance() -> u128 {
        // `value_available` is the contract account balance available to the
        // current execution and already includes value attached to this message.
        sails_rs::gstd::exec::value_available()
    }

    fn sync_reward_pool(&mut self) -> u128 {
        self.state.reward_pool = Self::account_balance();
        self.state.reward_pool
    }

    fn validate_config(config: &DailyContestConfig) -> Result<(), DailyContestError> {
        if config.admin_role == ActorId::zero()
            || config.settler_role == ActorId::zero()
            || config.day_boundary_offset_ms >= DAY_MS
        {
            return Err(DailyContestError::InvalidConfig);
        }

        Self::validate_prize_payouts(&config.prize_payouts)?;

        Ok(())
    }

    fn validate_admin_role(admin_role: ActorId) -> Result<(), DailyContestError> {
        if admin_role == ActorId::zero() {
            return Err(DailyContestError::InvalidConfig);
        }

        Ok(())
    }

    fn validate_settler_role(settler_role: ActorId) -> Result<(), DailyContestError> {
        if settler_role == ActorId::zero() {
            return Err(DailyContestError::InvalidConfig);
        }

        Ok(())
    }

    fn validate_prize_payouts(prize_payouts: &[u128]) -> Result<(), DailyContestError> {
        if prize_payouts.is_empty() || prize_payouts.iter().any(|reward| *reward == 0) {
            return Err(DailyContestError::InvalidConfig);
        }

        Ok(())
    }

    fn validate_pagination(limit: u32) -> Result<(), DailyContestError> {
        if limit == 0 || limit > MAX_PAGE_SIZE {
            return Err(DailyContestError::InvalidPageSize);
        }

        Ok(())
    }

    fn day_start_ms(day_id: u64, day_boundary_offset_ms: u64) -> Result<u64, DailyContestError> {
        day_id
            .checked_mul(DAY_MS)
            .and_then(|start| start.checked_add(day_boundary_offset_ms))
            .ok_or(DailyContestError::MathOverflow)
    }

    #[allow(dead_code)]
    fn day_end_ms(day_id: u64, day_boundary_offset_ms: u64) -> Result<u64, DailyContestError> {
        Self::day_start_ms(day_id, day_boundary_offset_ms)?
            .checked_add(DAY_MS)
            .and_then(|next_day_start| next_day_start.checked_sub(1))
            .ok_or(DailyContestError::MathOverflow)
    }

    fn settlement_allowed_at_ms(
        day_id: u64,
        day_boundary_offset_ms: u64,
        grace_period_ms: u64,
    ) -> Result<u64, DailyContestError> {
        day_id
            .checked_add(1)
            .ok_or(DailyContestError::MathOverflow)
            .and_then(|next_day_id| Self::day_start_ms(next_day_id, day_boundary_offset_ms))
            .and_then(|next_day_start| {
                next_day_start
                    .checked_add(grace_period_ms)
                    .ok_or(DailyContestError::MathOverflow)
            })
    }

    fn validate_winners(winners: &[WinnerInput]) -> Result<(), DailyContestError> {
        if winners.len() > MAX_WINNERS_PER_DAY {
            return Err(DailyContestError::TooManyWinners);
        }

        for (index, winner) in winners.iter().enumerate() {
            if winners
                .iter()
                .skip(index + 1)
                .any(|other| other.account == winner.account)
            {
                return Err(DailyContestError::DuplicateWinner);
            }
        }

        Ok(())
    }

    fn prize_payouts_for_winners(
        prize_payouts: &[u128],
        winners: &[WinnerInput],
    ) -> Result<Vec<WinnerPayout>, DailyContestError> {
        if winners.len() > prize_payouts.len() {
            return Err(DailyContestError::TooManyWinners);
        }

        let mut result = Vec::with_capacity(winners.len());
        for (index, winner) in winners.iter().enumerate() {
            result.push(WinnerPayout {
                account: winner.account,
                realized_profit: winner.realized_profit,
                reward: prize_payouts[index],
            });
        }

        Ok(result)
    }
}

#[sails_rs::service(events = Event)]
impl<'a> DailyContestService<'a> {
    #[export(unwrap_result)]
    pub fn fund(&mut self) -> Result<u128, DailyContestError> {
        // Funding is intentionally public: anyone may top up the contest treasury.
        // The pool mirrors the real account balance so direct transfers are usable too.
        let amount = sails_rs::gstd::msg::value();
        if amount == 0 {
            return Err(DailyContestError::InvalidFundingAmount);
        }

        let reward_pool = self.sync_reward_pool();

        self.emit_event(Event::Funded {
            from: sails_rs::gstd::msg::source(),
            amount,
            reward_pool,
        })
        .map_err(|_| DailyContestError::EventEmitFailed)?;

        Ok(reward_pool)
    }

    #[export(unwrap_result)]
    pub fn set_config(&mut self, config: DailyContestConfig) -> Result<(), DailyContestError> {
        self.ensure_zero_value()?;
        self.ensure_admin()?;
        DailyContestService::validate_config(&config)?;

        self.state.config = config.clone();

        self.emit_event(Event::ConfigUpdated { config })
            .map_err(|_| DailyContestError::EventEmitFailed)?;

        Ok(())
    }

    #[export(unwrap_result)]
    pub fn set_admin_role(&mut self, admin_role: ActorId) -> Result<(), DailyContestError> {
        self.ensure_zero_value()?;
        self.ensure_admin()?;
        DailyContestService::validate_admin_role(admin_role)?;

        self.state.config.admin_role = admin_role;

        self.emit_event(Event::ConfigUpdated {
            config: self.state.config.clone(),
        })
        .map_err(|_| DailyContestError::EventEmitFailed)?;

        Ok(())
    }

    #[export(unwrap_result)]
    pub fn set_settler_role(&mut self, settler_role: ActorId) -> Result<(), DailyContestError> {
        self.ensure_zero_value()?;
        self.ensure_admin()?;
        DailyContestService::validate_settler_role(settler_role)?;

        self.state.config.settler_role = settler_role;

        self.emit_event(Event::ConfigUpdated {
            config: self.state.config.clone(),
        })
        .map_err(|_| DailyContestError::EventEmitFailed)?;

        Ok(())
    }

    #[export(unwrap_result)]
    pub fn set_roles(
        &mut self,
        admin_role: ActorId,
        settler_role: ActorId,
    ) -> Result<(), DailyContestError> {
        self.ensure_zero_value()?;
        self.ensure_admin()?;
        DailyContestService::validate_admin_role(admin_role)?;
        DailyContestService::validate_settler_role(settler_role)?;

        self.state.config.admin_role = admin_role;
        self.state.config.settler_role = settler_role;

        self.emit_event(Event::ConfigUpdated {
            config: self.state.config.clone(),
        })
        .map_err(|_| DailyContestError::EventEmitFailed)?;

        Ok(())
    }

    #[export(unwrap_result)]
    pub fn set_prize_payouts(&mut self, prize_payouts: Vec<u128>) -> Result<(), DailyContestError> {
        self.ensure_zero_value()?;
        self.ensure_admin()?;
        DailyContestService::validate_prize_payouts(&prize_payouts)?;

        self.state.config.prize_payouts = prize_payouts;

        self.emit_event(Event::ConfigUpdated {
            config: self.state.config.clone(),
        })
        .map_err(|_| DailyContestError::EventEmitFailed)?;

        Ok(())
    }

    #[export(unwrap_result)]
    pub fn set_grace_period(&mut self, grace_period_ms: u64) -> Result<(), DailyContestError> {
        self.ensure_zero_value()?;
        self.ensure_admin()?;

        self.state.config.grace_period_ms = grace_period_ms;

        self.emit_event(Event::ConfigUpdated {
            config: self.state.config.clone(),
        })
        .map_err(|_| DailyContestError::EventEmitFailed)?;

        Ok(())
    }

    #[export(unwrap_result)]
    pub fn set_day_boundary_offset(
        &mut self,
        day_boundary_offset_ms: u64,
    ) -> Result<(), DailyContestError> {
        self.ensure_zero_value()?;
        self.ensure_admin()?;

        if day_boundary_offset_ms >= DAY_MS {
            return Err(DailyContestError::InvalidConfig);
        }

        self.state.config.day_boundary_offset_ms = day_boundary_offset_ms;

        self.emit_event(Event::ConfigUpdated {
            config: self.state.config.clone(),
        })
        .map_err(|_| DailyContestError::EventEmitFailed)?;

        Ok(())
    }

    #[export(unwrap_result)]
    pub fn withdraw_funds(&mut self, to: ActorId, amount: u128) -> Result<u128, DailyContestError> {
        self.ensure_zero_value()?;
        self.ensure_admin()?;

        self.sync_reward_pool();

        if amount > self.state.reward_pool {
            return Err(DailyContestError::InsufficientRewardPool);
        }

        if amount > 0 {
            sails_rs::gstd::msg::send_bytes_with_gas(to, b"", 0, amount)
                .map_err(|_| DailyContestError::TransferFailed)?;
        }

        self.state.reward_pool = self
            .state
            .reward_pool
            .checked_sub(amount)
            .ok_or(DailyContestError::MathOverflow)?;

        self.emit_event(Event::FundsWithdrawn {
            to,
            amount,
            reward_pool: self.state.reward_pool,
        })
        .map_err(|_| DailyContestError::EventEmitFailed)?;

        Ok(self.state.reward_pool)
    }

    #[export(unwrap_result)]
    pub fn settle_day(
        &mut self,
        day_id: u64,
        winners: Vec<WinnerInput>,
        result_hash: [u8; 32],
        evidence_hash: [u8; 32],
    ) -> Result<(), DailyContestError> {
        self.ensure_zero_value()?;
        self.ensure_admin_or_settler()?;
        DailyContestService::validate_winners(&winners)?;

        if self.state.days.contains_key(&day_id) {
            return Err(DailyContestError::DayAlreadySettled);
        }

        let now = sails_rs::gstd::exec::block_timestamp();
        let settlement_allowed_at = DailyContestService::settlement_allowed_at_ms(
            day_id,
            self.state.config.day_boundary_offset_ms,
            self.state.config.grace_period_ms,
        )?;
        if now < settlement_allowed_at {
            return Err(DailyContestError::DayNotClosed);
        }

        self.sync_reward_pool();

        let (status, reward, payouts) = if winners.is_empty() {
            (DayStatus::NoWinner, 0, Vec::new())
        } else {
            if winners.len() > self.state.config.prize_payouts.len() {
                return Err(DailyContestError::TooManyWinners);
            }

            let reward = self
                .state
                .config
                .prize_payouts
                .iter()
                .take(winners.len())
                .try_fold(0u128, |total, payout| {
                    total
                        .checked_add(*payout)
                        .ok_or(DailyContestError::MathOverflow)
                })?;
            if self.state.reward_pool < reward {
                return Err(DailyContestError::InsufficientRewardPool);
            }

            let payouts = DailyContestService::prize_payouts_for_winners(
                &self.state.config.prize_payouts,
                &winners,
            )?;

            for payout in payouts.iter() {
                if payout.reward > 0 {
                    sails_rs::gstd::msg::send_bytes_with_gas(payout.account, b"", 0, payout.reward)
                        .map_err(|_| DailyContestError::TransferFailed)?;
                }
            }

            self.emit_event(Event::WinnersPaid {
                day_id,
                payouts: payouts.clone(),
            })
            .map_err(|_| DailyContestError::EventEmitFailed)?;

            self.state.reward_pool = self
                .state
                .reward_pool
                .checked_sub(reward)
                .ok_or(DailyContestError::MathOverflow)?;

            (DayStatus::Settled, reward, payouts)
        };

        self.state.days.insert(
            day_id,
            ContestDay {
                day_id,
                status,
                winners: payouts,
                total_reward: reward,
                settled_at: now,
                settled_by: sails_rs::gstd::msg::source(),
                result_hash,
                evidence_hash,
            },
        );

        self.emit_event(Event::DaySettled {
            day_id,
            winner_count: winners.len() as u32,
            total_reward: reward,
            settled_at: now,
            result_hash,
            evidence_hash,
        })
        .map_err(|_| DailyContestError::EventEmitFailed)?;

        Ok(())
    }

    #[export]
    pub fn get_config(&self) -> DailyContestConfig {
        self.state.config.clone()
    }

    #[export]
    pub fn get_reward_pool(&self) -> u128 {
        DailyContestService::account_balance()
    }

    #[export]
    pub fn get_day_count(&self) -> u64 {
        self.state.days.len() as u64
    }

    #[export]
    pub fn get_day(&self, day_id: u64) -> Result<ContestDay, DailyContestError> {
        self.state
            .days
            .get(&day_id)
            .cloned()
            .ok_or(DailyContestError::DayNotFound)
    }

    #[export(unwrap_result)]
    pub fn list_days(&self, query: Pagination) -> Result<Vec<ContestDay>, DailyContestError> {
        DailyContestService::validate_pagination(query.limit)?;

        Ok(self
            .state
            .days
            .values()
            .skip(query.offset as usize)
            .take(query.limit as usize)
            .cloned()
            .collect())
    }
}

pub struct DailyContestProgram {
    state: State,
}

#[sails_rs::program]
impl DailyContestProgram {
    pub fn new(config: DailyContestConfig) -> Self {
        DailyContestService::validate_config(&config).expect("invalid initial config");

        Self {
            state: State {
                days: BTreeMap::new(),
                reward_pool: 0,
                config,
            },
        }
    }

    pub fn daily_contest(&mut self) -> DailyContestService<'_> {
        DailyContestService::new(&mut self.state)
    }
}
