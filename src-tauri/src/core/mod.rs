//! Tauri-free core logic (SPEC §13). Everything here runs under `cargo test` on Windows and Linux.

pub mod add;
pub mod app;
pub mod apply;
pub mod archive;
pub mod error;
pub mod fsutil;
pub mod hashindex;
pub mod hotkeys;
pub mod import;
pub mod ini;
pub mod library;
pub mod model;
pub mod names;
pub mod paths;
pub mod persist;
pub mod scanner;
pub mod settings;
pub mod state;
