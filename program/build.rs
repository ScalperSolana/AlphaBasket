use std::env;

fn main() {
    sails_rs::build_wasm();

    if env::var("__GEAR_WASM_BUILDER_NO_BUILD").is_ok() {
        return;
    }

    let idl_file_path = "polymarket-mirror.idl";

    sails_idl_gen::generate_idl_to_file::<polymarket_mirror_app::BasketMarketProgram>(idl_file_path)
        .expect("failed to generate IDL");

    println!("cargo:rerun-if-changed=app/src");
}
