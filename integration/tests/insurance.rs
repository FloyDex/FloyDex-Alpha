//! Phase 2 (e): insurance staking, ported from Stellar `perp-insurance`:
//! shares against NAV, request → cooldown → withdraw at the NAV *then*,
//! losses during the cooldown absorbed, and shares retired on a wipe.

mod common;
use common::*;
use kryon_integration::*;
use kryon_perps::error::KryonError;
use solana_keypair::Keypair;
use solana_signer::Signer;

const WEEK: u64 = 7 * 86_400;

struct Staker {
    kp: Keypair,
    wallet: anchor_lang::prelude::Pubkey,
}

fn staker(b: &mut Book, dollars: u64) -> Staker {
    let kp = funded(&mut b.w.svm);
    let t = Trader {
        kp: kp.insecure_clone(),
        sub_id: 0,
        user: user_pda(&kp.pubkey(), 0),
    };
    let usdc = usdc(b);
    let wallet = b.w.wallet(&t, &usdc, dollars * USDC);
    Staker { kp, wallet }
}

fn usdc(b: &Book) -> Asset {
    Asset {
        mint: b.usdc.mint,
        token_program: b.usdc.token_program,
    }
}

fn setup() -> Book {
    let mut b = Book::new();
    assert_ok(b.w.init_insurance(WEEK, 20, 5_000));
    b
}

fn stake(b: &mut Book, s: &Staker, dollars: u64) -> TxResult {
    let u = usdc(b);
    b.w.stake(&s.kp, &u, &s.wallet, dollars * USDC)
}

fn withdraw(b: &mut Book, s: &Staker) -> TxResult {
    let u = usdc(b);
    b.w.withdraw_unstaked(&s.kp, &u, &s.wallet)
}

#[test]
fn init_insurance_validates_its_config() {
    let mut b = Book::new();
    assert_err(
        b.w.init_insurance(WEEK, 0, 5_000),
        KryonError::InvalidConfig,
    );
    assert_err(
        b.w.init_insurance(WEEK, 1_001, 5_000),
        KryonError::InvalidConfig,
    );
    assert_err(b.w.init_insurance(WEEK, 20, 0), KryonError::InvalidConfig);
    assert_err(
        b.w.init_insurance(91 * 86_400, 20, 5_000),
        KryonError::InvalidConfig,
    );
    assert_ok(b.w.init_insurance(WEEK, 20, 5_000));
    let ex = b.w.exchange();
    assert_eq!(ex.insurance, insurance_pda());
    assert_eq!((ex.max_reward_bps, ex.partial_liquidation_bps), (20, 5_000));
    assert_eq!(b.w.insurance().usdc_vault, vault_pda(&b.usdc.mint));
}

#[test]
fn shares_are_priced_against_nav() {
    let mut b = setup();
    let (s1, s2) = (staker(&mut b, 1_000), staker(&mut b, 1_000));
    assert_ok(stake(&mut b, &s1, 1_000));
    assert_eq!(
        b.w.stake_position(&s1.kp.pubkey()).shares,
        1_000 * P,
        "1:1 first"
    );
    // Penalties grow NAV by 25%: later stakers pay more per share.
    patch_insurance(&mut b, |i| i.fund += 250 * P);
    assert_ok(stake(&mut b, &s2, 500));
    assert_eq!(b.w.stake_position(&s2.kp.pubkey()).shares, 400 * P);
    let ins = b.w.insurance();
    assert_eq!((ins.fund, ins.total_shares), (1_750 * P, 1_400 * P));
    assert_conserved_flat_with_patch(&b);
}

/// Test-only surgery on the Insurance account (Borsh).
fn patch_insurance(b: &mut Book, f: impl FnOnce(&mut kryon_perps::state::Insurance)) {
    use anchor_lang::AccountSerialize;
    let mut ins = b.w.insurance();
    let delta_fund = {
        let before = ins.fund;
        f(&mut ins);
        ins.fund - before
    };
    let mut data = Vec::new();
    ins.try_serialize(&mut data).unwrap();
    let mut acc = b.w.svm.get_account(&insurance_pda()).unwrap();
    acc.data[..data.len()].copy_from_slice(&data);
    b.w.svm.set_account(insurance_pda(), acc).unwrap();
    // Keep the vault honest for conservation checks: a fund gain is backed
    // by tokens, as a real penalty would be.
    if delta_fund > 0 {
        let admin = b.w.admin.insecure_clone();
        mint_to(
            &mut b.w.svm,
            &admin,
            b.usdc.token_program,
            &b.usdc.mint,
            &vault_pda(&b.usdc.mint),
            (delta_fund / 1_000_000_000_000) as u64,
        );
    }
}

