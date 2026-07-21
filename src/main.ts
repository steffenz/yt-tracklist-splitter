import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  api,
  onLog,
  onProgress,
  type JobConfig,
  type PreviewInfo,
  type Track,
  type TracklistCandidate,
  type VideoInfo,
} from "./api";
import { CropBox } from "./crop";
import "./styles.css";

const app = document.querySelector<HTMLDivElement>("#app")!;

app.innerHTML = /* html */ `
  <header class="topbar">
    <div class="brand">🎧 <b>yt-tracklist-splitter</b> <span class="sub">DJ set / compilation splitter</span></div>
    <div class="tools">
      <span id="ytdlpVer" class="ver">yt-dlp …</span>
      <button id="btnClearCache" class="ghost" title="Delete all cached downloads and start over">
        Clear cache <span id="cacheSize" class="badge">—</span>
      </button>
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
        <div id="editedNote" class="editednote hidden">
          ✎ <b>You've edited this tracklist.</b> Switching source or fetching another video
          will discard your changes.
        </div>
        <div class="preview-grid">
          <div class="preview-video">
            <div id="previewIdle" class="preview-idle">
              <button id="btnPrepare" class="primary">⬇ Download audio for preview</button>
              <p class="hint">Fetches the source audio once and caches it — the split afterwards
                reuses the same file, so there's no second download. Playback normally uses the
                original audio as-is; if this system can't play it, a smaller copy is made
                automatically.</p>
            </div>
            <div id="previewBusy" class="preview-busy hidden">
              <div class="spinrow"><span class="spin"></span><span id="prepMsg">Starting…</span></div>
              <div class="bar"><div id="prepBar" class="fill"></div></div>
            </div>
            <div id="previewPane" class="preview-pane hidden">
              <div class="transport">
                <button id="btnPlay" class="playbtn" title="Play / pause">▶</button>
                <span class="time"><span id="curTime">0:00</span> <span class="muted">/</span> <span id="durTime">0:00</span></span>
                <span id="nowPlaying" class="nowplaying muted">—</span>
                <label class="switch" title="Off: clicking picks a track. On: clicking scrubs to that exact point.">
                  <input type="checkbox" id="seekMode" />
                  <span class="sw-track"><span class="sw-knob"></span></span>
                  <span class="sw-label">Seek mode</span>
                </label>
              </div>
              <div id="timeline" class="timeline"></div>
              <p class="hint tlhint" id="tlHint"></p>
              <p id="previewNote" class="previewnote hidden">
                ℹ︎ This preview had to be re-encoded to a reduced-quality mono copy so it
                plays here. Your split tracks are cut from the full-quality source and
                will sound better.
              </p>
            </div>
          </div>
          <div class="tl-right">
            <div class="chapters-head">
              <label class="lbl nomargin">Chapters — <span id="selCount">0</span> of <span id="trackCount">0</span> selected
                <span class="muted">(click a row to jump · tick to choose what gets extracted)</span></label>
              <span class="selbtns">
                <button id="btnSelAll" class="ghost tiny">All</button>
                <button id="btnSelNone" class="ghost tiny">None</button>
              </span>
            </div>
            <ol id="preview" class="preview"></ol>
          </div>
        </div>
        <details id="rawDetails" class="raw">
          <summary>Raw tracklist text <span class="muted">— only needed if the detected list is wrong</span></summary>
          <div class="tl-editor">
            <div class="tl-left">
              <textarea id="tlText" spellcheck="false" placeholder="mm:ss Title - Artist"></textarea>
              <div class="row wrap opts">
                <label class="chk"><input type="checkbox" id="artistFirst" /> Artist appears before title</label>
                <label class="chk adv"><input type="checkbox" id="useRegex" /> Custom regex</label>
                <input id="regex" class="regex hidden" type="text" spellcheck="false"
                  placeholder="(?P&lt;ts&gt;[\\d:]+)\\s+(?P&lt;artist&gt;.+?)\\s+-\\s+(?P&lt;title&gt;.+)" />
              </div>
            </div>
          </div>
        </details>
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
let preparingPreview = false;
const audio = new Audio();
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
const fmtBytes = (b: number) => {
  if (b <= 0) return "empty";
  const units = ["B", "KB", "MB", "GB"];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
};

async function refreshCacheSize() {
  try {
    $("#cacheSize").textContent = fmtBytes(await api.cacheSize());
  } catch {
    /* ignore */
  }
}
refreshCacheSize();

$("#btnClearCache").addEventListener("click", async () => {
  const size = await api.cacheSize().catch(() => 0);
  const ok = await confirm(
    `Delete all cached downloads (${fmtBytes(size)})?\n\n` +
      `This removes downloaded audio, previews and thumbnails, and resets the app. ` +
      `Anything you open again will be re-downloaded. Already-split tracks are not affected.`,
    { title: "Clear cache", kind: "warning", okLabel: "Delete", cancelLabel: "Cancel" }
  );
  if (!ok) return;
  const n = await api.clearCache();
  resetToStart();
  await refreshCacheSize();
  setStatus(`Cleared ${n} cached file(s) — starting fresh.`, "ok");
  logLine(`Cleared ${n} cached file(s) (${fmtBytes(size)}) — app reset`);
});

/** Back to a blank slate: clears the URL, hides the workspace, resets all per-video state. */
function resetToStart() {
  resetUI();
  urlEl.value = "";
  workArea.classList.add("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
}
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
  originalText = "";
  updateEditedState();
  previewEl.innerHTML = "";
  trackCount.textContent = "0";
  albumEl.value = "";
  albumArtistEl.value = "";
  outdirEl.value = "";
  formatEl.innerHTML = "";
  $("#formatHint").textContent = "";
  // reset the audio preview
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  previewState("idle");
  timelineEl.innerHTML = "";
  curTimeEl.textContent = "0:00";
  durTimeEl.textContent = "0:00";
  nowPlayingEl.textContent = "—";
  crop.setImage("");
  btnReveal.classList.add("hidden");
  progressWrap.classList.add("hidden");
  progressMsg.textContent = "";
  bar.style.width = "2%";
}

async function doFetch() {
  const url = urlEl.value.trim();
  if (!url) return;
  if (!(await confirmDiscardEdits("Fetching another video"))) return;
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
  // If this video's audio was already prepared, load the preview straight away.
  const cached = await api.cachedPreview(info.id).catch(() => null);
  if (cached) {
    loadPreview(cached);
    logLine("Cached audio found — preview ready");
  } else {
    previewState("idle");
  }
  await refreshCacheSize();
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
    ($("#rawDetails") as HTMLDetailsElement).open = true; // they'll need the editor now
    await reparse();
    return;
  }
  ($("#rawDetails") as HTMLDetailsElement).open = false;
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
  el.addEventListener("click", async () => {
    if (!(await selectCandidate(c))) return; // user kept their edits
    document.querySelectorAll(".chip").forEach((n) => n.classList.remove("active"));
    el.classList.add("active");
  });
  if (best) el.classList.add("active");
  return el;
}

/** Raw text of the source currently loaded, so we can tell when the user has edited it. */
let originalText = "";
const isModified = () => originalText !== "" && tlText.value.trim() !== originalText.trim();

function updateEditedState() {
  $("#editedNote").classList.toggle("hidden", !isModified());
}

/** Ask before throwing away edits. Returns false if the user wants to keep them. */
async function confirmDiscardEdits(what: string): Promise<boolean> {
  if (!isModified()) return true;
  return await confirm(
    `Discard your edits?\n\nYou've changed the tracklist text. ${what} will replace it with the original.`,
    { title: "Unsaved changes", kind: "warning", okLabel: "Discard", cancelLabel: "Keep editing" }
  );
}

