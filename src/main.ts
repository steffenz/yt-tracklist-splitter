import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, onLog, onProgress, type JobConfig, type Track, type TracklistCandidate, type VideoInfo } from "./api";
import { CropBox } from "./crop";
import { mountPlayer, seekTo } from "./yt";
import "./styles.css";

const app = document.querySelector<HTMLDivElement>("#app")!;

app.innerHTML = /* html */ `
  <header class="topbar">
    <div class="brand">🎧 <b>yt-tracklist-splitter</b> <span class="sub">DJ set / compilation splitter</span></div>
    <div class="tools">
      <span id="ytdlpVer" class="ver">yt-dlp …</span>
      <button id="btnClearCache" class="ghost" title="Delete all cached downloads">Clear cache</button>
    </div>
  </header>

  <main>
    <section class="card">
      <h2><span class="step">1</span> Source</h2>
      <div class="row">
        <input id="url" type="text" placeholder="https://youtu.be/…  (paste a DJ set / compilation URL)" spellcheck="false" />
        <button id="btnFetch" class="primary">Fetch</button>
      </div>
      <div id="fetchStatus" class="status"></div>
      <div id="videoInfo" class="videoinfo hidden"></div>
    </section>

    <section id="workArea" class="hidden">
      <section class="card">
        <h2><span class="step">2</span> Tracklist &amp; preview</h2>
        <div id="tlFeedback" class="feedback"></div>
        <div id="candidates" class="candidates"></div>
        <div class="preview-grid">
          <div class="preview-video">
            <div id="ytPlayer" class="ytplayer"><div class="ytph">Video preview loads after fetching…</div></div>
          </div>
          <div class="tl-right">
            <label class="lbl">Chapters — <span id="trackCount">0</span> tracks <span class="muted">(click a row to jump)</span></label>
            <ol id="preview" class="preview"></ol>
          </div>
        </div>
        <div class="tl-editor">
          <div class="tl-left">
            <label class="lbl">Tracklist text <span class="muted">(edit freely — parses live)</span></label>
            <textarea id="tlText" spellcheck="false" placeholder="mm:ss Title - Artist"></textarea>
            <div class="row wrap opts">
              <label class="chk"><input type="checkbox" id="artistFirst" /> Artist appears before title</label>
              <label class="chk adv"><input type="checkbox" id="useRegex" /> Custom regex</label>
              <input id="regex" class="regex hidden" type="text" spellcheck="false"
                placeholder="(?P&lt;ts&gt;[\\d:]+)\\s+(?P&lt;artist&gt;.+?)\\s+-\\s+(?P&lt;title&gt;.+)" />
            </div>
          </div>
        </div>
      </section>

      <section class="card">
        <h2><span class="step">3</span> Album art</h2>
        <div class="cover-grid">
          <div id="cropWrap" class="cropwrap"></div>
          <div class="cover-controls">
            <label class="lbl">Source</label>
            <label class="rad"><input type="radio" name="coverMode" value="youtube" checked /> YouTube thumbnail</label>
            <label class="rad"><input type="radio" name="coverMode" value="custom" /> Custom image…</label>
            <label class="rad"><input type="radio" name="coverMode" value="none" /> No cover art</label>
            <hr/>
            <label class="chk"><input type="checkbox" id="square" checked /> Square (1000×1000)</label>
            <button id="btnResetCrop" class="ghost">Reset crop</button>
            <button id="btnPickImage" class="ghost">Choose image file…</button>
            <p class="hint">Drag &amp; drop an image file anywhere to use it as the cover. Drag the box or its corners to adjust the crop.</p>
          </div>
        </div>
      </section>

      <section class="card">
        <h2><span class="step">4</span> Options</h2>
        <div class="grid2">
          <label class="field">Audio format
            <select id="format"></select>
          </label>
          <label class="field">Album
            <input id="album" type="text" />
          </label>
          <label class="field">Album artist
            <input id="albumArtist" type="text" />
          </label>
          <label class="field">Output folder
            <span class="row nowrap">
              <input id="outdir" type="text" readonly />
              <button id="btnPickDir" class="ghost">Choose…</button>
            </span>
          </label>
        </div>
        <p class="hint" id="formatHint"></p>
        <div class="row wrap opts">
          <label class="chk"><input type="checkbox" id="keepFull" /> Also save the full unsplit set</label>
          <label class="chk"><input type="checkbox" id="cleanCache" /> Delete this video's cache after running</label>
        </div>
      </section>

      <section class="card run">
        <div class="row nowrap">
          <button id="btnRun" class="primary big">Split it</button>
          <button id="btnCancel" class="danger hidden">Cancel</button>
          <button id="btnReveal" class="ghost hidden">Reveal in Finder</button>
        </div>
        <div id="progressWrap" class="progress hidden">
          <div class="bar"><div id="bar" class="fill"></div></div>
          <div id="progressMsg" class="pmsg"></div>
        </div>
      </section>
    </section>

    <section class="card debug">
      <div class="debug-head">
        <span class="lbl nomargin">Activity log</span>
        <button id="btnClearLog" class="ghost">Clear</button>
      </div>
      <pre id="log" class="log"></pre>
    </section>
  </main>
`;

