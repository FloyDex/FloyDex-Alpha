//! (c) init_user, deposit, withdraw (SPL + Token-2022), deposit caps, the
//! withdraw health check and the paused escape hatch.

use floydex_integration::*;
use floydex_perps::error::FloyDexError;
use solana_signer::Signer;

const USDC: u64 = 1_000_000; // 6 decimals
const FEED_XSTOCK: [u8; 32] = [0x42; 32];

fn pause(w: &mut World) {
    let g = w.guardian.insecure_clone();
    let i = ix(
        ka::Pause {
            exchange: exchange_pda(),
            guardian: g.pubkey(),
        },
        ki::Pause {},
    );
    assert_ok(send(&mut w.svm, &[i], &g, &[]));
}

/// Conservation for a mint while nobody holds a position: the vault holds
/// exactly the users' balances plus fees (05 §7, strict when flat).
fn assert_conserved(w: &World, asset: &Asset, users: &[&Trader]) {
    let c = w.collateral(asset);
    let sum: i128 = users.iter().map(|t| w.user(t).balance(c.index)).sum();
    let vault = i128::from(token_balance(&w.svm, &vault_pda(&asset.mint)));
    assert_eq!(
        sum + c.fees_accrued,
        vault * c.scale(),
        "vault must equal balances + fees"
    );
}

#[test]
fn init_user_creates_independent_sub_accounts() {
    let mut w = World::new();
    let t = w.trader(0);
    let u = w.user(&t);
    assert_eq!(u.owner, t.key());
    assert_eq!(u.sub_id, 0);
    assert_eq!(u.next_position_id, 1);
    // Same sub_id twice fails; another sub_id is a separate account.
    let i = ix(
        ka::InitUser {
            owner: t.key(),
            user_account: t.user,
            system_program: anchor_lang::system_program::ID,
        },
        ki::InitUser { sub_id: 0 },
    );
    assert!(send(&mut w.svm, &[i], &t.kp, &[]).is_err());
    let sub3 = user_pda(&t.key(), 3);
    let i = ix(
        ka::InitUser {
            owner: t.key(),
            user_account: sub3,
            system_program: anchor_lang::system_program::ID,
        },
        ki::InitUser { sub_id: 3 },
    );
    assert_ok(send(&mut w.svm, &[i], &t.kp, &[]));
    let u3: floydex_perps::state::UserAccount = fetch_zc(&w.svm, &sub3);
    assert_eq!(u3.sub_id, 3);
}

#[test]
fn deposit_and_withdraw_move_tokens_and_the_ledger_exactly() {
    let mut w = World::new();
    let usdc = w.add_usdc(u64::MAX);
    let t = w.trader(0);
    let wallet = w.wallet(&t, &usdc, 1_000 * USDC);

    assert_ok(w.deposit(&t, &usdc, &wallet, 250 * USDC));
    assert_eq!(token_balance(&w.svm, &wallet), 750 * USDC);
    assert_eq!(token_balance(&w.svm, &vault_pda(&usdc.mint)), 250 * USDC);
    assert_eq!(w.user(&t).balance(0), 250 * P, "credited at PRECISION");
    assert_eq!(w.collateral(&usdc).total_deposited, 250 * USDC);
    assert_conserved(&w, &usdc, &[&t]);

    assert_ok(w.withdraw(&t, &usdc, &wallet, 100 * USDC, vec![]));
    assert_eq!(token_balance(&w.svm, &wallet), 850 * USDC);
    assert_eq!(w.user(&t).balance(0), 150 * P);
    assert_eq!(w.collateral(&usdc).total_deposited, 150 * USDC);
    assert_conserved(&w, &usdc, &[&t]);

    // Draining the balance frees the slot.
    assert_ok(w.withdraw(&t, &usdc, &wallet, 150 * USDC, vec![]));
    assert!(w.user(&t).balances.iter().all(|b| b.in_use == 0));
    assert_conserved(&w, &usdc, &[&t]);
}

