//! Cache lives in the OS app-cache dir (not the project tree), keyed by video id +
//! format, exactly like the old CLI's `Downloads/Temporary`.

use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("sources");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn entries(dir: &Path) -> Vec<PathBuf> {
    fs::read_dir(dir)
        .map(|rd| rd.filter_map(|e| e.ok().map(|e| e.path())).collect())
        .unwrap_or_default()
}

/// Cached source audio for this id+format, if present (`src_<id>_<fmt>.*`).
pub fn cached_source(dir: &Path, vid: &str, fmt: &str) -> Option<PathBuf> {
    let prefix = format!("src_{vid}_{fmt}.");
    entries(dir).into_iter().find(|p| {
        p.file_name().and_then(|n| n.to_str()).map(|n| n.starts_with(&prefix)).unwrap_or(false)
    })
}

/// Remove every cached file whose name contains this video id.
pub fn clean_video(dir: &Path, vid: &str) -> usize {
    let mut n = 0;
    for p in entries(dir) {
        if p.file_name().and_then(|s| s.to_str()).map(|s| s.contains(vid)).unwrap_or(false) {
            if fs::remove_file(&p).is_ok() {
                n += 1;
            }
        }
    }
    n
}

/// Remove intermediate thumbnail files for a video (kept out of finished output).
pub fn clean_thumbraw(dir: &Path, vid: &str) {
    let prefix = format!("thumbraw_{vid}");
    for p in entries(dir) {
        if p.file_name().and_then(|s| s.to_str()).map(|s| s.starts_with(&prefix)).unwrap_or(false) {
            let _ = fs::remove_file(&p);
        }
    }
}

pub fn clear_all(dir: &Path) -> usize {
    let mut n = 0;
    for p in entries(dir) {
        if fs::remove_file(&p).is_ok() {
            n += 1;
        }
    }
    n
}
