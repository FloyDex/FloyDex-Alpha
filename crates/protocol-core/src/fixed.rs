use crate::CoreError;
use ethnum::I256;

pub const PRECISION: i128 = 1_000_000_000_000_000_000;
pub const BPS_DENOMINATOR: i128 = 10_000;
pub const SECS_PER_HOUR: u64 = 3_600;

#[inline]
pub fn checked_add(a: i128, b: i128) -> Result<i128, CoreError> {
    a.checked_add(b).ok_or(CoreError::MathOverflow)
}

#[inline]
pub fn checked_sub(a: i128, b: i128) -> Result<i128, CoreError> {
    a.checked_sub(b).ok_or(CoreError::MathOverflow)
}

#[inline]
pub fn checked_mul(a: i128, b: i128) -> Result<i128, CoreError> {
    a.checked_mul(b).ok_or(CoreError::MathOverflow)
}

#[inline]
pub fn checked_div(a: i128, b: i128) -> Result<i128, CoreError> {
    if b == 0 {
        return Err(CoreError::DivisionByZero);
    }
    a.checked_div(b).ok_or(CoreError::MathOverflow)
}

/// `a * b / denominator` with a 256-bit intermediate, truncated toward zero.
///
/// Denominators that fit in a u64 (PRECISION, BPS and every other constant
/// scale) take a limb path: the exact 256-bit product in four u64 limbs, then
/// schoolbook division by the u64. On SBF that is ~1.0k-1.8k CU against
/// ~3.8k-6k CU for I256 (`05` §6). Wider denominators fall back to I256. Both
/// paths return bit-identical results, pinned by a differential proptest.
// inline(never): one shared copy of the body per program.
#[inline(never)]
pub fn mul_div(a: i128, b: i128, denominator: i128) -> Result<i128, CoreError> {
    if denominator == 0 {
        return Err(CoreError::DivisionByZero);
    }
    let d = denominator.unsigned_abs();
    if d > u64::MAX as u128 {
        return mul_div_i256(a, b, denominator);
    }
    let negative = (a < 0) ^ (b < 0) ^ (denominator < 0);
    let magnitude = mul_div_u64_limbs(a.unsigned_abs(), b.unsigned_abs(), d as u64)?;
    if negative {
        if magnitude > i128::MIN.unsigned_abs() {
            return Err(CoreError::MathOverflow);
        }
        Ok((magnitude as i128).wrapping_neg())
    } else {
        i128::try_from(magnitude).map_err(|_| CoreError::MathOverflow)
    }
}

/// `x * y / d` for unsigned inputs; errors if the quotient exceeds u128.
fn mul_div_u64_limbs(x: u128, y: u128, d: u64) -> Result<u128, CoreError> {
    const LO: u128 = u64::MAX as u128;
    let (x0, x1, y0, y1) = (x & LO, x >> 64, y & LO, y >> 64);
    let p00 = x0 * y0;
    let p01 = x0 * y1;
    let p10 = x1 * y0;
    let p11 = x1 * y1;
    // Each u64*u64 partial fits a u128; `mid` sums three values < 2^64.
    let mid = (p00 >> 64) + (p01 & LO) + (p10 & LO);
    let hi = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    let limbs = [hi >> 64, hi & LO, mid & LO, p00 & LO]; // most significant first
    let d = d as u128;
    let mut rem = 0u128;
    let mut q = [0u128; 4];
    for (i, limb) in limbs.iter().enumerate() {
        // rem < d <= u64::MAX, so `cur` fits and each digit is < 2^64.
        let cur = (rem << 64) | limb;
        q[i] = cur / d;
        rem = cur % d;
    }
    if q[0] != 0 || q[1] != 0 {
        return Err(CoreError::MathOverflow);
    }
    Ok((q[2] << 64) | q[3])
}

/// The original I256 implementation: the fallback for wide denominators and
/// the reference the limb path is tested against.
#[inline(never)]
pub fn mul_div_i256(a: i128, b: i128, denominator: i128) -> Result<i128, CoreError> {
    if denominator == 0 {
        return Err(CoreError::DivisionByZero);
    }
    let value = I256::from(a)
        .checked_mul(I256::from(b))
        .and_then(|v| v.checked_div(I256::from(denominator)))
        .ok_or(CoreError::MathOverflow)?;
    i128::try_from(value).map_err(|_| CoreError::MathOverflow)
}