#[test]
fn cannot_withdraw_more_than_the_balance() {
    let mut w = World::new();
    let usdc = w.add_usdc(u64::MAX);
    let t = w.trader(0);
    let wallet = w.wallet(&t, &usdc, 10 * USDC);
    assert_ok(w.deposit(&t, &usdc, &wallet, 10 * USDC));
    assert_err(
        w.withdraw(&t, &usdc, &wallet, 10 * USDC + 1, vec![]),
        FloyDexError::InsufficientCollateral,
    );
    assert_err(
        w.withdraw(&t, &usdc, &wallet, 0, vec![]),
        FloyDexError::InvalidAmount,
    );
    assert_err(w.deposit(&t, &usdc, &wallet, 0), FloyDexError::InvalidAmount);
}

#[test]
fn deposit_cap_is_enforced_and_withdrawals_free_headroom() {
    let mut w = World::new();
    let usdc = w.add_usdc(100 * USDC);
    let a = w.trader(0);
    let b = w.trader(0);
    let wa = w.wallet(&a, &usdc, 1_000 * USDC);
    let wb = w.wallet(&b, &usdc, 1_000 * USDC);
    assert_ok(w.deposit(&a, &usdc, &wa, 60 * USDC));
    assert_err(
        w.deposit(&b, &usdc, &wb, 41 * USDC),
        FloyDexError::DepositCapExceeded,
    );
    assert_ok(w.deposit(&b, &usdc, &wb, 40 * USDC));
    assert_ok(w.withdraw(&a, &usdc, &wa, 10 * USDC, vec![]));
    assert_ok(w.deposit(&b, &usdc, &wb, 10 * USDC));
    assert_conserved(&w, &usdc, &[&a, &b]);
}

#[test]
fn only_the_owner_moves_funds() {
    let mut w = World::new();
    let usdc = w.add_usdc(u64::MAX);
    let t = w.trader(0);
    let thief = w.trader(0);
    let wallet = w.wallet(&t, &usdc, 10 * USDC);
    let thief_wallet = w.wallet(&thief, &usdc, 0);
    assert_ok(w.deposit(&t, &usdc, &wallet, 10 * USDC));

    // The thief signs for the victim's user account: seeds bind it to the signer.
    let i = ix(
        w.move_accounts(&thief.key(), &t.user, &usdc, &thief_wallet),
        ki::Withdraw { amount: 1 },
    );
    assert!(send(&mut w.svm, &[i], &thief.kp, &[]).is_err());
    assert_eq!(w.user(&t).balance(0), 10 * P);
}

#[test]
fn token_2022_collateral_round_trips() {
    let mut w = World::new();
    w.add_usdc(u64::MAX);
    let x = w.add_xstock(FEED_XSTOCK, 1_500);
    let t = w.trader(0);
    let wallet = w.wallet(&t, &x, 5 * 100_000_000); // 5 shares at 8 decimals
    assert_ok(w.deposit(&t, &x, &wallet, 3 * 100_000_000));
    assert_eq!(w.user(&t).balance(1), 3 * P);
    // No positions and no debt: no oracle needed to withdraw.
    assert_ok(w.withdraw(&t, &x, &wallet, 100_000_000, vec![]));
    assert_eq!(w.user(&t).balance(1), 2 * P);
    assert_conserved(&w, &x, &[&t]);
}

#[test]
fn paused_blocks_deposits_but_not_idle_withdrawals() {
    let mut w = World::new();
    let usdc = w.add_usdc(u64::MAX);
    let t = w.trader(0);
    let wallet = w.wallet(&t, &usdc, 100 * USDC);
    assert_ok(w.deposit(&t, &usdc, &wallet, 50 * USDC));
    pause(&mut w);
    assert_err(w.deposit(&t, &usdc, &wallet, USDC), FloyDexError::Paused);
    // Escape hatch: idle collateral can always leave (05 §7.6).
    assert_ok(w.withdraw(&t, &usdc, &wallet, 50 * USDC, vec![]));
}

