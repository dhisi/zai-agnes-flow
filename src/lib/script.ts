export type Segment = {
  index: number;
  start: number;
  end: number;
  text: string;
};

// The first field is intentionally unbounded: long scripts commonly continue
// MM:SS past 99 minutes (for example 120:19), as well as using HH:MM:SS.
// Brackets are optional and may be any common style — (0:05), [0:05], 【0:05】,
// or a bare 0:05 at the start of a line — so real-world scripts all parse.
// Fractional seconds (00:14.800) and ranges ([00:00.080 - 00:14.800]) are also
// accepted: the range's own end time is remembered for the final segment.
const TS = new RegExp(
  "[(\\[{（【]\\s*(\\d+):(\\d{2})(?::(\\d{2}))?(?:[.,](\\d{1,3}))?" +
    "(?:\\s*(?:-->|[-–—~])\\s*(\\d+):(\\d{2})(?::(\\d{2}))?(?:[.,](\\d{1,3}))?)?" +
    "\\s*[)\\]}）】]" +
    "|(?:^|[\\s—–-])(\\d+):(\\d{2})(?::(\\d{2}))?(?:[.,](\\d{1,3}))?(?=\\s|$)",
  "gm",
);

/** Timeline frame rate. Every duration is quantised to this grid so the encoder
 * cannot drift: round(dur * FPS) is then always exact. */
export const FPS = 30;
/** Shortest panel the encoders accept. Shorter spans are merged, never dropped. */
export const MIN_PANEL = 0.8;

export function quantise(t: number): number {
  return Math.round(t * FPS) / FPS;
}

function partsToSeconds(
  a: string,
  b: string,
  c: string | undefined,
  frac: string | undefined,
): number {
  const base =
    c !== undefined
      ? Number(a) * 3600 + Number(b) * 60 + Number(c)
      : Number(a) * 60 + Number(b);
  const ms = frac === undefined ? 0 : Number(frac.padEnd(3, "0")) / 1000;
  return base + ms;
}

function toSeconds(m: RegExpExecArray): number {
  const bracketed = m[1] !== undefined;
  return bracketed
    ? partsToSeconds(m[1]!, m[2]!, m[3], m[4])
    : partsToSeconds(m[9]!, m[10]!, m[11], m[12]);
}

/** End time when the mark is a range like [00:00.080 - 00:14.800]. */
function toEndSeconds(m: RegExpExecArray): number | null {
  if (m[5] === undefined) return null;
  return partsToSeconds(m[5]!, m[6]!, m[7], m[8]);
}

/**
 * Absolute final timestamp in the raw script. This is the authoritative video
 * runtime and deliberately does not depend on how many panels were generated.
 */
export function scriptEndTime(raw: string): number {
  TS.lastIndex = 0;
  let end = 0;
  let m: RegExpExecArray | null;
  while ((m = TS.exec(raw)) !== null) {
    for (const seconds of [toSeconds(m), toEndSeconds(m)]) {
      if (seconds !== null && Number.isFinite(seconds)) end = Math.max(end, seconds);
    }
  }
  return quantise(end);
}

/**
 * Parses a script of the form:
 *   (0:00)text... (0:05)
 *   more text (0:09)
 *
 * Every timestamp marks a boundary; the text between two boundaries is one
 * segment. Segments are strictly contiguous — one segment's `end` is always the
 * next segment's `start` — so the sum of all segment durations equals
 * (last timestamp − first timestamp) exactly. Nothing is ever dropped: a
 * boundary pair with no text is merged into the previous segment so its time
 * still belongs to the timeline.
 */
/** Rough spoken length of a line, used only where the script gives no mark. */
function estimateSpeech(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(4, Math.min(12, Math.round(words / 2.5)));
}

