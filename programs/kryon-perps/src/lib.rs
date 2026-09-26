use anchor_lang::prelude::*;

declare_id!("2vgBHV763RtsBZGNpnuvbkGDKJdtt1DxP9tUDo4NZxUB");

pub mod constants;
pub mod error;
pub mod state;

#[cfg(feature = "bench")]
pub mod bench;

#[program]
pub mod kryon_perps {
    use super::*;

    /// Compute-unit benchmark for `protocol_core::mul_div`. Only compiled with
    /// the `bench` feature; never part of a deployable build.
    #[cfg(feature = "bench")]
    pub fn bench_mul_div(_ctx: Context<Bench>, a: i128, b: i128, denominator: i128) -> Result<()> {
        bench::mul_div(a, b, denominator)
    }
}

#[cfg(feature = "bench")]
#[derive(Accounts)]
pub struct Bench {}

#[cfg(test)]
mod layout_tests;