async function selectCandidate(c: TracklistCandidate): Promise<boolean> {
  if (!(await confirmDiscardEdits("Loading this source"))) return false;
  originalText = c.raw_text.trim();
  tlText.value = originalText;
  await reparse();
  return true;
}

let reparseTimer: number | undefined;
const scheduleReparse = () => {
  clearTimeout(reparseTimer);
  reparseTimer = window.setTimeout(reparse, 180);
};
// Click a chapter row to seek; the checkbox chooses whether it gets extracted.
previewEl.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target.classList.contains("pick")) return; // let the checkbox do its thing
  const li = target.closest("li[data-start]") as HTMLElement | null;
  if (li) seekTo(parseFloat(li.dataset.start!));
});
previewEl.addEventListener("change", (e) => {
  const cb = e.target as HTMLInputElement;
  if (!cb.classList.contains("pick")) return;
  tracks[Number(cb.dataset.i)].selected = cb.checked;
  cb.closest("li")?.classList.toggle("off", !cb.checked);
  updateSelection();
});

$("#btnSelAll").addEventListener("click", () => setAllSelected(true));
$("#btnSelNone").addEventListener("click", () => setAllSelected(false));

function setAllSelected(v: boolean) {
  tracks.forEach((t) => (t.selected = v));
  previewEl.querySelectorAll<HTMLInputElement>(".pick").forEach((cb) => (cb.checked = v));
  previewEl.querySelectorAll("li").forEach((li) => li.classList.toggle("off", !v));
  updateSelection();
}

