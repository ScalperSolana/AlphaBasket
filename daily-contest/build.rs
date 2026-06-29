use std::env;

fn main() {
    sails_rs::build_wasm();

    if env::var("__GEAR_WASM_BUILDER_NO_BUILD").is_ok() {
        return;
    }

    let idl_file_path = "daily-contest.idl";

    sails_idl_gen::generate_idl_to_file::<daily_contest_app::DailyContestProgram>(idl_file_path)
        .expect("failed to generate IDL");

    println!("cargo:rerun-if-changed=app/src");
}
