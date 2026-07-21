# 🎧 yt-tracklist-splitter

A small cross-platform **desktop app** (Tauri) that downloads a YouTube **DJ set /
compilation** at the highest available audio quality and slices it into clean, tagged
per-track files — with proper album art — ready to drop straight into Navidrome,
Symfonium, Plex, or any music library.

Built for the "one long mix, tracklist in the description (or a comment)" problem — and
now with a GUI so you can review and adjust everything **before** you run the job.

---

## ⚠️ Personal use only

This is a **personal utility for private use**, intended solely for downloading and
splitting content **you already own or otherwise have the right to download** (e.g. your
own uploads, or material that is explicitly free of restrictions).

- **Do not** use it for copyrighted material you don't have the rights to, and don't
  redistribute anything you produce with it.
- Downloading from YouTube may conflict with YouTube's Terms of Service; you are
  responsible for ensuring your use is lawful in your jurisdiction and for the content in
  question.
- No warranty. The authors take no responsibility for how the tool is used — using it is
  entirely at your own risk.

---

## What it does

- **Auto-finds the tracklist.** Scans the video **description and comments** and ranks
  the blocks that look like a tracklist, resilient to the many real-world layouts
  (`mm:ss - Title - Artist`, `mm:ss Artist - Title`, `[mm:ss] Title`, `1. mm:ss …`,
  timestamp-at-end, …). Pick the right one, or paste your own — it parses live as you
  type. Clear feedback when there are several candidates or none.
- **Interactive album art.** Shows the video thumbnail with a **draggable, resizable
  crop box** (default: centered square, 1000×1000). Or **drag-and-drop your own image**
  anywhere in the window to use it instead.
- **Highest quality, no waste.** Grabs the best audio stream YouTube offers (usually
  ~160 kbps Opus) and, by default, **keeps it in its native format** — no transcoding,
  no generation loss. Splitting is `ffmpeg` stream-copy, so each track is a bit-exact
  slice of the source. Optional conversion to `m4a`/`mp3`/`opus`/`flac`/`wav` if you
  need a specific format.
- **Proper tags + cover.** Every track gets title, artist, track number, **album**
  (= the video title), **album-artist** (= the channel). Cover art is embedded where
  reliable (m4a/mp3) **and** always written as a folder `cover.jpg` — the
  format-agnostic way Navidrome and most players actually read album art.
- **You pick where it lands**, and it **doesn't leave a mess**: downloads are cached in
  the OS app-cache directory (not your project), reused across re-runs, and cleanable
  with one click.

---

## Requirements

Nothing to install to *use* the app — `yt-dlp` and `ffmpeg`/`ffprobe` are **bundled**.

To build from source you need:

- [Rust](https://rustup.rs) (stable)
- [Node.js](https://nodejs.org) 18+
- Platform toolchain for Tauri v2 (Xcode CLT on macOS; `webkit2gtk-4.1` + build
  essentials on Linux; MSVC + WebView2 on Windows — see the
  [Tauri prerequisites](https://tauri.app/start/prerequisites/)).

---

## Run it (development)

```bash
npm install
npm run fetch-binaries   # download yt-dlp/ffmpeg/ffprobe sidecars for your OS
npm run tauri dev
```

## Build an installer

```bash
npm run fetch-binaries   # if you haven't already
npm run tauri build
```

Produces a native bundle for the current OS (`.dmg`/`.app` on macOS, `.msi` on Windows,
`.AppImage`/`.deb` on Linux) under `src-tauri/target/release/bundle/`.

> **Sidecars are not committed.** The `yt-dlp`, `ffmpeg`, and `ffprobe` binaries are
> downloaded on demand by `npm run fetch-binaries` into `src-tauri/binaries/`,
> named `<tool>-<target-triple>` as Tauri expects. The script auto-detects your OS/arch;
> re-run it any time to refresh yt-dlp. Pass a target key to fetch another platform's set
> (e.g. `node scripts/fetch-binaries.mjs win32-x64`).

## Releasing (DMG / MSI / AppImage via GitHub Actions)

Installers are built on GitHub's runners, not your machine — [`.github/workflows/release.yml`](.github/workflows/release.yml)
builds macOS (Apple Silicon), Windows, and Linux in parallel and attaches the bundles to a
**draft GitHub Release**.

1. Bump `version` in `src-tauri/tauri.conf.json`.
2. Push a tag: `git tag v0.1.0 && git push origin v0.1.0` (or run the workflow manually
   from the **Actions** tab).
3. Go to **Releases**, open the draft, and click **Publish release** — until you publish,
   the files are visible only to you and aren't publicly downloadable.

Each runner fetches its own sidecars, so nothing binary lives in the repo. Builds are
**unsigned** — macOS users right-click → *Open* on first launch (or add Apple signing
secrets + notarization to the workflow later).

> **No Intel-mac build.** GitHub retired the free Intel macOS runners (`macos-13`); a job
> requesting one queues forever rather than failing. Supporting Intel Macs would mean a
> universal (`universal-apple-darwin`) build, which also needs `lipo`-merged universal
> ffmpeg/ffprobe sidecars. Apple-Silicon-only is usually fine for a personal tool.

---

## Using it

1. **Paste a URL** and hit *Fetch*. The app pulls video info + comments and shows the
   thumbnail.
2. **Pick a tracklist** from the detected candidates (or paste/edit your own). Toggle
   "Artist appears before title" if the layout is `Artist - Title`; drop to a custom
   regex (named groups `ts`, `title`, `artist`) for anything exotic.
3. **Adjust the cover** crop, or drag in your own image. Toggle square vs. free crop, or
   choose *No cover art*.
4. **Set options** — format, album/album-artist overrides, keep-full, and the output
   folder.
5. **Split it.** Watch live progress; *Reveal in Finder/Explorer* when done.

Output lands in `<your folder>/<album>/`, containing numbered, tagged tracks plus
`cover.jpg`.

---

## Notes on quality

YouTube's best audio is roughly **160 kbps Opus** — there is no lossless tier for normal
videos. **Native format is best** (zero re-encoding loss); forcing FLAC gains you nothing
and just makes bigger files. If you need compatibility, `m4a` (AAC) is a reasonable lossy
choice.

## Album art & Navidrome

The reliable path is the folder **`cover.jpg`**, which the app always writes. If Navidrome
doesn't show it: trigger a full rescan, and set `ND_COVERARTPRIORITY` to prefer external
files (e.g. `cover.*, folder.*, front.*, embedded`).

## Keeping yt-dlp fresh

Most "it suddenly stopped working" issues are YouTube changing something and a stale
`yt-dlp`. `yt-dlp` is bundled with the app, so to refresh it, **install a newer app
release** — each CI build re-fetches the latest `yt-dlp` at bundle time. (An installed
app can't self-update its own bundled binary: it lives inside the app bundle, which is
read-only/admin-owned and, once signed, can't be modified without breaking the
signature.) For local development, just re-run `npm run fetch-binaries`.

---

## License

Personal utility — use and modify freely, subject to the **Personal use only** note at
the top. Provided as-is, without warranty of any kind.
