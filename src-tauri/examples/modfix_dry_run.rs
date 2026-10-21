//! Read-only check of the mod fixes: copy a mod folder to a temp dir, fix the copy, print what changed.
//!
//!     cargo run --example modfix_dry_run -- <modfix_data.json> <mod folder> [<out dir>]
//!
//! With an out dir the fixed copy is kept there for diffing; the source folder is never written to.

use skin_switcher_lib::core::modfix::{FixData, fix_tree};
use std::path::{Path, PathBuf};

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let t = e.file_type()?;
        let dest = to.join(e.file_name());
        if t.is_dir() {
            copy_tree(&e.path(), &dest)?;
        } else if t.is_file() {
            std::fs::copy(e.path(), dest)?;
        }
    }
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 2 {
        eprintln!("usage: modfix_dry_run <modfix_data.json> <mod folder> [<out dir>]");
        std::process::exit(2);
    }
    let data = FixData::load(Path::new(&args[0])).expect("modfix data");
    let tmp = tempfile::tempdir().expect("temp dir");
    let out: PathBuf = args.get(2).map(PathBuf::from).unwrap_or_else(|| tmp.path().join("mod"));
    copy_tree(Path::new(&args[1]), &out).expect("copy");
    let report = fix_tree(&out, &data);
    println!("{report:#?}");
    println!("{}", report.summary().unwrap_or_else(|| "Nothing to change.".into()));
}
