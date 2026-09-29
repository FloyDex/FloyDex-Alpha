//! Phase 2 (h): a randomized LiteSVM harness for the invariants in `05` §7,
//! with liquidations, funding, ADL, staking and session changes in the mix.
//!
//! Each run: 6 traders with session keys, a well-funded keeper, one staker.
//! Every op is drawn at random; ops may be refused, but only with an error
//! the rules allow. After every op:
//! - OI long == OI short == Σ open sizes per side (§7.3);
//! - solvency per mint: vault + bad debt ≥ balances + fees + fund + Σ upnl
//!   (incl. pending funding), at the mark and at two other prices (§7.1);
//! - every order record: filled ≤ size (§7.2);
//! - the fund and the bad debt are never negative.
//!
//! At the end everyone is flattened at the mark and conservation must hold
//! strictly (to sub-unit dust). `FUZZ_SEEDS` / `FUZZ_OPS` scale it up.

mod common;
use common::*;
use floydex_integration::*;
use floydex_perps::error::FloyDexError;
use solana_keypair::Keypair;
use solana_signer::Signer;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn chance(&mut self, pct: u64) -> bool {
        self.below(100) < pct
    }
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

struct Fuzz {
    w: World,
    usdc: Asset,
    traders: Vec<(Trader, Keypair)>,
    keeper: Trader,
    staker: Keypair,
    staker_wallet: anchor_lang::prelude::Pubkey,
    nonce: u64,
    price: f64,
    open: bool,
    records: Vec<(anchor_lang::prelude::Pubkey, i128)>,
    rng: Rng,
    stats: [u32; 10],
}

const OK_REFUSALS: &[FloyDexError] = &[
    FloyDexError::InsufficientCollateral,
    FloyDexError::OpenInterestExceeded,
    FloyDexError::SessionExposureBlocked,
    FloyDexError::LiquidatableReduceOffMark,
    FloyDexError::NotLiquidatable,
    FloyDexError::NoBadDebtToOffset,
    FloyDexError::PositionNotInProfit,
    FloyDexError::PostMarkTooSoon,
    FloyDexError::InsufficientShares,
    FloyDexError::UnstakePending,
    FloyDexError::UnstakeLocked,
    FloyDexError::NoPendingUnstake,
    FloyDexError::PositionNotFound,
];

/// Ok, or refused with an error the rules allow. Anything else fails the run.
#[track_caller]
fn allowed(r: TxResult, what: &str) -> bool {
    match r {
        Ok(_) => true,
        Err(f) => {
            let got = format!("{:?}", f.err);
            let ok = OK_REFUSALS
                .iter()
                .any(|e| got.contains(&format!("Custom({})", anchor_code(*e))));
            assert!(ok, "{what}: unexpected {got}\n{:#?}", f.meta.logs);
            false
        }
    }
}

impl Fuzz {
    fn new(seed: u64) -> Self {
        let mut w = World::new();
        let usdc = w.add_usdc(u64::MAX);
        w.open_market(1, 250.0);
        assert_ok(w.init_insurance(3_600, 20, 5_000));
        let mut traders = Vec::new();
        for k in 0..6 {
            let t = w.funded_trader(&usdc, 1_000 + 1_500 * k);
            let key = Keypair::new();
            let exp = w.now() + 365 * 86_400;
            assert_ok(w.set_delegate(&t, &key.pubkey(), exp));
            traders.push((t, key));
        }
        let keeper = w.funded_trader(&usdc, 5_000_000);
        let staker = funded(&mut w.svm);
        let st = Trader {
            kp: staker.insecure_clone(),
            sub_id: 0,
            user: user_pda(&staker.pubkey(), 0),
        };
        let staker_wallet = w.wallet(&st, &usdc, 1_000_000 * USDC);
        Fuzz {
            w,
            usdc,
            traders,
            keeper,
            staker,
            staker_wallet,
            nonce: 0,
            price: 250.0,
            open: true,
            records: Vec::new(),
            rng: Rng(seed | 1),
            stats: [0; 10],
        }
    }

    fn all(&self) -> Vec<&Trader> {
        let mut v: Vec<&Trader> = self.traders.iter().map(|(t, _)| t).collect();
        v.push(&self.keeper);
        v
    }