#[inline]
pub fn mul_precision(a: i128, b: i128) -> Result<i128, CoreError> {
    mul_div(a, b, PRECISION)
}

#[inline]
pub fn div_precision(a: i128, b: i128) -> Result<i128, CoreError> {
    mul_div(a, PRECISION, b)
}

#[inline]
pub fn apply_bps(amount: i128, bps: u32) -> Result<i128, CoreError> {
    if bps as i128 > BPS_DENOMINATOR {
        return Err(CoreError::InvalidConfig);
    }
    mul_div(amount, bps as i128, BPS_DENOMINATOR)
}

#[inline]
pub fn ceil_div(a: i128, b: i128) -> Result<i128, CoreError> {
    if b <= 0 || a < 0 {
        return Err(CoreError::InvalidAmount);
    }
    if a == 0 {
        return Ok(0);
    }
    checked_add(checked_div(checked_sub(a, 1)?, b)?, 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mul_precision_scales_down() {
        assert_eq!(
            mul_precision(2 * PRECISION, 3 * PRECISION).unwrap(),
            6 * PRECISION
        );
    }

    #[test]
    fn signed_mul_precision_does_not_overflow_before_division() {
        assert_eq!(
            mul_precision(-90 * PRECISION, PRECISION).unwrap(),
            -90 * PRECISION
        );
    }

    #[test]
    fn apply_bps_rejects_above_100_percent() {
        assert_eq!(apply_bps(PRECISION, 10_001), Err(CoreError::InvalidConfig));
    }

    #[test]
    fn ceil_div_rounds_up() {
        assert_eq!(ceil_div(101, 10).unwrap(), 11);
    }

    #[test]
    fn limb_mul_div_matches_i256_at_the_edges() {
        let edges = [
            0,
            1,
            -1,
            2,
            PRECISION,
            -PRECISION,
            u64::MAX as i128,
            -(u64::MAX as i128),
            (u64::MAX as i128) + 1,
            i128::MAX,
            i128::MIN,
            i128::MAX - 1,
            i128::MIN + 1,
        ];
        let denominators = [
            1,
            -1,
            3,
            BPS_DENOMINATOR,
            PRECISION,
            -PRECISION,
            u64::MAX as i128,
            -(u64::MAX as i128),
            (u64::MAX as i128) + 1,
            i128::MAX,
            i128::MIN,
        ];
        for &a in &edges {
            for &b in &edges {
                for &d in &denominators {
                    assert_eq!(mul_div(a, b, d), mul_div_i256(a, b, d), "{a} * {b} / {d}");
                }
            }
        }
    }

    #[test]
    fn i128_min_quotient_is_representable() {
        assert_eq!(mul_div(i128::MIN, 1, 1), Ok(i128::MIN));
        assert_eq!(mul_div(i128::MIN, -1, 1), Err(CoreError::MathOverflow));
        assert_eq!(mul_div(1, 1, 0), Err(CoreError::DivisionByZero));
    }
}

#[cfg(test)]
mod differential {
    extern crate std;
    use super::*;
    use proptest::prelude::*;

    fn denominator() -> impl Strategy<Value = i128> {
        prop_oneof![
            Just(PRECISION),
            Just(BPS_DENOMINATOR),
            (1u64..=u64::MAX).prop_map(|d| d as i128),
            (1u64..=u64::MAX).prop_map(|d| -(d as i128)),
            any::<i128>().prop_filter("non-zero", |d| *d != 0),
        ]
    }

    fn operand() -> impl Strategy<Value = i128> {
        prop_oneof![
            any::<i128>(),
            (-(1i128 << 100)..(1i128 << 100)),
            (-1_000_000_000 * PRECISION..1_000_000_000 * PRECISION),
            (-10_000i128..=10_000),
        ]
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(200_000))]
        #[test]
        fn limb_mul_div_is_bit_identical_to_i256(a in operand(), b in operand(), d in denominator()) {
            prop_assert_eq!(mul_div(a, b, d), mul_div_i256(a, b, d));
        }
    }
}
