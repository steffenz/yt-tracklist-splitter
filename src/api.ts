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
  getThumbnail: (url: string, videoId: string) =>
    invoke<string>("get_thumbnail", { url, videoId }),
  preparePreview: (url: string, videoId: string) =>
    invoke<string>("prepare_preview", { url, videoId }),
  cachedPreview: (videoId: string) => invoke<string | null>("cached_preview", { videoId }),
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
