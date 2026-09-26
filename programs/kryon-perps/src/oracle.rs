//! Pyth pull-oracle reads (`06` §2, §8).
//!
//! The feed id always comes from our own `Market`/`Collateral` account, never
//! from the caller. The account must be the fixed push-feed account for
//! `(shard, feed_id)`, so a caller cannot pick among several recent prices by
//! posting their own update account.

use crate::error::KryonError;
use anchor_lang::prelude::*;
use protocol_core::{OracleGuard, OracleSnapshot, OracleSource, PRECISION};
use pyth_solana_receiver_sdk::price_update::{PriceUpdateV2, VerificationLevel};
use pyth_solana_receiver_sdk::PYTH_PUSH_ORACLE_ID;

/// The push-feed account Pyth's pusher keeps updated for `(shard, feed_id)`.
/// Shard 0 holds the Pyth-sponsored feeds; any other shard is ours.
pub fn push_feed_address(shard_id: u16, feed_id: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(&[&shard_id.to_le_bytes(), feed_id], &PYTH_PUSH_ORACLE_ID).0
}

/// Rescale a Pyth fixed-point value (`value · 10^exponent`) to PRECISION.
pub fn pyth_to_precision(value: i128, exponent: i32) -> Result<i128> {
    let shift = 18i32
        .checked_add(exponent)
        .ok_or(KryonError::InvalidPrice)?;
    require!((-38..=38).contains(&shift), KryonError::InvalidPrice);
    let out = if shift >= 0 {
        value.checked_mul(10i128.pow(shift as u32))
    } else {
        value.checked_div(10i128.pow((-shift) as u32))
    };
    out.ok_or_else(|| error!(KryonError::MathOverflow))
}

/// Read `ai` as the Pyth feed `feed_id` on `shard_id`. Checks the account
/// address, owner (receiver program), discriminator, full verification and
/// feed id. Freshness and confidence are checked separately with
/// [`OracleSnapshot::validate`], because a Closed market may read a stale feed.
pub fn read_pyth(ai: &AccountInfo, feed_id: &[u8; 32], shard_id: u16) -> Result<OracleSnapshot> {
    require_keys_eq!(
        ai.key(),
        push_feed_address(shard_id, feed_id),
        KryonError::InvalidOracleAccount
    );
    require_keys_eq!(
        *ai.owner,
        pyth_solana_receiver_sdk::ID,
        KryonError::InvalidOracleAccount
    );
    let data = ai.try_borrow_data()?;
    // try_deserialize checks the account discriminator.
    let update = PriceUpdateV2::try_deserialize(&mut &data[..])
        .map_err(|_| error!(KryonError::InvalidOracleAccount))?;
    require!(
        update.verification_level == VerificationLevel::Full,
        KryonError::OracleNotFullyVerified
    );
    let msg = &update.price_message;
    require!(msg.feed_id == *feed_id, KryonError::InvalidOracleAccount);
    require!(msg.publish_time >= 0, KryonError::InvalidPrice);
    let publish_time = msg.publish_time as u64;
    Ok(OracleSnapshot {
        asset: [0; 16],
        price: pyth_to_precision(i128::from(msg.price), msg.exponent)?,
        confidence: pyth_to_precision(i128::from(msg.conf), msg.exponent)?,
        source: OracleSource::Pyth,
        publish_time,
        // A pull update has no separate on-chain write time we can trust
        // more than its publish time.
        write_time: publish_time,
    })
}

/// Read and require a fresh, tight price.
pub fn read_pyth_checked(
    ai: &AccountInfo,
    feed_id: &[u8; 32],
    shard_id: u16,
    now: u64,
    guard: &OracleGuard,
) -> Result<OracleSnapshot> {
    let snap = read_pyth(ai, feed_id, shard_id)?;
    snap.validate(now, guard)
        .map_err(|e| error!(KryonError::from(e)))?;
    Ok(snap)
}

const _: () = assert!(PRECISION == 1_000_000_000_000_000_000);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pyth_exponents_rescale_to_precision() {
        // $250.12345678 at expo -8.
        assert_eq!(
            pyth_to_precision(25_012_345_678, -8).unwrap(),
            250_123_456_780_000_000_000
        );
        assert_eq!(pyth_to_precision(5, 0).unwrap(), 5 * PRECISION);
        // More decimals than PRECISION truncate.
        assert_eq!(pyth_to_precision(123, -20).unwrap(), 1);
        assert!(pyth_to_precision(1, 30).is_err());
    }

    #[test]
    fn shards_give_distinct_feed_accounts() {
        let feed = [9u8; 32];
        assert_ne!(push_feed_address(0, &feed), push_feed_address(1, &feed));
    }
}
