use std::{
    env,
    fs::File,
    io::{BufRead, BufReader},
};

fn main() {
    sails_rs::build_wasm();

    if env::var("__GEAR_WASM_BUILDER_NO_BUILD").is_ok() {
        return;
    }

    // Read the binary path from .binpath file created by build_wasm
    let bin_path_file = File::open(".binpath").unwrap();
    let mut bin_path_reader = BufReader::new(bin_path_file);
    let mut bin_path = String::new();
    bin_path_reader.read_line(&mut bin_path).unwrap();

    // Note: IDL generation requires the compiled crate types to be available
    // Since build.rs runs during compilation, we can't reference the crate types here
    // The IDL will be generated manually or via a post-build script
    // See generate_idl.sh in the parent directory
}
