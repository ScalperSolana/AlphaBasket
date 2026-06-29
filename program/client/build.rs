use std::{env, path::PathBuf};

fn main() {
    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR should exist"));
    let idl_path = manifest_dir.join("../polymarket-mirror.idl");
    let client_path = manifest_dir.join("src/polymarket_mirror_client.rs");

    sails_rs::ClientGenerator::from_idl_path(&idl_path)
        .generate_to(&client_path)
        .expect("failed to generate polymarket mirror client from idl");

    println!("cargo:rerun-if-changed={}", idl_path.display());
}
