//! (f) Ed25519 introspection (05 §5): each rule violated on its own.
//! In every case the Ed25519 precompile itself succeeds; only our checks
//! stand between the attacker and the fill.

mod common;
use common::*;
use floydex_integration::*;
use floydex_perps::error::FloyDexError;
use solana_keypair::Keypair;
use solana_signer::Signer;

/// Build the two honest signature entries for a maker/taker pair.
fn honest(b: &Book, mo: &OrderArgs, to: &OrderArgs) -> (SigEntry, SigEntry) {
    (
        SigEntry::sign(&b.alice_key, &order_message(DOMAIN, &b.alice, mo)),
        SigEntry::sign(&b.bob_key, &order_message(DOMAIN, &b.bob, to)),
    )
}

#[test]
fn the_honest_layout_settles() {
    let mut b = Book::new();
    let (mo, to) = b.pair(true, W, PX);
    let (m, t) = honest(&b, &mo, &to);
    let p = plan(&b.alice, &b.bob, mo, to, W, PX);
    assert_ok(b.w.settle_with(1, &[p], ed25519_ix(&[m, t])));
}

#[test]
fn tamper_wrong_program() {
    // The referenced instruction (index 1) is not the Ed25519 program: here a
    // second compute-budget instruction sits where the signatures should be.
    let mut b = Book::new();
    let (mo, to) = b.pair(true, W, PX);
    let p = plan(&b.alice, &b.bob, mo, to, W, PX);
    let mut fake = compute_budget(1_400_000);
    fake.data = vec![3, 0, 0, 0, 0, 0, 0, 0, 0]; // SetComputeUnitPrice(0)
    assert_err(
        b.w.settle_with(1, &[p], fake),
        FloyDexError::Ed25519WrongProgram,
    );
}

#[test]
fn tamper_offsets_point_at_another_instruction() {
    // The classic introspection bug: instruction 1 is an Ed25519 instruction
    // whose offsets tell the precompile to verify the pubkey/signature/message
    // stored in instruction 2 (a genuine signature over some *other* order),
    // while at those same offsets in instruction 1 sit the bytes we would
    // compare. The precompile passes; our u16::MAX rule must not.
    let mut b = Book::new();
    let (mo, to) = b.pair(true, W, PX);
    let (m, t) = honest(&b, &mo, &to);
    // What Alice really signed: a tiny order.
    let mut real = mo;
    real.size = 1;
    let genuine = SigEntry::sign(&b.alice_key, &order_message(DOMAIN, &b.alice, &real));
    // Instruction 2 carries the genuine signature with the same layout.
    let carrier = ed25519_ix(&[genuine.clone(), t.clone()]);
    // Instruction 1 has our bytes (the big order, unsigned) but its maker
    // offsets point into instruction 2, where the genuine data lives.
    let mut forged = m.clone();
    forged.signature = genuine.signature;
    forged.pubkey = genuine.pubkey;
    forged.sig_ix = 2;
    forged.pk_ix = 2;
    forged.msg_ix = 2;
    let attack = ed25519_ix(&[forged, t]);
    let settle = b.w.settle_ix(1, &[plan(&b.alice, &b.bob, mo, to, W, PX)]);
    let op = b.w.operator.insecure_clone();
    let r = send(
        &mut b.w.svm,
        &[compute_budget(1_400_000), attack, carrier, settle],
        &op,
        &[],
    );
    assert_err(r, FloyDexError::Ed25519OffsetIndex);
}

#[test]
fn tamper_wrong_pubkey() {
    // A perfectly valid signature over the right message, by a key that is
    // neither the owner nor the delegate.
    let mut b = Book::new();
    let (mo, to) = b.pair(true, W, PX);
    let (_, t) = honest(&b, &mo, &to);
    let stranger = Keypair::new();
    let m = SigEntry::sign(&stranger, &order_message(DOMAIN, &b.alice, &mo));
    let p = plan(&b.alice, &b.bob, mo, to, W, PX);
    assert_err(
        b.w.settle_with(1, &[p], ed25519_ix(&[m, t])),
        FloyDexError::Ed25519PubkeyMismatch,
    );
}

#[test]
fn tamper_expired_or_revoked_delegate() {
    let mut b = Book::new();
    let (mo, to) = b.pair(true, W, PX);
    let alice = b.alice.kp.insecure_clone();
    let alice_t = Trader {
        kp: alice,
        sub_id: 0,
        user: b.alice.user,
    };
    assert_ok(b.w.revoke_delegate(&alice_t));
    let (m, t) = honest(&b, &mo, &to);
    let p = plan(&b.alice, &b.bob, mo, to, W, PX);
    assert_err(
        b.w.settle_with(1, &[p], ed25519_ix(&[m, t])),
        FloyDexError::Ed25519PubkeyMismatch,
    );

    // A delegate at the exact second it expires (expiry is exclusive).
    let mut b = Book::new();
    let alice = Trader {
        kp: b.alice.kp.insecure_clone(),
        sub_id: 0,
        user: b.alice.user,
    };
    let exp = b.w.now() + 60;
    let key = b.alice_key.pubkey();
    assert_ok(b.w.set_delegate(&alice, &key, exp));
    b.w.warp_to(exp);
    mock_usd(&mut b.w.svm, FEED_TSLA, 250.0, exp);
    let (mo, to) = b.pair(true, W, PX);
    let (m, t) = honest(&b, &mo, &to);
    let p = plan(&b.alice, &b.bob, mo, to, W, PX);
    assert_err(
        b.w.settle_with(1, &[p], ed25519_ix(&[m, t])),
        FloyDexError::Ed25519PubkeyMismatch,
    );
}

