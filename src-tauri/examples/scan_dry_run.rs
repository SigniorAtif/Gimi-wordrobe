//! Read-only dry run of the scanner: `cargo run --example scan_dry_run -- <Mods folder> [hash_index.json]`.
//! Prints libraries, skin candidates with entity guesses, and what was skipped. Never writes anything.

use skin_switcher_lib::core::hashindex::HashIndex;
use skin_switcher_lib::core::model::Library;
use skin_switcher_lib::core::scanner::{ScanContext, scan};
use std::path::PathBuf;

fn main() {
    let mut args = std::env::args().skip(1);
    let mods = PathBuf::from(args.next().expect("usage: scan_dry_run <Mods folder> [hash_index.json]"));
    let index =
        args.next().map(|p| HashIndex::load(&PathBuf::from(p)).expect("hash index")).unwrap_or_else(HashIndex::empty);
    let lib = Library::default();
    let ctx = ScanContext::new(&index, &lib);
    let r = scan(&mods, &ctx);
    println!("libraries:");
    for l in &r.libraries {
        println!("  {:<40} {:?}", l.path, l.reason);
    }
    for l in &r.maybe_libraries {
        println!("  {:<40} looks like a library", l.path);
    }
    println!("skins:");
    for c in &r.candidates {
        let g = c.guess.as_ref();
        println!(
            "  {:<28} {:<10} {:?} conf {:.2}  {}  ({} hotkeys)",
            g.map(|g| g.name.as_str()).unwrap_or("?"),
            g.map(|g| format!("{:?}", g.category)).unwrap_or_default(),
            g.map(|g| g.reason),
            g.map(|g| g.confidence).unwrap_or(0.0),
            c.folders.join(" + "),
            r.hotkeys_of(c).len()
        );
        for n in &c.nested {
            println!("      nested: {} -> {:?}", n.folder, n.guess.as_ref().map(|g| &g.name));
        }
    }
    println!("disabled: {:?}", r.disabled);
    println!("junk: {:?}", r.junk);
    println!("stray archives: {:?}", r.stray_archives);
    println!("archives below root: {}", r.archives.len());
}
