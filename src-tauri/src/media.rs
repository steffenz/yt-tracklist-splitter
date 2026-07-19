//! ffmpeg / ffprobe sidecar wrappers: probe duration, build the cover jpg, and
//! stream-copy each track with tags (mirrors the old CLI's ffmpeg pipeline).

use crate::sh;
use crate::types::{CropRect, Track};
use std::path::Path;
use tauri::AppHandle;

const COVER_SIZE: i64 = 1000;
const ART_EMBED_OK: [&str; 3] = ["m4a", "mp3", "aac"];

pub async fn duration(app: &AppHandle, path: &Path) -> Result<f64, String> {
    let (ok, out, err) = sh::capture(
        app,
        "ffprobe",
        vec![
            "-v".into(),
            "error".into(),
            "-show_entries".into(),
            "format=duration".into(),
            "-of".into(),
            "default=nk=1:nw=1".into(),
            path.to_string_lossy().into_owned(),
        ],
    )
    .await?;
    if !ok {
        return Err(format!("ffprobe failed:\n{}", sh::tail(&err, 4)));
    }
    out.trim().parse::<f64>().map_err(|_| "could not read source duration".into())
}

fn cover_vf(crop: &Option<CropRect>, square: bool) -> String {
    let s = COVER_SIZE;
    match (crop, square) {
        (Some(c), true) => format!(
            "crop={}:{}:{}:{},scale={s}:{s}",
            c.w as i64, c.h as i64, c.x as i64, c.y as i64
        ),
        (Some(c), false) => format!(
            "crop={}:{}:{}:{},scale='min({s},iw)':-2",
            c.w as i64, c.h as i64, c.x as i64, c.y as i64
        ),
        (None, true) => format!("crop='min(iw,ih)':'min(iw,ih)',scale={s}:{s}"),
        (None, false) => format!("scale='min({s},iw)':-2"),
    }
}

/// Produce `out_jpg` from `src_img`, applying the crop rectangle + optional square scale.
pub async fn make_cover(
    app: &AppHandle,
    src_img: &Path,
    out_jpg: &Path,
    crop: &Option<CropRect>,
    square: bool,
) -> Result<(), String> {
    let (ok, _o, err) = sh::capture(
        app,
        "ffmpeg",
        vec![
            "-y".into(),
            "-hide_banner".into(),
            "-loglevel".into(),
            "error".into(),
            "-i".into(),
            src_img.to_string_lossy().into_owned(),
            "-vf".into(),
            cover_vf(crop, square),
            "-frames:v".into(),
            "1".into(),
            out_jpg.to_string_lossy().into_owned(),
        ],
    )
    .await?;
    if !ok {
        return Err(format!("cover render failed:\n{}", sh::tail(&err, 4)));
    }
    Ok(())
}

fn meta_args(t: &Track, album: &str, album_artist: &str, index: usize, total: usize) -> Vec<String> {
    let title = if t.title.is_empty() { format!("Track {}", index + 1) } else { t.title.clone() };
    vec![
        "-metadata".into(),
        format!("title={title}"),
        "-metadata".into(),
        format!("artist={}", t.artist),
        "-metadata".into(),
        format!("album={album}"),
        "-metadata".into(),
        format!("album_artist={album_artist}"),
        "-metadata".into(),
        format!("track={}/{}", index + 1, total),
    ]
}

/// Extract one track via stream-copy with tags, embedding cover art where the format
/// supports it. Falls back to a re-mux (no `-c copy`) if the copy fails, matching the CLI.
pub async fn split_track(
    app: &AppHandle,
    src: &Path,
    start: f64,
    end: f64,
    out: &Path,
    fmt: &str,
    t: &Track,
    album: &str,
    album_artist: &str,
    index: usize,
    total: usize,
    cover: Option<&Path>,
) -> Result<(), String> {
    let meta = meta_args(t, album, album_artist, index, total);
    let embed_art = cover.is_some() && ART_EMBED_OK.contains(&fmt);
    let base = vec![
        "-y".to_string(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-ss".into(),
        format!("{start:.3}"),
        "-to".into(),
        format!("{end:.3}"),
        "-i".into(),
        src.to_string_lossy().into_owned(),
    ];

    let mut primary = base.clone();
    if embed_art {
        let cover = cover.unwrap();
        primary.extend([
            "-i".into(),
            cover.to_string_lossy().into_owned(),
            "-map".into(),
            "0:a".into(),
            "-map".into(),
            "1:0".into(),
            "-c:a".into(),
            "copy".into(),
            "-c:v".into(),
            "mjpeg".into(),
            "-disposition:v".into(),
            "attached_pic".into(),
        ]);
    } else {
        primary.extend(["-map".into(), "0:a".into(), "-c".into(), "copy".into()]);
    }
    primary.extend(meta.clone());
    primary.push(out.to_string_lossy().into_owned());

    let (ok, _o, _e) = sh::capture(app, "ffmpeg", primary).await?;
    if ok {
        return Ok(());
    }

    // Fallback: re-mux the audio without stream-copy (drops art), like the CLI's last resort.
    let mut fallback = base;
    fallback.extend(["-map".into(), "0:a".into()]);
    fallback.extend(meta);
    fallback.push(out.to_string_lossy().into_owned());
    let (ok2, _o2, err2) = sh::capture(app, "ffmpeg", fallback).await?;
    if !ok2 {
        return Err(format!("failed to write {}:\n{}", out.display(), sh::tail(&err2, 4)));
    }
    Ok(())
}
