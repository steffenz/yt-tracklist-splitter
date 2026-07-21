import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface Comment {
  author: string;
  text: string;
  like_count: number;
  pinned: boolean;
  favorited: boolean;
  by_uploader: boolean;
}

export interface VideoInfo {
  id: string;
  title: string;
  uploader: string;
  duration: number;
  thumbnail_url: string;
  description: string;
  comments: Comment[];
  native_ext: string;
  native_abr: number;
}

export interface Track {
  start: number;
  title: string;
  artist: string;
  /** Deselected tracks are skipped entirely (no ffmpeg run for them). */
  selected: boolean;
  /** 0-based source line, so the fine-tune editor can rewrite that exact line. */
  line: number;
}

export interface TracklistCandidate {
  source_label: string;
  source_kind: string;
  raw_text: string;
  tracks: Track[];
  score: number;
  first_ts: number;
  last_ts: number;
  author: string;
  like_count: number;
  pinned: boolean;
}

export interface ParseOptions {
  artist_first: boolean;
  regex: string | null;
}

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface JobConfig {
  url: string;
  video_id: string;
  tracks: Track[];
  audio_format: string;
  source_abr: number;
  /** Force re-encoding for sample-accurate cut boundaries. */
  precise_cuts: boolean;
  album: string;
  album_artist: string;
  cover_mode: "none" | "youtube" | "custom";
  custom_image_path: string | null;
  crop: CropRect | null;
  square: boolean;
  keep_full: boolean;
  clean_cache: boolean;
  outdir: string;
}

export interface PreviewInfo {
  path: string;
  /** True only when the preview was re-encoded (mono, reduced quality). */
  encoded: boolean;
}

export interface Progress {
  stage: string;
  message: string;
  current: number;
  total: number;
  pct: number;
}

export const api = {
  fetchInfo: (url: string) => invoke<VideoInfo>("fetch_info", { url }),
  detect: (info: VideoInfo) => invoke<TracklistCandidate[]>("detect_tracklists", { info }),
  parse: (text: string, opts: ParseOptions) => invoke<Track[]>("parse_tracklist", { text, opts }),
  setTrackFields: (text: string, line: number, seconds: number, title: string, artist: string) =>
    invoke<string>("set_track_fields", { text, line, seconds, title, artist }),
  singleTrackFallback: (title: string, uploader: string) =>
    invoke<string>("single_track_fallback", { title, uploader }),
  getThumbnail: (url: string, videoId: string) =>
    invoke<string>("get_thumbnail", { url, videoId }),
  preparePreview: (url: string, videoId: string, forceEncode: boolean) =>
    invoke<PreviewInfo>("prepare_preview", { url, videoId, forceEncode }),
  cachedPreview: (videoId: string) => invoke<PreviewInfo | null>("cached_preview", { videoId }),
  waveform: (videoId: string, width: number) => invoke<string>("waveform", { videoId, width }),
  waveformWindow: (videoId: string, center: number, half: number, width: number) =>
    invoke<string>("waveform_window", { videoId, center, half, width }),
  defaultOutputDir: (album: string) => invoke<string>("default_output_dir", { album }),
  ytdlpVersion: () => invoke<string>("ytdlp_version"),
  clearCache: () => invoke<number>("clear_cache"),
  cacheSize: () => invoke<number>("cache_size"),
  cancel: () => invoke<void>("cancel_job"),
  runJob: (cfg: JobConfig) => invoke<string>("run_job", { cfg }),
};

export const onProgress = (cb: (p: Progress) => void): Promise<UnlistenFn> =>
  listen<Progress>("job-progress", (e) => cb(e.payload));

export const onLog = (cb: (line: string) => void): Promise<UnlistenFn> =>
  listen<string>("job-log", (e) => cb(e.payload));
