//! Timestamp-anchored, format-agnostic tracklist parsing + detection.
//!
//! Unlike the old CLI's single rigid `ts - title - artist` regex, the parser finds a
//! timestamp anywhere on a line and treats the rest as the track text, so it survives
//! the many real-world layouts (`ts Title - Artist`, `ts Artist - Title`, `[ts] Title`,
//! `1. ts Title`, `Title - Artist ts`, ...). Detection scans the description and every
//! comment and ranks blocks that look like a tracklist.

use crate::types::{Comment, ParseOptions, Track, TracklistCandidate, VideoInfo};
use once_cell::sync::Lazy;
use regex::Regex;

/// A bare `mm:ss` / `h:mm:ss` / `hh:mm:ss` token. Boundaries are checked manually
/// afterwards (the `regex` crate has no look-around).
/// Fractional seconds are written with a dot (`20:09.250`) — unambiguous next to the
/// colons that separate hours/minutes/seconds.
static TS_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\d{1,3}:\d{2}(?::\d{2})?(?:\.\d+)?").unwrap());
/// ` - `, ` – `, ` — ` used as title/artist separators.
static SEP_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s+[-\u{2013}\u{2014}]\s+").unwrap());
/// Leading list markers: `1.`, `01)`, `#3`, bullets, stray dashes.
static LEAD_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\s*(?:#?\d{1,3}\s*[\.\)]\s*|[-\u{2013}\u{2014}\*\u{2022}\u{00B7}]\s*)+").unwrap());
/// Empty brackets left behind after stripping a bracketed timestamp, e.g. `[]` `()`.
static EMPTY_BRACKETS_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[\[\(\{]\s*[\]\)\}]").unwrap());

/// `mm:ss`, `h:mm:ss`, and either with fractional seconds (`mm:ss.mmm`).
pub fn hms_to_seconds(ts: &str) -> Option<f64> {
    let mut parts = ts.split(':').collect::<Vec<_>>();
    // only the seconds field may carry a fraction
    let secs: f64 = parts.pop()?.parse().ok()?;
    let whole: Vec<i64> = parts.iter().map(|p| p.parse::<i64>().ok()).collect::<Option<_>>()?;
    match whole.as_slice() {
        [] => Some(secs),
        [m] => Some((m * 60) as f64 + secs),
        [h, m] => Some((h * 3600 + m * 60) as f64 + secs),
        _ => None,
    }
}

/// Render seconds back to a tracklist timestamp, keeping milliseconds only when needed.
pub fn seconds_to_hms(total: f64) -> String {
    let total = total.max(0.0);
    let h = (total / 3600.0).floor() as i64;
    let m = ((total % 3600.0) / 60.0).floor() as i64;
    let s = total % 60.0;
    let ms = ((s - s.floor()) * 1000.0).round() as i64;
    let whole = s.floor() as i64;
    let frac = if ms > 0 { format!(".{ms:03}") } else { String::new() };
    if h > 0 {
        format!("{h}:{m:02}:{whole:02}{frac}")
    } else {
        format!("{m:02}:{whole:02}{frac}")
    }
}

/// Rewrite one tracklist line from the fine-tune editor's fields, in canonical form
/// (`mm:ss.mmm - Title - Artist`). The raw text stays the single source of truth.
pub fn set_line_fields(
    text: &str,
    line_no: usize,
    seconds: f64,
    title: &str,
    artist: &str,
) -> Result<String, String> {
    let mut lines: Vec<String> = text.lines().map(|l| l.to_string()).collect();
    if line_no >= lines.len() {
        return Err("line out of range".into());
    }
    let ts = seconds_to_hms(seconds);
    let (t, a) = (title.trim(), artist.trim());
    lines[line_no] = if a.is_empty() { format!("{ts} - {t}") } else { format!("{ts} - {t} - {a}") };
    Ok(lines.join("\n"))
}

/// Promo noise commonly bracketed onto single-track video titles.
static NOISE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)\s*[\(\[]\s*[^\)\]]*\b(?:official|lyrics?|audio|video|visuali[sz]er|hd|hq|4k|mv)\b[^\)\]]*[\)\]]",
    )
    .unwrap()
});

fn clean_video_title(t: &str) -> String {
    let t = NOISE_RE.replace_all(t, "");
    t.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(|c: char| c == '-' || c == '\u{2013}' || c == '\u{2014}' || c == '|' || c.is_whitespace())
        .to_string()
}

/// YouTube's auto-generated artist channels are named "Artist - Topic".
fn clean_uploader(u: &str) -> String {
    u.trim().trim_end_matches("- Topic").trim().to_string()
}

