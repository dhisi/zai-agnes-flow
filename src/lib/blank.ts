/**
 * Browser-side blank-panel detection.
 *
 * The server rejects blanks by byte size and entropy, but a panel can still
 * come back visually empty (a flat black/grey wash). This decodes the image and
 * measures how much real variation the pixels carry: a flat frame has almost
 * none. Used both when a panel is generated (so it is re-rolled) and when the
 * encoder loads it (so a blank never reaches the video).
 */

/** Below this luminance standard deviation the frame is effectively flat. */
const MIN_STDDEV = 6;
/** Below this share of distinct luminance buckets the frame is effectively flat. */
const MIN_SPREAD = 0.06;

export type BlankStats = { blank: boolean; stddev: number; spread: number };

export function analyseBitmap(bmp: ImageBitmap | HTMLImageElement): BlankStats {
  const w = 64;
  const h = 36;
  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = (canvas as OffscreenCanvas | HTMLCanvasElement).getContext("2d", {
    willReadFrequently: true,
  }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) return { blank: false, stddev: 999, spread: 1 };
  ctx.drawImage(bmp as CanvasImageSource, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  const buckets = new Uint8Array(32);
  let sum = 0;
  let sumSq = 0;
  const n = w * h;
  for (let i = 0; i < data.length; i += 4) {
    const l = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
    sum += l;
    sumSq += l * l;
    buckets[Math.min(31, l >> 3)] = 1;
  }
  const mean = sum / n;
  const stddev = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  const spread = buckets.reduce((a, b) => a + b, 0) / 32;
  return { blank: stddev < MIN_STDDEV || spread < MIN_SPREAD, stddev, spread };
}

/** True when the image at `url` decodes to an effectively empty frame. */
export async function isBlankImageUrl(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { mode: "cors" });
    if (!res.ok) return true;
    const blob = await res.blob();
    if (blob.size < 4000) return true;
    // Decode straight to the 64x36 analysis size. Decoding hundreds of
    // full-resolution panels at native size is what exhausts tab memory on a
    // long run and eventually kills the page.
    const bmp = await createImageBitmap(blob, {
      resizeWidth: 64,
      resizeHeight: 36,
      resizeQuality: "low",
    });
    const stats = analyseBitmap(bmp);
    bmp.close();
    return stats.blank;
  } catch {
    // Can't inspect it (CORS/network) — don't throw away a probably-good panel.
    return false;
  }
}
