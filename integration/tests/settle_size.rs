//! Transaction-size and compute budget for the matcher (03 §4, 05 §6).

mod common;
use common::*;
use kryon_integration::*;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

#[test]
fn one_fill_fits_a_legacy_transaction() {
    let mut b = Book::new();
    let (mo, to) = b.pair(true, W, PX);
    let entries = [
        SigEntry::sign(&b.alice_key, &order_message(DOMAIN, &b.alice, &mo)),
        SigEntry::sign(&b.bob_key, &order_message(DOMAIN, &b.bob, &to)),
    ];
    let ixs = [
        compute_budget(400_000),
        ed25519_ix(&entries),
        b.w.settle_ix(1, &[plan(&b.alice, &b.bob, mo, to, W, PX)]),
    ];
    let op = b.w.operator.insecure_clone();
    let tx = Transaction::new(
        &[&op],
        Message::new(&ixs, Some(&op.pubkey())),
        b.w.svm.latest_blockhash(),
    );
    let size = bincode::serialize(&tx).unwrap().len();
    println!("one-fill legacy transaction: {size} bytes (limit 1232)");
    assert!(
        size <= 1232,
        "one fill must fit a legacy transaction: {size}"
    );
    let meta = assert_ok(b.w.svm.send_transaction(tx));
    println!(
        "one fill, fresh positions and records, 400k budget: {} CU",
        meta.compute_units_consumed
    );
    assert!(meta.compute_units_consumed < 250_000);
}