/// Last-resort tracklist for videos that are just one song: guess title/artist from the
/// video title, falling back to the uploader as the artist. Emitted as a normal tracklist
/// line so everything downstream (editing, fine-tuning, splitting) works unchanged.
pub fn single_track_line(title: &str, uploader: &str) -> String {
    let clean = clean_video_title(title);
    let up = clean_uploader(uploader);
    let parts: Vec<&str> = SEP_RE.split(&clean).map(str::trim).filter(|p| !p.is_empty()).collect();
    // Single-song videos are conventionally titled "Artist - Title" — the opposite order
    // to a tracklist line, so swap. Only when it's unambiguous (exactly two fields).
    if parts.len() == 2 {
        format!("0:00 - {} - {}", parts[1], parts[0])
    } else if !up.is_empty() {
        format!("0:00 - {clean} - {up}")
    } else {
        format!("0:00 - {clean}")
    }
}

/// All boundary-valid timestamps on a line (not glued to another digit or `:` group),
/// as `(start_byte, end_byte, seconds)`.
fn all_timestamps(line: &str) -> Vec<(usize, usize, f64)> {
    let bytes = line.as_bytes();
    let mut out = Vec::new();
    for m in TS_RE.find_iter(line) {
        let (s, e) = (m.start(), m.end());
        let before_ok = s == 0 || !bytes[s - 1].is_ascii_digit();
        let after_ok = e >= bytes.len() || (!bytes[e].is_ascii_digit() && bytes[e] != b':');
        if before_ok && after_ok {
            if let Some(secs) = hms_to_seconds(m.as_str()) {
                out.push((s, e, secs));
            }
        }
    }
    out
}

fn clean_text(rest: &str) -> String {
    let rest = EMPTY_BRACKETS_RE.replace_all(rest, "");
    let rest = LEAD_RE.replace(rest.trim(), "");
    rest.trim().trim_matches(|c| c == '-' || c == '\u{2013}' || c == '\u{2014}').trim().to_string()
}

fn split_title_artist(text: &str, artist_first: bool) -> (String, String) {
    let parts: Vec<&str> = SEP_RE.split(text).map(str::trim).filter(|p| !p.is_empty()).collect();
    if parts.len() <= 1 {
        return (text.to_string(), String::new());
    }
    if artist_first {
        (parts[1..].join(" - "), parts[0].to_string())
    } else {
        // mirror the old CLI: title = first field, artist = the rest.
        (parts[0].to_string(), parts[1..].join(" - "))
    }
}

/// Parse using the timestamp-anchored heuristic. Tracks are returned in the order found
/// (NOT sorted) so callers can measure monotonicity; sort before use.
pub fn parse_heuristic(text: &str, artist_first: bool) -> Vec<Track> {
    let mut out = Vec::new();
    for (line_no, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let stamps = all_timestamps(line);
        let Some(&(_, _, start)) = stamps.first() else { continue };
        // Remove EVERY timestamp from the title text, so a `start - end - Title` range
        // (e.g. "00:04:31 - 00:06:11 - Track") doesn't leave the end time in the title.
        let mut rest = String::with_capacity(line.len());
        let mut prev = 0;
        for &(s, e, _) in &stamps {
            rest.push_str(&line[prev..s]);
            rest.push(' ');
            prev = e;
        }
        rest.push_str(&line[prev..]);
        let cleaned = clean_text(&rest);
        let (title, artist) = split_title_artist(&cleaned, artist_first);
        out.push(Track { start, title, artist, selected: true, line: line_no });
    }
    out
}

/// Parse using an explicit named-group regex (`ts`, `title`, `artist`), like the old CLI.
fn parse_regex(text: &str, pattern: &str) -> Result<Vec<Track>, String> {
    let rx = Regex::new(pattern).map_err(|e| format!("bad regex: {e}"))?;
    let mut out = Vec::new();
    for (line_no, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let Some(caps) = rx.captures(line) else { continue };
        let Some(ts) = caps.name("ts") else { continue };
        let Some(start) = hms_to_seconds(ts.as_str()) else { continue };
        out.push(Track {
            start,
            title: caps.name("title").map(|m| m.as_str().trim().to_string()).unwrap_or_default(),
            artist: caps.name("artist").map(|m| m.as_str().trim().to_string()).unwrap_or_default(),
            selected: true,
            line: line_no,
        });
    }
    Ok(out)
}