export function parseScript(raw: string): Segment[] {
  const marks: { at: number; time: number; len: number; endTime: number | null }[] = [];
  TS.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TS.exec(raw)) !== null) {
    const time = toSeconds(m);
    const prev = marks[marks.length - 1];
    // Non-increasing timestamps would break contiguity — keep the monotonic run.
    if (prev && time <= prev.time) continue;
    // A bare timestamp match may include the separator that preceded it; keep
    // that character with the previous segment's text.
    const lead = m[1] === undefined && /^[\s—–-]/.test(m[0]) ? 1 : 0;
    marks.push({ at: m.index + lead, time, len: m[0].length - lead, endTime: toEndSeconds(m) });
  }
  if (marks.length === 0) return [];

  type Raw = { start: number; end: number; text: string };
  const rawSegs: Raw[] = [];

  const push = (start: number, end: number, text: string) => {
    if (end <= start) return;
    if (!text) {
      // No dialogue in this span. One timestamp = one panel, ALWAYS: even a very
      // short span keeps its own image as a continuation beat of the previous line.
      const last = rawSegs[rawSegs.length - 1];
      if (last) {
        rawSegs.push({
          start,
          end,
          text: `Continuation of the same moment, camera holds on the scene: ${last.text}`,
        });
        return;
      }
      // leading gap before the first spoken line — keep it as an establishing beat
      rawSegs.push({ start, end, text: "Establishing shot of the story's opening setting." });
      return;
    }
    rawSegs.push({ start, end, text });
  };

  // Two layouts exist in the wild:
  //   leading  — "(0:05) text ... (0:13) text ..."  the mark opens its line
  //   trailing — "text ... (0:05)\ntext ... (0:13)" the mark closes its line
  // In the trailing layout the text BEFORE a mark is what is spoken up to it,
  // so attributing it to the following span shifts every panel one line late.
  // Decide once, from the whole script, then slice accordingly.
  const firstText = raw.slice(0, marks[0]!.at).replace(/\s+/g, " ").trim();
  const trailingHits = marks.filter((mk) =>
    /^[^\S\n]*$/.test(
      raw.slice(
        mk.at + mk.len,
        raw.indexOf("\n", mk.at) === -1 ? raw.length : raw.indexOf("\n", mk.at),
      ),
    ),
  ).length;
  const trailing = firstText.length > 0 && trailingHits > marks.length / 2;

  if (trailing) {
    // Segment i = the text that ends at mark i, spanning the previous mark → mark i.
    let prevTime = Math.max(0, marks[0]!.time - estimateSpeech(firstText));
    let cursor = 0;
    for (const mk of marks) {
      const text = raw.slice(cursor, mk.at).replace(/\s+/g, " ").trim();
      push(prevTime, mk.time, text);
      prevTime = mk.time;
      cursor = mk.at + mk.len;
    }
    const tailT = raw.slice(cursor).replace(/\s+/g, " ").trim();
    if (tailT) push(prevTime, prevTime + estimateSpeech(tailT), tailT);
  } else {
    for (let i = 0; i < marks.length - 1; i++) {
      const a = marks[i]!;
      const b = marks[i + 1]!;
      const text = raw
        .slice(a.at + a.len, b.at)
        .replace(/\s+/g, " ")
        .trim();
      push(a.time, b.time, text);
    }

    // Trailing text after the last timestamp (script may end without a closing mark).
    // A range mark carries its own end time, so use that rather than an estimate.
    const last = marks[marks.length - 1]!;
    const tail = raw
      .slice(last.at + last.len)
      .replace(/\s+/g, " ")
      .trim();
    if (tail) {
      const tailEnd =
        last.endTime !== null && last.endTime > last.time
          ? last.endTime
          : last.time + estimateSpeech(tail);
      push(last.time, tailEnd, tail);
    }
  }

  // NOTHING is merged: every timestamp span keeps its own segment, so the run
  // always produces exactly one image per timestamp. Spans shorter than one
  // panel are given the minimum panel length when the timeline is built.
  return rawSegs.map((s, i) => ({
    index: i,
    start: quantise(s.start),
    end: quantise(s.end),
    text: s.text,
  }));
}

/** Total runtime the finished video MUST have: last timestamp − first timestamp. */
export function scriptDuration(segments: { start: number; end: number }[]): number {
  if (segments.length === 0) return 0;
  const start = segments.reduce((m, s) => Math.min(m, s.start), segments[0]!.start);
  const end = segments.reduce((m, s) => Math.max(m, s.end), segments[0]!.end);
  return quantise(end - start);
}

