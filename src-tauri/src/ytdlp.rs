//! yt-dlp sidecar wrappers: video info + comments, audio download, thumbnail.

use crate::sh;
use crate::types::{Comment, VideoInfo};
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

static PCT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\[download\]\s+([\d.]+)%").unwrap());

/// Directory holding the bundled sidecars. Tauri places them next to the app executable
/// with clean names in BOTH dev (`target/debug/ffmpeg`) and a packaged bundle
/// (`…app/Contents/MacOS/ffmpeg`), so this works in either case.
fn sidecar_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(|p| p.to_path_buf())
}

/// Point yt-dlp at our bundled ffmpeg. A packaged app has no ffmpeg on PATH, which makes
/// yt-dlp's post-processing fail outright and restricts format selection.
fn ffmpeg_location() -> Vec<String> {
    let Some(dir) = sidecar_dir() else { return vec![] };
    let exe = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    if dir.join(exe).exists() {
        vec!["--ffmpeg-location".into(), dir.to_string_lossy().into_owned()]
    } else {
        vec![]
    }
}

/// yt-dlp needs a JavaScript runtime to solve YouTube's JS challenges (without one,
/// extraction is deprecated and some formats go missing). A packaged app gets a minimal
/// PATH, so probe the usual install locations and point yt-dlp at whatever we find.
fn js_runtime() -> Vec<String> {
    let arg = |name: &str, path: &Path| {
        vec!["--js-runtimes".to_string(), format!("{name}:{}", path.display())]
    };
    // 1. shipped next to the app (if we ever bundle one)
    if let Some(dir) = sidecar_dir() {
        for name in ["deno", "node", "bun"] {
            let p = dir.join(name);
            if p.exists() {
                return arg(name, &p);
            }
        }
    }
    // 2. common system install locations
    for (name, path) in [
        ("deno", "/opt/homebrew/bin/deno"),
        ("deno", "/usr/local/bin/deno"),
        ("deno", "/usr/bin/deno"),
        ("node", "/opt/homebrew/bin/node"),
        ("node", "/usr/local/bin/node"),
        ("node", "/usr/bin/node"),
    ] {
        let p = Path::new(path);
        if p.exists() {
            return arg(name, p);
        }
    }
    // 3. per-user deno install
    if let Ok(home) = std::env::var("HOME") {
        let p = PathBuf::from(home).join(".deno/bin/deno");
        if p.exists() {
            return arg("deno", &p);
        }
    }
    vec![]
}

/// Args every yt-dlp invocation should carry so the packaged app behaves like dev.
fn common_args() -> Vec<String> {
    let mut v = ffmpeg_location();
    v.extend(js_runtime());
    v
}

fn normalize_ext(ext: &str) -> String {
    match ext.to_lowercase().as_str() {
        "webm" | "opus" | "ogg" => "opus".into(),
        "m4a" | "mp4" | "aac" => "m4a".into(),
        "" => "m4a".into(),
        other => other.into(),
    }
}

/// Pick the best audio-only format from the info JSON's `formats` list,
/// returning its normalized extension and bitrate (kbps, 0 if unknown).
fn native_audio(v: &Value) -> (String, f64) {
    let Some(formats) = v.get("formats").and_then(|f| f.as_array()) else {
        return ("m4a".into(), 0.0);
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
    match best {
        Some((rate, ext)) => (normalize_ext(&ext), rate),
        None => ("m4a".into(), 0.0),
    }
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
    let mut args = vec![
        "--no-playlist".to_string(),
        "--dump-single-json".into(),
        "--write-comments".into(),
        "--extractor-args".into(),
        "youtube:comment_sort=top;max_comments=150,150,0".into(),
    ];
    args.extend(common_args());
    args.push(url.into());
    let (ok, stdout, stderr) = sh::capture(app, "yt-dlp", args).await?;
    if !ok {
        return Err(format!("yt-dlp could not read this URL:\n{}", sh::tail(&stderr, 6)));
    }
    let v: Value = serde_json::from_str(&stdout).map_err(|e| format!("unexpected yt-dlp output: {e}"))?;
    let (native_ext, native_abr) = native_audio(&v);
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
        native_ext,
        native_abr,
    })
}