    /// The mark the program will use now (as `health::market_view`).
    fn mark(&self) -> i128 {
        let m = self.w.market(1);
        if self.open {
            return (self.price * 1e8).round() as i128 * 10_000_000_000;
        }
        let last = m.last_oracle_price.get();
        let ema = m.mark_ema.get();
        let secs = if m.closed_since == 0 {
            0
        } else {
            (self.w.now() as u64).saturating_sub(m.closed_since)
        };
        risk_engine::closed_mark_price(
            last,
            if ema > 0 { ema } else { last },
            secs,
            &m.session_policy(),
        )
        .unwrap()
    }

    fn publish(&mut self) {
        let now = self.w.now();
        mock_usd(&mut self.w.svm, FEED_TSLA, self.price, now);
    }

    fn fill(&mut self) {
        let n = self.traders.len() as u64;
        let i = self.rng.below(n) as usize;
        let j = (i + 1 + self.rng.below(n - 1) as usize) % n as usize;
        let maker_long = self.rng.chance(50);
        let size = (1 + self.rng.below(6_000)) * W / 100; // 0.01 .. 60 shares
        let mark = self.mark();
        let dev = (self.rng.unit() - 0.5) * 0.009; // within ±0.45%
        let px = ((mark as f64) * (1.0 + dev) / 1e9).round() as u64;
        let exp = (self.w.now() + 3_600) as u64;
        self.nonce += 1;
        let mo = order_args(1, maker_long, size, px, self.nonce, exp);
        let to = order_args(1, !maker_long, size, px, self.nonce, exp);
        let (mt, mk) = (&self.traders[i].0, &self.traders[i].1);
        let (tt, tk) = (&self.traders[j].0, &self.traders[j].1);
        let p = plan(mt, tt, mo, to, size, px);
        let recs = [
            order_pda(&mt.key(), 0, self.nonce),
            order_pda(&tt.key(), 0, self.nonce),
        ];
        let (mk, tk) = (mk.insecure_clone(), tk.insecure_clone());
        let r = self.w.settle(1, &[p], &[(&mk, &tk)]);
        if allowed(r, "fill") {
            self.stats[0] += 1;
            for r in recs {
                self.records.push((r, i128::from(size) * 1_000_000_000));
            }
        }
    }

    fn move_price(&mut self, max_pct: f64) {
        let step = (self.rng.unit() - 0.5) * 2.0 * max_pct / 100.0;
        self.price = (self.price * (1.0 + step)).clamp(50.0, 1_000.0);
        self.price = (self.price * 100.0).round() / 100.0;
        if self.open {
            self.publish();
        }
    }

    fn warp(&mut self) {
        let secs = 1 + self.rng.below(600) as i64;
        self.w.warp(secs);
        if self.open {
            self.publish();
        }
    }

    fn liquidate_someone(&mut self) {
        let holders: Vec<usize> = (0..self.traders.len())
            .filter(|&k| self.w.user(&self.traders[k].0).open_positions > 0)
            .collect();
        if holders.is_empty() {
            return;
        }
        let k = holders[self.rng.below(holders.len() as u64) as usize];
        let t = &self.traders[k].0;
        let Some(pos) = self
            .w
            .user(t)
            .positions
            .iter()
            .find(|p| p.in_use != 0)
            .copied()
        else {
            return;
        };
        let (keeper, t) = (
            Trader {
                kp: self.keeper.kp.insecure_clone(),
                sub_id: 0,
                user: self.keeper.user,
            },
            Trader {
                kp: t.kp.insecure_clone(),
                sub_id: 0,
                user: t.user,
            },
        );
        if allowed(
            self.w.liquidate(&keeper, &t, 1, pos.position_id, vec![]),
            "liquidate",
        ) {
            self.stats[1] += 1;
        }
    }

    /// A gap, then the keeper sweeps: liquidate every holder until nothing
    /// more goes through (partial steps, bankruptcies, bad debt).
    fn gap_and_sweep(&mut self) {
        self.move_price(40.0);
        for _ in 0..30 {
            let before = self.stats[1];
            for k in 0..self.traders.len() {
                let t = &self.traders[k].0;
                let Some(pos) = self
                    .w
                    .user(t)
                    .positions
                    .iter()
                    .find(|p| p.in_use != 0)
                    .copied()
                else {
                    continue;
                };
                let keeper = Trader {
                    kp: self.keeper.kp.insecure_clone(),
                    sub_id: 0,
                    user: self.keeper.user,
                };
                let t = Trader {
                    kp: t.kp.insecure_clone(),
                    sub_id: 0,
                    user: t.user,
                };
                if allowed(
                    self.w.liquidate(&keeper, &t, 1, pos.position_id, vec![]),
                    "sweep",
                ) {
                    self.stats[1] += 1;
                }
            }
            if self.stats[1] == before {
                break;
            }
        }
    }

