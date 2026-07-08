#!/usr/bin/env python3
r"""
split-set.py — download a YouTube DJ set / compilation at highest audio quality
and split it into per-track files using a tracklist.

Requires: yt-dlp and ffmpeg on PATH.
    pip install -U yt-dlp        # or your package manager
    ffmpeg via your package manager / termux

TRACKLIST FORMAT (default pattern):
    mm:ss - Title - Artist
    h:mm:ss - Title - Artist        (hours optional)
  e.g.
    0:00 - Intro - DJ Someone
    3:24 - Nightcall - Kavinsky
    1:02:15 - Closing - Someone Else

Each line's timestamp is the track START; the next line's timestamp is where it ends
(last track runs to end of file).

USAGE
    # tracklist from a file (always reliable):
    ./split-set.py <URL> --tracklist tracks.txt

    # try to pull the tracklist from the video description:
    ./split-set.py <URL> --from-description

    # custom pattern via named regex groups (ts, title, artist):
    ./split-set.py <URL> --tracklist tracks.txt \
        --regex '(?P<ts>[\d:]+)\s+(?P<artist>.+?)\s+-\s+(?P<title>.+)'

    # keep the full single file too, and choose output dir / format:
    ./split-set.py <URL> --tracklist tracks.txt --keep-full -o "My Set" --audio-format flac
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

# Default: "mm:ss - Title - Artist" (hours optional). Named groups: ts, title, artist.
DEFAULT_REGEX = r'(?P<ts>\d{1,2}:\d{2}(?::\d{2})?)\s*[-–—]\s*(?P<title>.+?)\s*[-–—]\s*(?P<artist>.+)'


def die(msg, code=1):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)


def check_deps():
    for tool in ("yt-dlp", "ffmpeg", "ffprobe"):
        if shutil.which(tool) is None:
            die(f"'{tool}' not found on PATH. Install it and retry.")


def hms_to_seconds(ts: str) -> float:
    parts = [int(p) for p in ts.split(":")]
    if len(parts) == 2:
        m, s = parts
        return m * 60 + s
    if len(parts) == 3:
        h, m, s = parts
        return h * 3600 + m * 60 + s
    raise ValueError(f"bad timestamp: {ts}")


def sanitize(name: str) -> str:
    name = re.sub(r'[/\\:*?"<>|]', "_", name).strip()
    return name or "track"


def download_audio(url: str, workdir: str, audio_format: str) -> str:
    """Download best-quality audio to workdir. Returns the output file path."""
    out_tmpl = os.path.join(workdir, "source.%(ext)s")
    # -f bestaudio: best audio-only stream; extract & (re)encode to chosen format at max quality.
    cmd = [
        "yt-dlp",
        "-f", "bestaudio/best",
        "-x", "--audio-format", audio_format,
        "--audio-quality", "0",          # 0 = best (VBR) for lossy; ignored for lossless
        "--no-playlist",
        "-o", out_tmpl,
        url,
    ]
    print(">> downloading best-quality audio ...")
    subprocess.run(cmd, check=True)
    for f in os.listdir(workdir):
        if f.startswith("source."):
            return os.path.join(workdir, f)
    die("download finished but no output file found.")


def fetch_description(url: str) -> str:
    print(">> fetching video description ...")
    res = subprocess.run(
        ["yt-dlp", "--no-playlist", "--dump-single-json", url],
        check=True, capture_output=True, text=True,
    )
    data = json.loads(res.stdout)
    return data.get("description", "") or ""


def parse_tracklist(text: str, pattern: str):
    rx = re.compile(pattern)
    tracks = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        m = rx.search(line)
        if not m:
            continue
        gd = m.groupdict()
        if "ts" not in gd or gd["ts"] is None:
            continue
        try:
            start = hms_to_seconds(gd["ts"])
        except ValueError:
            continue
        title = (gd.get("title") or "").strip() if gd.get("title") else ""
        artist = (gd.get("artist") or "").strip() if gd.get("artist") else ""
        tracks.append({"start": start, "title": title, "artist": artist})
    tracks.sort(key=lambda t: t["start"])
    return tracks


def get_duration(path: str) -> float:
    res = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nk=1:nw=1", path],
        check=True, capture_output=True, text=True,
    )
    return float(res.stdout.strip())


def split_tracks(src: str, tracks, outdir: str, audio_format: str):
    os.makedirs(outdir, exist_ok=True)
    duration = get_duration(src)
    total = len(tracks)
    pad = len(str(total))
    for i, t in enumerate(tracks):
        start = t["start"]
        end = tracks[i + 1]["start"] if i + 1 < total else duration
        if end <= start:
            print(f"!! skipping '{t['title']}' (non-positive length)", file=sys.stderr)
            continue
        num = str(i + 1).zfill(pad)
        title = t["title"] or f"Track {num}"
        artist = t["artist"] or ""
        base = f"{num} - {sanitize(title)}"
        if artist:
            base += f" - {sanitize(artist)}"
        out = os.path.join(outdir, base + f".{audio_format}")

        cmd = [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-i", src,
            "-ss", f"{start:.3f}", "-to", f"{end:.3f}",
            "-map", "0:a",
            # copy where possible to avoid quality loss; re-encode only if needed for cut accuracy
            "-c", "copy",
            "-metadata", f"title={title}",
            "-metadata", f"artist={artist}",
            "-metadata", f"track={i+1}/{total}",
            out,
        ]
        print(f"   [{num}/{total}] {title}" + (f" — {artist}" if artist else ""))
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            # stream copy can fail on some containers/cut points; retry with re-encode
            cmd_re = [
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-i", src, "-ss", f"{start:.3f}", "-to", f"{end:.3f}",
                "-map", "0:a",
                "-metadata", f"title={title}",
                "-metadata", f"artist={artist}",
                "-metadata", f"track={i+1}/{total}",
                out,
            ]
            r2 = subprocess.run(cmd_re, capture_output=True, text=True)
            if r2.returncode != 0:
                print(f"!! failed to write {out}:\n{r2.stderr}", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser(description="Download & split a YouTube set into tracks.")
    ap.add_argument("url", help="YouTube URL")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--tracklist", help="path to a tracklist text file")
    src.add_argument("--from-description", action="store_true",
                     help="pull tracklist from the video description")
    ap.add_argument("--regex", default=DEFAULT_REGEX,
                    help="named-group regex with ts,title,artist (default: 'mm:ss - Title - Artist')")
    ap.add_argument("--audio-format", default="m4a",
                    help="output format: m4a, mp3, flac, opus, wav (default: m4a)")
    ap.add_argument("-o", "--outdir", default=None, help="output directory (default: ./<video title>)")
    ap.add_argument("--keep-full", action="store_true", help="also keep the full single file")
    ap.add_argument("--dry-run", action="store_true", help="parse tracklist & print, don't download/split")
    args = ap.parse_args()

    if not args.dry_run:
        check_deps()

    # Gather tracklist text
    if args.tracklist:
        if not os.path.isfile(args.tracklist):
            die(f"tracklist file not found: {args.tracklist}")
        with open(args.tracklist, encoding="utf-8") as fh:
            tl_text = fh.read()
    else:
        tl_text = fetch_description(args.url)

    tracks = parse_tracklist(tl_text, args.regex)
    if not tracks:
        die("no tracks parsed. Check the tracklist format or pass a custom --regex.\n"
            f"Pattern used: {args.regex}")

    print(f">> parsed {len(tracks)} tracks:")
    for i, t in enumerate(tracks, 1):
        mm = int(t["start"] // 60); ss = int(t["start"] % 60)
        line = f"   {i:>2}. {mm:02d}:{ss:02d}  {t['title'] or '(untitled)'}"
        if t["artist"]:
            line += f" — {t['artist']}"
        print(line)

    if args.dry_run:
        return

    outdir = args.outdir
    with tempfile.TemporaryDirectory() as work:
        source = download_audio(args.url, work, args.audio_format)
        if outdir is None:
            outdir = os.path.splitext(os.path.basename(source))[0] + " - tracks"
        print(f">> splitting into: {outdir}")
        split_tracks(source, tracks, outdir, args.audio_format)
        if args.keep_full:
            dest = os.path.join(outdir, "00 - FULL SET." + args.audio_format)
            shutil.copy2(source, dest)
            print(f">> kept full file: {dest}")
    print(">> done.")


if __name__ == "__main__":
    main()