/// Download the best audio in its NATIVE container (no `-x`, so yt-dlp needs no ffmpeg
/// — the shipped app has none on PATH). Format conversion is done later by our bundled
/// ffmpeg. Returns the raw file path (e.g. `raw_<id>.webm`). Emits download % via `on_pct`.
pub async fn download_native<F: FnMut(f64, String)>(
    app: &AppHandle,
    url: &str,
    vid: &str,
    dir: &Path,
    mut on_pct: F,
) -> Result<PathBuf, String> {
    let out_tmpl = dir.join(format!("raw_{vid}.%(ext)s"));
    let mut errbuf = String::new();
    let mut args = vec![
        "-f".to_string(),
        "bestaudio/best".into(),
        "--no-playlist".into(),
        "--newline".into(),
    ];
    args.extend(common_args());
    args.extend(["-o".to_string(), out_tmpl.to_string_lossy().into_owned(), url.into()]);
    let ok = sh::stream(
        app,
        "yt-dlp",
        args,
        |line, is_err| {
            if let Some(c) = PCT_RE.captures(&line) {
                if let Ok(p) = c[1].parse::<f64>() {
                    on_pct(p, line.trim().to_string());
                }
            }
            if is_err {
                errbuf.push_str(&line);
                errbuf.push('\n');
            }
        },
    )
    .await?;
    if !ok {
        return Err(format!(
            "audio download failed (yt-dlp):\n{}\nYouTube may have changed — a newer app build with an updated yt-dlp usually fixes it.",
            sh::tail(&errbuf, 8)
        ));
    }
    let prefix = format!("raw_{vid}.");
    std::fs::read_dir(dir)
        .ok()
        .and_then(|rd| {
            rd.filter_map(|e| e.ok().map(|e| e.path())).find(|p| {
                p.file_name().and_then(|n| n.to_str()).map(|n| n.starts_with(&prefix)).unwrap_or(false)
            })
        })
        .ok_or_else(|| "download produced no file".into())
}

/// Find an already-downloaded thumbnail for this video, whatever extension it has.
fn find_thumbnail(dir: &Path, vid: &str) -> Option<PathBuf> {
    let prefix = format!("thumbraw_{vid}.");
    std::fs::read_dir(dir).ok()?.filter_map(|e| e.ok().map(|e| e.path())).find(|p| {
        p.file_name().and_then(|n| n.to_str()).map(|n| n.starts_with(&prefix)).unwrap_or(false)
    })
}

/// Fetch the video thumbnail into cache (in whatever format YouTube serves — usually
/// webp). We deliberately do NOT use yt-dlp's `--convert-thumbnails`: that's an ffmpeg
/// post-processor, and our own ffmpeg converts it while cropping the cover anyway.
pub async fn get_thumbnail(app: &AppHandle, url: &str, vid: &str, dir: &Path) -> Result<PathBuf, String> {
    if let Some(p) = find_thumbnail(dir, vid) {
        return Ok(p);
    }
    let out_tmpl = dir.join(format!("thumbraw_{vid}.%(ext)s"));
    let mut args = vec![
        "--no-playlist".to_string(),
        "--skip-download".into(),
        "--write-thumbnail".into(),
    ];
    args.extend(common_args());
    args.extend(["-o".to_string(), out_tmpl.to_string_lossy().into_owned(), url.into()]);
    let (_ok, _out, stderr) = sh::capture(app, "yt-dlp", args).await?;
    find_thumbnail(dir, vid)
        .ok_or_else(|| format!("could not fetch thumbnail:\n{}", sh::tail(&stderr, 4)))
}

pub async fn version(app: &AppHandle) -> Result<String, String> {
    let (_ok, out, _err) = sh::capture(app, "yt-dlp", vec!["--version".into()]).await?;
    Ok(out.trim().to_string())
}
