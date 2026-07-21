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

/// Guess a one-line tracklist for a video that has no tracklist at all (a single song).
#[tauri::command]
pub fn single_track_fallback(title: String, uploader: String) -> String {
    tracklist::single_track_line(&title, &uploader)
}

/// Rewrite one line from the fine-tune editor (time + title + artist) and hand back the
/// new tracklist text, so the raw text remains the single source of truth.
#[tauri::command]
pub fn set_track_fields(
    text: String,
    line: usize,
    seconds: f64,
    title: String,
    artist: String,
) -> Result<String, String> {
    tracklist::set_line_fields(&text, line, seconds, &title, &artist)
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

/// Locate this video's preview file (whatever form it took).
fn preview_path(dir: &std::path::Path, vid: &str) -> Option<PathBuf> {
    ["m4a", "caf"].iter().map(|e| dir.join(format!("preview_{vid}.{e}"))).find(|p| p.exists())
}

/// Waveform for the whole set, drawn from the PREVIEW file so it lines up exactly with
/// what the player is playing. Cached per width.
#[tauri::command]
pub async fn waveform(app: AppHandle, video_id: String, width: u32) -> Result<String, String> {
    let dir = cache::cache_dir(&app)?;
    let src = preview_path(&dir, &video_id).ok_or("no preview prepared yet")?;
    let out = dir.join(format!("wave_{video_id}_{width}.png"));
    media::make_waveform(&app, &src, &out, &format!("{width}x120"), "#8b8ba8", None).await?;
    Ok(out.to_string_lossy().into_owned())
}

/// Zoomed waveform around a boundary, for the fine-tune dialog (~0.02s to render).
#[tauri::command]
pub async fn waveform_window(
    app: AppHandle,
    video_id: String,
    center: f64,
    half: f64,
    width: u32,
) -> Result<String, String> {
    let dir = cache::cache_dir(&app)?;
    let src = preview_path(&dir, &video_id).ok_or("no preview prepared yet")?;
    // The window length MUST be part of the key — otherwise two different zoom levels at
    // the same centre would collide and the cached image would be served for the wrong span.
    let key = (center * 100.0).round() as i64;
    let span = (half * 100.0).round() as i64;
    let out = dir.join(format!("zoom_{video_id}_{key}_{span}_{width}.png"));
    let start = (center - half).max(0.0);
    media::make_waveform(&app, &src, &out, &format!("{width}x110"), "#7c6cff", Some((start, half * 2.0)))
        .await?;
    Ok(out.to_string_lossy().into_owned())
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
    let is_copy = !cfg.precise_cuts
        && ((fmt == "opus" && source_codec == "opus")
            || ((fmt == "m4a" || fmt == "aac") && source_codec == "aac"));
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
    let wanted = cfg.tracks.iter().filter(|t| t.selected).count();
    if wanted == 0 {
        return Err("No tracks selected.".into());
    }
    let pad = total.to_string().len();
    if wanted == total {
        log(&app, format!(">> splitting {total} tracks into {}", outdir.display()));
    } else {
        log(&app, format!(">> splitting {wanted} of {total} tracks into {}", outdir.display()));
    }
    let mut done = 0usize;

    for (i, t) in cfg.tracks.iter().enumerate() {
        if cancelled() {
            return Err("Cancelled.".into());
        }
        let start = t.start;
        // Boundaries always come from the FULL list, so skipping a track never stretches
        // the previous one past where it actually ends.
        let end = if i + 1 < total { cfg.tracks[i + 1].start } else { duration };
        if !t.selected {
            continue; // never invoked -> no ffmpeg work at all
        }
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
        done += 1;
        // Progress counts only the tracks we're actually writing.
        emit_progress(&app, "split", &title, done as u32, wanted as u32, (done as f64 / wanted as f64) * 100.0);
        media::split_track(
            &app,
            &source,
            start,
            end,
            &out,
            &fmt,
            &source_codec,
            cfg.source_abr,
            cfg.precise_cuts,
            t,
            &cfg.album,
            &cfg.album_artist,
            i,
            total,
            cover.as_deref(),
        )
        .await?;
        log(&app, format!("   [{done}/{wanted}] {num} {title}"));
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
