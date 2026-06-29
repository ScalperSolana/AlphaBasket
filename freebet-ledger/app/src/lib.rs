#![no_std]

use parity_scale_codec::{Decode, Encode};
use polymarket_mirror_client::{
    PolymarketMirror, PolymarketMirrorProgram, SignedVaraBetQuote, basket_market::BasketMarket,
};
use sails_rs::client::Program as _;
use sails_rs::collections::{BTreeMap, BTreeSet};
use sails_rs::gstd::{exec, msg};
use sails_rs::prelude::*;
use scale_info::TypeInfo;

const MAX_GRANT_ID_LEN: usize = 128;
const MAX_REASON_LEN: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct FreebetLedgerInit {
    pub admin: ActorId,
}

#[derive(Debug, Clone, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct FreebetGrant {
    pub id: String,
    pub recipient: ActorId,
    pub amount: u128,
    pub reason: String,
    pub granted_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Encode, Decode, TypeInfo, thiserror::Error)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum FreebetLedgerError {
    #[error("access denied")]
    Unauthorized,
    #[error("invalid config")]
    InvalidConfig,
    #[error("amount must be greater than zero")]
    InvalidAmount,
    #[error("freebet balance is too low")]
    InsufficientBalance,
    #[error("grant has already been applied")]
    GrantAlreadyApplied,
    #[error("grant id is too long")]
    GrantIdTooLong,
    #[error("grant reason is too long")]
    GrantReasonTooLong,
    #[error("bet program is not authorized")]
    BetProgramNotAuthorized,
    #[error("operation already in progress")]
    OperationInProgress,
    #[error("downstream freebet bet failed")]
    DownstreamBetFailed,
    #[error("return value does not match payload")]
    InvalidReturnValue,
    #[error("math overflow")]
    MathOverflow,
    #[error("event emission failed")]
    EventEmitFailed,
}

#[event]
#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum Event {
    BetProgramAuthorized {
        program_id: ActorId,
    },
    BetProgramRevoked {
        program_id: ActorId,
    },
    FreebetGranted {
        recipient: ActorId,
        amount: u128,
        balance: u128,
        grant_id: String,
        reason: String,
    },
    FreebetSpent {
        user: ActorId,
        bet_program_id: ActorId,
        basket_id: u64,
        amount: u128,
        remaining_balance: u128,
    },
    FreebetReturned {
        user: ActorId,
        bet_program_id: ActorId,
        basket_id: u64,
        amount: u128,
        balance: u128,
    },
    FreebetSpendFailed {
        user: ActorId,
        bet_program_id: ActorId,
        basket_id: u64,
        amount: u128,
        restored_balance: u128,
    },
}

#[derive(Debug, Clone, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct State {
    pub admin: ActorId,
    pub balances: BTreeMap<ActorId, u128>,
    pub grants: BTreeMap<String, FreebetGrant>,
    pub authorized_bet_programs: BTreeSet<ActorId>,
    pub pending_spends: BTreeSet<(ActorId, ActorId, u64)>,
}

impl State {
    fn new(init: FreebetLedgerInit) -> Self {
        if init.admin == ActorId::zero() {
            panic!("invalid freebet ledger admin");
        }

        Self {
            admin: init.admin,
            balances: BTreeMap::new(),
            grants: BTreeMap::new(),
            authorized_bet_programs: BTreeSet::new(),
            pending_spends: BTreeSet::new(),
        }
    }
}

pub struct FreebetLedgerService<'a> {
    state: &'a mut State,
}

impl<'a> FreebetLedgerService<'a> {
    pub fn new(state: &'a mut State) -> Self {
        Self { state }
    }

    fn ensure_admin(&self) -> Result<(), FreebetLedgerError> {
        if msg::source() != self.state.admin {
            return Err(FreebetLedgerError::Unauthorized);
        }

        Ok(())
    }

    fn ensure_authorized_bet_program(&self, program_id: ActorId) -> Result<(), FreebetLedgerError> {
        if !self.state.authorized_bet_programs.contains(&program_id) {
            return Err(FreebetLedgerError::BetProgramNotAuthorized);
        }

        Ok(())
    }

    fn validate_grant(grant_id: &str, reason: &str) -> Result<(), FreebetLedgerError> {
        if grant_id.len() > MAX_GRANT_ID_LEN {
            return Err(FreebetLedgerError::GrantIdTooLong);
        }
        if reason.len() > MAX_REASON_LEN {
            return Err(FreebetLedgerError::GrantReasonTooLong);
        }

        Ok(())
    }

    fn add_balance(&mut self, user: ActorId, amount: u128) -> Result<u128, FreebetLedgerError> {
        let balance = self
            .state
            .balances
            .get(&user)
            .copied()
            .unwrap_or(0)
            .checked_add(amount)
            .ok_or(FreebetLedgerError::MathOverflow)?;
        self.state.balances.insert(user, balance);
        Ok(balance)
    }

    fn subtract_balance(
        &mut self,
        user: ActorId,
        amount: u128,
    ) -> Result<u128, FreebetLedgerError> {
        let current_balance = self.state.balances.get(&user).copied().unwrap_or(0);
        if current_balance < amount {
            return Err(FreebetLedgerError::InsufficientBalance);
        }

        let remaining_balance = current_balance
            .checked_sub(amount)
            .ok_or(FreebetLedgerError::MathOverflow)?;
        self.state.balances.insert(user, remaining_balance);
        Ok(remaining_balance)
    }

    fn basket_actor(
        program_id: ActorId,
    ) -> sails_rs::client::Actor<PolymarketMirrorProgram, sails_rs::client::GstdEnv> {
        PolymarketMirrorProgram::client(program_id)
    }
}

