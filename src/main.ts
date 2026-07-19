import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, onLog, onProgress, type JobConfig, type Track, type TracklistCandidate, type VideoInfo } from "./api";
import { CropBox } from "./crop";
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
        <h2><span class="step">2</span> Tracklist</h2>
        <div id="tlFeedback" class="feedback"></div>
        <div id="candidates" class="candidates"></div>
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
          <div class="tl-right">
            <label class="lbl">Parsed preview — <span id="trackCount">0</span> tracks</label>
            <ol id="preview" class="preview"></ol>
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
        <pre id="log" class="log hidden"></pre>
      </section>
    </section>
  </main>
`;

// ---- element handles ---------------------------------------------------------
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const urlEl = $<HTMLInputElement>("#url");
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

// ---- yt-dlp version + maintenance -------------------------------------------
api.ytdlpVersion().then((v) => ($("#ytdlpVer").textContent = `yt-dlp ${v}`)).catch(() => {});
$("#btnClearCache").addEventListener("click", async () => {
  const n = await api.clearCache();
  setStatus(`Cleared ${n} cached file(s).`, "ok");
});

// ---- step 1: fetch -----------------------------------------------------------
$("#btnFetch").addEventListener("click", doFetch);
urlEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doFetch();
});

async function doFetch() {
  const url = urlEl.value.trim();
  if (!url) return;
  setStatus("Fetching video info and scanning comments… (this can take a few seconds)");
  workArea.classList.add("hidden");
  try {
    info = await api.fetchInfo(url);
  } catch (e) {
    setStatus(String(e), "err");
    return;
  }
  setStatus(`Loaded “${info.title}”.`, "ok");
  renderVideoInfo(info);
  albumEl.value = info.title;
  albumArtistEl.value = info.uploader;
  buildFormatOptions(info.native_ext);
  outdirEl.value = await api.defaultOutputDir(info.title).catch(() => "");
  // cover
  coverMode = "youtube";
  ($(`input[name=coverMode][value=youtube]`) as HTMLInputElement).checked = true;
  await loadYoutubeThumb();
  // tracklist detection
  await detect();
  workArea.classList.remove("hidden");
  workArea.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderVideoInfo(v: VideoInfo) {
  videoInfoEl.classList.remove("hidden");
  videoInfoEl.innerHTML = /* html */ `
    <img src="${v.thumbnail_url}" alt="" />
    <div>
      <div class="vtitle">${escapeHtml(v.title)}</div>
      <div class="muted">${escapeHtml(v.uploader)} · ${hms(v.duration)} · ${v.comments.length} comments scanned</div>
    </div>`;
}

function buildFormatOptions(nativeExt: string) {
  const opts = [
    { value: "native", label: `Native — no re-encode (${nativeExt})` },
    { value: "m4a", label: "m4a (AAC)" },
    { value: "mp3", label: "mp3" },
    { value: "opus", label: "opus" },
    { value: "flac", label: "flac (lossless container)" },
    { value: "wav", label: "wav" },
  ];
  formatEl.innerHTML = opts.map((o) => `<option value="${o.value}">${o.label}</option>`).join("");
}

// ---- step 2: tracklist detection + live parse -------------------------------
async function detect() {
  candidatesEl.innerHTML = "";
  if (!info) return;
  const cands = await api.detect(info);
  if (cands.length === 0) {
    tlFeedback.className = "feedback warn";
    tlFeedback.textContent =
      "No tracklist detected in the description or top comments. Paste one below — it parses as you type.";
    tlText.value = "";
    await reparse();
    return;
  }
  tlFeedback.className = "feedback ok";
  tlFeedback.textContent =
    cands.length === 1
      ? `Found a tracklist in the ${cands[0].source_kind === "description" ? "description" : "comments"}.`
      : `Found ${cands.length} possible tracklists — pick the right one (best match selected).`;
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
        `<li><span class="pt">${hms(t.start)}</span> <span class="ptitle">${escapeHtml(
          t.title || "(untitled)"
        )}</span>${t.artist ? ` <span class="partist">— ${escapeHtml(t.artist)}</span>` : ""}</li>`
    )
    .join("");
}

// ---- step 3: cover -----------------------------------------------------------
document.querySelectorAll<HTMLInputElement>("input[name=coverMode]").forEach((r) =>
  r.addEventListener("change", async () => {
    coverMode = r.value as typeof coverMode;
    const wrap = $("#cropWrap");
    wrap.classList.toggle("disabled", coverMode === "none");
    if (coverMode === "youtube") await loadYoutubeThumb();
    else if (coverMode === "custom" && customImagePath) crop.setImage(convertFileSrc(customImagePath));
  })
);
squareEl.addEventListener("change", () => crop.setSquare(squareEl.checked));
$("#btnResetCrop").addEventListener("click", () => crop.reset());
$("#btnPickImage").addEventListener("click", pickImage);

async function loadYoutubeThumb() {
  if (!info) return;
  try {
    const path = await api.getThumbnail(urlEl.value.trim(), info.id);
    crop.setImage(convertFileSrc(path));
  } catch (e) {
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
onLog((line) => {
  logEl.classList.remove("hidden");
  logEl.textContent += line + "\n";
  logEl.scrollTop = logEl.scrollHeight;
});

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

  logEl.textContent = "";
  setRunning(true);
  try {
    lastOutdir = await api.runJob(cfg);
    progressMsg.textContent = "Done ✓";
    btnReveal.classList.remove("hidden");
    setStatus(`Done — ${tracks.length} tracks written.`, "ok");
  } catch (e) {
    progressMsg.textContent = String(e);
    setStatus(String(e), "err");
  } finally {
    setRunning(false);
  }
}

function setRunning(on: boolean) {
  btnRun.disabled = on;
  btnCancel.classList.toggle("hidden", !on);
  if (on) {
    btnReveal.classList.add("hidden");
    bar.style.width = "2%";
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
