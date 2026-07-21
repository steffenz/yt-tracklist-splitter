//! Tauri commands invoked from the frontend.

use crate::types::{
    JobConfig, ParseOptions, PreviewInfo, Progress, Track, TracklistCandidate, VideoInfo,
};
use crate::{cache, media, tracklist, ytdlp, AppState};
use once_cell::sync::Lazy;
use regex::Regex;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager, State};

static SANITIZE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"[/\\:*?"<>|]"#).unwrap());

fn sanitize(name: &str) -> String {
    let s = SANITIZE_RE.replace_all(name, "_").trim().to_string();
    if s.is_empty() {
        "track".into()
    } else {
        s
    }
}

fn emit_progress(app: &AppHandle, stage: &str, message: &str, current: u32, total: u32, pct: f64) {
    let _ = app.emit(
        "job-progress",
        Progress {
            stage: stage.into(),
            message: message.into(),
            current,
            total,
            pct,
        },
    );
}

fn log(app: &AppHandle, msg: impl Into<String>) {
    let _ = app.emit("job-log", msg.into());
}

#[tauri::command]
pub async fn fetch_info(app: AppHandle, url: String) -> Result<VideoInfo, String> {
    ytdlp::fetch_info(&app, url.trim()).await
}

#[tauri::command]
pub fn detect_tracklists(info: VideoInfo) -> Vec<TracklistCandidate> {
    tracklist::detect(&info)
}

#[tauri::command]
pub fn parse_tracklist(text: String, opts: ParseOptions) -> Result<Vec<Track>, String> {
    tracklist::parse(&text, &opts)
}