    fn adl(&mut self) {
        if self.w.insurance().bad_debt == 0 {
            return;
        }
        let mark = self.mark();
        let all: Vec<Trader> = self
            .all()
            .iter()
            .map(|t| Trader {
                kp: t.kp.insecure_clone(),
                sub_id: 0,
                user: t.user,
            })
            .collect();
        let slot = |t: &Trader| {
            self.w
                .user(t)
                .positions
                .iter()
                .find(|p| p.in_use != 0)
                .copied()
        };
        let winner = all.iter().find(|t| {
            slot(t).is_some_and(|p| {
                let e = p.entry_price.get();
                if p.is_long != 0 {
                    mark > e
                } else {
                    e > mark
                }
            })
        });
        let Some(w) = winner else { return };
        let wp = slot(w).unwrap();
        let Some(c) = all
            .iter()
            .find(|t| t.user != w.user && slot(t).is_some_and(|p| p.is_long != wp.is_long))
        else {
            return;
        };
        let cp = slot(c).unwrap();
        if allowed(self.w.adl(w, wp.position_id, c, cp.position_id, 1), "adl") {
            self.stats[2] += 1;
        }
    }

    fn funding(&mut self) {
        let payer = self.keeper.kp.insecure_clone();
        assert_ok(self.w.update_funding_as(1, &payer));
        self.stats[3] += 1;
    }

    fn post_mark(&mut self) {
        let mark = self.mark();
        let dev = (self.rng.unit() - 0.5) * 0.02;
        let mid = ((mark as f64) * (1.0 + dev) / 1e9).round() as u64;
        if allowed(self.w.post_mark(1, mid), "post_mark") {
            self.stats[4] += 1;
        }
    }

    fn stake_or_unstake(&mut self) {
        let s = self.staker.insecure_clone();
        let r = match self.rng.below(3) {
            0 => {
                let amt = (1 + self.rng.below(300)) * USDC;
                self.w
                    .stake(&s, &self.usdc_asset(), &self.staker_wallet, amt)
            }
            1 => {
                if self.w.svm.get_account(&stake_pda(&s.pubkey())).is_none() {
                    return;
                }
                let shares = self.w.stake_position(&s.pubkey()).shares;
                self.w.request_unstake(&s, shares / 2 + 1)
            }
            _ => {
                if self.w.svm.get_account(&stake_pda(&s.pubkey())).is_none() {
                    return;
                }
                self.w
                    .withdraw_unstaked(&s, &self.usdc_asset(), &self.staker_wallet)
            }
        };
        if allowed(r, "stake") {
            self.stats[5] += 1;
        }
    }

    fn usdc_asset(&self) -> Asset {
        Asset {
            mint: self.usdc.mint,
            token_program: self.usdc.token_program,
        }
    }

    fn toggle_session(&mut self) {
        if self.open {
            self.w.close_market(1);
            self.open = false;
        } else {
            let now = self.w.now();
            self.w.post_regular_window(1, now - 10, now + 30 * 86_400);
            self.open = true;
            self.publish();
        }
        self.stats[6] += 1;
    }

    fn check(&self, op: usize) {
        let m = self.w.market(1);
        let (mut long, mut short) = (0i128, 0i128);
        for t in self.all() {
            for p in self.w.user(t).positions.iter().filter(|p| p.in_use != 0) {
                if p.is_long != 0 {
                    long += p.size.get();
                } else {
                    short += p.size.get();
                }
            }
        }
        assert_eq!(m.oi_long.get(), long, "op {op}: OI long");
        assert_eq!(m.oi_short.get(), short, "op {op}: OI short");
        assert_eq!(long, short, "op {op}: two-sided");
        let ins = self.w.insurance();
        assert!(ins.fund >= 0 && ins.bad_debt >= 0, "op {op}: fund/bad debt");
        let mark = self.mark();
        let users = self.all();
        for px in [mark, mark / 2, mark * 3 / 2] {
            let slack = assert_solvent(&self.w, &self.usdc, &users, 1, px);
            assert!(
                slack < P / 1_000_000,
                "op {op}: slack {slack} wei at {px} is not dust"
            );
        }
    }