// ---- element handles ---------------------------------------------------------
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const urlEl = $<HTMLInputElement>("#url");
const btnFetch = $<HTMLButtonElement>("#btnFetch");
const fetchStatus = $("#fetchStatus");
const videoInfoEl = $("#videoInfo");
const workArea = $("#workArea");
const tlFeedback = $("#tlFeedback");
const candidatesEl = $("#candidates");
const tlText = $<HTMLTextAreaElement>("#tlText");
const artistFirst = $<HTMLInputElement>("#artistFirst");
const useRegex = $<HTMLInputElement>("#useRegex");
const regexEl = $<HTMLInputElement>("#regex");
const previewEl = $("#preview");
const trackCount = $("#trackCount");
const squareEl = $<HTMLInputElement>("#square");
const formatEl = $<HTMLSelectElement>("#format");
const albumEl = $<HTMLInputElement>("#album");
const albumArtistEl = $<HTMLInputElement>("#albumArtist");
const outdirEl = $<HTMLInputElement>("#outdir");
const keepFullEl = $<HTMLInputElement>("#keepFull");
const cleanCacheEl = $<HTMLInputElement>("#cleanCache");
const btnRun = $<HTMLButtonElement>("#btnRun");
const btnCancel = $<HTMLButtonElement>("#btnCancel");
const btnReveal = $<HTMLButtonElement>("#btnReveal");
const progressWrap = $("#progressWrap");
const bar = $("#bar");
const progressMsg = $("#progressMsg");
const logEl = $<HTMLPreElement>("#log");

// ---- app state ---------------------------------------------------------------
let info: VideoInfo | null = null;
let tracks: Track[] = [];
let coverMode: "youtube" | "custom" | "none" = "youtube";
let customImagePath: string | null = null;
let lastOutdir: string | null = null;
const crop = new CropBox($("#cropWrap"));

// ---- helpers -----------------------------------------------------------------
const hms = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};
const isImage = (p: string) => /\.(jpe?g|png|webp|gif|bmp|tiff?)$/i.test(p);
const setStatus = (msg: string, kind: "" | "err" | "ok" = "") => {
  fetchStatus.textContent = msg;
  fetchStatus.className = `status ${kind}`;
};
// Busy spinner on the Fetch button + status line.
const setBusy = (on: boolean, label = "") => {
  btnFetch.disabled = on;
  btnFetch.textContent = on ? "Fetching…" : "Fetch";
  if (on) {
    fetchStatus.className = "status busy";
    fetchStatus.innerHTML = `<span class="spin"></span>${escapeHtml(label)}`;
  }
};
// Append a line to the always-visible activity log.
const logLine = (msg: string) => {
  logEl.textContent += (logEl.textContent ? "\n" : "") + msg;
  logEl.scrollTop = logEl.scrollHeight;
};

// ---- yt-dlp version + maintenance -------------------------------------------
api.ytdlpVersion().then((v) => ($("#ytdlpVer").textContent = `yt-dlp ${v}`)).catch(() => {});
$("#btnClearCache").addEventListener("click", async () => {
  const n = await api.clearCache();
  setStatus(`Cleared ${n} cached file(s).`, "ok");
  logLine(`Cleared ${n} cached file(s)`);
});
$("#btnClearLog").addEventListener("click", () => (logEl.textContent = ""));
logLine("Ready. Paste a YouTube URL and hit Fetch.");

// ---- step 1: fetch -----------------------------------------------------------
$("#btnFetch").addEventListener("click", doFetch);
urlEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doFetch();
});

