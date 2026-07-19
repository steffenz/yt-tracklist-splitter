use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Comment {
    pub author: String,
    pub text: String,
    pub like_count: i64,
    pub pinned: bool,
    pub favorited: bool,
    pub by_uploader: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct VideoInfo {
    pub id: String,
    pub title: String,
    pub uploader: String,
    pub duration: f64,
    pub thumbnail_url: String,
    pub description: String,
    pub comments: Vec<Comment>,
    /// yt-dlp's native best-audio extension, normalized (opus/m4a/...); used for "native" format.
    pub native_ext: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Track {
    pub start: f64,
    pub title: String,
    pub artist: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TracklistCandidate {
    pub source_label: String,
    pub source_kind: String, // "description" | "comment"
    pub raw_text: String,
    pub tracks: Vec<Track>,
    pub score: f64,
    pub first_ts: f64,
    pub last_ts: f64,
    pub author: String,
    pub like_count: i64,
    pub pinned: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ParseOptions {
    #[serde(default)]
    pub artist_first: bool,
    #[serde(default)]
    pub regex: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CropRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct JobConfig {
    pub url: String,
    pub video_id: String,
    pub tracks: Vec<Track>,
    /// "native" resolves to the source ext; otherwise a concrete ext (m4a/mp3/opus/flac/wav).
    pub audio_format: String,
    pub album: String,
    pub album_artist: String,
    /// "none" | "youtube" | "custom"
    pub cover_mode: String,
    pub custom_image_path: Option<String>,
    /// crop rectangle in SOURCE-image pixels; None = use the whole image.
    pub crop: Option<CropRect>,
    /// square-crop/scale the cover to 1000x1000.
    pub square: bool,
    pub keep_full: bool,
    pub clean_cache: bool,
    pub outdir: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub stage: String,
    pub message: String,
    pub current: u32,
    pub total: u32,
    pub pct: f64,
}