/// Trader with 1,000 USDC and a 10-share TSLA long at $250 (notional 2,500,
/// 20% initial margin = 500, 10% maintenance = 250).
fn leveraged() -> (
    World,
    Asset,
    Trader,
    anchor_lang::prelude::Pubkey,
    anchor_lang::prelude::Pubkey,
) {
    let mut w = World::new();
    let usdc = w.add_usdc(u64::MAX);
    let feed = w.open_market(1, 250.0);
    let t = w.trader(0);
    let wallet = w.wallet(&t, &usdc, 1_000 * USDC);
    assert_ok(w.deposit(&t, &usdc, &wallet, 1_000 * USDC));
    inject_position(&mut w.svm, &t.user, 1, true, 10 * P, 250 * P);
    (w, usdc, t, wallet, feed)
}

fn market_accounts(feed: anchor_lang::prelude::Pubkey) -> Vec<anchor_lang::prelude::AccountMeta> {
    vec![meta(market_pda(1), false), meta(feed, false)]
}

#[test]
fn withdraw_with_positions_keeps_initial_margin() {
    let (mut w, usdc, t, wallet, feed) = leveraged();
    // Equity 1,000, initial margin 500: 500 is free, 500.000001 is not.
    assert_err(
        w.withdraw(&t, &usdc, &wallet, 500 * USDC + 1, market_accounts(feed)),
        FloyDexError::InsufficientCollateral,
    );
    assert_ok(w.withdraw(&t, &usdc, &wallet, 500 * USDC, market_accounts(feed)));
    assert_eq!(w.user(&t).balance(0), 500 * P);
}

#[test]
fn withdraw_health_uses_unrealized_pnl() {
    let (mut w, usdc, t, wallet, _) = leveraged();
    // TSLA drops to $230: pnl -200, equity 800, IM on 2,300 = 460 → 340 free.
    let now = w.now();
    let feed = mock_usd(&mut w.svm, FEED_TSLA, 230.0, now);
    assert_err(
        w.withdraw(&t, &usdc, &wallet, 340 * USDC + 1, market_accounts(feed)),
        FloyDexError::InsufficientCollateral,
    );
    assert_ok(w.withdraw(&t, &usdc, &wallet, 340 * USDC, market_accounts(feed)));
}

#[test]
fn withdraw_with_positions_requires_the_market_accounts() {
    let (mut w, usdc, t, wallet, feed) = leveraged();
    assert_err(
        w.withdraw(&t, &usdc, &wallet, USDC, vec![]),
        FloyDexError::InvalidRemainingAccounts,
    );
    // Extra accounts are refused too: the layout is exact.
    let mut extra = market_accounts(feed);
    extra.push(meta(feed, false));
    assert_err(
        w.withdraw(&t, &usdc, &wallet, USDC, extra),
        FloyDexError::InvalidRemainingAccounts,
    );
    // The market must be the one the position is in.
    let i = w.create_market_ix(2, default_market_params());
    assert_ok(w.admin_send(&[i]));
    assert_err(
        w.withdraw(
            &t,
            &usdc,
            &wallet,
            USDC,
            vec![meta(market_pda(2), false), meta(feed, false)],
        ),
        FloyDexError::InvalidRemainingAccounts,
    );
}

#[test]
fn withdraw_rejects_a_foreign_or_spoofed_price_account() {
    let (mut w, usdc, t, wallet, _) = leveraged();
    let now = w.now();
    // A real-looking update for another feed, at that feed's address.
    let other = mock_usd(&mut w.svm, [0x99; 32], 250.0, now);
    assert_err(
        w.withdraw(&t, &usdc, &wallet, USDC, market_accounts(other)),
        FloyDexError::InvalidOracleAccount,
    );
    // The right address but not owned by the Pyth receiver.
    let addr = floydex_perps::oracle::push_feed_address(0, &FEED_TSLA);
    let data = w.svm.get_account(&addr).unwrap().data;
    mock_price_with(&mut w.svm, addr, anchor_lang::system_program::ID, data);
    assert_err(
        w.withdraw(&t, &usdc, &wallet, USDC, market_accounts(addr)),
        FloyDexError::InvalidOracleAccount,
    );
    // The same feed on another shard is a different account.
    let shard1 = mock_price(&mut w.svm, 1, FEED_TSLA, 250_0000_0000, 1, -8, now);
    assert_err(
        w.withdraw(&t, &usdc, &wallet, USDC, market_accounts(shard1)),
        FloyDexError::InvalidOracleAccount,
    );
}

