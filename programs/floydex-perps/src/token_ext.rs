//! Token-2022 mint extensions, read straight from the TLV bytes (`06` §7).
//!
//! The pinned `spl-token-2022` crate (v6, held back by the rustc 1.79 SBF
//! toolchain) predates the scaled-UI-amount and pausable extensions, and its
//! `get_extension_types` fails on any type it doesn't know. So the program
//! walks the TLV entries itself: every type must be on the allow-list, and
//! the scaled-UI multiplier is decoded without floats.

use crate::error::{CoreResultExt, FloyDexError};
use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022;
use protocol_core::{f64_bits_to_precision, PRECISION};

/// Extension type numbers (the `ExtensionType` enum of spl-token-2022 v8).
pub mod ext {
    pub const UNINITIALIZED: u16 = 0;
    pub const TRANSFER_FEE_CONFIG: u16 = 1;
    pub const MINT_CLOSE_AUTHORITY: u16 = 3;
    pub const CONFIDENTIAL_TRANSFER_MINT: u16 = 4;
    pub const DEFAULT_ACCOUNT_STATE: u16 = 6;
    pub const NON_TRANSFERABLE: u16 = 9;
    pub const INTEREST_BEARING_CONFIG: u16 = 10;
    pub const PERMANENT_DELEGATE: u16 = 12;
    pub const TRANSFER_HOOK: u16 = 14;
    pub const METADATA_POINTER: u16 = 18;
    pub const TOKEN_METADATA: u16 = 19;
    pub const GROUP_POINTER: u16 = 20;
    pub const TOKEN_GROUP: u16 = 21;
    pub const GROUP_MEMBER_POINTER: u16 = 22;
    pub const TOKEN_GROUP_MEMBER: u16 = 23;
    pub const SCALED_UI_AMOUNT: u16 = 25;
    pub const PAUSABLE: u16 = 26;
}

/// Extensions a collateral mint may carry. Everything else is refused:
/// transfer fees and hooks break exact vault accounting; a permanent
/// delegate, a pausable mint or a default-frozen account state let the
/// issuer move or freeze vault funds; non-transferable and confidential
/// mints can't be custodied; interest-bearing amounts are not valued.
/// The scaled-UI amount (splits, dividends) is valued through its
/// multiplier (`06` §7, `07` §6).
pub const ALLOWED_MINT_EXTENSIONS: &[u16] = &[
    ext::MINT_CLOSE_AUTHORITY,
    ext::METADATA_POINTER,
    ext::TOKEN_METADATA,
    ext::GROUP_POINTER,
    ext::TOKEN_GROUP,
    ext::GROUP_MEMBER_POINTER,
    ext::TOKEN_GROUP_MEMBER,
    ext::SCALED_UI_AMOUNT,
];

/// A Token-2022 mint with extensions is padded to the token-account length,
/// then an account-type byte (1 = mint), then TLV entries.
const BASE_LEN: usize = 165;
const MINT_ACCOUNT_TYPE: u8 = 1;

/// `(type, value)` for each TLV entry of a Token-2022 mint.
fn tlv_entries(data: &[u8]) -> Result<Vec<(u16, &[u8])>> {
    let mut out = Vec::new();
    if data.len() <= BASE_LEN {
        return Ok(out); // no extensions
    }
    require!(
        data[BASE_LEN] == MINT_ACCOUNT_TYPE,
        FloyDexError::UnsupportedMintExtension
    );
    let mut i = BASE_LEN + 1;
    while i + 2 <= data.len() {
        let ty = u16::from_le_bytes([data[i], data[i + 1]]);
        if ty == ext::UNINITIALIZED {
            break;
        }
        require!(i + 4 <= data.len(), FloyDexError::UnsupportedMintExtension);
        let len = usize::from(u16::from_le_bytes([data[i + 2], data[i + 3]]));
        let end = i + 4 + len;
        require!(end <= data.len(), FloyDexError::UnsupportedMintExtension);
        out.push((ty, &data[i + 4..end]));
        i = end;
    }
    Ok(out)
}

/// Refuse any Token-2022 mint with an extension off the allow-list.
pub fn check_mint_extensions(mint: &AccountInfo) -> Result<()> {
    if *mint.owner != spl_token_2022::ID {
        return Ok(()); // legacy SPL Token: no extensions
    }
    let data = mint.try_borrow_data()?;
    for (ty, _) in tlv_entries(&data)? {
        require!(
            ALLOWED_MINT_EXTENSIONS.contains(&ty),
            FloyDexError::UnsupportedMintExtension
        );
    }
    Ok(())
}

/// The scaled-UI multiplier in effect at `now`, PRECISION-scaled: shares per
/// raw token. 1.0 for a mint without the extension.
///
/// Layout (56 bytes): authority (32), multiplier (f64), the unix time the
/// new multiplier takes effect (i64), new multiplier (f64).
pub fn ui_multiplier(mint: &AccountInfo, now: i64) -> Result<i128> {
    if *mint.owner != spl_token_2022::ID {
        return Ok(PRECISION);
    }
    let data = mint.try_borrow_data()?;
    let Some((_, v)) = tlv_entries(&data)?
        .into_iter()
        .find(|(ty, _)| *ty == ext::SCALED_UI_AMOUNT)
    else {
        return Ok(PRECISION);
    };
    require!(v.len() >= 56, FloyDexError::UnsupportedMintExtension);
    let word = |at: usize| u64::from_le_bytes(v[at..at + 8].try_into().unwrap());
    let effective_at = word(40) as i64;
    let bits = if now >= effective_at {
        word(48)
    } else {
        word(32)
    };
    f64_bits_to_precision(bits).core()
}
