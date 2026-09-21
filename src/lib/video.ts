/**
 * Video engine.
 *
 * Long scripts (100k+ chars -> 2h+ of runtime, thousands of shots) cannot be
 * encoded with ffmpeg.wasm: a single filter_complex with thousands of inputs
 * blows past the wasm heap and the software x264 encoder needs many hours.
 *
 * This engine instead renders every frame on a canvas and encodes with
 * WebCodecs (hardware H.264), muxing straight into an mp4. Memory stays flat:
 * one image in, one frame out, and — when the browser supports the File System
 * Access API — the mp4 is streamed to disk instead of being held in RAM, so a
 * multi-gigabyte 2-hour render never has to fit in memory.
 */

import { Muxer, ArrayBufferTarget, StreamTarget } from "mp4-muxer";
import { analyseBitmap } from "./blank";

export type Shot = { url: string; start: number; end: number; prompt?: string | undefined };

export type BuildResult = { kind: "blob"; blob: Blob } | { kind: "file"; fileName: string };

const W = 1920;
const H = 1080;
const FPS = 24;
/** Cross-fade length between two shots (seconds). */
const XF = 0.7;
/** Keyframe interval (seconds) — keeps the mp4 seekable without bloating it. */
const GOP = 2;

export function webCodecsSupported(): boolean {
  return typeof window !== "undefined" && typeof window.VideoEncoder === "function";
}

/* ------------------------------------------------------------------ */
/* Cinematography                                                      */
/* ------------------------------------------------------------------ */