// Clear all per-video UI + state before loading a new one, so nothing stale lingers.
function resetUI() {
  info = null;
  tracks = [];
  customImagePath = null;
  coverMode = "youtube";
  ($(`input[name=coverMode][value=youtube]`) as HTMLInputElement).checked = true;
  $("#cropWrap").classList.remove("disabled");
  videoInfoEl.classList.add("hidden");
  videoInfoEl.innerHTML = "";
  tlFeedback.textContent = "";
  tlFeedback.className = "feedback";
  candidatesEl.innerHTML = "";
  tlText.value = "";
  previewEl.innerHTML = "";
  trackCount.textContent = "0";
  albumEl.value = "";
  albumArtistEl.value = "";
  outdirEl.value = "";
  formatEl.innerHTML = "";
  $("#formatHint").textContent = "";
  $("#ytPlayer").innerHTML = `<div class="ytph">Loading preview…</div>`;
  crop.setImage("");
  btnReveal.classList.add("hidden");
  progressWrap.classList.add("hidden");
  progressMsg.textContent = "";
  bar.style.width = "2%";
}

async function doFetch() {
  const url = urlEl.value.trim();
  if (!url) return;
  resetUI();
  setBusy(true, "Fetching video info and scanning comments… (this can take a few seconds)");
  logLine(`Fetching ${url} …`);
  try {
    info = await api.fetchInfo(url);
  } catch (e) {
    setBusy(false);
    setStatus(String(e), "err");
    logLine(`ERROR: ${e}`);
    return;
  }
  setBusy(false);
  setStatus(`Loaded “${info.title}”.`, "ok");
  logLine(`Loaded “${info.title}” — ${info.uploader}, ${hms(info.duration)}, ${info.comments.length} comments scanned`);
  renderVideoInfo(info);
  albumEl.value = info.title;
  albumArtistEl.value = info.uploader;
  buildFormatOptions(info);
  outdirEl.value = await api.defaultOutputDir(info.title).catch(() => "");
  coverMode = "youtube";
  ($(`input[name=coverMode][value=youtube]`) as HTMLInputElement).checked = true;
  // Reveal the workspace BEFORE loading the thumbnail so the crop box lays out correctly.
  workArea.classList.remove("hidden");
  workArea.scrollIntoView({ behavior: "smooth", block: "start" });
  await loadYoutubeThumb();
  await detect();
  // Load the video preview (network; non-blocking).
  logLine("Loading video preview…");
  mountPlayer($("#ytPlayer"), info.id)
    .then(() => logLine("Video preview ready"))
    .catch((e) => logLine(`Video preview unavailable: ${e}`));
}

function srcBitrate(v: VideoInfo): string {
  return v.native_abr > 0 ? `~${Math.round(v.native_abr)} kbps` : "source bitrate";
}

function renderVideoInfo(v: VideoInfo) {
  videoInfoEl.classList.remove("hidden");
  const br = v.native_abr > 0 ? `${srcBitrate(v)} ${v.native_ext} · ` : "";
  videoInfoEl.innerHTML = /* html */ `
    <img src="${v.thumbnail_url}" alt="" />
    <div>
      <div class="vtitle">${escapeHtml(v.title)}</div>
      <div class="muted">${escapeHtml(v.uploader)} · ${hms(v.duration)} · ${br}${v.comments.length} comments scanned</div>
    </div>`;
}

function buildFormatOptions(v: VideoInfo) {
  const br = srcBitrate(v);
  const opts = [
    { value: "native", label: `Native — ${v.native_ext}, ${br} (no re-encode, best)` },
    { value: "m4a", label: `m4a (AAC) — ${br}` },
    { value: "mp3", label: `mp3 — ${br}` },
    { value: "opus", label: `opus — ${br}` },
    { value: "flac", label: `flac — lossless (larger, no quality gain)` },
    { value: "wav", label: `wav — uncompressed (very large)` },
  ];
  formatEl.innerHTML = opts.map((o) => `<option value="${o.value}">${o.label}</option>`).join("");
  $("#formatHint").textContent =
    `Source audio is ${br} ${v.native_ext}. Lossy formats (m4a/mp3/opus) are capped to the source bitrate — ` +
    `encoding higher can't recover quality. flac/wav don't shrink files. Native = a bit-exact copy.`;
}