/** Reflect the current selection in the count, the timeline, and the Run button. */
function updateSelection() {
  const n = tracks.filter((t) => t.selected).length;
  $("#selCount").textContent = String(n);
  tracks.forEach((t, i) =>
    timelineEl.querySelector(`.seg[data-i="${i}"]`)?.classList.toggle("off", !t.selected)
  );
  btnRun.textContent =
    n === 0
      ? "Select at least one track"
      : n === tracks.length
        ? `Split all ${n} tracks`
        : `Split ${n} of ${tracks.length} tracks`;
  btnRun.disabled = n === 0;
}
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
  const pad = String(tracks.length).length;
  previewEl.innerHTML = tracks
    .map(
      (t, i) =>
        `<li data-i="${i}" data-start="${t.start}" class="${t.selected ? "" : "off"}" title="Jump to ${hms(t.start)}">` +
        `<input type="checkbox" class="pick" data-i="${i}"${t.selected ? " checked" : ""} title="Include this track" />` +
        `<span class="pnum">${String(i + 1).padStart(pad, "0")}</span>` +
        `<span class="pt">${hms(t.start)}</span> <span class="ptitle">${escapeHtml(t.title || "(untitled)")}</span>` +
        `${t.artist ? ` <span class="partist">— ${escapeHtml(t.artist)}</span>` : ""}</li>`
    )
    .join("");
  updateEditedState();
  updateSelection();
  renderTimeline();
}

// ---- step 2b: local audio preview -------------------------------------------
const previewIdle = $("#previewIdle");
const previewBusy = $("#previewBusy");
const previewPane = $("#previewPane");
const prepBar = $("#prepBar");
const prepMsg = $("#prepMsg");
const btnPlay = $<HTMLButtonElement>("#btnPlay");
const timelineEl = $("#timeline");
const curTimeEl = $("#curTime");
const durTimeEl = $("#durTime");
const nowPlayingEl = $("#nowPlaying");

function previewState(s: "idle" | "busy" | "ready") {
  previewIdle.classList.toggle("hidden", s !== "idle");
  previewBusy.classList.toggle("hidden", s !== "busy");
  previewPane.classList.toggle("hidden", s !== "ready");
}

function seekTo(seconds: number) {
  if (!audio.getAttribute("src")) return;
  audio.currentTime = Math.max(0, seconds);
  audio.play().catch(() => {});
}

// The fast path stream-copies Opus into a .caf (instant, full quality). CoreAudio decodes
// it, but if this webview refuses we fall back to an encoded preview — and remember that,
// so we don't retry the fast path on every video.
const CAF_UNSUPPORTED = "cafUnsupported";
let cafWatchdog: number | undefined;

