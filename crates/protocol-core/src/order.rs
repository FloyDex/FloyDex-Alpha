//! The signed order intent (`05` §4): 108 bytes, little-endian, the exact
//! Borsh encoding of the field sequence below. What a session key signs.
//!
//! ```text
//! 0    8  magic        "FLOYDEX\0"
//! 8   32  domain       sha256(genesis_hash || program_id)
//! 40  32  owner        wallet pubkey (never the delegate)
//! 72   1  sub_id
//! 73   2  market_id    u16
//! 75   1  flags        bit0 is_long, bit1 reduce_only, bit2 post_only
//! 76   8  size         u64, 1e9 scale
//! 84   8  limit_price  u64, 1e9 scale
//! 92   8  nonce        u64
//! 100  8  expiry_ts    u64, unix seconds
//! ```

use crate::{checked_mul, CoreError, PRECISION};

pub const ORDER_MAGIC: [u8; 8] = *b"FLOYDEX\0";
pub const ORDER_MSG_LEN: usize = 108;

pub const FLAG_IS_LONG: u8 = 1 << 0;
pub const FLAG_REDUCE_ONLY: u8 = 1 << 1;
pub const FLAG_POST_ONLY: u8 = 1 << 2;
pub const FLAGS_KNOWN: u8 = FLAG_IS_LONG | FLAG_REDUCE_ONLY | FLAG_POST_ONLY;

/// Wire amounts are 1e9-scaled; the risk math is 1e18-scaled.
pub const WIRE_SCALE: i128 = 1_000_000_000;
const _: () = assert!(WIRE_SCALE * WIRE_SCALE == PRECISION);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OrderMsg {
    pub domain: [u8; 32],
    pub owner: [u8; 32],
    pub sub_id: u8,
    pub market_id: u16,
    pub flags: u8,
    pub size: u64,
    pub limit_price: u64,
    pub nonce: u64,
    pub expiry_ts: u64,
}

impl OrderMsg {
    pub fn is_long(&self) -> bool {
        self.flags & FLAG_IS_LONG != 0
    }

    pub fn reduce_only(&self) -> bool {
        self.flags & FLAG_REDUCE_ONLY != 0
    }

    pub fn post_only(&self) -> bool {
        self.flags & FLAG_POST_ONLY != 0
    }

    pub fn encode(&self) -> [u8; ORDER_MSG_LEN] {
        let mut out = [0u8; ORDER_MSG_LEN];
        out[0..8].copy_from_slice(&ORDER_MAGIC);
        out[8..40].copy_from_slice(&self.domain);
        out[40..72].copy_from_slice(&self.owner);
        out[72] = self.sub_id;
        out[73..75].copy_from_slice(&self.market_id.to_le_bytes());
        out[75] = self.flags;
        out[76..84].copy_from_slice(&self.size.to_le_bytes());
        out[84..92].copy_from_slice(&self.limit_price.to_le_bytes());
        out[92..100].copy_from_slice(&self.nonce.to_le_bytes());
        out[100..108].copy_from_slice(&self.expiry_ts.to_le_bytes());
        out
    }

    /// Strict decode: exact length, magic, and no unknown flag bits.
    pub fn decode(bytes: &[u8]) -> Result<Self, CoreError> {
        if bytes.len() != ORDER_MSG_LEN || bytes[0..8] != ORDER_MAGIC {
            return Err(CoreError::InvalidConfig);
        }
        let u64_at = |i: usize| {
            let mut b = [0u8; 8];
            b.copy_from_slice(&bytes[i..i + 8]);
            u64::from_le_bytes(b)
        };
        let mut domain = [0u8; 32];
        domain.copy_from_slice(&bytes[8..40]);
        let mut owner = [0u8; 32];
        owner.copy_from_slice(&bytes[40..72]);
        let flags = bytes[75];
        if flags & !FLAGS_KNOWN != 0 {
            return Err(CoreError::InvalidConfig);
        }
        Ok(Self {
            domain,
            owner,
            sub_id: bytes[72],
            market_id: u16::from_le_bytes([bytes[73], bytes[74]]),
            flags,
            size: u64_at(76),
            limit_price: u64_at(84),
            nonce: u64_at(92),
            expiry_ts: u64_at(100),
        })
    }
}

