use anchor_lang::prelude::*;

use crate::constants::{MANAGEMENT_FEE_BPS, MANAGEMENT_FEE_PERIOD_SECS, MAX_BPS, SHARE_SCALE};
use crate::errors::EscrowError;

/// Protocol fees round up so dust-sized requests cannot avoid configured fees.
pub fn fee_ceil(amount: u64, fee_bps: u16) -> Result<u64> {
    let numerator = (amount as u128)
        .checked_mul(fee_bps as u128)
        .and_then(|value| value.checked_add(MAX_BPS as u128 - 1))
        .ok_or(EscrowError::MathOverflow)?;
    let fee = numerator
        .checked_div(MAX_BPS as u128)
        .ok_or(EscrowError::MathOverflow)?;
    u64::try_from(fee).map_err(|_| error!(EscrowError::MathOverflow))
}

/// Deposit shares round down in the protocol's favour.
pub fn shares_for_value(net_value: u64, share_price: u64) -> Result<u64> {
    require!(share_price > 0, EscrowError::InvalidSettlementValues);
    let shares = (net_value as u128)
        .checked_mul(SHARE_SCALE as u128)
        .and_then(|value| value.checked_div(share_price as u128))
        .ok_or(EscrowError::MathOverflow)?;
    u64::try_from(shares).map_err(|_| error!(EscrowError::MathOverflow))
}

/// Current share price from the backend-computed NAV and on-chain supply.
pub fn share_price_from_nav(nav_value: u64, total_shares: u64) -> Result<u64> {
    require!(total_shares > 0, EscrowError::InvalidSettlementValues);
    let price = (nav_value as u128)
        .checked_mul(SHARE_SCALE as u128)
        .and_then(|value| value.checked_div(total_shares as u128))
        .ok_or(EscrowError::MathOverflow)?;
    u64::try_from(price).map_err(|_| error!(EscrowError::MathOverflow))
}

/// Gross value represented by shares at a six-decimal share price.
pub fn value_for_shares(shares: u64, share_price: u64) -> Result<u64> {
    let value = (shares as u128)
        .checked_mul(share_price as u128)
        .and_then(|amount| amount.checked_div(SHARE_SCALE as u128))
        .ok_or(EscrowError::MathOverflow)?;
    u64::try_from(value).map_err(|_| error!(EscrowError::MathOverflow))
}

/// Shares minted to transfer exactly 0.35% of user AUM for one fee period.
pub fn management_fee_shares(total_shares: u64) -> Result<u64> {
    let denominator = MAX_BPS
        .checked_sub(MANAGEMENT_FEE_BPS)
        .ok_or(EscrowError::InvalidBasisPoints)?;
    let shares = (total_shares as u128)
        .checked_mul(MANAGEMENT_FEE_BPS as u128)
        .and_then(|value| value.checked_div(denominator as u128))
        .ok_or(EscrowError::MathOverflow)?;
    u64::try_from(shares).map_err(|_| error!(EscrowError::MathOverflow))
}

/// Time-weights monthly management dilution and carries sub-share precision
/// forward so frequent keeper calls cannot erase fees through rounding.
pub fn management_fee_shares_for_elapsed(
    total_shares: u64,
    elapsed_seconds: i64,
    prior_remainder: u128,
) -> Result<(u64, u128)> {
    require!(elapsed_seconds >= 0, EscrowError::InvalidSettlementValues);
    let elapsed = u128::try_from(elapsed_seconds).map_err(|_| EscrowError::MathOverflow)?;
    let period =
        u128::try_from(MANAGEMENT_FEE_PERIOD_SECS).map_err(|_| EscrowError::MathOverflow)?;
    let dilution_denominator = (MAX_BPS as u128)
        .checked_sub(MANAGEMENT_FEE_BPS as u128)
        .and_then(|value| value.checked_mul(period))
        .ok_or(EscrowError::MathOverflow)?;
    require!(
        prior_remainder < dilution_denominator,
        EscrowError::InvalidSettlementValues
    );
    let numerator = (total_shares as u128)
        .checked_mul(MANAGEMENT_FEE_BPS as u128)
        .and_then(|value| value.checked_mul(elapsed))
        .and_then(|value| value.checked_add(prior_remainder))
        .ok_or(EscrowError::MathOverflow)?;
    let minted = numerator
        .checked_div(dilution_denominator)
        .ok_or(EscrowError::MathOverflow)?;
    let remainder = numerator
        .checked_rem(dilution_denominator)
        .ok_or(EscrowError::MathOverflow)?;
    Ok((
        u64::try_from(minted).map_err(|_| error!(EscrowError::MathOverflow))?,
        remainder,
    ))
}

