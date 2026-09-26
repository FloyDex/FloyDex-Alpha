//! Compute-unit benchmark for `protocol_core::mul_div` inside SBF.
//!
//! Build the bench binary first:
//!   cargo build-sbf --manifest-path programs/kryon-perps/Cargo.toml \
//!     --features bench --sbf-out-dir target/deploy-bench
//! then: cargo test --manifest-path integration/Cargo.toml --test bench -- --nocapture

use anchor_lang::{InstructionData, ToAccountMetas};
use kryon_integration::svm_with_program;
use litesvm::LiteSVM;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

const P: i128 = 1_000_000_000_000_000_000;

fn run(svm: &mut LiteSVM, payer: &Keypair, data: Vec<u8>) -> (Vec<String>, u64) {
    let ix = anchor_lang::solana_program::instruction::Instruction {
        program_id: kryon_perps::ID,
        accounts: kryon_perps::accounts::Bench {}.to_account_metas(None),
        data,
    };
    // ComputeBudget SetComputeUnitLimit(1_400_000): tag 2 + u32 LE.
    let mut cu = vec![2u8];
    cu.extend_from_slice(&1_400_000u32.to_le_bytes());
    let budget = anchor_lang::solana_program::instruction::Instruction {
        program_id: anchor_lang::solana_program::pubkey!("ComputeBudget111111111111111111111111111111"),
        accounts: vec![],
        data: cu,
    };
    let tx = Transaction::new(
        &[payer],
        Message::new(&[budget, ix], Some(&payer.pubkey())),
        svm.latest_blockhash(),
    );
    let meta = svm.send_transaction(tx).expect("bench tx");
    svm.expire_blockhash();
    (meta.logs, meta.compute_units_consumed)
}

#[test]
fn mul_div_compute_units() {
    let mut svm = svm_with_program("deploy-bench");
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();

    let cases: [(&str, i128, i128, i128); 5] = [
        ("small (bps on 1e18)", 100 * P, 50, 10_000),
        ("mul_precision 2e18*3e18", 2 * P, 3 * P, P),
        ("notional 1e6 units * $250", 1_000_000 * P, 250 * P, P),
        ("negative pnl", -90 * P, 1_234 * P, P),
        ("near i128 limit /1e18", i128::MAX / 3, 2 * P, P),
    ];
    for (name, a, b, d) in cases {
        let i256 = kryon_perps::instruction::BenchMulDiv { a, b, denominator: d }.data();
        let (logs, _) = run(&mut svm, &payer, i256);
        let line = logs.iter().find(|l| l.contains("bench mul_div:")).unwrap();
        println!("I256  {name:<28} {line}");
        let u128 = kryon_perps::instruction::BenchMulDivU128 { a, b, denominator: d }.data();
        let (logs, _) = run(&mut svm, &payer, u128);
        let line = logs.iter().find(|l| l.contains("bench mul_div_u128:")).unwrap();
        println!("u128  {name:<28} {line}");
        let limbs = kryon_perps::instruction::BenchMulDivLimbs { a, b, denominator: d }.data();
        let (logs, _) = run(&mut svm, &payer, limbs);
        let line = logs.iter().find(|l| l.contains("bench mul_div_limbs:")).unwrap();
        println!("limbs {name:<28} {line}");
    }
}