// ---- step 2: tracklist detection + live parse -------------------------------
async function detect() {
  candidatesEl.innerHTML = "";
  if (!info) return;
  logLine("Scanning description + comments for a tracklist…");
  const cands = await api.detect(info);
  if (cands.length === 0) {
    tlFeedback.className = "feedback warn";
    tlFeedback.textContent =
      "No tracklist detected in the description or top comments. Paste one below — it parses as you type.";
    tlText.value = "";
    logLine("No tracklist detected — paste one manually.");
    await reparse();
    return;
  }
  tlFeedback.className = "feedback ok";
  tlFeedback.textContent =
    cands.length === 1
      ? `Found a tracklist in the ${cands[0].source_kind === "description" ? "description" : "comments"}.`
      : `Found ${cands.length} possible tracklists — pick the right one (best match selected).`;
  logLine(`Detected ${cands.length} tracklist candidate(s); using “${cands[0].source_label}” (${cands[0].tracks.length} tracks)`);
  cands.forEach((c, i) => candidatesEl.appendChild(candidateChip(c, i === 0)));
  selectCandidate(cands[0]);
}

function candidateChip(c: TracklistCandidate, best: boolean): HTMLElement {
  const el = document.createElement("button");
  el.className = "chip" + (best ? " best" : "");
  el.innerHTML = /* html */ `
    <span class="chip-title">${escapeHtml(c.source_label)}</span>
    <span class="chip-meta">${c.tracks.length} tracks · ${hms(c.first_ts)}–${hms(c.last_ts)}${
      c.pinned ? " · 📌" : ""
    }${c.like_count > 0 ? ` · ♥ ${c.like_count}` : ""}</span>`;
  el.addEventListener("click", () => {
    document.querySelectorAll(".chip").forEach((n) => n.classList.remove("active"));
    el.classList.add("active");
    selectCandidate(c);
  });
  if (best) el.classList.add("active");
  return el;
}

function selectCandidate(c: TracklistCandidate) {
  tlText.value = c.raw_text.trim();
  reparse();
}

let reparseTimer: number | undefined;
const scheduleReparse = () => {
  clearTimeout(reparseTimer);
  reparseTimer = window.setTimeout(reparse, 180);
};
// Click a parsed chapter to seek the video preview.
previewEl.addEventListener("click", (e) => {
  const li = (e.target as HTMLElement).closest("li[data-start]") as HTMLElement | null;
  if (li) seekTo(parseFloat(li.dataset.start!));
});
tlText.addEventListener("input", scheduleReparse);
artistFirst.addEventListener("change", reparse);
regexEl.addEventListener("input", scheduleReparse);
useRegex.addEventListener("change", () => {
  regexEl.classList.toggle("hidden", !useRegex.checked);
  reparse();
});

async function reparse() {
  const opts = { artist_first: artistFirst.checked, regex: useRegex.checked ? regexEl.value : null };
  try {
    tracks = await api.parse(tlText.value, opts);
  } catch (e) {
    tracks = [];
    previewEl.innerHTML = `<li class="err">${escapeHtml(String(e))}</li>`;
    trackCount.textContent = "0";
    return;
  }
  trackCount.textContent = String(tracks.length);
  previewEl.innerHTML = tracks
    .map(
      (t) =>
        `<li data-start="${t.start}" title="Jump to ${hms(t.start)}"><span class="pt">▸ ${hms(
          t.start
        )}</span> <span class="ptitle">${escapeHtml(t.title || "(untitled)")}</span>${
          t.artist ? ` <span class="partist">— ${escapeHtml(t.artist)}</span>` : ""
        }</li>`
    )
    .join("");
}

// ---- step 3: cover -----------------------------------------------------------
document.querySelectorAll<HTMLInputElement>("input[name=coverMode]").forEach((r) =>
  r.addEventListener("change", async () => {
    coverMode = r.value as typeof coverMode;
    const wrap = $("#cropWrap");
    wrap.classList.toggle("disabled", coverMode === "none");
    logLine(`Cover source: ${coverMode}`);
    if (coverMode === "youtube") await loadYoutubeThumb();
    else if (coverMode === "custom" && customImagePath) crop.setImage(convertFileSrc(customImagePath));
  })
);
squareEl.addEventListener("change", () => crop.setSquare(squareEl.checked));
$("#btnResetCrop").addEventListener("click", () => crop.reset());
$("#btnPickImage").addEventListener("click", pickImage);

