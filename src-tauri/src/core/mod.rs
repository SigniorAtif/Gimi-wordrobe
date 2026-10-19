//! Tauri-free core logic (SPEC §13). Everything here runs under `cargo test` on Windows and Linux.

pub mod app;
pub mod error;
pub mod fsutil;
pub mod hashindex;
pub mod hotkeys;
pub mod ini;
pub mod library;
pub mod model;
pub mod names;
pub mod paths;
pub mod scanner;
pub mod settings;
pub mod state;
