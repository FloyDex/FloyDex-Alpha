//! (d) set_delegate / revoke_delegate.

use floydex_integration::*;
use floydex_perps::error::FloyDexError;
use solana_keypair::Keypair;
use solana_signer::Signer;

#[test]
fn owner_sets_and_revokes_a_session_key() {
    let mut w = World::new();
    let t = w.trader(0);
    let session = Keypair::new();
    let now = w.now();
    assert_ok(w.set_delegate(&t, &session.pubkey(), now + 86_400));
    let u = w.user(&t);
    assert_eq!(u.delegate, session.pubkey());
    assert_eq!(u.delegate_expiry, now + 86_400);
    assert!(u.can_sign_orders(&session.pubkey(), now));
    assert!(
        !u.can_sign_orders(&session.pubkey(), now + 86_400),
        "expires exactly at expiry"
    );

    // Rotating replaces the old key.
    let next = Keypair::new();
    assert_ok(w.set_delegate(&t, &next.pubkey(), now + 3_600));
    assert!(!w.user(&t).can_sign_orders(&session.pubkey(), now));

    assert_ok(w.revoke_delegate(&t));
    let u = w.user(&t);
    assert_eq!(u.delegate, anchor_lang::prelude::Pubkey::default());
    assert!(!u.can_sign_orders(&next.pubkey(), now));
}

#[test]
fn delegate_expiry_must_be_in_the_future() {
    let mut w = World::new();
    let t = w.trader(0);
    let now = w.now();
    let k = Keypair::new().pubkey();
    assert_err(
        w.set_delegate(&t, &k, now),
        FloyDexError::InvalidDelegateExpiry,
    );
    assert_err(
        w.set_delegate(&t, &k, now - 1),
        FloyDexError::InvalidDelegateExpiry,
    );
}

#[test]
fn delegate_cannot_be_empty_or_the_owner() {
    let mut w = World::new();
    let t = w.trader(0);
    let now = w.now();
    assert_err(
        w.set_delegate(&t, &anchor_lang::prelude::Pubkey::default(), now + 60),
        FloyDexError::InvalidConfig,
    );
    let owner = t.key();
    assert_err(
        w.set_delegate(&t, &owner, now + 60),
        FloyDexError::InvalidConfig,
    );
}

#[test]
fn only_the_owner_manages_the_session_key() {
    let mut w = World::new();
    let t = w.trader(0);
    let session = funded(&mut w.svm);
    let now = w.now();
    assert_ok(w.set_delegate(&t, &session.pubkey(), now + 86_400));
    // The session key cannot extend itself, replace itself or revoke.
    for data in [
        ix(
            ka::OwnerOnly {
                owner: session.pubkey(),
                user_account: t.user,
                event_authority: event_authority(),
                program: floydex_perps::ID,
            },
            ki::SetDelegate {
                delegate: session.pubkey(),
                expiry: now + 10 * 86_400,
            },
        ),
        ix(
            ka::OwnerOnly {
                owner: session.pubkey(),
                user_account: t.user,
                event_authority: event_authority(),
                program: floydex_perps::ID,
            },
            ki::RevokeDelegate {},
        ),
    ] {
        assert!(send(&mut w.svm, &[data], &session, &[]).is_err());
    }
    assert_eq!(w.user(&t).delegate_expiry, now + 86_400);
}

#[test]
fn a_session_key_cannot_withdraw() {
    let mut w = World::new();
    let usdc = w.add_usdc(u64::MAX);
    let t = w.trader(0);
    let wallet = w.wallet(&t, &usdc, 10_000_000);
    assert_ok(w.deposit(&t, &usdc, &wallet, 10_000_000));
    let session = funded(&mut w.svm);
    let now = w.now();
    assert_ok(w.set_delegate(&t, &session.pubkey(), now + 86_400));
    let i = ix(
        w.move_accounts(&session.pubkey(), &t.user, &usdc, &wallet),
        ki::Withdraw { amount: 1 },
    );
    assert!(send(&mut w.svm, &[i], &session, &[]).is_err());
    assert_eq!(w.user(&t).balance(0), 10 * P);
}
