#!/usr/bin/env node
// Download the yt-dlp / ffmpeg / ffprobe sidecars for the HOST platform into
// src-tauri/binaries/, named `<tool>-<rust-target-triple>` as Tauri's externalBin
// expects. Runs the same on macOS / Windows / Linux, so it works both locally and
// on each GitHub Actions runner. Override the target with: node fetch-binaries.mjs <key>
// where <key> is one of: darwin-arm64 darwin-x64 linux-x64 linux-arm64 win32-x64

import { createWriteStream } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const FFMPEG_TAG = "b6.1.1"; // eugeneware/ffmpeg-static

// key -> { triple, exe, ytdlp asset }. `ffmpeg`/`ffprobe` assets are `<tool>-<key>`.
const TARGETS = {
  "darwin-arm64": { triple: "aarch64-apple-darwin", exe: "", ytdlp: "yt-dlp_macos" },
  "darwin-x64": { triple: "x86_64-apple-darwin", exe: "", ytdlp: "yt-dlp_macos" },
  "linux-x64": { triple: "x86_64-unknown-linux-gnu", exe: "", ytdlp: "yt-dlp_linux" },
  "linux-arm64": { triple: "aarch64-unknown-linux-gnu", exe: "", ytdlp: "yt-dlp_linux_aarch64" },
  "win32-x64": { triple: "x86_64-pc-windows-msvc", exe: ".exe", ytdlp: "yt-dlp.exe" },
};

const hostKey = () => {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const key = `${process.platform}-${arch}`;
  if (!TARGETS[key]) throw new Error(`unsupported host: ${key}`);
  return key;
};

const key = process.argv[2] || hostKey();
const t = TARGETS[key];
if (!t) throw new Error(`unknown target '${key}'. Options: ${Object.keys(TARGETS).join(", ")}`);

const binDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "binaries");

const YTDLP_URL = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${t.ytdlp}`;
const FF = (tool) =>
  `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_TAG}/${tool}-${key}`;

const jobs = [
  { url: YTDLP_URL, out: `yt-dlp-${t.triple}${t.exe}` },
  { url: FF("ffmpeg"), out: `ffmpeg-${t.triple}${t.exe}` },
  { url: FF("ffprobe"), out: `ffprobe-${t.triple}${t.exe}` },
];

async function download({ url, out }) {
  const dest = join(binDir, out);
  process.stdout.write(`  ${out} … `);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  if (t.exe === "") await chmod(dest, 0o755);
  console.log("ok");
}

console.log(`Fetching sidecars for ${key} (${t.triple}) into src-tauri/binaries/`);
await mkdir(binDir, { recursive: true });
for (const job of jobs) await download(job);
console.log("Done.");
