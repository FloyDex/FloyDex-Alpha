//! Ed25519 signature introspection (`05` §5).
//!
//! The native Ed25519 program verifies signatures in its own instruction and
//! fails the whole transaction if any is invalid. It does NOT check that the
//! bytes it verified are the bytes we care about. So for every signature we
//! rely on, we read that instruction back through the Instructions sysvar and
//! require:
//!
//! 1. the instruction's program is the Ed25519 program;
//! 2. every `*_instruction_index` in its offsets is `u16::MAX` ("this same
//!    instruction"), so the precompile verified bytes we can see, not bytes
//!    in some other instruction;
//! 3. the public key bytes are the expected signer's, and the message bytes
//!    are exactly the order we re-encoded: full length, full content.

use crate::error::FloyDexError;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::ed25519_program;
use anchor_lang::solana_program::sysvar::instructions::load_instruction_at_checked;

/// `Ed25519SignatureOffsets`: seven little-endian u16s.
pub const OFFSETS_LEN: usize = 14;
/// Offsets start after `num_signatures: u8` and one padding byte.
pub const OFFSETS_START: usize = 2;
pub const SIGNATURE_LEN: usize = 64;
pub const PUBKEY_LEN: usize = 32;
/// "The instruction this offset appears in."
pub const THIS_INSTRUCTION: u16 = u16::MAX;

/// Where a signature lives: the Ed25519 instruction's index in the
/// transaction, and which of its signatures.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct SigRef {
    pub ix_index: u8,
    pub sig_index: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SignatureOffsets {
    pub signature_offset: u16,
    pub signature_instruction_index: u16,
    pub public_key_offset: u16,
    pub public_key_instruction_index: u16,
    pub message_data_offset: u16,
    pub message_data_size: u16,
    pub message_instruction_index: u16,
}

impl SignatureOffsets {
    pub fn parse(b: &[u8]) -> Self {
        let u = |i: usize| u16::from_le_bytes([b[i], b[i + 1]]);
        Self {
            signature_offset: u(0),
            signature_instruction_index: u(2),
            public_key_offset: u(4),
            public_key_instruction_index: u(6),
            message_data_offset: u(8),
            message_data_size: u(10),
            message_instruction_index: u(12),
        }
    }
}

fn slice(data: &[u8], offset: u16, len: usize) -> Result<&[u8]> {
    let start = usize::from(offset);
    let end = start
        .checked_add(len)
        .ok_or(FloyDexError::Ed25519Malformed)?;
    data.get(start..end)
        .ok_or_else(|| error!(FloyDexError::Ed25519Malformed))
}

/// Check signature `r` against `expected_message` and return the public key
/// that signed it. The caller must still check that key is allowed to sign.
pub fn verified_signer(
    instructions_sysvar: &AccountInfo,
    r: SigRef,
    expected_message: &[u8],
) -> Result<Pubkey> {
    let ix = load_instruction_at_checked(usize::from(r.ix_index), instructions_sysvar)
        .map_err(|_| error!(FloyDexError::Ed25519Malformed))?;
    // Rule 1: the precompile, and nothing else.
    require_keys_eq!(
        ix.program_id,
        ed25519_program::ID,
        FloyDexError::Ed25519WrongProgram
    );
    let data = &ix.data;
    require!(data.len() >= OFFSETS_START, FloyDexError::Ed25519Malformed);
    let count = usize::from(data[0]);
    require!(
        usize::from(r.sig_index) < count,
        FloyDexError::Ed25519Malformed
    );
    let at = OFFSETS_START + usize::from(r.sig_index) * OFFSETS_LEN;
    let o = SignatureOffsets::parse(
        data.get(at..at + OFFSETS_LEN)
            .ok_or_else(|| error!(FloyDexError::Ed25519Malformed))?,
    );
    // Rule 2: every offset points into this same instruction.
    require!(
        o.signature_instruction_index == THIS_INSTRUCTION
            && o.public_key_instruction_index == THIS_INSTRUCTION
            && o.message_instruction_index == THIS_INSTRUCTION,
        FloyDexError::Ed25519OffsetIndex
    );
    slice(data, o.signature_offset, SIGNATURE_LEN)?;
    let pubkey = slice(data, o.public_key_offset, PUBKEY_LEN)?;
    let message = slice(
        data,
        o.message_data_offset,
        usize::from(o.message_data_size),
    )?;
    // Rule 3: the full message, byte for byte (a prefix or a longer message fails).
    require!(
        message == expected_message,
        FloyDexError::Ed25519MessageMismatch
    );
    Pubkey::try_from(pubkey).map_err(|_| error!(FloyDexError::Ed25519Malformed))
}