/// Entry point for the live editor: parse a block of text, sorted by start time.
pub fn parse(text: &str, opts: &ParseOptions) -> Result<Vec<Track>, String> {
    let mut tracks = match &opts.regex {
        Some(p) if !p.trim().is_empty() => parse_regex(text, p)?,
        _ => parse_heuristic(text, opts.artist_first),
    };
    tracks.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap_or(std::cmp::Ordering::Equal));
    Ok(tracks)
}

fn monotonic_fraction(tracks: &[Track]) -> f64 {
    if tracks.len() < 2 {
        return 1.0;
    }
    let inc = tracks.windows(2).filter(|w| w[1].start > w[0].start).count();
    inc as f64 / (tracks.len() - 1) as f64
}

fn score_block(tracks: &[Track], kind: &str, pinned: bool, favorited: bool, likes: i64) -> f64 {
    let n = tracks.len() as f64;
    let mono = monotonic_fraction(tracks);
    let first = tracks.first().map(|t| t.start).unwrap_or(f64::MAX);
    let mut score = n;
    score += mono * n * 0.5;
    if first <= 5.0 {
        score += 3.0;
    }
    if pinned {
        score += 6.0;
    }
    if favorited {
        score += 2.0;
    }
    if kind == "description" {
        score += 2.0;
    }
    score += ((1 + likes.max(0)) as f64).ln();
    score
}

fn candidate_from(
    kind: &str,
    label: String,
    text: &str,
    author: String,
    likes: i64,
    pinned: bool,
    favorited: bool,
) -> Option<TracklistCandidate> {
    let parsed = parse_heuristic(text, false);
    if parsed.len() < 3 {
        return None;
    }
    let score = score_block(&parsed, kind, pinned, favorited, likes);
    let mut tracks = parsed;
    tracks.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap_or(std::cmp::Ordering::Equal));
    let first_ts = tracks.first().map(|t| t.start).unwrap_or(0.0);
    let last_ts = tracks.last().map(|t| t.start).unwrap_or(0.0);
    Some(TracklistCandidate {
        source_label: label,
        source_kind: kind.to_string(),
        raw_text: text.to_string(),
        tracks,
        score,
        first_ts,
        last_ts,
        author,
        like_count: likes,
        pinned,
    })
}

