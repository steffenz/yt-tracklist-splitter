# 🎧 split-set

Download a YouTube **DJ set** or **compilation** at the highest available audio
quality and slice it into clean, tagged per-track files — with proper album art —
ready to drop straight into Navidrome, Symfonium, Plex, or any music library.

Built for the "one long mix, tracklist in the description" problem.

---

## What it does

- **Highest quality, no waste.** Grabs the best audio stream YouTube offers
  (usually ~160 kbps Opus) and, by default, **keeps it in its native format** —
  no transcoding, no generation loss, no pointless FLAC bloat. Splitting is done
  with `ffmpeg` stream-copy, so each track is a bit-exact slice of the source.
- **Tracklist-driven splitting.** Cuts the set into tracks using a simple
  `mm:ss - Title - Artist` tracklist. Bring your own file, or try to pull it from
  the video description.
- **Proper tags.** Every track gets title, artist, track number, **album**
  (= the video title), and **album-artist** (= the channel).
- **Album cover art.** Uses the video thumbnail, **center-cropped to a square**
  (1000×1000) so it doesn't look stretched or letterboxed in music players.
  Embeds it where reliable (m4a/mp3) **and** always drops a `cover.jpg` in the
  album folder — which is the format-agnostic way that Navidrome and most players
  actually read album art (important, since Opus embedded art is unreliable).
- **Smart caching.** The downloaded source and thumbnail are cached in a
  git-ignored `./.cache/` folder, keyed by video ID **and** quality profile.
  Re-running (e.g. to tweak the tracklist) **won't re-download** the same set.

---

## Requirements

- Python 3.8+
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp)
- [`ffmpeg`](https://ffmpeg.org/) (includes `ffprobe`)

**macOS:**
```bash
brew install yt-dlp ffmpeg
```

**Termux (Android):**
```bash
pkg install ffmpeg
pip install -U yt-dlp
```

> Keep `yt-dlp` updated (`brew upgrade yt-dlp` / `yt-dlp -U`). Most "it suddenly
> stopped working" issues are YouTube changing something and a stale yt-dlp — an
> update fixes it the vast majority of the time.

---

## Quick start

```bash
# 1. Make a tracklist (see format below), then:
python3 split-set.py "https://youtu.be/VIDEO_ID" --tracklist tracks.txt --dry-run

# 2. Happy with the parse? Drop --dry-run to actually download and split:
python3 split-set.py "https://youtu.be/VIDEO_ID" --tracklist tracks.txt
```

Output lands in `Downloads/Albums/<album>/` (named after the video title), e.g.
`Downloads/Albums/Artist @ Venue 2024/`, containing numbered, tagged tracks plus
`cover.jpg`. The whole `Downloads/` folder is git-ignored automatically. Pass
`-o/--outdir` to write somewhere else.

Everything the script produces lives under `Downloads/`:

```
Downloads/            (git-ignored)
├── Temporary/        cached source audio + thumbnails (reused across runs)
└── Albums/
    └── <album>/      finished split tracks + cover.jpg
```

---

## Tracklist format

Default pattern is `mm:ss - Title - Artist` (hours optional):

```
0:00 - Intro - DJ Someone
3:24 - Nightcall - Kavinsky
7:10 - Midnight City - M83
1:02:15 - Closing - Someone Else
```

- Each line's timestamp is the track **start**.
- The next line's timestamp is where it **ends**.
- The last track runs to the end of the file.
- `-`, `–`, or `—` all work as separators.

**Different layout?** Supply your own regex with named groups `ts`, `title`,
`artist`. For example, if your tracklist is `mm:ss Artist - Title`:

```bash
python3 split-set.py "<URL>" --tracklist tracks.txt \
  --regex '(?P<ts>[\d:]+)\s+(?P<artist>.+?)\s+-\s+(?P<title>.+)'
```

> **Always `--dry-run` first.** It parses the tracklist and prints exactly what it
> *would* cut, without downloading. Lines that don't match the pattern are
> silently skipped — so dry-run is how you catch a format mismatch before spending
> the download.

---

## Options

| Flag | Description |
|------|-------------|
| `--tracklist FILE` | Read the tracklist from a file (reliable). |
| `--from-description` | Try to pull the tracklist from the video description. *(Won't catch timestamps that live in a **comment** — use a file for those.)* |
| `--regex PATTERN` | Custom named-group regex (`ts`, `title`, `artist`). |
| `--audio-format FMT` | Force a format (`m4a`, `mp3`, `opus`, `flac`…). **Default: keep the source's native format** (recommended). |
| `-o, --outdir DIR` | Output directory (default: `Downloads/Albums/<album>`). |
| `--album NAME` | Override the album name (default: the video title). |
| `--no-cover` | Skip fetching/embedding the thumbnail. |
| `--no-crop` | Keep the 16:9 thumbnail instead of square-cropping it. |
| `--keep-full` | Also save the full, unsplit set in the output folder. |
| `--clean-cache` | Delete this video's cached files after a successful run. |
| `--dry-run` | Parse the tracklist and print it; download nothing. |

---

## Caching

Downloads and thumbnails are cached in `Downloads/Temporary/`, named by video ID
and quality profile (e.g. `src_dQw4w9WgXcQ_opus.opus`). Consequences:

- Re-running to tweak a tracklist **re-splits from cache** — no second download.
- Requesting a **different** quality profile (e.g. forcing `mp3`) is a different
  cache key, so it fetches fresh.
- Everything the script writes lives under `Downloads/`, which is git-ignored
  automatically (a nested `Downloads/.gitignore` plus a `Downloads/` entry in your
  top-level `.gitignore`), so neither cached audio nor finished tracks get
  committed. The cache is **visible** (not a hidden dot-folder) on purpose — set
  files are large, so you can see and prune them by hand.
- Cache is **kept by default**. Use `--clean-cache` for a one-off run you don't
  want to keep the source of.

---

## Notes on quality

YouTube's best audio is roughly **160 kbps Opus** — there is no lossless or
higher tier for normal videos. So:

- **Native format is best.** Keeping the source Opus means zero re-encoding loss.
  Forcing FLAC gains you *nothing* (you can't restore quality lossy compression
  already discarded) and just makes bigger files.
- If you need a specific format for compatibility, `--audio-format m4a` (AAC) is a
  reasonable lossy choice; avoid lossless formats for YouTube sources.

---

## Album art & Navidrome

The reliable path is the **folder `cover.jpg`**, which this script always writes.
If Navidrome doesn't show it:

1. Trigger a **full rescan** — art changes often aren't picked up incrementally.
2. Check `ND_COVERARTPRIORITY` prefers external files over `embedded`
   (e.g. `cover.*, folder.*, front.*, embedded`) so a good `cover.jpg` isn't
   overridden by unreliable Opus embedded art.
3. Make sure Navidrome can read the file (permissions, especially in Docker).

---

## License

Personal utility — use and modify freely.