/// Performance fees round down so a creator can never receive more than the
/// configured percentage of realized profit.
pub fn fee_floor(amount: u64, fee_bps: u16) -> Result<u64> {
    let fee = (amount as u128)
        .checked_mul(fee_bps as u128)
        .and_then(|value| value.checked_div(MAX_BPS as u128))
        .ok_or(EscrowError::MathOverflow)?;
    u64::try_from(fee).map_err(|_| error!(EscrowError::MathOverflow))
}

/// Allocates cost basis to a partial redemption. Partial allocations round up
/// in the user's favour; a full redemption consumes the exact remaining basis.
pub fn cost_basis_for_shares(
    cost_basis: u64,
    shares_redeemed: u64,
    shares_owned: u64,
) -> Result<u64> {
    require!(
        shares_owned > 0 && shares_redeemed <= shares_owned,
        EscrowError::InvalidSettlementValues
    );
    if shares_redeemed == shares_owned {
        return Ok(cost_basis);
    }
    let numerator = (cost_basis as u128)
        .checked_mul(shares_redeemed as u128)
        .and_then(|value| value.checked_add(shares_owned as u128 - 1))
        .ok_or(EscrowError::MathOverflow)?;
    let basis = numerator
        .checked_div(shares_owned as u128)
        .ok_or(EscrowError::MathOverflow)?;
    u64::try_from(basis).map_err(|_| error!(EscrowError::MathOverflow))
}

/// Minimum acceptable output derived from a quoted output and tolerance.
pub fn minimum_after_slippage(quoted_out: u64, tolerance_bps: u16) -> Result<u64> {
    let retained_bps = MAX_BPS
        .checked_sub(tolerance_bps)
        .ok_or(EscrowError::InvalidBasisPoints)?;
    let minimum = (quoted_out as u128)
        .checked_mul(retained_bps as u128)
        .and_then(|value| value.checked_div(MAX_BPS as u128))
        .ok_or(EscrowError::MathOverflow)?;
    u64::try_from(minimum).map_err(|_| error!(EscrowError::MathOverflow))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fee_rounds_up() {
        assert_eq!(fee_ceil(100_000_000, 50).unwrap(), 500_000);
        assert_eq!(fee_ceil(1, 50).unwrap(), 1);
    }

    #[test]
    fn shares_round_down() {
        assert_eq!(
            shares_for_value(494_000_000, 1_000_000).unwrap(),
            494_000_000
        );
        assert_eq!(shares_for_value(10, 3_000_000).unwrap(), 3);
        assert_eq!(
            share_price_from_nav(1_990_000_000, 995_000_000).unwrap(),
            2_000_000
        );
        assert_eq!(
            value_for_shares(497_500_000, 2_000_000).unwrap(),
            995_000_000
        );
        assert_eq!(management_fee_shares(25_000_000_000).unwrap(), 87_807_325);
        let (half_month, remainder) =
            management_fee_shares_for_elapsed(25_000_000_000, MANAGEMENT_FEE_PERIOD_SECS / 2, 0)
                .unwrap();
        let (second_half, _) = management_fee_shares_for_elapsed(
            25_000_000_000 + half_month,
            MANAGEMENT_FEE_PERIOD_SECS / 2,
            remainder,
        )
        .unwrap();
        assert!(half_month > 0);
        assert!(second_half >= half_month);
    }

    #[test]
    fn realized_profit_fee_and_basis_rounding() {
        assert_eq!(fee_floor(20_000_000, 1_000).unwrap(), 2_000_000);
        assert_eq!(
            cost_basis_for_shares(100_000_001, 50, 100).unwrap(),
            50_000_001
        );
        assert_eq!(
            cost_basis_for_shares(50_000_000, 50, 50).unwrap(),
            50_000_000
        );
        assert_eq!(
            minimum_after_slippage(100_000_000, 200).unwrap(),
            98_000_000
        );
    }
}
