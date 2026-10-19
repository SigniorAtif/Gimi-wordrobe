//! `cargo run --example fetch_hash_index -- <out.json>`: run the in-app "Update hash index" fetch once.
fn main() {
    let out = std::env::args().nth(1).expect("usage: fetch_hash_index <out.json>");
    match skin_switcher_lib::net::update_hash_index(std::path::Path::new(&out)) {
        Ok((date, n)) => println!("ok: {n} hashes, snapshot {date:?}"),
        Err(e) => {
            eprintln!("failed: {e}");
            std::process::exit(1);
        }
    }
}