export function fmt(t: number): string {
  const total = Math.max(0, Math.round(t));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export type PanelSource = {
  start: number;
  end: number;
  url?: string | undefined;
  prompt?: string | undefined;
};

export type Panel = { url: string; start: number; end: number; prompt?: string | undefined };

export type Timeline = {
  panels: Panel[];
  /** Exact runtime of the panel list — always equal to the script duration. */
  total: number;
  /** Panels whose own image was missing and reuse a neighbour's image. */
  substituted: number;
};

/**
 * Builds the video timeline from the generated shots.
 *
 * Contract (this is what keeps the video the same length as the script):
 *  1. Panels are strictly contiguous — no gaps, no overlaps.
 *  2. A shot whose image failed NEVER removes its time from the timeline; the
 *     nearest available image is shown across it instead, so a 1:55:04 script
 *     always exports as a 1:55:04 video.
 *  3. Every boundary is frame-aligned and every panel is at least MIN_PANEL
 *     long, so the encoders' round(dur * FPS) can't accumulate drift.
 */
export function buildTimeline(shots: PanelSource[], targetSeconds?: number): Timeline {
  const all = [...shots]
    .map((s) => ({ ...s, start: quantise(s.start), end: quantise(s.end) }))
    .sort((a, b) => a.start - b.start);
  if (all.length === 0) return { panels: [], total: 0, substituted: 0 };
  if (!all.some((s) => s.url)) return { panels: [], total: 0, substituted: 0 };

  // Video time starts at zero and ends at the raw script's last timestamp.
  // A target can therefore extend beyond incomplete/restored panel data without
  // losing the missing tail; the nearest available image simply holds over it.
  const t0 = 0;
  const panelEnd = all.reduce((m, s) => Math.max(m, s.end), all[0]!.end);
  // When the raw script supplied an explicit final timestamp it is absolute,
  // not a minimum. parseScript may give trailing text a provisional duration
  // so it can still generate its image, but that must never extend the video.
  const tEnd = quantise(targetSeconds === undefined ? panelEnd : targetSeconds);

  // 1. contiguous boundaries from the timestamps themselves
  const bounds: number[] = [];
  for (let i = 0; i < all.length; i++) bounds.push(i === 0 ? t0 : Math.min(tEnd, all[i]!.start));
  bounds.push(tEnd);

  // 2. resolve every panel's image: its own, else the nearest neighbour's
  let substituted = 0;
  const resolved: { url: string; prompt?: string | undefined }[] = [];
  for (let i = 0; i < all.length; i++) {
    const own = all[i]!;
    if (own.url) {
      resolved.push({ url: own.url, prompt: own.prompt });
      continue;
    }
    let pick: PanelSource | undefined;
    for (let b = i - 1; b >= 0; b--)
      if (all[b]!.url) {
        pick = all[b]!;
        break;
      }
    if (!pick)
      for (let f = i + 1; f < all.length; f++)
        if (all[f]!.url) {
          pick = all[f]!;
          break;
        }
    substituted++;
    resolved.push({ url: pick!.url as string, prompt: pick!.prompt });
  }

  // 3. lay them out. EVERY panel is kept — one image per timestamp, always.
  // A span shorter than MIN_PANEL is stretched to MIN_PANEL and later panels
  // shift forward, so no image is ever dropped from the video.
  const panels: Panel[] = [];
  let cursor = t0;
  for (let i = 0; i < resolved.length; i++) {
    const end = quantise(Math.max(bounds[i + 1]!, cursor + MIN_PANEL));
    panels.push({ url: resolved[i]!.url, start: cursor, end, prompt: resolved[i]!.prompt });
    cursor = end;
  }
  if (panels.length === 0) return { panels: [], total: 0, substituted };

  // 4. hard guarantee: first panel starts at t0, last ends at the script end
  // (or later, if minimum panel lengths pushed past it — never earlier).
  panels[0]!.start = t0;
  const lastPanel = panels[panels.length - 1]!;
  lastPanel.end = quantise(Math.max(tEnd, lastPanel.start + MIN_PANEL));

  return { panels, total: quantise(lastPanel.end - t0), substituted };
}

/** Sum of the panel durations exactly as the encoders will render them. */
export function timelineSeconds(panels: Panel[]): number {
  return quantise(panels.reduce((a, p) => a + Math.max(MIN_PANEL, p.end - p.start), 0));
}
