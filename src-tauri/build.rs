use std::path::PathBuf;

fn main() {
    // Record this checkout's `config/` dir so a locally built app finds the
    // repo's settings and theme without any setup (see PLAN.md §4).
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let config_dir = manifest_dir
        .parent()
        .expect("src-tauri lives inside the project dir")
        .join("config");
    println!(
        "cargo:rustc-env=GMD_REPO_CONFIG_DIR={}",
        config_dir.display()
    );
    tauri_build::build()
}