function hash(i: number, salt: number): number {
  const x = Math.sin((i + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

type Move = { z0: number; z1: number; x0: number; x1: number; y0: number; y1: number };

/** Ken Burns moves: start/end zoom plus start/end focal point (0..1). */
const MOVES: Move[] = [
  { z0: 1.0, z1: 1.2, x0: 0.5, x1: 0.5, y0: 0.5, y1: 0.5 }, // push in
  { z0: 1.22, z1: 1.0, x0: 0.5, x1: 0.5, y0: 0.5, y1: 0.5 }, // pull back
  { z0: 1.14, z1: 1.14, x0: 0.0, x1: 1.0, y0: 0.5, y1: 0.5 }, // pan L->R
  { z0: 1.14, z1: 1.14, x0: 1.0, x1: 0.0, y0: 0.5, y1: 0.5 }, // pan R->L
  { z0: 1.14, z1: 1.14, x0: 0.5, x1: 0.5, y0: 0.0, y1: 1.0 }, // tilt down
  { z0: 1.14, z1: 1.14, x0: 0.5, x1: 0.5, y0: 1.0, y1: 0.0 }, // tilt up
  { z0: 1.02, z1: 1.24, x0: 0.3, x1: 0.28, y0: 0.3, y1: 0.22 }, // push to face TL
  { z0: 1.02, z1: 1.24, x0: 0.7, x1: 0.72, y0: 0.7, y1: 0.78 }, // push to BR
  { z0: 1.08, z1: 1.22, x0: 0.15, x1: 0.85, y0: 0.85, y1: 0.15 }, // diagonal drift
];

type Grade = { filter: string; tint: string; tintAlpha: number };

/**
 * No mood grade. The panels are rendered as clean, well-lit full-colour
 * webtoon pages and the video shows them exactly as drawn — the old dark
 * night/ember/dread/gloom tints are gone. A single very light contrast touch
 * keeps the encoded frames crisp; no colour tint is applied.
 */
const CLEAN_GRADE: Grade = {
  filter: "contrast(1.03) saturate(1.04)",
  tint: "#000000",
  tintAlpha: 0,
};

function gradeFor(_shot: Shot, _i: number): Grade {
  return CLEAN_GRADE;
}

/* ------------------------------------------------------------------ */
/* Image loading                                                       */
/* ------------------------------------------------------------------ */

async function loadBitmap(url: string, attempts = 3): Promise<ImageBitmap> {
  let last = "";
  for (let a = 0; a < attempts; a++) {
    try {
      const res = await fetch(`/api/proxy-image?url=${encodeURIComponent(url)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      if (blob.size < 4000) throw new Error("blank panel file");
      const bmp = await createImageBitmap(blob);
      if (isBlankBitmap(bmp)) {
        bmp.close();
        throw new Error("blank panel image");
      }
      return bmp;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
      await new Promise((r) => setTimeout(r, 400 * (a + 1)));
    }
  }
  throw new Error(`Could not load panel image: ${last}`);
}

/**
 * Blank-frame detector.
 *
 * Downsamples the panel to 32x18 and measures luminance spread. A real drawn
 * panel always has structure; a solid/near-solid frame has almost none, and
 * those are exactly the frames that used to end up in (or get skipped out of)
 * the video.
 */
function isBlankBitmap(img: ImageBitmap): boolean {
  try {
    const c = new OffscreenCanvas(32, 18);
    const g = c.getContext("2d", { alpha: false, willReadFrequently: true });
    if (!g) return false;
    g.drawImage(img, 0, 0, 32, 18);
    const { data } = g.getImageData(0, 0, 32, 18);
    let sum = 0;
    let sumSq = 0;
    const n = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      const l = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
      sum += l;
      sumSq += l * l;
    }
    const mean = sum / n;
    const sd = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
    // < 4 levels of spread over the whole frame == effectively a flat fill
    return sd < 4;
  } catch {
    return false;
  }
}

/**
 * Applies the colour grade ONCE per panel instead of once per frame.
 *
 * `ctx.filter` and the `overlay` composite pass are the two most expensive
 * canvas operations there are; running them on all ~216,000 frames of a 2-hour
 * render is what made encoding take hours. Baking them into the source bitmap
 * leaves the per-frame work at a single `drawImage`, with identical output.
 */
async function gradeBitmap(img: ImageBitmap, grade: Grade): Promise<ImageBitmap> {
  try {
    const c = new OffscreenCanvas(img.width, img.height);
    const g = c.getContext("2d", { alpha: false });
    if (!g) return img;
    g.filter = grade.filter;
    g.drawImage(img, 0, 0);
    g.filter = "none";
    if (grade.tintAlpha > 0) {
      g.globalAlpha = grade.tintAlpha;
      g.globalCompositeOperation = "overlay";
      g.fillStyle = grade.tint;
      g.fillRect(0, 0, img.width, img.height);
    }
    const out = c.transferToImageBitmap();
    img.close();
    return out;
  } catch {
    return img;
  }
}

function drawKenBurns(
  ctx: CanvasRenderingContext2D,
  img: ImageBitmap,
  move: Move,
  p: number,
  alpha: number,
) {
  const t = Math.min(1, Math.max(0, p));
  // ease-in-out so the camera never starts or stops abruptly
  const e = t * t * (3 - 2 * t);
  const zoom = move.z0 + (move.z1 - move.z0) * e;
  const fx = move.x0 + (move.x1 - move.x0) * e;
  const fy = move.y0 + (move.y1 - move.y0) * e;

  // cover-fit the source into 16:9, then crop the zoom window inside it
  const target = W / H;
  const src = img.width / img.height;
  let cw = img.width;
  let ch = img.height;
  if (src > target) cw = img.height * target;
  else ch = img.width / target;

  const vw = cw / zoom;
  const vh = ch / zoom;
  const ox = (img.width - cw) / 2 + (cw - vw) * fx;
  const oy = (img.height - ch) / 2 + (ch - vh) * fy;

  if (alpha >= 1) {
    ctx.drawImage(img, ox, oy, vw, vh, 0, 0, W, H);
    return;
  }
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(img, ox, oy, vw, vh, 0, 0, W, H);
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

type Opts = {
  /** Stream straight to a user-chosen file (required for very long videos). */
  fileHandle?: FileSystemFileHandle | undefined;
  /** Encoded width; long videos may be rendered at 1280x720 to stay realtime. */
  width?: number;
  height?: number;
  bitrate?: number;
  /**
   * Runtime the finished mp4 MUST have (the script's last timestamp). The
   * encoder pads the tail with the final frame if anything came up short, so
   * the video length always matches the script.
   */
  targetSeconds?: number;
};

export async function buildVideo(
  shots: Shot[],
  onProgress: (pct: number, note: string) => void,
  opts: Opts = {},
): Promise<BuildResult> {
  if (shots.length === 0) throw new Error("No panels to render.");
  if (!webCodecsSupported())
    throw new Error(
      "This browser cannot encode video. Use the latest Chrome, Edge or Opera on desktop.",
    );

  const width = opts.width ?? W;
  const height = opts.height ?? H;
  // Crisp output: generous bitrate so line art and screentones stay sharp.
  const bitrate = opts.bitrate ?? (width >= 1920 ? 16_000_000 : 8_000_000);

  const durations = shots.map((s) => Math.max(0, s.end - s.start));
  const panelSeconds = durations.reduce((a, b) => a + b, 0);
  // A single absolute frame count is the export's source of truth. Adding
  // independently rounded panel durations accumulates drift on long scripts.
  const requestedSeconds = opts.targetSeconds ?? panelSeconds;
  const targetFrames = Math.max(1, Math.round(requestedSeconds * FPS));
  const totalFrames = targetFrames;

  onProgress(1, "Starting encoder…");

  // ---- pick a codec the browser can actually encode -------------------------
  // H.264 first (universally playable); VP9 then AV1 as fallbacks so browsers
  // built without proprietary codecs can still export a valid mp4.
  const codecCandidates: { codec: string; mux: "avc" | "vp9" | "av1" }[] = [
    // High profile first — noticeably crisper at the same bitrate.
    { codec: "avc1.640034", mux: "avc" },
    { codec: "avc1.4d0034", mux: "avc" },
    { codec: "avc1.42003e", mux: "avc" },
    { codec: "avc1.42001f", mux: "avc" },
    { codec: "vp09.00.51.08", mux: "vp9" },
    { codec: "vp09.00.10.08", mux: "vp9" },
    { codec: "av01.0.08M.08", mux: "av1" },
  ];

  let chosen: { codec: string; mux: "avc" | "vp9" | "av1" } | null = null;
  for (const cand of codecCandidates) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec: cand.codec,
        width,
        height,
        bitrate,
        framerate: FPS,
      });
      if (support.supported) {
        chosen = cand;
        break;
      }
    } catch {
      /* try next */
    }
  }
  if (!chosen)
    throw new Error(
      "This browser has no usable video encoder. Use the latest desktop Chrome, Edge or Opera.",
    );

  // ---- muxer target: stream to disk when we have a file handle -------------
  //
  // A FileSystemWritableFileStream accepts exactly one write at a time. The
  // muxer emits data synchronously and often faster than the disk can take it,
  // so fire-and-forget writes overlap, the stream errors, and the render dies
  // at the end with "Cannot close a ERRORED writable stream" — the failure only
  // shows up on very long videos because that's when writes actually queue up.
  // Every chunk is therefore appended to a single promise chain and the first
  // failure is remembered so it can be reported properly.
  let writable: FileSystemWritableFileStream | null = null;
  let writeChain: Promise<void> = Promise.resolve();
  let writeError: Error | null = null;
  let muxer: Muxer<ArrayBufferTarget | StreamTarget>;

  if (opts.fileHandle) {
    writable = await opts.fileHandle.createWritable();
    const w = writable;
    muxer = new Muxer({
      target: new StreamTarget({
        onData: (data, position) => {
          // copy: the muxer reuses its buffer as soon as onData returns
          const buf = data.slice();
          writeChain = writeChain.then(async () => {
            if (writeError) return;
            try {
              await w.write({ type: "write", data: buf as unknown as BufferSource, position });
            } catch (e) {
              writeError = e instanceof Error ? e : new Error(String(e));
            }
          });
        },
        chunked: true,
      }),
      video: { codec: chosen.mux, width, height },
      fastStart: false,
    }) as Muxer<StreamTarget>;
  } else {
    muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: chosen.mux, width, height },
      fastStart: "in-memory",
    }) as Muxer<ArrayBufferTarget>;
  }

  let encoderError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      encoderError = e instanceof Error ? e : new Error(String(e));
    },
  });

  encoder.configure({
    codec: chosen.codec,
    width,
    height,
    bitrate,
    framerate: FPS,
    latencyMode: "quality",
  });

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false }) as CanvasRenderingContext2D;
  if (!ctx) throw new Error("Could not create a rendering canvas.");
  ctx.imageSmoothingQuality = "high";

  // Ken Burns math is written against a 16:9 stage; scale the draw calls.
  const sx = width / W;
  const sy = height / H;

  let frameIndex = 0;
  const started = Date.now();
  let lastNote = 0;

  // Back-pressure: keep the hardware encoder fed but never let the queue grow
  // unbounded. `ondequeue` wakes us the instant a frame leaves the queue, which
  // is far faster than polling on a 4ms timer over hundreds of thousands of
  // frames.
  const MAX_QUEUE = 16;
  let wake: (() => void) | null = null;
  encoder.ondequeue = () => {
    if (wake && encoder.encodeQueueSize <= MAX_QUEUE / 2) {
      const w = wake;
      wake = null;
      w();
    }
  };
  const flushGate = async () => {
    if (encoder.encodeQueueSize <= MAX_QUEUE) return;
    await new Promise<void>((resolve) => {
      wake = resolve;
      // safety net in case the encoder never fires ondequeue
      setTimeout(() => {
        if (wake === resolve) {
          wake = null;
          resolve();
        }
      }, 250);
    });
  };

  // pick a distinct camera move per shot
  const moves: Move[] = [];
  let lastMove = -1;
  for (let i = 0; i < shots.length; i++) {
    let mi = Math.floor(hash(i, 3) * MOVES.length) % MOVES.length;
    if (mi === lastMove) mi = (mi + 1 + Math.floor(hash(i, 9) * 3)) % MOVES.length;
    lastMove = mi;
    moves.push(MOVES[mi]!);
  }

  /** Loads a panel and bakes its colour grade in — once, not per frame. */
  const loadGraded = async (i: number): Promise<ImageBitmap> => {
    const raw = await loadBitmap(shots[i]!.url);
    // reject a visually empty panel so loadGradedSafe substitutes a neighbour
    if (analyseBitmap(raw).blank) {
      raw.close?.();
      throw new Error("blank panel");
    }
    return gradeBitmap(raw, gradeFor(shots[i]!, i));
  };

  /**
   * Never let one unusable panel abort or shorten the render: fall back to a
   * neighbouring panel's image so the timeline stays intact.
   */
  const loadGradedSafe = async (i: number): Promise<ImageBitmap | null> => {
    for (const j of [i, i + 1, i - 1, i + 2, i - 2]) {
      if (j < 0 || j >= shots.length) continue;
      try {
        return await loadGraded(j);
      } catch {
        /* try the next candidate */
      }
    }
    return null;
  };

  let current: ImageBitmap | null = null;
  let next: Promise<ImageBitmap> | null = null;

  try {
    current = await loadGradedSafe(0);
    if (!current) throw new Error("None of the panel images could be loaded.");

    for (let i = 0; i < shots.length; i++) {
      if (encoderError) throw encoderError;
      // hard cap: never write past the script's exact runtime
      if (frameIndex >= targetFrames) break;

      const dur = durations[i]!;
      // Allocate from absolute timestamp boundaries rather than summing rounded
      // durations. The final panel is pinned to the exact requested frame.
      const absoluteEnd =
        i === shots.length - 1
          ? targetFrames
          : Math.max(0, Math.min(targetFrames, Math.round(shots[i]!.end * FPS)));
      const frames = Math.max(0, absoluteEnd - frameIndex);
      const move = moves[i]!;

      // prefetch the next panel while this one renders
      next = i + 1 < shots.length ? loadGraded(i + 1) : null;
      let incoming: ImageBitmap | null = null;
      let incomingReady = false;
      if (next) {
        void next
          .then((b) => {
            incoming = b;
            incomingReady = true;
          })
          .catch(() => {
            incomingReady = true;
          });
      }

      const fadeStart = Math.max(0, dur - XF);

      for (let f = 0; f < frames; f++) {
        if (frameIndex >= targetFrames) break;
        const t = f / FPS;

        // the shot's own move runs over its duration plus the outgoing fade
        const p = t / (dur + (i < shots.length - 1 ? XF : 0));

        ctx.save();
        ctx.scale(sx, sy);
        drawKenBurns(ctx, current!, move, p, 1);

        if (i < shots.length - 1 && t >= fadeStart) {
          if (!incomingReady) {
            // the next image is still downloading — wait rather than skip it
            await next!.then(
              (b) => {
                incoming = b;
                incomingReady = true;
              },
              () => {
                incomingReady = true;
              },
            );
          }
          if (incoming) {
            const a = Math.min(1, (t - fadeStart) / XF);
            const nMove = moves[i + 1]!;
            const nDur = durations[i + 1]! + XF;
            drawKenBurns(ctx, incoming, nMove, (t - fadeStart) / nDur, a);
          }
        }
        ctx.restore();

        const frame = new VideoFrame(canvas, {
          timestamp: Math.round((frameIndex * 1_000_000) / FPS),
          duration: Math.round(1_000_000 / FPS),
        });
        await flushGate();
        encoder.encode(frame, { keyFrame: frameIndex % (FPS * GOP) === 0 });
        frame.close();
        frameIndex++;

        if (Date.now() - lastNote > 500) {
          lastNote = Date.now();
          const pct = frameIndex / totalFrames;
          const elapsed = (Date.now() - started) / 1000;
          const eta = pct > 0.002 ? Math.round(elapsed / pct - elapsed) : 0;
          onProgress(
            Math.min(99, Math.round(pct * 100)),
            `Encoding ${Math.round(pct * 100)}% · shot ${i + 1}/${shots.length}` +
              (eta ? ` · ~${fmtEta(eta)} left` : ""),
          );
          // yield to the UI thread
          await new Promise((r) => setTimeout(r, 0));
          if (writable) {
            // drain pending disk writes so the queue can never run away on a
            // multi-hour render, and surface a disk failure where it happened
            await writeChain;
            if (writeError) throw writeError;
          }
        }
        if (encoderError) throw encoderError;
      }

      if (i + 1 >= shots.length) {
        current?.close();
        current = null;
      } else {
        const upcoming =
          (incoming as ImageBitmap | null) ??
          (next ? await next.catch(() => null) : null) ??
          (await loadGradedSafe(i + 1));
        if (upcoming) {
          current?.close();
          current = upcoming;
        }
        // else: nothing loadable — hold this frame across the next panel so its
        // time still lands in the video instead of being skipped.
      }
    }

    // Length guarantee: if anything came up short of the script's runtime, hold
    // the last rendered frame until the exact target length is reached.
    if (targetFrames > frameIndex) {
      onProgress(99, "Matching video length to the script…");
      while (frameIndex < targetFrames) {
        const frame = new VideoFrame(canvas, {
          timestamp: Math.round((frameIndex * 1_000_000) / FPS),
          duration: Math.round(1_000_000 / FPS),
        });
        await flushGate();
        encoder.encode(frame, { keyFrame: frameIndex % (FPS * GOP) === 0 });
        frame.close();
        frameIndex++;
        if (encoderError) throw encoderError;
      }
    }

    onProgress(99, "Finalising file…");

    await encoder.flush();
    if (encoderError) throw encoderError;
    muxer.finalize();

    if (writable) {
      // every queued chunk must land before the stream is closed
      await writeChain;
      if (writeError) throw writeError;
      await writable.close();
      writable = null;
      onProgress(100, "Video saved");
      return { kind: "file", fileName: opts.fileHandle!.name };
    }

    const target = muxer.target as ArrayBufferTarget;
    onProgress(100, "Video ready");
    return {
      kind: "blob",
      blob: new Blob([target.buffer as ArrayBuffer], { type: "video/mp4" }),
    };
  } catch (e) {
    try {
      encoder.close();
    } catch {
      /* already closed */
    }
    if (writable) {
      // an errored stream cannot be closed — abort releases the file lock
      await writeChain.catch(() => {});
      await writable.abort().catch(() => {});
    }
    throw e instanceof Error ? e : new Error(String(e));
  } finally {
    current?.close();
  }
}

function fmtEta(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
