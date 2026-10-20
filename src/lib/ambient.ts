// Ambient art colour (docs/DESIGN.md): the dominant colour of a skin cover, sampled in the webview and used as a
// soft, low-chroma glow behind the open shelf, the A2 header and the A3 detail. Sampling never blocks rendering and
// fails quietly: a tainted canvas or a broken image just means no glow.
import { useEffect, useState } from "react";

export type Rgb = [number, number, number];

/** sRGB (0-255) to OKLCH. `h` is in degrees. */
export function rgbToOklch([r, g, b]: Rgb): { l: number; c: number; h: number } {
  const lin = (v: number) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const Bo = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  let h = (Math.atan2(Bo, A) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c: Math.hypot(A, Bo), h };
}

/**
 * Glow colours sit at one low lightness with capped chroma: the glow tints by hue, not by brightness, so --text-3
 * laid over its peak (mixed at most 55% into --surface-2) still clears 4.5:1.
 */
export const GLOW_L = 0.3;
export const GLOW_MAX_C = 0.09;

/**
 * Dominant colour of RGBA pixel data as a glow-safe OKLCH string, or null for a grey image.
 * A chroma-weighted average in OKLab: vivid pixels count most, near-black and near-white pixels barely count, so a
 * subject's colour wins over a dark background.
 */
export function ambientFromPixels(data: ArrayLike<number>): string | null {
  let sa = 0;
  let sb = 0;
  let sw = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    const alpha = data[i + 3] / 255;
    if (alpha < 0.5) continue;
    const { l, c, h } = rgbToOklch([data[i], data[i + 1], data[i + 2]]);
    const tone = l < 0.12 || l > 0.97 ? 0.1 : 1;
    const w = tone * alpha * (0.02 + c);
    const rad = (h * Math.PI) / 180;
    sa += Math.cos(rad) * c * w;
    sb += Math.sin(rad) * c * w;
    sw += w;
  }
  if (!sw) return null;
  const a = sa / sw;
  const b = sb / sw;
  const c = Math.hypot(a, b);
  if (c < 0.012) return null;
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return `oklch(${GLOW_L} ${Math.min(GLOW_MAX_C, c * 0.9).toFixed(3)} ${h.toFixed(1)})`;
}

const MAX_CACHED = 300;
const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

function whenIdle(fn: () => void) {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(fn, { timeout: 400 });
  else setTimeout(fn, 16);
}

function read(img: HTMLImageElement): string | null {
  try {
    const w = 24;
    const h = 32;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    return ambientFromPixels(ctx.getImageData(0, 0, w, h).data);
  } catch {
    // a cross-origin (tainted) canvas throws on getImageData: no glow, nothing else changes
    return null;
  }
}

/** Sample one cover. Cached per URL; concurrent calls share one load. */
export function sampleAmbient(url: string): Promise<string | null> {
  if (cache.has(url)) return Promise.resolve(cache.get(url) ?? null);
  const running = inflight.get(url);
  if (running) return running;
  const p = new Promise<string | null>((resolve) => {
    const img = new Image();
    // the Tauri asset protocol answers with CORS headers; data: and blob: URLs are same-origin anyway
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => whenIdle(() => resolve(read(img)));
    img.onerror = () => resolve(null);
    img.src = url;
  }).then((color) => {
    inflight.delete(url);
    cache.set(url, color);
    if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
    return color;
  });
  inflight.set(url, p);
  return p;
}

/**
 * The ambient colour for a cover URL. Returns the cached colour straight away when there is one; while a new cover
 * is sampled it keeps returning the previous colour, so the glow crossfades from old to new instead of dipping out.
 */
export function useAmbient(url: string | null | undefined): string | null {
  const [last, setLast] = useState<string | null>(null);
  useEffect(() => {
    if (!url) return;
    let live = true;
    void sampleAmbient(url).then((color) => {
      if (live) setLast(color);
    });
    return () => {
      live = false;
    };
  }, [url]);
  if (!url) return null;
  return cache.has(url) ? (cache.get(url) ?? null) : last;
}