function loadPreview(p: PreviewInfo) {
  clearTimeout(cafWatchdog);
  audio.src = convertFileSrc(p.path);
  audio.load();
  previewState("ready");
  $("#previewNote").classList.toggle("hidden", !p.encoded);
  renderTimeline();
  if (p.path.endsWith(".caf")) {
    // If metadata never arrives, the format isn't playable here — fall back.
    cafWatchdog = window.setTimeout(() => fallbackToEncoded("no response"), 6000);
  }
}

async function fallbackToEncoded(why: string) {
  clearTimeout(cafWatchdog);
  if (!info || preparingPreview) return;
  localStorage.setItem(CAF_UNSUPPORTED, "1");
  logLine(`Instant preview format not playable here (${why}) — converting instead (one-time)`);
  await runPrepare(true);
}

$("#btnPrepare").addEventListener("click", () => runPrepare(localStorage.getItem(CAF_UNSUPPORTED) === "1"));

async function runPrepare(forceEncode: boolean) {
  if (!info) return;
  preparingPreview = true;
  previewState("busy");
  prepBar.style.width = "2%";
  prepMsg.textContent = forceEncode ? "Converting to preview format…" : "Downloading audio…";
  try {
    const p = await api.preparePreview(urlEl.value.trim(), info.id, forceEncode);
    loadPreview(p);
    await refreshCacheSize();
  } catch (e) {
    previewState("idle");
    setStatus(String(e), "err");
    logLine(`ERROR: ${e}`);
  } finally {
    preparingPreview = false;
  }
}

btnPlay.addEventListener("click", () => (audio.paused ? audio.play() : audio.pause()));
audio.addEventListener("play", () => (btnPlay.textContent = "❚❚"));
audio.addEventListener("pause", () => (btnPlay.textContent = "▶"));
audio.addEventListener("loadedmetadata", () => {
  clearTimeout(cafWatchdog); // it plays — no fallback needed
  durTimeEl.textContent = hms(audio.duration);
  renderTimeline();
});
audio.addEventListener("error", () => {
  if ((audio.getAttribute("src") || "").includes(".caf")) fallbackToEncoded("unsupported format");
});
audio.addEventListener("timeupdate", updatePlayhead);

// Clicking picks a track by default; "Seek mode" switches to free scrubbing. Alt/Shift
// inverts whichever is active, for one-offs. (Alt is Option on macOS; we also accept
// Shift because some Linux window managers swallow Alt+click.)
const isMac = navigator.userAgent.includes("Mac");
const ALT = isMac ? "⌥" : "Alt";
const SEEK_MODE = "timelineSeekMode";
const seekModeEl = $<HTMLInputElement>("#seekMode");
seekModeEl.checked = localStorage.getItem(SEEK_MODE) === "1";
function renderHint() {
  $("#tlHint").innerHTML = seekModeEl.checked
    ? `Click the timeline to scrub to that exact point · <b>${ALT}/Shift-click</b> to jump to a track's start instead · the chapter list always jumps.`
    : `Click a block to jump to that track · <b>${ALT}/Shift-click</b> to scrub to an exact point · or turn on <b>Seek mode</b>.`;
}
renderHint();
seekModeEl.addEventListener("change", () => {
  localStorage.setItem(SEEK_MODE, seekModeEl.checked ? "1" : "0");
  renderHint();
});

/** Index of the track playing at `time`, or -1. */
function trackAt(time: number): number {
  let idx = -1;
  for (let i = 0; i < tracks.length; i++) if (time >= tracks[i].start) idx = i;
  return idx;
}

const timeAtEvent = (e: MouseEvent, dur: number) => {
  const r = timelineEl.getBoundingClientRect();
  return Math.min(dur, Math.max(0, ((e.clientX - r.left) / r.width) * dur));
};

timelineEl.addEventListener("click", (e) => {
  const dur = previewDuration();
  if (!dur) return;
  const t = timeAtEvent(e, dur);
  const inverted = e.altKey || e.shiftKey;
  const wantTrackStart = seekModeEl.checked ? inverted : !inverted;
  const idx = trackAt(t);
  seekTo(wantTrackStart && idx >= 0 ? tracks[idx].start : t);
});

