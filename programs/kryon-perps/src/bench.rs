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