#[test]
fn a_stale_oracle_in_a_scheduled_session_halts_at_the_last_price() {
    let (mut w, usdc, t, wallet, _) = leveraged();
    let now = w.now();
    // Oracle 2 minutes old (max age 70 s) inside a Regular window → Halted.
    // No last valid price recorded yet → StaleOracle.
    let feed = mock_usd(&mut w.svm, FEED_TSLA, 250.0, now - 120);
    assert_err(
        w.withdraw(&t, &usdc, &wallet, USDC, market_accounts(feed)),
        FloyDexError::StaleOracle,
    );
    // With a last valid price, Halted uses it and margin doubles (×2):
    // IM = 2,500 × 40% = 1,000 = equity → nothing is free.
    patch_zc::<floydex_perps::state::Market>(&mut w.svm, &market_pda(1), |m| {
        m.last_oracle_price.set(250 * P)
    });
    assert_err(
        w.withdraw(&t, &usdc, &wallet, 1, market_accounts(feed)),
        FloyDexError::InsufficientCollateral,
    );
}

#[test]
fn a_wide_confidence_interval_is_refused_in_session() {
    let (mut w, usdc, t, wallet, _) = leveraged();
    let now = w.now();
    // conf 2% of price, guard 1%.
    let feed = mock_price(
        &mut w.svm,
        0,
        FEED_TSLA,
        250_0000_0000,
        5_0000_0000,
        -8,
        now,
    );
    assert_err(
        w.withdraw(&t, &usdc, &wallet, USDC, market_accounts(feed)),
        FloyDexError::OracleConfidenceTooWide,
    );
}

#[test]
fn paused_blocks_withdrawals_for_accounts_with_positions() {
    let (mut w, usdc, t, wallet, feed) = leveraged();
    pause(&mut w);
    assert_err(
        w.withdraw(&t, &usdc, &wallet, USDC, market_accounts(feed)),
        FloyDexError::Paused,
    );
}

#[test]
fn xstock_collateral_is_priced_and_haircut() {
    let mut w = World::new();
    let usdc = w.add_usdc(u64::MAX);
    let x = w.add_xstock(FEED_XSTOCK, 2_000); // 20% haircut
    let feed = w.open_market(1, 250.0);
    let t = w.trader(0);
    let xw = w.wallet(&t, &x, 10 * 100_000_000);
    let uw = w.wallet(&t, &usdc, 0);
    // 10 shares at $100, 20% haircut → 800 of collateral value.
    assert_ok(w.deposit(&t, &x, &xw, 10 * 100_000_000));
    // Long 10 TSLA @ 250: IM 500. Also a -100 USDC debt from a realized loss.
    inject_position(&mut w.svm, &t.user, 1, true, 10 * P, 250 * P);
    patch_zc::<floydex_perps::state::UserAccount>(&mut w.svm, &t.user, |u| {
        u.apply_balance(0, -100 * P).unwrap();
    });
    let now = w.now();
    let xfeed = mock_usd(&mut w.svm, FEED_XSTOCK, 100.0, now);
    let accs = |xfeed| {
        vec![
            meta(market_pda(1), false),
            meta(feed, false),
            meta(collateral_pda(&x.mint), false),
            meta(xfeed, false),
            meta(x.mint, false),
        ]
    };
    // Equity = 800 − 100 = 700, IM 500 → 200 free. Withdrawing 2 shares
    // ($200 before haircut) is exactly the limit; 2 shares + 1 unit is over.
    assert_err(
        w.withdraw(&t, &x, &xw, 2 * 100_000_000 + 1, accs(xfeed)),
        FloyDexError::InsufficientCollateral,
    );
    assert_ok(w.withdraw(&t, &x, &xw, 2 * 100_000_000, accs(xfeed)));
    // A stale xStock price blocks it: collateral needs a fresh price.
    let stale = mock_usd(&mut w.svm, FEED_XSTOCK, 100.0, now - 600);
    assert_err(
        w.withdraw(&t, &x, &xw, 1, accs(stale)),
        FloyDexError::StaleOracle,
    );
    let _ = (usdc, uw);
}