// Hover tooltip: which track you're over, and the time under the cursor.
const tip = document.createElement("div");
tip.className = "tltip hidden";
document.body.appendChild(tip);
timelineEl.addEventListener("mousemove", (e) => {
  const dur = previewDuration();
  if (!dur) return;
  const t = timeAtEvent(e, dur);
  const idx = trackAt(t);
  const trk = idx >= 0 ? tracks[idx] : null;
  const name = trk
    ? `<b>${escapeHtml(trk.title || "(untitled)")}</b>${trk.artist ? ` — ${escapeHtml(trk.artist)}` : ""}`
    : "";
  tip.innerHTML = `${name ? `<span class="tt-name">${name}</span>` : ""}<span class="tt">${hms(t)}</span>`;
  tip.classList.remove("hidden");
  const r = timelineEl.getBoundingClientRect();
  tip.style.left = `${Math.min(window.innerWidth - tip.offsetWidth - 8, Math.max(8, e.clientX - tip.offsetWidth / 2))}px`;
  tip.style.top = `${r.top - tip.offsetHeight - 8}px`;
});
timelineEl.addEventListener("mouseleave", () => tip.classList.add("hidden"));

function previewDuration(): number {
  return Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : info?.duration ?? 0;
}

/** Draw each track as a block on the timeline, so chapters are visible and clickable. */
function renderTimeline() {
  const dur = previewDuration();
  if (!dur) {
    timelineEl.innerHTML = "";
    return;
  }
  const segs = tracks
    .map((t, i) => {
      const end = i + 1 < tracks.length ? tracks[i + 1].start : dur;
      const left = (t.start / dur) * 100;
      const width = Math.max(0.2, ((end - t.start) / dur) * 100);
      return `<div class="seg${i % 2 ? " alt" : ""}${t.selected ? "" : " off"}" data-i="${i}" style="left:${left}%;width:${width}%"></div>`;
    })
    .join("");
  timelineEl.innerHTML = `${segs}<div id="tlFill" class="tl-fill"></div><div id="tlHead" class="tl-head"></div>`;
  updatePlayhead();
}

function updatePlayhead() {
  const dur = previewDuration();
  const fill = document.querySelector<HTMLElement>("#tlFill");
  const head = document.querySelector<HTMLElement>("#tlHead");
  if (!dur || !fill || !head) return;
  const pct = Math.min(100, (audio.currentTime / dur) * 100);
  fill.style.width = `${pct}%`;
  head.style.left = `${pct}%`;
  curTimeEl.textContent = hms(audio.currentTime);

  const idx = trackAt(audio.currentTime);
  timelineEl.querySelectorAll(".seg.active").forEach((s) => s.classList.remove("active"));
  previewEl.querySelectorAll("li.active").forEach((li) => li.classList.remove("active"));
  if (idx >= 0) {
    timelineEl.querySelector(`.seg[data-i="${idx}"]`)?.classList.add("active");
    previewEl.children[idx]?.classList.add("active");
    const t = tracks[idx];
    nowPlayingEl.textContent = `${t.title || "(untitled)"}${t.artist ? ` — ${t.artist}` : ""}`;
  } else {
    nowPlayingEl.textContent = "—";
  }
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
  // While preparing a preview, drive the inline preview bar instead of the run bar.
  if (preparingPreview) {
    const label = p.stage === "preview" ? "Converting to preview format" : "Downloading audio";
    prepBar.style.width = `${Math.max(2, p.pct)}%`;
    prepBar.classList.toggle("indeterminate", p.pct <= 0);
    prepMsg.textContent = p.pct > 0 ? `${label}… ${Math.round(p.pct)}%` : `${label}…`;
    return;
  }
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
  if (!tracks.some((t) => t.selected)) {
    setStatus("No tracks selected — tick at least one.", "err");
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
    setStatus(`Done — ${cfg.tracks.filter((t) => t.selected).length} tracks written.`, "ok");
    await refreshCacheSize();
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
  if (!on) updateSelection(); // restores the label + disabled state for the selection
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