/// Scan the description + every comment, returning tracklist candidates ranked best-first.
pub fn detect(info: &VideoInfo) -> Vec<TracklistCandidate> {
    let mut out = Vec::new();
    if let Some(c) = candidate_from(
        "description",
        "Video description".to_string(),
        &info.description,
        info.uploader.clone(),
        0,
        false,
        false,
    ) {
        out.push(c);
    }
    for cm in &info.comments {
        let Comment { author, text, like_count, pinned, favorited, by_uploader } = cm;
        let mut label = format!("Comment by {author}");
        if *by_uploader {
            label.push_str(" (uploader)");
        } else if *pinned {
            label.push_str(" (pinned)");
        }
        if let Some(c) =
            candidate_from("comment", label, text, author.clone(), *like_count, *pinned, *favorited)
        {
            out.push(c);
        }
    }
    out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_cli_sample_format() {
        let t = "00:16 - Summer Breeze - Piper\n03:30 - Papaya Dance - Michal Urbaniak\n1:00:21 - Fio da Navalha - Guilherme Aarantes";
        let tracks = parse_heuristic(t, false);
        assert_eq!(tracks.len(), 3);
        assert_eq!(tracks[0].start, 16.0);
        assert_eq!(tracks[0].title, "Summer Breeze");
        assert_eq!(tracks[0].artist, "Piper");
        assert_eq!(tracks[2].start, 3621.0);
    }

    #[test]
    fn handles_ts_first_no_dash_and_brackets_and_numbering() {
        let t = "1. [0:00] Intro Track\n2. [3:24] Nightcall - Kavinsky";
        let tracks = parse_heuristic(t, false);
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].title, "Intro Track");
        assert_eq!(tracks[1].title, "Nightcall");
        assert_eq!(tracks[1].artist, "Kavinsky");
    }

    #[test]
    fn single_track_fallback_handles_common_shapes() {
        // "Artist - Title (Official Video)" -> swapped into tracklist order, noise stripped
        let l = single_track_line("Kavinsky - Nightcall (Official Video)", "Record Makers");
        assert_eq!(l, "0:00 - Nightcall - Kavinsky");
        let t = &parse_heuristic(&l, false)[0];
        assert_eq!((t.title.as_str(), t.artist.as_str(), t.start), ("Nightcall", "Kavinsky", 0.0));

        // title is just the song, artist comes from an auto-generated "- Topic" channel
        let l = single_track_line("Nightcall", "Kavinsky - Topic");
        assert_eq!(l, "0:00 - Nightcall - Kavinsky");

        // bracketed promo junk in various forms
        assert_eq!(single_track_line("Some Song [Official Music Video]", "A"), "0:00 - Some Song - A");
        assert_eq!(single_track_line("Some Song (Lyrics)", "A"), "0:00 - Some Song - A");

        // nothing to go on but the title
        assert_eq!(single_track_line("Just A Title", ""), "0:00 - Just A Title");

        // a real title, exactly as yt-dlp reports it (two bracketed noise groups)
        assert_eq!(
            single_track_line("Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)", "Rick Astley"),
            "0:00 - Never Gonna Give You Up - Rick Astley"
        );
    }

    #[test]
    fn millisecond_timestamps_round_trip() {
        let t = "00:16.250 - A - X\n3:24 - B - Y\n1:02:15.5 - C - Z";
        let tracks = parse_heuristic(t, false);
        assert_eq!(tracks[0].start, 16.25);
        assert_eq!(tracks[0].title, "A"); // the fraction must not leak into the title
        assert_eq!(tracks[1].start, 204.0);
        assert_eq!(tracks[2].start, 3735.5);
        // formatting drops .000 but keeps real milliseconds
        assert_eq!(seconds_to_hms(16.25), "00:16.250");
        assert_eq!(seconds_to_hms(204.0), "03:24");
        assert_eq!(seconds_to_hms(3735.5), "1:02:15.500");
    }

    #[test]
    fn rewrites_only_the_target_line() {
        let t = "00:16 - A - X\n3:24 - B - Y\n5:00 - C - Z";
        let out = set_line_fields(t, 1, 204.4, "B", "Y").unwrap();
        assert_eq!(out, "00:16 - A - X\n03:24.400 - B - Y\n5:00 - C - Z");
        assert_eq!(parse_heuristic(&out, false)[1].start, 204.4);

        // title/artist can be edited from the dialog too, and round-trip cleanly
        let out = set_line_fields(t, 1, 204.0, "New Title", "New Artist").unwrap();
        let p = &parse_heuristic(&out, false)[1];
        assert_eq!((p.title.as_str(), p.artist.as_str()), ("New Title", "New Artist"));

        // dropping the artist leaves a clean two-field line
        let out = set_line_fields(t, 1, 204.0, "Solo", "").unwrap();
        assert_eq!(out.lines().nth(1).unwrap(), "03:24 - Solo");
    }

    #[test]
    fn tracks_remember_their_source_line() {
        let t = "intro blurb\n00:16 - A - X\n\n3:24 - B - Y";
        let tracks = parse_heuristic(t, false);
        assert_eq!(tracks[0].line, 1);
        assert_eq!(tracks[1].line, 3);
    }

    #[test]
    fn handles_start_end_range_lines() {
        let t = "00:04:31 - 00:06:11 - Track Name - Artist\n\
                 6:11 - 9:00 Another One - Someone\n\
                 9:00 Plain - Nobody";
        let tracks = parse_heuristic(t, false);
        assert_eq!(tracks.len(), 3);
        assert_eq!(tracks[0].start, 271.0); // 4:31
        assert_eq!(tracks[0].title, "Track Name");
        assert_eq!(tracks[0].artist, "Artist");
        assert_eq!(tracks[1].start, 371.0); // 6:11, not the 9:00 end
        assert_eq!(tracks[1].title, "Another One");
        assert_eq!(tracks[1].artist, "Someone");
    }

    #[test]
    fn timestamp_at_end_of_line() {
        let t = "Nightcall - Kavinsky 3:24\nMidnight City - M83 7:10\nStarted - Someone 9:99extra 10:00";
        let tracks = parse_heuristic(t, false);
        assert_eq!(tracks[0].start, 204.0);
        assert_eq!(tracks[0].title, "Nightcall");
        assert_eq!(tracks[0].artist, "Kavinsky");
    }

    #[test]
    fn artist_first_toggle() {
        let t = "0:00 Kavinsky - Nightcall\n3:00 M83 - Midnight City\n6:00 A - B";
        let tracks = parse_heuristic(t, true);
        assert_eq!(tracks[0].artist, "Kavinsky");
        assert_eq!(tracks[0].title, "Nightcall");
    }

    #[test]
    fn rejects_prose_without_enough_track_lines() {
        let info = VideoInfo {
            id: "x".into(),
            title: "t".into(),
            uploader: "u".into(),
            duration: 0.0,
            thumbnail_url: String::new(),
            description: "great mix, loved the drop at 2:30".into(),
            comments: vec![],
            native_ext: "opus".into(),
            native_abr: 0.0,
        };
        assert!(detect(&info).is_empty());
    }
}
