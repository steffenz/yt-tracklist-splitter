//! Tauri commands invoked from the frontend.

use crate::types::{JobConfig, ParseOptions, Progress, Track, TracklistCandidate, VideoInfo};
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

    // 1. Download (cached).
    emit_progress(&app, "download", "Fetching audio…", 0, 0, 0.0);
    log(&app, format!(">> downloading best audio as {fmt} (cached by video id)"));
    let app2 = app.clone();
    let source = ytdlp::download_audio(&app, &cfg.url, &cfg.video_id, &fmt, &dir, |pct, line| {
        emit_progress(&app2, "download", &line, 0, 0, pct);
    })
    .await?;
    if cancelled() {
        return Err("Cancelled.".into());
    }
    log(&app, format!(">> source ready: {}", source.display()));

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
        let _ = fs::copy(&source, outdir.join(format!("00 - FULL SET.{fmt}")));
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