#[sails_rs::service(events = Event)]
impl<'a> FreebetLedgerService<'a> {
    #[export]
    pub fn admin(&self) -> ActorId {
        self.state.admin
    }

    #[export]
    pub fn balance_of(&self, user: ActorId) -> u128 {
        self.state.balances.get(&user).copied().unwrap_or(0)
    }

    #[export]
    pub fn get_grant(&self, grant_id: String) -> Option<FreebetGrant> {
        self.state.grants.get(&grant_id).cloned()
    }

    #[export]
    pub fn is_bet_program_authorized(&self, program_id: ActorId) -> bool {
        self.state.authorized_bet_programs.contains(&program_id)
    }

    #[export]
    pub fn get_pending_spend_count(&self) -> u64 {
        self.state.pending_spends.len() as u64
    }

    #[export(unwrap_result)]
    pub fn authorize_bet_program(&mut self, program_id: ActorId) -> Result<(), FreebetLedgerError> {
        self.ensure_admin()?;
        if program_id == ActorId::zero() {
            return Err(FreebetLedgerError::InvalidConfig);
        }

        self.state.authorized_bet_programs.insert(program_id);
        self.emit_event(Event::BetProgramAuthorized { program_id })
            .map_err(|_| FreebetLedgerError::EventEmitFailed)?;
        Ok(())
    }

    #[export(unwrap_result)]
    pub fn revoke_bet_program(&mut self, program_id: ActorId) -> Result<(), FreebetLedgerError> {
        self.ensure_admin()?;
        self.state.authorized_bet_programs.remove(&program_id);
        self.emit_event(Event::BetProgramRevoked { program_id })
            .map_err(|_| FreebetLedgerError::EventEmitFailed)?;
        Ok(())
    }

    #[export(unwrap_result)]
    pub fn grant(
        &mut self,
        to: ActorId,
        grant_id: String,
        reason: String,
    ) -> Result<u128, FreebetLedgerError> {
        self.ensure_admin()?;
        FreebetLedgerService::validate_grant(&grant_id, &reason)?;

        let amount = msg::value();
        if amount == 0 {
            return Err(FreebetLedgerError::InvalidAmount);
        }
        if self.state.grants.contains_key(&grant_id) {
            return Err(FreebetLedgerError::GrantAlreadyApplied);
        }

        let balance = self.add_balance(to, amount)?;
        self.state.grants.insert(
            grant_id.clone(),
            FreebetGrant {
                id: grant_id.clone(),
                recipient: to,
                amount,
                reason: reason.clone(),
                granted_at: exec::block_timestamp(),
            },
        );

        self.emit_event(Event::FreebetGranted {
            recipient: to,
            amount,
            balance,
            grant_id,
            reason,
        })
        .map_err(|_| FreebetLedgerError::EventEmitFailed)?;

        Ok(balance)
    }

    #[export(unwrap_result)]
    pub async fn spend_freebet(
        &mut self,
        bet_program_id: ActorId,
        basket_id: u64,
        amount: u128,
        signed_quote: SignedVaraBetQuote,
    ) -> Result<u128, FreebetLedgerError> {
        if amount == 0 {
            return Err(FreebetLedgerError::InvalidAmount);
        }
        self.ensure_authorized_bet_program(bet_program_id)?;

        let user = msg::source();
        let pending_key = (user, bet_program_id, basket_id);
        if !self.state.pending_spends.insert(pending_key) {
            return Err(FreebetLedgerError::OperationInProgress);
        }

        let remaining_balance = match self.subtract_balance(user, amount) {
            Ok(balance) => balance,
            Err(error) => {
                self.state.pending_spends.remove(&pending_key);
                return Err(error);
            }
        };

        let downstream_result = FreebetLedgerService::basket_actor(bet_program_id)
            .basket_market()
            .bet_on_basket_from_freebet_ledger(user, basket_id, signed_quote)
            .with_value(amount)
            .await;

        if downstream_result.is_err() {
            let restored_balance = self.add_balance(user, amount)?;
            self.state.pending_spends.remove(&pending_key);
            self.emit_event(Event::FreebetSpendFailed {
                user,
                bet_program_id,
                basket_id,
                amount,
                restored_balance,
            })
            .map_err(|_| FreebetLedgerError::EventEmitFailed)?;
            return Ok(0);
        }

        self.state.pending_spends.remove(&pending_key);
        self.emit_event(Event::FreebetSpent {
            user,
            bet_program_id,
            basket_id,
            amount,
            remaining_balance,
        })
        .map_err(|_| FreebetLedgerError::EventEmitFailed)?;

        Ok(amount)
    }

    #[export(unwrap_result)]
    pub fn return_freebet(
        &mut self,
        user: ActorId,
        basket_id: u64,
    ) -> Result<u128, FreebetLedgerError> {
        let bet_program_id = msg::source();
        self.ensure_authorized_bet_program(bet_program_id)?;

        let amount = msg::value();
        if amount == 0 {
            return Err(FreebetLedgerError::InvalidAmount);
        }

        let balance = self.add_balance(user, amount)?;
        self.emit_event(Event::FreebetReturned {
            user,
            bet_program_id,
            basket_id,
            amount,
            balance,
        })
        .map_err(|_| FreebetLedgerError::EventEmitFailed)?;

        Ok(balance)
    }
}

pub struct FreebetLedgerProgram {
    state: State,
}

#[sails_rs::program]
impl FreebetLedgerProgram {
    pub fn new(init: FreebetLedgerInit) -> Self {
        Self {
            state: State::new(init),
        }
    }

    pub fn freebet_ledger(&mut self) -> FreebetLedgerService<'_> {
        FreebetLedgerService::new(&mut self.state)
    }
}
