import type { CropRect } from "./api";

type Handle = "nw" | "ne" | "sw" | "se" | "move";
type Rect = { x: number; y: number; w: number; h: number };

/**
 * A draggable + corner-resizable crop rectangle drawn over an <img>. Coordinates are
 * kept in *displayed* pixels and converted to natural (source) pixels via getRect().
 *
 * A ResizeObserver keeps the overlay sized to the image — and, crucially, re-derives the
 * default box the moment the image gains a real size or the panel becomes visible, so the
 * centered square shows correctly on first load (no need to hit "Reset").
 */
export class CropBox {
  private img: HTMLImageElement;
  private overlay: HTMLDivElement;
  private box: HTMLDivElement;
  private rect: Rect = { x: 0, y: 0, w: 0, h: 0 }; // display px, relative to the image box
  square = true;
  private userAdjusted = false;
  private drag: { handle: Handle; sx: number; sy: number; start: Rect } | null = null;

  constructor(private container: HTMLElement, private onChange?: () => void) {
    this.container.classList.add("crop-container");
    this.img = document.createElement("img");
    this.img.className = "crop-img";
    this.overlay = document.createElement("div");
    this.overlay.className = "crop-overlay";
    this.box = document.createElement("div");
    this.box.className = "crop-box";
    for (const h of ["nw", "ne", "sw", "se"] as Handle[]) {
      const el = document.createElement("div");
      el.className = `crop-handle ${h}`;
      el.dataset.handle = h;
      this.box.appendChild(el);
    }
    this.overlay.appendChild(this.box);
    this.container.appendChild(this.img);
    this.container.appendChild(this.overlay);

    // Fires on image load, on window resize, AND when the panel un-hides (0 -> real size).
    new ResizeObserver(() => this.onResize()).observe(this.img);

    const onDown = (e: PointerEvent) => {
      const handle = ((e.target as HTMLElement).dataset.handle as Handle) || "move";
      this.drag = { handle, sx: e.clientX, sy: e.clientY, start: { ...this.rect } };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      e.preventDefault();
    };
    const onMove = (e: PointerEvent) => {
      if (!this.drag) return;
      this.userAdjusted = true;
      this.applyDrag(e.clientX - this.drag.sx, e.clientY - this.drag.sy);
      this.render();
      this.onChange?.();
    };
    this.box.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", () => (this.drag = null));
  }

  setImage(src: string) {
    this.userAdjusted = false; // a new image gets a fresh default box
    if (src) this.img.src = src;
    else this.img.removeAttribute("src"); // clear cleanly (no broken-image flash)
  }

  get hasImage() {
    return !!this.img.src && this.img.complete && this.img.naturalWidth > 0;
  }
  private dispW() {
    return this.img.clientWidth;
  }
  private dispH() {
    return this.img.clientHeight;
  }

  private onResize() {
    const w = this.dispW();
    const h = this.dispH();
    if (w === 0 || h === 0) return; // hidden / not laid out yet
    this.overlay.style.width = `${w}px`;
    this.overlay.style.height = `${h}px`;
    if (!this.userAdjusted) this.reset();
    else {
      this.clamp();
      this.render();
    }
  }

  /** Centered largest square (or full frame when square-lock is off). */
  reset() {
    this.userAdjusted = false;
    const W = this.dispW();
    const H = this.dispH();
    if (W === 0 || H === 0) return;
    if (this.square) {
      const s = Math.min(W, H);
      this.rect = { x: (W - s) / 2, y: (H - s) / 2, w: s, h: s };
    } else {
      this.rect = { x: 0, y: 0, w: W, h: H };
    }
    this.render();
    this.onChange?.();
  }

  setSquare(sq: boolean) {
    this.square = sq;
    this.reset();
  }

  private applyDrag(dx: number, dy: number) {
    const s = this.drag!.start;
    const W = this.dispW();
    const H = this.dispH();
    const MIN = 24;
    if (this.drag!.handle === "move") {
      this.rect.x = Math.min(Math.max(0, s.x + dx), W - s.w);
      this.rect.y = Math.min(Math.max(0, s.y + dy), H - s.h);
      return;
    }
    let { x, y, w, h } = s;
    const right = x + w;
    const bottom = y + h;
    const west = this.drag!.handle === "nw" || this.drag!.handle === "sw";
    const north = this.drag!.handle === "nw" || this.drag!.handle === "ne";
    if (west) {
      x = Math.min(Math.max(0, s.x + dx), right - MIN);
      w = right - x;
    } else {
      w = Math.min(Math.max(MIN, s.w + dx), W - x);
    }
    if (north) {
      y = Math.min(Math.max(0, s.y + dy), bottom - MIN);
      h = bottom - y;
    } else {
      h = Math.min(Math.max(MIN, s.h + dy), H - y);
    }
    if (this.square) {
      const side = Math.min(w, h);
      w = side;
      h = side;
      if (west) x = right - side;
      if (north) y = bottom - side;
    }
    this.rect = { x, y, w, h };
  }

  private clamp() {
    const W = this.dispW();
    const H = this.dispH();
    this.rect.w = Math.min(this.rect.w, W);
    this.rect.h = Math.min(this.rect.h, H);
    this.rect.x = Math.min(Math.max(0, this.rect.x), W - this.rect.w);
    this.rect.y = Math.min(Math.max(0, this.rect.y), H - this.rect.h);
  }

  private render() {
    this.box.style.left = `${this.rect.x}px`;
    this.box.style.top = `${this.rect.y}px`;
    this.box.style.width = `${this.rect.w}px`;
    this.box.style.height = `${this.rect.h}px`;
  }

  /** Crop rectangle in natural source pixels, or null if no image. */
  getRect(): CropRect | null {
    if (!this.hasImage) return null;
    const scaleX = this.img.naturalWidth / this.dispW();
    const scaleY = this.img.naturalHeight / this.dispH();
    return {
      x: Math.round(this.rect.x * scaleX),
      y: Math.round(this.rect.y * scaleY),
      w: Math.round(this.rect.w * scaleX),
      h: Math.round(this.rect.h * scaleY),
    };
  }
}