#[test]
fn tamper_wrong_message() {
    // Alice signed a 1-share order; the operator submits it as 5 shares.
    let mut b = Book::new();
    let (mo, to) = b.pair(true, 5 * W, PX);
    let mut signed = mo;
    signed.size = W;
    let m = SigEntry::sign(&b.alice_key, &order_message(DOMAIN, &b.alice, &signed));
    let t = SigEntry::sign(&b.bob_key, &order_message(DOMAIN, &b.bob, &to));
    let p = plan(&b.alice, &b.bob, mo, to, 5 * W, PX);
    assert_err(
        b.w.settle_with(1, &[p], ed25519_ix(&[m, t])),
        FloyDexError::Ed25519MessageMismatch,
    );
}

#[test]
fn tamper_wrong_domain() {
    // A signature from another deployment (devnet order replayed on mainnet).
    let mut b = Book::new();
    let (mo, to) = b.pair(true, W, PX);
    let m = SigEntry::sign(&b.alice_key, &order_message([8u8; 32], &b.alice, &mo));
    let t = SigEntry::sign(&b.bob_key, &order_message(DOMAIN, &b.bob, &to));
    let p = plan(&b.alice, &b.bob, mo, to, W, PX);
    assert_err(
        b.w.settle_with(1, &[p], ed25519_ix(&[m, t])),
        FloyDexError::Ed25519MessageMismatch,
    );
}

#[test]
fn tamper_truncated_message() {
    // Alice's key signed only the first 107 bytes; a prefix match is not a match.
    let mut b = Book::new();
    let (mo, to) = b.pair(true, W, PX);
    let full = order_message(DOMAIN, &b.alice, &mo);
    let m = SigEntry::sign(&b.alice_key, &full[..107]);
    let t = SigEntry::sign(&b.bob_key, &order_message(DOMAIN, &b.bob, &to));
    let p = plan(&b.alice, &b.bob, mo, to, W, PX);
    assert_err(
        b.w.settle_with(1, &[p], ed25519_ix(&[m, t])),
        FloyDexError::Ed25519MessageMismatch,
    );
    // …and neither is a longer message that starts with the order.
    let mut b = Book::new();
    let (mo, to) = b.pair(true, W, PX);
    let mut long = order_message(DOMAIN, &b.alice, &mo);
    long.push(0);
    let m = SigEntry::sign(&b.alice_key, &long);
    let t = SigEntry::sign(&b.bob_key, &order_message(DOMAIN, &b.bob, &to));
    let p = plan(&b.alice, &b.bob, mo, to, W, PX);
    assert_err(
        b.w.settle_with(1, &[p], ed25519_ix(&[m, t])),
        FloyDexError::Ed25519MessageMismatch,
    );
}

#[test]
fn tamper_signature_index_out_of_range() {
    // The fill points at signature #5 of a 2-signature instruction.
    let mut b = Book::new();
    let (mo, to) = b.pair(true, W, PX);
    let (m, t) = honest(&b, &mo, &to);
    let mut settle = b.w.settle_ix(1, &[plan(&b.alice, &b.bob, mo, to, W, PX)]);
    // Rewrite the maker SigRef inside the instruction data.
    let mut fills = vec![FillArgs {
        maker: mo,
        taker: to,
        fill_size: W,
        fill_price: PX,
        maker_sig: SigRef {
            ix_index: 1,
            sig_index: 5,
        },
        taker_sig: SigRef {
            ix_index: 1,
            sig_index: 1,
        },
    }];
    settle.data = anchor_lang::InstructionData::data(&ki::SettleFills {
        fills: std::mem::take(&mut fills),
    });
    let op = b.w.operator.insecure_clone();
    let r = send(
        &mut b.w.svm,
        &[compute_budget(1_400_000), ed25519_ix(&[m, t]), settle],
        &op,
        &[],
    );
    assert_err(r, FloyDexError::Ed25519Malformed);
}

#[test]
fn swapping_maker_and_taker_signatures_fails() {
    // Both signatures are valid, but each is checked against its own order.
    let mut b = Book::new();
    let (mo, to) = b.pair(true, W, PX);
    let (m, t) = honest(&b, &mo, &to);
    let p = plan(&b.alice, &b.bob, mo, to, W, PX);
    assert_err(
        b.w.settle_with(1, &[p], ed25519_ix(&[t, m])),
        FloyDexError::Ed25519MessageMismatch,
    );
}