/// Widen a 1e9-scaled wire amount to PRECISION (1e18).
pub fn wire_to_precision(v: u64) -> Result<i128, CoreError> {
    checked_mul(i128::from(v), WIRE_SCALE)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> OrderMsg {
        OrderMsg {
            domain: [0xAB; 32],
            owner: [0x11; 32],
            sub_id: 2,
            market_id: 0x0102,
            flags: FLAG_IS_LONG | FLAG_POST_ONLY,
            size: 0x0807_0605_0403_0201,
            limit_price: 250_000_000_000,
            nonce: 42,
            expiry_ts: 1_790_602_200,
        }
    }

    #[test]
    fn layout_offsets_match_the_spec() {
        let b = sample().encode();
        assert_eq!(b.len(), 108);
        assert_eq!(&b[0..8], b"FLOYDEX\0");
        assert_eq!(b[8], 0xAB);
        assert_eq!(b[40], 0x11);
        assert_eq!(b[72], 2);
        assert_eq!(&b[73..75], &[0x02, 0x01]);
        assert_eq!(b[75], 0b101);
        assert_eq!(&b[76..84], &[1, 2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(&b[92..100], &42u64.to_le_bytes());
    }

    #[test]
    fn decode_inverts_encode() {
        let o = sample();
        assert_eq!(OrderMsg::decode(&o.encode()), Ok(o));
    }

    #[test]
    fn decode_is_strict() {
        let good = sample().encode();
        assert!(OrderMsg::decode(&good[..107]).is_err());
        let mut long = [0u8; 109];
        long[..108].copy_from_slice(&good);
        assert!(OrderMsg::decode(&long).is_err());
        let mut bad_magic = good;
        bad_magic[7] = b'x';
        assert!(OrderMsg::decode(&bad_magic).is_err());
        let mut cancel_magic = good;
        cancel_magic[0..8].copy_from_slice(b"KRYCANv1");
        assert!(
            OrderMsg::decode(&cancel_magic).is_err(),
            "a cancel can never parse as an order"
        );
        let mut bad_flags = good;
        bad_flags[75] |= 0b1000;
        assert!(OrderMsg::decode(&bad_flags).is_err());
    }

    #[test]
    fn wire_amounts_widen_to_precision() {
        assert_eq!(wire_to_precision(1_000_000_000), Ok(PRECISION));
        assert_eq!(
            wire_to_precision(u64::MAX),
            Ok(i128::from(u64::MAX) * 1_000_000_000)
        );
    }
}

#[cfg(test)]
mod golden {
    //! The shared conformance vectors in `sdk/conformance/order-v1.json`.
    //! The TypeScript encoder tests against the same file.
    extern crate std;
    use super::*;
    use std::string::String;
    use std::vec::Vec;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    fn arr32(s: &str) -> [u8; 32] {
        hex(s).try_into().unwrap()
    }

    #[test]
    fn rust_encoder_matches_every_golden_vector() {
        let raw = include_str!("../../../sdk/conformance/order-v1.json");
        let doc: serde_json::Value = serde_json::from_str(raw).unwrap();
        assert_eq!(doc["length"], 108);
        let vectors = doc["vectors"].as_array().unwrap();
        assert!(vectors.len() >= 8);
        for v in vectors {
            let o = &v["order"];
            let u = |k: &str| o[k].as_str().unwrap().parse::<u64>().unwrap();
            let msg = OrderMsg {
                domain: arr32(o["domain"].as_str().unwrap()),
                owner: arr32(o["owner"].as_str().unwrap()),
                sub_id: o["sub_id"].as_u64().unwrap() as u8,
                market_id: o["market_id"].as_u64().unwrap() as u16,
                flags: o["flags"].as_u64().unwrap() as u8,
                size: u("size"),
                limit_price: u("limit_price"),
                nonce: u("nonce"),
                expiry_ts: u("expiry_ts"),
            };
            let expected = hex(v["hex"].as_str().unwrap());
            let name: String = v["name"].as_str().unwrap().into();
            assert_eq!(
                msg.encode().as_slice(),
                expected.as_slice(),
                "vector {name}"
            );
            assert_eq!(OrderMsg::decode(&expected), Ok(msg), "vector {name} decode");
        }
    }
}
