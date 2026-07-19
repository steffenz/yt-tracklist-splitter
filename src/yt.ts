// Minimal wrapper around the YouTube IFrame Player API for the in-app preview.
// Lets the chapter list seek the video (player.seekTo). Loaded lazily on first use.

let player: any = null;
let apiReady: Promise<void> | null = null;

function loadApi(): Promise<void> {
  if (apiReady) return apiReady;
  apiReady = new Promise<void>((resolve, reject) => {
    const w = window as any;
    if (w.YT && w.YT.Player) return resolve();
    const prev = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    tag.onerror = () => reject(new Error("could not load the YouTube player"));
    document.head.appendChild(tag);
  });
  return apiReady;
}

/** Mount (or re-point) the player for `videoId` inside `container`. Cues (does not
 * autoplay) so the chapter list controls playback. Recreates the player if a UI reset
 * removed its iframe from the DOM. */
export async function mountPlayer(container: HTMLElement, videoId: string): Promise<void> {
  await loadApi();
  const w = window as any;
  const attached = player && player.getIframe && document.contains(player.getIframe());
  if (attached && player.cueVideoById) {
    player.cueVideoById({ videoId, startSeconds: 0 });
    return;
  }
  if (player && player.destroy) {
    try {
      player.destroy();
    } catch {
      /* ignore */
    }
    player = null;
  }
  const host = document.createElement("div");
  container.innerHTML = "";
  container.appendChild(host);
  await new Promise<void>((resolve) => {
    player = new w.YT.Player(host, {
      videoId,
      playerVars: { modestbranding: 1, rel: 0, playsinline: 1 },
      events: { onReady: () => resolve() },
    });
  });
}

/** Seek the preview to `seconds` and start playing. No-op if no player yet. */
export function seekTo(seconds: number): void {
  if (player && player.seekTo) {
    player.seekTo(Math.max(0, Math.floor(seconds)), true);
    player.playVideo?.();
  }
}

export function hasPlayer(): boolean {
  return !!player;
}