async function loadYoutubeThumb() {
  if (!info) return;
  logLine("Fetching thumbnail…");
  try {
    const path = await api.getThumbnail(urlEl.value.trim(), info.id);
    crop.setImage(convertFileSrc(path));
    logLine("Thumbnail ready");
  } catch (e) {
    logLine(`Thumbnail error: ${e}`);
    console.error(e);
  }
}

async function pickImage() {
  const sel = await open({ multiple: false, filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp"] }] });
  if (typeof sel === "string") useCustomImage(sel);
}

function useCustomImage(path: string) {
  customImagePath = path;
  coverMode = "custom";
  ($(`input[name=coverMode][value=custom]`) as HTMLInputElement).checked = true;
  $("#cropWrap").classList.remove("disabled");
  crop.setImage(convertFileSrc(path));
}

// window-level drag & drop of an image file
getCurrentWebview().onDragDropEvent((e) => {
  if (e.payload.type === "drop") {
    const p = e.payload.paths.find(isImage);
    if (p) useCustomImage(p);
  }
});

// ---- step 4: pickers ---------------------------------------------------------
albumEl.addEventListener("change", async () => {
  if (info && outdirEl.value) outdirEl.value = await api.defaultOutputDir(albumEl.value).catch(() => outdirEl.value);
});
$("#btnPickDir").addEventListener("click", async () => {
  const sel = await open({ directory: true });
  if (typeof sel === "string") outdirEl.value = sel;
});

// ---- step 5: run -------------------------------------------------------------
onProgress((p) => {
  progressWrap.classList.remove("hidden");
  bar.style.width = `${Math.max(2, p.pct)}%`;
  bar.classList.toggle("indeterminate", p.stage === "download" && p.pct === 0);
  progressMsg.textContent =
    p.stage === "split" ? `Track ${p.current}/${p.total}: ${p.message}` : p.message;
});
onLog((line) => logLine(line));

btnRun.addEventListener("click", runJob);
btnCancel.addEventListener("click", () => api.cancel());
btnReveal.addEventListener("click", () => lastOutdir && revealItemInDir(lastOutdir));

async function runJob() {
  if (!info) return;
  if (tracks.length === 0) {
    setStatus("Nothing to split — the tracklist is empty.", "err");
    return;
  }
  if (!outdirEl.value) {
    setStatus("Pick an output folder first.", "err");
    return;
  }
  const audioFormat = formatEl.value === "native" ? info.native_ext : formatEl.value;
  const cfg: JobConfig = {
    url: urlEl.value.trim(),
    video_id: info.id,
    tracks,
    audio_format: audioFormat,
    source_abr: info.native_abr,
    album: albumEl.value,
    album_artist: albumArtistEl.value,
    cover_mode: coverMode,
    custom_image_path: coverMode === "custom" ? customImagePath : null,
    crop: coverMode === "none" ? null : crop.getRect(),
    square: squareEl.checked,
    keep_full: keepFullEl.checked,
    clean_cache: cleanCacheEl.checked,
    outdir: outdirEl.value,
  };

  logLine(`—— starting job: ${tracks.length} tracks → ${cfg.outdir} ——`);
  setRunning(true);
  try {
    lastOutdir = await api.runJob(cfg);
    bar.classList.remove("indeterminate");
    bar.style.width = "100%";
    progressMsg.textContent = "Done ✓";
    btnReveal.classList.remove("hidden");
    setStatus(`Done — ${tracks.length} tracks written.`, "ok");
  } catch (e) {
    const msg = String(e);
    bar.classList.remove("indeterminate");
    if (/cancel/i.test(msg)) {
      bar.style.width = "2%"; // cancelled: reset, not an error
    } else {
      bar.classList.add("error"); // real failure: stop + turn the bar red
      bar.style.width = "100%";
    }
    progressMsg.textContent = msg;
    setStatus(msg, "err");
    logLine(`ERROR: ${e}`);
  } finally {
    setRunning(false);
  }
}

function setRunning(on: boolean) {
  btnRun.disabled = on;
  btnCancel.classList.toggle("hidden", !on);
  // Always stop the sliding animation when a run ends (success, error, or cancel).
  bar.classList.remove("indeterminate");
  if (on) {
    btnReveal.classList.add("hidden");
    bar.classList.remove("error");
    bar.style.width = "2%";
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