fn assert_conserved_flat_with_patch(b: &Book) {
    assert_conserved_flat(&b.w, &b.usdc, &[&b.alice, &b.bob]);
}

#[test]
fn unstaking_waits_out_the_cooldown_and_pays_the_nav_then() {
    let mut b = setup();
    let s = staker(&mut b, 1_000);
    assert_ok(stake(&mut b, &s, 1_000));
    assert_err(withdraw(&mut b, &s), KryonError::NoPendingUnstake);
    assert_err(
        b.w.request_unstake(&s.kp, 1_001 * P),
        KryonError::InsufficientShares,
    );
    assert_err(b.w.request_unstake(&s.kp, 0), KryonError::InvalidAmount);
    assert_ok(b.w.request_unstake(&s.kp, 600 * P));
    assert_err(
        b.w.request_unstake(&s.kp, 100 * P),
        KryonError::UnstakePending,
    );
    b.w.warp(WEEK as i64 - 1);
    assert_err(withdraw(&mut b, &s), KryonError::UnstakeLocked);
    // A loss lands during the cooldown: the pending shares absorb it too.
    patch_insurance(&mut b, |i| i.fund -= 200 * P); // NAV 800 for 1,000 shares
    b.w.warp(1);
    let before = token_balance(&b.w.svm, &s.wallet);
    assert_ok(withdraw(&mut b, &s));
    assert_eq!(token_balance(&b.w.svm, &s.wallet) - before, 480 * USDC);
    let ins = b.w.insurance();
    assert_eq!((ins.fund, ins.total_shares), (320 * P, 400 * P));
    let pos = b.w.stake_position(&s.kp.pubkey());
    assert_eq!((pos.shares, pos.pending_unstake_shares), (400 * P, 0));
}

#[test]
fn a_wipe_retires_every_share_and_the_next_staker_starts_fresh() {
    let mut b = setup();
    let (old, new) = (staker(&mut b, 1_000), staker(&mut b, 1_000));
    assert_ok(stake(&mut b, &old, 1_000));
    assert_ok(b.w.request_unstake(&old.kp, 1_000 * P));
    // A bankrupt account drains the whole fund (see liquidate.rs for the
    // real path; the retirement rule is the same code).
    let usdc = usdc(&b);
    let carol = b.w.funded_trader(&usdc, 50_000);
    assert_ok(b.trade(true, 100 * W, PX));
    b.w.tick(1, 120.0);
    let id = b.position(&b.alice).unwrap().position_id;
    while b.position(&b.alice).is_some() {
        assert_ok(b.w.liquidate(&carol, &b.alice, 1, id, vec![]));
    }
    let ins = b.w.insurance();
    assert_eq!((ins.fund, ins.total_shares, ins.epoch), (0, 0, 1));
    // The next staker is not diluted by dead shares: 1:1 again.
    assert_ok(stake(&mut b, &new, 300));
    assert_eq!(b.w.stake_position(&new.kp.pubkey()).shares, 300 * P);
    // The old request matures into nothing and is cleared.
    b.w.warp(WEEK as i64);
    let before = token_balance(&b.w.svm, &old.wallet);
    assert_ok(withdraw(&mut b, &old));
    assert_eq!(token_balance(&b.w.svm, &old.wallet), before);
    let pos = b.w.stake_position(&old.kp.pubkey());
    assert_eq!(
        (pos.shares, pos.pending_unstake_shares, pos.epoch),
        (0, 0, 1)
    );
    assert_eq!(
        b.w.insurance().fund,
        300 * P,
        "the new capital is untouched"
    );
}

#[test]
fn staking_stops_while_paused_but_withdrawing_does_not() {
    let mut b = setup();
    let s = staker(&mut b, 1_000);
    assert_ok(stake(&mut b, &s, 500));
    assert_ok(b.w.request_unstake(&s.kp, 500 * P));
    let g = b.w.guardian.insecure_clone();
    let i = ix(
        ka::Pause {
            exchange: exchange_pda(),
            guardian: g.pubkey(),
        },
        ki::Pause {},
    );
    assert_ok(send(&mut b.w.svm, &[i], &g, &[]));
    assert_err(stake(&mut b, &s, 100), KryonError::Paused);
    b.w.warp(WEEK as i64);
    assert_ok(withdraw(&mut b, &s));
    assert_eq!(token_balance(&b.w.svm, &s.wallet), 1_000 * USDC);
}
