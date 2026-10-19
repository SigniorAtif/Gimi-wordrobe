// Type-check the Tauri-free core (src-tauri/src/core) for Windows from a Linux box, so `cfg(windows)` code is at
// least compiled before it reaches the real machine. Needs `rustup target add x86_64-pc-windows-gnu`; nothing is
// linked, so no MinGW toolchain is required. The full app can't be checked this way (ring needs a C cross compiler).
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const core = resolve(dirname(fileURLToPath(import.meta.url)), "../src-tauri/src/core/mod.rs");
const dir = join(tmpdir(), "skin-switcher-wincheck");
mkdirSync(join(dir, "src"), { recursive: true });
writeFileSync(
  join(dir, "Cargo.toml"),
  `[package]\nname = "wincheck"\nversion = "0.0.0"\nedition = "2024"\n\n[dependencies]\nserde = { version = "1", features = ["derive"] }\nserde_json = "1"\nthiserror = "2"\n`,
);
writeFileSync(join(dir, "src/lib.rs"), `#![allow(dead_code)]\n#[path = ${JSON.stringify(core)}]\npub mod core;\n`);
execFileSync("cargo", ["check", "--target", "x86_64-pc-windows-gnu"], {
  cwd: dir,
  stdio: "inherit",
  env: { ...process.env, CARGO_TARGET_DIR: join(homedir(), ".cache/skin-switcher-wincheck") },
});
console.log("core type-checks for Windows");
