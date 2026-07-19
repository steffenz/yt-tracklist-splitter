//! ffmpeg / ffprobe sidecar wrappers: probe duration, build the cover jpg, and
//! stream-copy each track with tags (mirrors the old CLI's ffmpeg pipeline).

use crate::sh;
use crate::types::{CropRect, Track};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

const COVER_SIZE: i64 = 1000;
const ART_EMBED_OK: [&str; 3] = ["m4a", "mp3", "aac"];

/// Audio codec of a downloaded native file, inferred from its extension.
fn codec_of_ext(p: &Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase().as_str() {
        "m4a" | "mp4" | "aac" => "aac",
        _ => "opus",
    }
}

/// Public: the source codec ("opus" | "aac") of a normalized source file.
pub fn source_codec(p: &Path) -> String {
    codec_of_ext(p).to_string()
}

/// Remux the raw yt-dlp download into a clean canonical container (opus → `.opus`,
/// aac → `.m4a`) with our bundled ffmpeg — a bit-exact stream copy, no re-encode.
/// This mirrors what `yt-dlp -x` used to do, but self-contained, and gives clean
/// per-track slices (direct `-ss` seeking on a raw WebM produces bad granule positions).
pub async fn normalize_source(
    app: &AppHandle,
    raw: &Path,
    vid: &str,
    dir: &Path,
) -> Result<PathBuf, String> {
    let ext = if codec_of_ext(raw) == "aac" { "m4a" } else { "opus" };
    let out = dir.join(format!("src_{vid}_native.{ext}"));
    let (ok, _o, err) = sh::capture(
        app,
        "ffmpeg",
        vec![
            "-y".into(),
            "-hide_banner".into(),
            "-loglevel".into(),
            "error".into(),
            "-i".into(),
            raw.to_string_lossy().into_owned(),
            "-map".into(),
            "0:a".into(),
            "-c:a".into(),
            "copy".into(),
            out.to_string_lossy().into_owned(),
        ],
    )
    .await?;
    if !ok {
        return Err(format!("preparing source failed:\n{}", sh::tail(&err, 4)));
    }
    Ok(out)
}

/// ffmpeg audio-codec args for producing `fmt` from a `source_codec` ("opus"/"aac")
/// source, capping lossy re-encodes at the source bitrate (never encode higher).
fn audio_codec_args(fmt: &str, source_codec: &str, source_abr: f64) -> Vec<String> {
    let cap = if source_abr > 0.0 {
        format!("{}k", source_abr.round() as i64)
    } else {
        "160k".into()
    };
    // Same codec as the source → bit-exact stream copy, no quality loss.
    let copy = (fmt == "opus" && source_codec == "opus")
        || ((fmt == "m4a" || fmt == "aac") && source_codec == "aac");
    if copy {
        return vec!["-c:a".into(), "copy".into()];
    }
    match fmt {
        "mp3" => vec!["-c:a".into(), "libmp3lame".into(), "-b:a".into(), cap],
        "m4a" | "aac" => vec!["-c:a".into(), "aac".into(), "-b:a".into(), cap],
        "opus" => vec!["-c:a".into(), "libopus".into(), "-b:a".into(), cap],
        "flac" => vec!["-c:a".into(), "flac".into()],
        "wav" => vec!["-c:a".into(), "pcm_s16le".into()],
        _ => vec!["-c:a".into(), "copy".into()],
    }
}

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

/// Extract one track from `src` (a normalized `source_codec` file) into `fmt`, tagging it
/// and embedding cover art where the format supports it. Audio is stream-copied when the
/// target matches the source codec, otherwise re-encoded (capped at `source_abr`).
/// Falls back to dropping the art if the primary command fails.
pub async fn split_track(
    app: &AppHandle,
    src: &Path,
    start: f64,
    end: f64,
    out: &Path,
    fmt: &str,
    source_codec: &str,
    source_abr: f64,
    t: &Track,
    album: &str,
    album_artist: &str,
    index: usize,
    total: usize,
    cover: Option<&Path>,
) -> Result<(), String> {
    let meta = meta_args(t, album, album_artist, index, total);
    let codec = audio_codec_args(fmt, source_codec, source_abr);
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
        primary.extend(["-i".into(), cover.to_string_lossy().into_owned()]);
        primary.extend(["-map".into(), "0:a".into(), "-map".into(), "1:0".into()]);
        primary.extend(codec.clone());
        primary.extend([
            "-c:v".into(),
            "mjpeg".into(),
            "-disposition:v".into(),
            "attached_pic".into(),
        ]);
    } else {
        primary.extend(["-map".into(), "0:a".into()]);
        primary.extend(codec.clone());
    }
    primary.extend(meta.clone());
    primary.push(out.to_string_lossy().into_owned());

    let (ok, _o, _e) = sh::capture(app, "ffmpeg", primary).await?;
    if ok {
        return Ok(());
    }

    // Fallback: same codec, but drop the cover art (art embedding is the fragile part).
    let mut fallback = base;
    fallback.extend(["-map".into(), "0:a".into()]);
    fallback.extend(codec);
    fallback.extend(meta);
    fallback.push(out.to_string_lossy().into_owned());
    let (ok2, _o2, err2) = sh::capture(app, "ffmpeg", fallback).await?;
    if !ok2 {
        return Err(format!("failed to write {}:\n{}", out.display(), sh::tail(&err2, 4)));
    }
    Ok(())
}
