use std::env;

fn main() {
    sails_rs::build_wasm();

    if env::var("__GEAR_WASM_BUILDER_NO_BUILD").is_ok() {
        return;
    }

    sails_idl_gen::generate_idl_to_file::<freebet_ledger_app::FreebetLedgerProgram>(
        "freebet-ledger.idl",
    )
    .expect("failed to generate freebet ledger IDL");

    println!("cargo:rerun-if-changed=app/src");
}
