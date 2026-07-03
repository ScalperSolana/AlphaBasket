use anchor_lang::prelude::*;

use crate::constants::MAX_BPS;
use crate::errors::EscrowError;

/// Calculate a basis-point fee, rounding up in the protocol's favour so a
/// sequence of dust-sized transfers cannot avoid fees through truncation.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn charges_two_percent_and_rounds_up() {
        assert_eq!(fee_ceil(100_000_000, 200).unwrap(), 2_000_000);
        assert_eq!(fee_ceil(1, 200).unwrap(), 1);
        assert_eq!(fee_ceil(51, 200).unwrap(), 2);
    }
}
