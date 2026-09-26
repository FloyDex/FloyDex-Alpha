//! Shared settle fixture: USDC, TSLA market at $250, two funded traders
//! with session keys.
#![allow(dead_code)]

use kryon_integration::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

pub const USDC: u64 = 1_000_000;
pub const W: u64 = 1_000_000_000; // 1e9 wire scale
pub const PX: u64 = 250 * W;

pub struct Book {
    pub w: World,
    pub usdc: Asset,
    pub alice: Trader,
    pub bob: Trader,
    pub alice_key: Keypair,
    pub bob_key: Keypair,
    pub nonce: u64,
}

impl Book {
    pub fn new() -> Self {
        let mut w = World::new();
        let usdc = w.add_usdc(u64::MAX);
        w.open_market(1, 250.0);
        let alice = w.trader(0);
        let bob = w.trader(0);
        for t in [&alice, &bob] {
            let wallet = w.wallet(t, &usdc, 10_000 * USDC);
            assert_ok(w.deposit(t, &usdc, &wallet, 10_000 * USDC));
        }
        let alice_key = Keypair::new();
        let bob_key = Keypair::new();
        let exp = w.now() + 7 * 86_400;
        assert_ok(w.set_delegate(&alice, &alice_key.pubkey(), exp));
        assert_ok(w.set_delegate(&bob, &bob_key.pubkey(), exp));
        Book {
            w,
            usdc,
            alice,
            bob,
            alice_key,
            bob_key,
            nonce: 0,
        }
    }

    pub fn nonce(&mut self) -> u64 {
        self.nonce += 1;
        self.nonce
    }

    pub fn expiry(&self) -> u64 {
        (self.w.now() + 3_600) as u64
    }

    /// A maker/taker pair that crosses at `price`: maker takes `maker_long`.
    pub fn pair(&mut self, maker_long: bool, size: u64, price: u64) -> (OrderArgs, OrderArgs) {
        let e = self.expiry();
        let (n1, n2) = (self.nonce(), self.nonce());
        (
            order_args(1, maker_long, size, price, n1, e),
            order_args(1, !maker_long, size, price, n2, e),
        )
    }

    /// Alice makes, Bob takes, both via session keys.
    pub fn fill(&mut self, mo: OrderArgs, to: OrderArgs, size: u64, price: u64) -> TxResult {
        let plan = FillPlan {
            maker: &self.alice,
            taker: &self.bob,
            maker_order: mo,
            taker_order: to,
            size,
            price,
            maker_risk: vec![],
            taker_risk: vec![],
        };
        self.w
            .settle(1, &[plan], &[(&self.alice_key, &self.bob_key)])
    }

    pub fn trade(&mut self, alice_long: bool, size: u64, price: u64) -> TxResult {
        let (mo, to) = self.pair(alice_long, size, price);
        self.fill(mo, to, size, price)
    }

    pub fn position(&self, t: &Trader) -> Option<kryon_perps::state::PositionSlot> {
        let u = self.w.user(t);
        u.find_position(1).map(|i| u.positions[i])
    }
}

pub fn plan<'a>(
    maker: &'a Trader,
    taker: &'a Trader,
    mo: OrderArgs,
    to: OrderArgs,
    size: u64,
    price: u64,
) -> FillPlan<'a> {
    FillPlan {
        maker,
        taker,
        maker_order: mo,
        taker_order: to,
        size,
        price,
        maker_risk: vec![],
        taker_risk: vec![],
    }
}