/// Fetch the thumbnail and return a filesystem path (frontend converts to an asset URL).
#[tauri::command]
pub async fn get_thumbnail(app: AppHandle, url: String, video_id: String) -> Result<String, String> {
    let dir = cache::cache_dir(&app)?;
    let p = ytdlp::get_thumbnail(&app, url.trim(), &video_id, &dir).await?;
    Ok(p.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn default_output_dir(app: AppHandle, album: String) -> Result<String, String> {
    let base = app
        .path()
        .download_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| e.to_string())?;
    Ok(base.join("Albums").join(sanitize(&album)).to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn ytdlp_version(app: AppHandle) -> Result<String, String> {
    ytdlp::version(&app).await
}

/// Download the native audio (if not cached) and normalize it. Shared by the preview
/// button and the split job, so preparing a preview also warms the cache and makes the
/// subsequent split skip the download entirely.
async fn ensure_source(
    app: &AppHandle,
    url: &str,
    vid: &str,
    dir: &std::path::Path,
) -> Result<PathBuf, String> {
    if let Some(p) = cache::cached_source(dir, vid, "native") {
        return Ok(p);
    }
    let app2 = app.clone();
    let raw = ytdlp::download_native(app, url, vid, dir, |pct, line| {
        emit_progress(&app2, "download", &line, 0, 0, pct);
    })
    .await?;
    emit_progress(app, "download", "Preparing source…", 0, 0, 100.0);
    let native = media::normalize_source(app, &raw, vid, dir).await?;
    let _ = fs::remove_file(&raw);
    Ok(native)
}

/// Fetch (and cache) the audio, then produce a playable preview file. Returns its path.
#[tauri::command]
pub async fn prepare_preview(
    app: AppHandle,
    url: String,
    video_id: String,
    force_encode: bool,
) -> Result<PreviewInfo, String> {
    let dir = cache::cache_dir(&app)?;
    let cached = cache::cached_source(&dir, &video_id, "native").is_some();
    log(&app, if cached { ">> using cached audio" } else { ">> downloading audio…" });
    emit_progress(&app, "download", "Downloading audio…", 0, 0, 0.0);
    let source = ensure_source(&app, url.trim(), &video_id, &dir).await?;

    emit_progress(&app, "preview", "Preparing preview…", 0, 0, 0.0);
    let app2 = app.clone();
    let preview = media::make_preview(&app, &source, &video_id, &dir, force_encode, |pct| {
        emit_progress(&app2, "preview", "Converting to preview format…", 0, 0, pct);
    })
    .await?;
    let encoded = is_encoded(&preview, &source);
    log(
        &app,
        if encoded {
            ">> preview converted (audio cached — the split will reuse it)"
        } else {
            ">> preview ready instantly, full quality (audio cached — the split will reuse it)"
        },
    );
    Ok(PreviewInfo { path: preview.to_string_lossy().into_owned(), encoded })
}

/// A preview is "encoded" (quality-reduced) only when we re-encoded an Opus source into
/// m4a. Stream-copied previews (.caf, or m4a from an AAC source) are bit-exact.
fn is_encoded(preview: &std::path::Path, source: &std::path::Path) -> bool {
    preview.extension().and_then(|e| e.to_str()) == Some("m4a")
        && media::source_codec(source) != "aac"
}

/// An already-prepared preview, if one exists (so we can auto-load it). Prefers a
/// previously-encoded m4a, since its playability is already proven on this machine.
#[tauri::command]
pub fn cached_preview(app: AppHandle, video_id: String) -> Result<Option<PreviewInfo>, String> {
    let dir = cache::cache_dir(&app)?;
    let source = cache::cached_source(&dir, &video_id, "native");
    for ext in ["m4a", "caf"] {
        let p = dir.join(format!("preview_{video_id}.{ext}"));
        if p.exists() {
            let encoded = source.as_deref().map(|s| is_encoded(&p, s)).unwrap_or(false);
            return Ok(Some(PreviewInfo { path: p.to_string_lossy().into_owned(), encoded }));
        }
    }
    Ok(None)
}

/// Total bytes currently held in the cache (shown next to "Clear cache").
#[tauri::command]
pub fn cache_size(app: AppHandle) -> Result<u64, String> {
    let dir = cache::cache_dir(&app)?;
    Ok(cache::total_size(&dir))
}

#[tauri::command]
pub fn clear_cache(app: AppHandle) -> Result<usize, String> {
    let dir = cache::cache_dir(&app)?;
    Ok(cache::clear_all(&dir))
}

#[tauri::command]
pub fn cancel_job(state: State<AppState>) {
    state.cancel.store(true, Ordering::SeqCst);
    if let Some(child) = state.current_child.lock().unwrap().take() {
        let _ = child.kill();
    }
}

#[tauri::command]
pub async fn run_job(
    app: AppHandle,
    state: State<'_, AppState>,
    cfg: JobConfig,
) -> Result<String, String> {
    state.cancel.store(false, Ordering::SeqCst);
    let cancelled = || state.cancel.load(Ordering::SeqCst);

    if cfg.tracks.is_empty() {
        return Err("No tracks to split.".into());
    }
    let fmt = cfg.audio_format.to_lowercase();
    let dir = cache::cache_dir(&app)?;

    // 1. Download native audio once (cached), then normalize with our bundled ffmpeg.
    emit_progress(&app, "download", "Fetching audio…", 0, 0, 0.0);
    let had_cache = cache::cached_source(&dir, &cfg.video_id, "native").is_some();
    if had_cache {
        log(&app, ">> using cached source (no download needed)");
    }
    let source = match ensure_source(&app, &cfg.url, &cfg.video_id, &dir).await {
        Ok(p) => p,
        Err(e) => return Err(if cancelled() { "Cancelled.".into() } else { e }),
    };
    if cancelled() {
        return Err("Cancelled.".into());
    }
    let source_codec = media::source_codec(&source);
    let is_copy = (fmt == "opus" && source_codec == "opus")
        || ((fmt == "m4a" || fmt == "aac") && source_codec == "aac");
    let out_note = if is_copy {
        " (stream copy, no re-encode)".to_string()
    } else if fmt == "flac" || fmt == "wav" {
        " (lossless/uncompressed)".to_string()
    } else if cfg.source_abr > 0.0 {
        format!(" @ ~{} kbps (capped to source)", cfg.source_abr.round() as i64)
    } else {
        String::new()
    };
    log(&app, format!(">> source ready ({source_codec}); output {fmt}{out_note}"));

    // 2. Cover.
    let mut cover: Option<PathBuf> = None;
    if cfg.cover_mode != "none" {
        emit_progress(&app, "cover", "Preparing cover art…", 0, 0, 0.0);
        let src_img: PathBuf = if cfg.cover_mode == "custom" {
            cfg.custom_image_path
                .as_ref()
                .map(PathBuf::from)
                .ok_or("custom cover selected but no image provided")?
        } else {
            ytdlp::get_thumbnail(&app, &cfg.url, &cfg.video_id, &dir).await?
        };
        let out_cover = dir.join(format!("cover_{}.jpg", cfg.video_id));
        media::make_cover(&app, &src_img, &out_cover, &cfg.crop, cfg.square).await?;
        cover = Some(out_cover);
        log(&app, ">> cover art ready");
    }
    if cancelled() {
        return Err("Cancelled.".into());
    }

    // 3. Split.
    let duration = media::duration(&app, &source).await?;
    let outdir = PathBuf::from(&cfg.outdir);
    fs::create_dir_all(&outdir).map_err(|e| format!("cannot create output folder: {e}"))?;
    let total = cfg.tracks.len();
    let pad = total.to_string().len();
    log(&app, format!(">> splitting {total} tracks into {}", outdir.display()));

    for (i, t) in cfg.tracks.iter().enumerate() {
        if cancelled() {
            return Err("Cancelled.".into());
        }
        let start = t.start;
        let end = if i + 1 < total { cfg.tracks[i + 1].start } else { duration };
        if end <= start {
            log(&app, format!("!! skipping '{}' (non-positive length)", t.title));
            continue;
        }
        let num = format!("{:0width$}", i + 1, width = pad);
        let title = if t.title.is_empty() { format!("Track {num}") } else { t.title.clone() };
        let mut base = format!("{num} - {}", sanitize(&title));
        if !t.artist.is_empty() {
            base.push_str(&format!(" - {}", sanitize(&t.artist)));
        }
        let out = outdir.join(format!("{base}.{fmt}"));
        emit_progress(
            &app,
            "split",
            &title,
            (i + 1) as u32,
            total as u32,
            ((i + 1) as f64 / total as f64) * 100.0,
        );
        media::split_track(
            &app,
            &source,
            start,
            end,
            &out,
            &fmt,
            &source_codec,
            cfg.source_abr,
            t,
            &cfg.album,
            &cfg.album_artist,
            i,
            total,
            cover.as_deref(),
        )
        .await?;
        log(&app, format!("   [{}/{}] {title}", i + 1, total));
    }

    // 4. Finish: folder cover, optional full set, cleanup.
    if let Some(c) = &cover {
        let _ = fs::copy(c, outdir.join("cover.jpg"));
        log(&app, ">> wrote cover.jpg");
    }
    if cfg.keep_full {
        let ext = source.extension().and_then(|e| e.to_str()).unwrap_or("m4a");
        let _ = fs::copy(&source, outdir.join(format!("00 - FULL SET.{ext}")));
        log(&app, ">> kept full set");
    }
    cache::clean_thumbraw(&dir, &cfg.video_id);
    if cfg.clean_cache {
        let n = cache::clean_video(&dir, &cfg.video_id);
        log(&app, format!(">> cleaned {n} cached file(s)"));
    }

    emit_progress(&app, "done", "Done", total as u32, total as u32, 100.0);
    log(&app, ">> done.");
    Ok(outdir.to_string_lossy().into_owned())
}
