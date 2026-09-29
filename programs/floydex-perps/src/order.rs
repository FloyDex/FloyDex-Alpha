//! On-chain view of the signed order (`05` §4). The encoding lives in
//! `protocol_core::order`; this module adds the Borsh mirror the spec names
//! (`OrderMsg::try_to_vec()`) and the deployment domain.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;

/// Borsh mirror of `protocol_core::OrderMsg`, field for field. Its
/// `try_to_vec()` must equal `protocol_core::OrderMsg::encode()` (tested
/// against the golden vectors).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct OrderMsgBorsh {
    pub magic: [u8; 8],
    pub domain: [u8; 32],
    pub owner: Pubkey,
    pub sub_id: u8,
    pub market_id: u16,
    pub flags: u8,
    pub size: u64,
    pub limit_price: u64,
    pub nonce: u64,
    pub expiry_ts: u64,
}

/// `sha256(genesis_hash || program_id)`. A program cannot read the genesis
/// hash, so the deploy script computes this and passes it to
/// `initialize_exchange`; this helper exists for scripts and tests.
pub fn compute_domain(genesis_hash: &[u8; 32], program_id: &Pubkey) -> [u8; 32] {
    hashv(&[genesis_hash, program_id.as_ref()]).to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol_core::{OrderMsg, ORDER_MAGIC};

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    fn doc() -> serde_json::Value {
        serde_json::from_str(include_str!("../../../sdk/conformance/order-v1.json")).unwrap()
    }

    #[test]
    fn borsh_try_to_vec_matches_the_golden_vectors() {
        for v in doc()["vectors"].as_array().unwrap() {
            let expected = hex(v["hex"].as_str().unwrap());
            let core = OrderMsg::decode(&expected).unwrap();
            let borsh = OrderMsgBorsh {
                magic: ORDER_MAGIC,
                domain: core.domain,
                owner: Pubkey::new_from_array(core.owner),
                sub_id: core.sub_id,
                market_id: core.market_id,
                flags: core.flags,
                size: core.size,
                limit_price: core.limit_price,
                nonce: core.nonce,
                expiry_ts: core.expiry_ts,
            };
            assert_eq!(borsh.try_to_vec().unwrap(), expected, "{}", v["name"]);
            assert_eq!(core.encode().to_vec(), expected);
        }
    }

    #[test]
    fn domain_matches_the_golden_vectors() {
        for d in doc()["domains"].as_array().unwrap() {
            let g: [u8; 32] = hex(d["genesis_hash"].as_str().unwrap()).try_into().unwrap();
            let p: [u8; 32] = hex(d["program_id"].as_str().unwrap()).try_into().unwrap();
            let want = hex(d["domain"].as_str().unwrap());
            assert_eq!(
                compute_domain(&g, &Pubkey::new_from_array(p)).to_vec(),
                want
            );
        }
    }
}
