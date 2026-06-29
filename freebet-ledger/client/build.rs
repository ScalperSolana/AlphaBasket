use std::{env, path::PathBuf};

fn main() {
    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR should exist"));
    let idl_path = manifest_dir.join("../freebet-ledger.idl");
    let client_path = manifest_dir.join("src/freebet_ledger_client.rs");

    if idl_path.exists() {
        sails_rs::ClientGenerator::from_idl_path(&idl_path)
            .generate_to(&client_path)
            .expect("failed to generate freebet ledger client from idl");
    }

    println!("cargo:rerun-if-changed={}", idl_path.display());
}
