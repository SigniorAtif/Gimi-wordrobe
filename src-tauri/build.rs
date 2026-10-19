fn main() {
    // resources/hash_index.json is generated (and gitignored) by `npm run predev/prebuild`. tauri-build checks
    // bundled resources exist, so a fresh `cargo test` gets an empty placeholder; detection then falls back to names.
    let index = std::path::Path::new("resources/hash_index.json");
    if !index.exists() {
        let _ = std::fs::create_dir_all("resources");
        let _ = std::fs::write(
            index,
            r#"{"version":1,"source":"placeholder","commit":null,"date":null,"entities":[],"hashes":{}}"#,
        );
    }
    tauri_build::build()
}
