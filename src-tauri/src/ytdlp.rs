//! yt-dlp sidecar wrappers: video info + comments, audio download, thumbnail.

use crate::types::{Comment, VideoInfo};
use crate::{cache, sh};
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

static PCT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\[download\]\s+([\d.]+)%").unwrap());

fn normalize_ext(ext: &str) -> String {
    match ext.to_lowercase().as_str() {
        "webm" | "opus" | "ogg" => "opus".into(),
        "m4a" | "mp4" | "aac" => "m4a".into(),
        "" => "m4a".into(),
        other => other.into(),
    }
}

/// Pick the best audio-only format's extension from the info JSON's `formats` list.
fn native_ext_from_formats(v: &Value) -> String {
    let Some(formats) = v.get("formats").and_then(|f| f.as_array()) else {
        return "m4a".into();
    };
    let mut best: Option<(f64, String)> = None;
    for f in formats {
        let acodec = f.get("acodec").and_then(|x| x.as_str()).unwrap_or("none");
        let vcodec = f.get("vcodec").and_then(|x| x.as_str()).unwrap_or("none");
        if acodec == "none" || vcodec != "none" {
            continue; // want audio-only
        }
        let rate = f
            .get("abr")
            .and_then(|x| x.as_f64())
            .or_else(|| f.get("tbr").and_then(|x| x.as_f64()))
            .unwrap_or(0.0);
        let ext = f.get("ext").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if best.as_ref().map(|(r, _)| rate > *r).unwrap_or(true) {
            best = Some((rate, ext));
        }
    }
    normalize_ext(&best.map(|(_, e)| e).unwrap_or_default())
}

fn derive_id(v: &Value, url: &str) -> String {
    if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
        if !id.is_empty() {
            return id.to_string();
        }
    }
    static ID_RE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"(?:v=|youtu\.be/|/shorts/)([A-Za-z0-9_-]{6,})").unwrap());
    if let Some(c) = ID_RE.captures(url) {
        return c[1].to_string();
    }
    url.chars().filter(|c| c.is_alphanumeric()).collect::<String>().chars().rev().take(16).collect()
}

fn parse_comments(v: &Value) -> Vec<Comment> {
    let Some(arr) = v.get("comments").and_then(|c| c.as_array()) else {
        return vec![];
    };
    arr.iter()
        .filter(|c| c.get("parent").and_then(|p| p.as_str()).map(|p| p == "root").unwrap_or(true))
        .map(|c| Comment {
            author: c.get("author").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            text: c.get("text").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            like_count: c.get("like_count").and_then(|x| x.as_i64()).unwrap_or(0),
            pinned: c.get("is_pinned").and_then(|x| x.as_bool()).unwrap_or(false),
            favorited: c.get("is_favorited").and_then(|x| x.as_bool()).unwrap_or(false),
            by_uploader: c.get("author_is_uploader").and_then(|x| x.as_bool()).unwrap_or(false),
        })
        .filter(|c| !c.text.trim().is_empty())
        .collect()
}

pub async fn fetch_info(app: &AppHandle, url: &str) -> Result<VideoInfo, String> {
    let (ok, stdout, stderr) = sh::capture(
        app,
        "yt-dlp",
        vec![
            "--no-playlist".into(),
            "--dump-single-json".into(),
            "--write-comments".into(),
            "--extractor-args".into(),
            "youtube:comment_sort=top;max_comments=150,150,0".into(),
            url.into(),
        ],
    )
    .await?;
    if !ok {
        return Err(format!("yt-dlp could not read this URL:\n{}", sh::tail(&stderr, 6)));
    }
    let v: Value = serde_json::from_str(&stdout).map_err(|e| format!("unexpected yt-dlp output: {e}"))?;
    Ok(VideoInfo {
        id: derive_id(&v, url),
        title: v.get("title").and_then(|x| x.as_str()).unwrap_or("Unknown title").to_string(),
        uploader: v
            .get("uploader")
            .and_then(|x| x.as_str())
            .or_else(|| v.get("channel").and_then(|x| x.as_str()))
            .unwrap_or("")
            .to_string(),
        duration: v.get("duration").and_then(|x| x.as_f64()).unwrap_or(0.0),
        thumbnail_url: v.get("thumbnail").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        description: v.get("description").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        comments: parse_comments(&v),
        native_ext: native_ext_from_formats(&v),
    })
}

/// Download best audio, converting to `fmt`, cached by id+format. Emits download
/// percentage through `on_pct`.
pub async fn download_audio<F: FnMut(f64, String)>(
    app: &AppHandle,
    url: &str,
    vid: &str,
    fmt: &str,
    dir: &Path,
    mut on_pct: F,
) -> Result<PathBuf, String> {
    if let Some(p) = cache::cached_source(dir, vid, fmt) {
        return Ok(p);
    }
    let out_tmpl = dir.join(format!("src_{vid}_{fmt}.%(ext)s"));
    let ok = sh::stream(
        app,
        "yt-dlp",
        vec![
            "-f".into(),
            "bestaudio/best".into(),
            "-x".into(),
            "--audio-format".into(),
            fmt.into(),
            "--audio-quality".into(),
            "0".into(),
            "--no-playlist".into(),
            "--newline".into(),
            "-o".into(),
            out_tmpl.to_string_lossy().into_owned(),
            url.into(),
        ],
        |line, _stderr| {
            if let Some(c) = PCT_RE.captures(&line) {
                if let Ok(p) = c[1].parse::<f64>() {
                    on_pct(p, line.trim().to_string());
                }
            }
        },
    )
    .await?;
    if !ok {
        return Err("audio download failed (yt-dlp). Try 'Update yt-dlp'.".into());
    }
    cache::cached_source(dir, vid, fmt).ok_or_else(|| "download produced no file".into())
}

/// Fetch the video thumbnail as a jpg into cache; returns its path.
pub async fn get_thumbnail(app: &AppHandle, url: &str, vid: &str, dir: &Path) -> Result<PathBuf, String> {
    let final_jpg = dir.join(format!("thumbraw_{vid}.jpg"));
    if final_jpg.exists() {
        return Ok(final_jpg);
    }
    let out_tmpl = dir.join(format!("thumbraw_{vid}.%(ext)s"));
    let (ok, _out, stderr) = sh::capture(
        app,
        "yt-dlp",
        vec![
            "--no-playlist".into(),
            "--skip-download".into(),
            "--write-thumbnail".into(),
            "--convert-thumbnails".into(),
            "jpg".into(),
            "-o".into(),
            out_tmpl.to_string_lossy().into_owned(),
            url.into(),
        ],
    )
    .await?;
    if !ok || !final_jpg.exists() {
        return Err(format!("could not fetch thumbnail:\n{}", sh::tail(&stderr, 4)));
    }
    Ok(final_jpg)
}

pub async fn version(app: &AppHandle) -> Result<String, String> {
    let (_ok, out, _err) = sh::capture(app, "yt-dlp", vec!["--version".into()]).await?;
    Ok(out.trim().to_string())
}
