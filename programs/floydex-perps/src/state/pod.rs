//! Plain-old-data helpers for zero-copy accounts.
//!
//! `i128` is 16-byte aligned on the host but 8-byte aligned on SBF, so a
//! zero-copy struct holding a bare `i128` has a different layout (and padding)
//! in the program than in tests and clients. Storing it as 16 little-endian
//! bytes keeps every layout identical and padding-free.

use anchor_lang::prelude::*;

#[zero_copy]
#[derive(Default, Debug, PartialEq, Eq)]
pub struct PodI128 {
    pub le: [u8; 16],
}

impl PodI128 {
    pub const ZERO: Self = Self { le: [0; 16] };

    #[inline]
    pub fn get(&self) -> i128 {
        i128::from_le_bytes(self.le)
    }

    #[inline]
    pub fn set(&mut self, v: i128) {
        self.le = v.to_le_bytes();
    }
}

impl From<i128> for PodI128 {
    fn from(v: i128) -> Self {
        Self {
            le: v.to_le_bytes(),
        }
    }
}
