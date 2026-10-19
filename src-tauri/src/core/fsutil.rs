//! Small file helpers: atomic writes with a `.bak` copy, tolerant JSON reads.

use serde::de::DeserializeOwned;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

/// Write via temp file + rename. With `keep_bak`, the previous contents are copied to `<file>.bak` first.
pub fn write_atomic(path: &Path, bytes: &[u8], keep_bak: bool) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = with_suffix(path, ".tmp");
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    if keep_bak && path.exists() {
        fs::copy(path, with_suffix(path, ".bak"))?;
    }
    // std::fs::rename replaces an existing target on Windows too (MOVEFILE_REPLACE_EXISTING).
    fs::rename(&tmp, path)
}

pub fn write_json_atomic<T: serde::Serialize>(path: &Path, value: &T, keep_bak: bool) -> io::Result<()> {
    let bytes = serde_json::to_vec_pretty(value).map_err(io::Error::other)?;
    write_atomic(path, &bytes, keep_bak)
}

/// Read JSON from `path`, falling back to `<path>.bak` when the main file is missing or corrupt.
/// Returns Ok(None) when neither exists.
pub fn read_json_or_bak<T: DeserializeOwned>(path: &Path) -> io::Result<Option<T>> {
    let bak = with_suffix(path, ".bak");
    let mut last_err = None;
    for p in [path, bak.as_path()] {
        match fs::read(p) {
            Ok(bytes) => match serde_json::from_slice::<T>(strip_bom(&bytes)) {
                Ok(v) => return Ok(Some(v)),
                Err(e) => last_err = Some(io::Error::new(io::ErrorKind::InvalidData, e)),
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => last_err = Some(e),
        }
    }
    match last_err {
        Some(e) => Err(e),
        None => Ok(None),
    }
}

pub fn strip_bom(b: &[u8]) -> &[u8] {
    b.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_keeps_backup_and_reads_fall_back() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("library.json");
        write_json_atomic(&p, &serde_json::json!({"v": 1}), true).unwrap();
        write_json_atomic(&p, &serde_json::json!({"v": 2}), true).unwrap();
        let bak: serde_json::Value = serde_json::from_slice(&fs::read(with_suffix(&p, ".bak")).unwrap()).unwrap();
        assert_eq!(bak["v"], 1);
        fs::write(&p, b"{ corrupt").unwrap();
        let v: serde_json::Value = read_json_or_bak(&p).unwrap().unwrap();
        assert_eq!(v["v"], 1);
        assert!(read_json_or_bak::<serde_json::Value>(&dir.path().join("none.json")).unwrap().is_none());
    }
}
