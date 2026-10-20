//! Read-only dry run of the first-run import review (SPEC §5):
//! `cargo run --example import_dry_run -- <Mods folder> <Library folder> [config dir]`.
//!
//! Plans the import exactly as the review screen does and prints the grouping. Nothing under the Mods folder is
//! written: archives are only listed, and their .ini files extracted into `<Library>/tmp` (removed afterwards).
//! The Library must be a scratch folder outside every Mods folder; the config dir defaults to a temp folder.

use skin_switcher_lib::core::app::AppCore;
use skin_switcher_lib::core::importer::{ImportItem, ImportSource};
use skin_switcher_lib::core::model::{Loader, ModsPaths, Settings};
use skin_switcher_lib::core::scanner::{ScanContext, scan};
use std::path::PathBuf;

fn main() {
    let mut args = std::env::args().skip(1);
    let usage = "usage: import_dry_run <Mods folder> <Library folder> [config dir]";
    let mods = PathBuf::from(args.next().expect(usage));
    let lib = PathBuf::from(args.next().expect(usage));
    let tmp_cfg = tempfile::tempdir().expect("temp dir");
    let cfg = args.next().map(PathBuf::from).unwrap_or_else(|| tmp_cfg.path().to_path_buf());
    assert!(mods.is_dir(), "Mods folder not found: {}", mods.display());
    let (mods_abs, lib_abs) = (mods.canonicalize().unwrap(), std::path::absolute(&lib).unwrap());
    assert!(!lib_abs.starts_with(&mods_abs), "the Library must not be inside the Mods folder");
    // opening a Library re-scans and may save its library.json, so only a fresh scratch folder keeps this read-only
    assert!(!lib_abs.join("library.json").exists(), "use an empty scratch Library, not one with a library.json");
    std::fs::create_dir_all(&cfg).expect("config dir");

    // no load(): there is no journal to recover in a scratch Library, and nothing is applied
    let mut core = AppCore::open(&cfg);
    let settings = Settings {
        active_loader: Loader::Migoto,
        mods_path: ModsPaths { xxmi: None, migoto: Some(mods_abs.to_string_lossy().into_owned()) },
        library_path: lib_abs.to_string_lossy().into_owned(),
        ..Settings::default()
    };
    core.save_settings(settings).expect("settings");
    println!("hash index: {:?}", core.index().info());

    let installed = {
        let ctx = ScanContext::new(core.index(), core.library());
        scan(&mods_abs, &ctx)
    };
    println!("\nMods folder:");
    println!("  libraries: {:?}", installed.libraries.iter().map(|l| &l.path).collect::<Vec<_>>());
    println!("  maybe libraries: {:?}", installed.maybe_libraries.iter().map(|l| &l.path).collect::<Vec<_>>());
    println!("  junk: {:?}", installed.junk);
    println!("  disabled: {:?}", installed.disabled);

    let plan = core.plan_import(&mut |done, n, label| eprintln!("  {done}/{n} {label}")).expect("plan_import");

    println!("\nitems ({}):", plan.items.len());
    for it in &plan.items {
        print_item(it);
    }
    println!("\narchives ({}):", plan.archives.len());
    for a in &plan.archives {
        println!(
            "  {:<70} {:>10} {}",
            a.path,
            a.size,
            a.error.as_deref().map(|e| format!("ERROR {e}")).unwrap_or_default()
        );
    }
    println!("\nstray archives (offered a move): {:?}", plan.stray);

    // what each readable archive leaves out (junk, bundled ORFix copies), as "Extract & add" would
    println!("\nleft out of each archive:");
    for a in plan.archives.iter().filter(|a| a.error.is_none()) {
        let abs = mods_abs.join(&a.path);
        match core.analyze_archive(&abs) {
            Ok(s) => {
                let roots: Vec<String> = s.roots.iter().map(|r| format!("{:?}", r.inis)).collect();
                println!("  {} (ini roots: {})", a.path, roots.join(" "));
                for k in &s.skipped {
                    println!("      skipped {k}");
                }
            }
            Err(e) => println!("  {} ERROR {}", a.path, e.message),
        }
    }
}

fn print_item(it: &ImportItem) {
    let g = &it.guess;
    let source = match &it.source {
        ImportSource::Installed { folders } => format!("installed {}", folders.join(" + ")),
        ImportSource::Archive { archive, root, main, nested, .. } => format!(
            "archive {archive} # {} {}{}",
            if root.is_empty() { "<root>" } else { root },
            if *main { "[main]" } else { "[split]" },
            if *nested { " nested" } else { "" }
        ),
    };
    let entity = format!("{}{}", g.name, g.parent_name.as_ref().map(|p| format!(" (under {p})")).unwrap_or_default());
    let category = format!("{:?}", g.category);
    let role = match (&it.parent, it.own) {
        (None, _) => "",
        (Some(_), true) => "  own skin",
        (Some(_), false) => "  part of main",
    };
    println!(
        "  {entity:<34} {category:<9} {:<9?} conf {:.2}  skin {:?}{}{role}  {} hotkeys, {} images",
        g.reason,
        g.confidence,
        it.skin_name,
        if it.nsfw { "  NSFW" } else { "" },
        it.hotkeys,
        it.images,
    );
    println!("      {source}");
}
