//! Tauri-free core logic (SPEC §13). Everything here runs under `cargo test` on Windows and Linux.

pub mod app;
pub mod error;
pub mod fsutil;
pub mod hotkeys;
pub mod ini;
pub mod model;
pub mod paths;
pub mod settings;
