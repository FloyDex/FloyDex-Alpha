//! Shared LiteSVM harness for the `kryon_perps` program tests.

use litesvm::LiteSVM;
use std::path::PathBuf;

pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// A fresh VM with the program loaded from `target/<dir>/kryon_perps.so`.
pub fn svm_with_program(dir: &str) -> LiteSVM {
    let so = repo_root().join("target").join(dir).join("kryon_perps.so");
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(kryon_perps::ID, &so)
        .unwrap_or_else(|e| panic!("load {}: {e:?} (build it first)", so.display()));
    svm
}