    fn check_records(&self) {
        for (pda, size) in &self.records {
            if let Some(acc) = self.w.svm.get_account(pda) {
                if acc.lamports > 0 {
                    let r: floydex_perps::state::OrderRecord = fetch(&self.w.svm, pda);
                    assert!(r.filled <= *size, "filled {} > size {}", r.filled, size);
                }
            }
        }
    }

    /// Reopen, then pair longs with shorts at the mark until nobody holds a
    /// position; then conservation must hold strictly.
    fn flatten(&mut self) {
        if !self.open {
            self.toggle_session();
        }
        self.w.warp(1);
        self.publish();
        let all: Vec<(Trader, Option<Keypair>)> = self
            .traders
            .iter()
            .map(|(t, k)| {
                (
                    Trader {
                        kp: t.kp.insecure_clone(),
                        sub_id: 0,
                        user: t.user,
                    },
                    Some(k.insecure_clone()),
                )
            })
            .chain(std::iter::once((
                Trader {
                    kp: self.keeper.kp.insecure_clone(),
                    sub_id: 0,
                    user: self.keeper.user,
                },
                None,
            )))
            .collect();
        for _ in 0..200 {
            let slot = |t: &Trader| {
                self.w
                    .user(t)
                    .positions
                    .iter()
                    .find(|p| p.in_use != 0)
                    .copied()
            };
            let Some(l) = all
                .iter()
                .position(|(t, _)| slot(t).is_some_and(|p| p.is_long != 0))
            else {
                break;
            };
            let s = all
                .iter()
                .position(|(t, _)| slot(t).is_some_and(|p| p.is_long == 0))
                .unwrap();
            let size_p = slot(&all[l].0)
                .unwrap()
                .size
                .get()
                .min(slot(&all[s].0).unwrap().size.get());
            let size = (size_p / 1_000_000_000) as u64;
            let px = (self.mark() / 1_000_000_000) as u64;
            self.nonce += 1;
            let exp = (self.w.now() + 3_600) as u64;
            let mut mo = order_args(1, false, size, px, self.nonce, exp);
            let mut to = order_args(1, true, size, px, self.nonce, exp);
            mo.flags |= protocol_core::FLAG_REDUCE_ONLY;
            to.flags |= protocol_core::FLAG_REDUCE_ONLY;
            // The keeper has no session key: it signs with its owner key.
            let mk = all[l]
                .1
                .as_ref()
                .map_or(all[l].0.kp.insecure_clone(), |k| k.insecure_clone());
            let tk = all[s]
                .1
                .as_ref()
                .map_or(all[s].0.kp.insecure_clone(), |k| k.insecure_clone());
            let p = plan(&all[l].0, &all[s].0, mo, to, size, px);
            assert_ok(self.w.settle(1, &[p], &[(&mk, &tk)]));
            if size_p % 1_000_000_000 != 0 {
                panic!("sizes are always whole wire units");
            }
        }
        let users = self.all();
        assert_conserved_flat(&self.w, &self.usdc, &users);
    }
}

fn run(seed: u64, ops: usize) -> [u32; 10] {
    let mut f = Fuzz::new(seed);
    for op in 0..ops {
        match f.rng.below(100) {
            0..=39 => f.fill(),
            40..=51 => f.move_price(3.0),
            52..=56 => f.gap_and_sweep(),
            57..=62 => f.warp(),
            63..=72 => f.liquidate_someone(),
            73..=81 => f.adl(),
            82..=87 => f.funding(),
            88..=91 => f.post_mark(),
            92..=96 => f.stake_or_unstake(),
            _ => f.toggle_session(),
        }
        f.check(op);
    }
    f.check_records();
    f.flatten();
    f.stats
}

#[test]
fn random_ops_preserve_the_invariants() {
    let seeds: u64 = std::env::var("FUZZ_SEEDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(4);
    let ops: usize = std::env::var("FUZZ_OPS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(400);
    let mut total = [0u32; 10];
    for s in 0..seeds {
        let st = run(0x9e37_79b9_7f4a_7c15 ^ (s * 0x1234_5678_9abc_def1), ops);
        for (t, v) in total.iter_mut().zip(st) {
            *t += v;
        }
    }
    println!(
        "fills {} liquidations {} adl {} funding {} marks {} stakes {} sessions {}",
        total[0], total[1], total[2], total[3], total[4], total[5], total[6]
    );
    assert!(
        total[0] > 0 && total[1] > 0 && total[3] > 0,
        "the mix must exercise fills, liquidations and funding"
    );
}
