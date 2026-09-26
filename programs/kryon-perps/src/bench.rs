//! Compute-unit benchmarks (`--features bench` only). Each measurement reads
//! the remaining-CU counter around the call and logs the difference, minus the
//! cost of an empty measurement, so the number is the call alone.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::compute_units::sol_remaining_compute_units;
use core::hint::black_box;

fn measure<F: FnMut()>(mut f: F) -> u64 {
    let before = sol_remaining_compute_units();
    f();
    let after = sol_remaining_compute_units();
    before - after
}

pub fn mul_div(a: i128, b: i128, denominator: i128) -> Result<()> {
    let overhead = measure(|| {
        black_box((black_box(a), black_box(b), black_box(denominator)));
    });

    let mut out = Ok(0);
    let one = measure(|| {
        out = protocol_core::mul_div(black_box(a), black_box(b), black_box(denominator))
    });
    let one = one.saturating_sub(overhead);

    const N: u64 = 10;
    let mut acc = 0i128;
    let hundred = measure(|| {
        for i in 0..N as i128 {
            acc = acc.wrapping_add(
                protocol_core::mul_div(black_box(a + i), black_box(b), black_box(denominator))
                    .unwrap_or(0),
            );
        }
    });
    black_box(acc);

    msg!(
        "bench mul_div: result={:?} single={} cu, avg_of_{}={} cu",
        out,
        one,
        N,
        hundred / N
    );
    Ok(())
}

/// Prototype for the proposal in `05` §6, NOT used by the protocol: the same
/// truncate-toward-zero result as `protocol_core::mul_div`, via u128 when
/// `|a|·|b|` fits and I256 only when it doesn't.
#[inline(never)]
pub fn mul_div_u128_fast(a: i128, b: i128, d: i128) -> core::result::Result<i128, ()> {
    if d == 0 {
        return Err(());
    }
    let neg = (a < 0) ^ (b < 0) ^ (d < 0);
    match a.unsigned_abs().checked_mul(b.unsigned_abs()) {
        Some(p) => {
            let q = p / d.unsigned_abs();
            if neg {
                if q > i128::MAX as u128 + 1 {
                    Err(())
                } else {
                    Ok((q as i128).wrapping_neg())
                }
            } else {
                i128::try_from(q).map_err(|_| ())
            }
        }
        None => protocol_core::mul_div(a, b, d).map_err(|_| ()),
    }
}

pub fn mul_div_u128(a: i128, b: i128, denominator: i128) -> Result<()> {
    let overhead = measure(|| {
        black_box((black_box(a), black_box(b), black_box(denominator)));
    });
    let mut out = Ok(0);
    let one =
        measure(|| out = mul_div_u128_fast(black_box(a), black_box(b), black_box(denominator)))
            .saturating_sub(overhead);
    let reference = protocol_core::mul_div(a, b, denominator).map_err(|_| ());
    msg!(
        "bench mul_div_u128: result={:?} matches_i256={} single={} cu",
        out,
        out == reference,
        one
    );
    Ok(())
}

/// Prototype 2: exact 128x128 -> 256-bit product in 64-bit limbs, then
/// schoolbook division by a u64 denominator (PRECISION and BPS both fit).
/// Falls back to I256 for wider denominators. Same truncation as I256.
#[inline(never)]
pub fn mul_div_limbs(a: i128, b: i128, d: i128) -> core::result::Result<i128, ()> {
    if d == 0 {
        return Err(());
    }
    let du = d.unsigned_abs();
    if du > u64::MAX as u128 {
        return protocol_core::mul_div(a, b, d).map_err(|_| ());
    }
    let neg = (a < 0) ^ (b < 0) ^ (d < 0);
    let (x, y) = (a.unsigned_abs(), b.unsigned_abs());
    let (x0, x1, y0, y1) = (x as u64 as u128, x >> 64, y as u64 as u128, y >> 64);
    // 256-bit product as four u64 limbs, little-endian.
    let p00 = x0 * y0;
    let p01 = x0 * y1;
    let p10 = x1 * y0;
    let p11 = x1 * y1;
    let mid = (p00 >> 64) + (p01 as u64 as u128) + (p10 as u64 as u128);
    let l0 = p00 as u64;
    let l1 = mid as u64;
    let hi = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    let (l2, l3) = (hi as u64, (hi >> 64) as u64);
    // Long division by a u64: each step divides a u128 by the u64 denominator.
    let d64 = du as u64 as u128;
    let mut rem: u128 = 0;
    let mut q = [0u64; 4];
    for (i, limb) in [l3, l2, l1, l0].into_iter().enumerate() {
        let cur = (rem << 64) | limb as u128;
        q[3 - i] = (cur / d64) as u64;
        rem = cur % d64;
    }
    if q[3] != 0 || q[2] != 0 {
        return Err(());
    }
    let mag = ((q[1] as u128) << 64) | q[0] as u128;
    if neg {
        if mag > i128::MAX as u128 + 1 {
            Err(())
        } else {
            Ok((mag as i128).wrapping_neg())
        }
    } else {
        i128::try_from(mag).map_err(|_| ())
    }
}

pub fn mul_div_limbs_bench(a: i128, b: i128, denominator: i128) -> Result<()> {
    let overhead = measure(|| {
        black_box((black_box(a), black_box(b), black_box(denominator)));
    });
    let mut out = Ok(0);
    let one = measure(|| out = mul_div_limbs(black_box(a), black_box(b), black_box(denominator)))
        .saturating_sub(overhead);
    let reference = protocol_core::mul_div(a, b, denominator).map_err(|_| ());
    msg!(
        "bench mul_div_limbs: result={:?} matches_i256={} single={} cu",
        out,
        out == reference,
        one
    );
    Ok(())
}
