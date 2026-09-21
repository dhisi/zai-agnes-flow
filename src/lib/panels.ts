/**
 * Panel layout + speech balloons.
 *
 * Three things the storyboard writer now decides per script line, appended to its
 * picture prompt as a strict machine-readable tail:
 *
 *   ... prompt body ... || FRAMES: 2 || BEATS: 1) ... ; 2) ... || DIALOGUE: 1) Ravi: "Run!" ; 2) NONE || NARRATION: 1) That night... ; 2) NONE
 *
 * FRAMES is how many comic frames that ONE timestamp is drawn as. It follows
 * the timestamp's own length and its own number of story beats, so a short
 * timestamp stays a single frame and no frame is ever padded in to fill a grid.
 *
 * DIALOGUE is the spoken line translated into short, natural ENGLISH, which the
 * image model letters into a proper speech balloon. Lines with no speech get
 * NONE and stay wordless.
 *
 * NARRATION preserves the remaining story text as short, natural ENGLISH in a
 * rectangular webtoon story box. It is separate from speech and never gains a
 * balloon tail.
 *
 * The tail is parsed off before the prompt body is sanitised (the sanitiser
 * deliberately removes every mention of text and balloons from the body, since
 * only this module is allowed to ask for lettering).
 */

export type Bubble = {
  /** Who speaks, when the writer named them. */
  speaker: string;
  /** Short English line to letter, already translated. */
  text: string;
};

export type PanelPlan = {
  /** The picture prompt with the tail removed. */
  body: string;
  /** 1 to 4. */
  frames: number;
  /** One short sub-action per frame (only for multi-frame timestamps). */
  beats: string[];
  /** One entry per frame; an empty text means that frame is silent. */
  bubbles: Bubble[];
  /** One translated story-box caption per frame; empty means no narration. */
  narration: string[];
};

export const MAX_FRAMES = 4;

/**
 * Frame budget from the timestamp's own duration. Short timestamps are always
 * one frame; longer timestamps may use progressively richer page structures.
 */
export function frameCeiling(durationSeconds: number): number {
  const d = Number.isFinite(durationSeconds) ? durationSeconds : 0;
  if (d < 5) return 1;
  if (d < 9) return 2;
  if (d < 15) return 3;
  return MAX_FRAMES;
}

function storyBeats(source: string): string[] {
  const clean = source.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences = clean
    .split(/(?<=[.!?।])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 2);
  if (sentences.length > 1) return sentences;
  return clean
    .split(/\s+(?:and then|then|after that|suddenly|but then|फिर|तभी|इसके बाद|और फिर)\s+/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 2);
}

function visualBeatFallback(body: string): string[] {
  const clauses = body
    .split(/(?<=[.!?])\s+|;\s+|,\s+(?=(?:then|before|after|while|as|and)\b)/i)
    .map((part) => part.trim().replace(/[.;,]+$/, ""))
    .filter((part) => part.length > 8);
  return clauses.length > 0 ? clauses : [body];
}

const SPLIT = /\|\|/;

function splitList(raw: string): string[] {
  // "1) first ; 2) second" -> ["first", "second"]
  const parts = raw
    .split(/\s*;\s*|\s*\|\s*/)
    .map((p) => p.replace(/^\s*(?:frame\s*)?\d+\s*[).:-]\s*/i, "").trim())
    .filter((p) => p.length > 0);
  return parts;
}

function parseBubble(raw: string): Bubble {
  const value = raw.trim();
  if (!value || /^none$|^silent$|^-$/i.test(value)) return { speaker: "", text: "" };
  // Ravi: "Run now!"  |  Ravi says: Run now!  |  "Run now!"
  const m = /^([^:"'“”]{1,40}?)\s*(?:says?)?\s*:\s*(.+)$/.exec(value);
  const speaker = m ? m[1]!.trim() : "";
  const spoken = (m ? m[2]! : value).trim().replace(/^["'“”]+|["'“”]+$/g, "").trim();
  if (!spoken || /^none$/i.test(spoken)) return { speaker: "", text: "" };
  // Balloons hold a line, not a paragraph.
  const words = spoken.split(/\s+/);
  const clipped = words.length > 14 ? `${words.slice(0, 14).join(" ")}` : spoken;
  return { speaker, text: clipped.replace(/\s+/g, " ") };
}

function parseNarration(raw: string): string {
  const value = raw.trim().replace(/^['“”]+|['“”]+$/g, "").trim();
  if (!value || /^none$|^silent$|^-$/i.test(value)) return "";
  const words = value.split(/\s+/);
  return (words.length > 22 ? words.slice(0, 22).join(" ") : value).replace(/\s+/g, " ");
}

/**
 * Reads the writer's tail off a prompt, wherever it sits. The writer sometimes
 * drops the tail in the MIDDLE of the prompt (before the location lock), so each
 * tail value is cut at its own sentence end and whatever followed is handed back
 * to the picture body instead of being lettered into a balloon.
 *
 * A prompt without a tail (older cached prompts, repairs, manual edits) is simply
 * a silent single frame — exactly how this app behaved before.
 */
export function parsePanelPlan(
  written: string,
  durationSeconds?: number,
  sourceText?: string,
): PanelPlan {
  let frames = 1;
  let beats: string[] = [];
  let bubbles: Bubble[] = [];
  let narration: string[] = [];
  const leftovers: string[] = [];

  // "|| KEY: value" up to the next "||" or the end of the line.
  const body = written
    .replace(/\|\|\s*(FRAMES|BEATS|DIALOGUE|NARRATION)\s*:\s*([^|]*)/gi, (_all, rawKey: string, rawValue: string) => {
      const key = rawKey.toUpperCase();
      let value = rawValue.trim();
      // A value never runs into the next instruction sentence: cut at the first
      // ". Capitalised…" that is not part of a "1) …" list item.
      const cut = /[.?!]\s+(?=[A-Z][A-Za-z]{2,})/.exec(value);
      if (cut && cut.index !== undefined) {
        leftovers.push(value.slice(cut.index + 1).trim());
        value = value.slice(0, cut.index).trim();
      }
      if (key === "FRAMES") {
        const n = Number.parseInt(value.replace(/\D+/g, ""), 10);
        if (Number.isFinite(n)) frames = n;
      } else if (key === "BEATS") {
        beats = splitList(value);
      } else if (key === "DIALOGUE") {
        bubbles = splitList(value).map(parseBubble);
      } else if (key === "NARRATION") {
        narration = splitList(value).map(parseNarration);
      }
      return " ";
    })
    .concat(leftovers.length ? ` ${leftovers.join(" ")}` : "")
    .replace(/\s{2,}/g, " ")
    .trim();

  // A long timestamp with several written story moments must remain a
  // multi-frame page even when the free storyboard model mistakenly says 1.
  // A genuinely single-moment timestamp remains one frame at every duration.
  const ceiling = durationSeconds === undefined ? MAX_FRAMES : frameCeiling(durationSeconds);
  const sourceMoments = storyBeats(sourceText ?? "");
  const required = sourceMoments.length > 1 ? Math.min(ceiling, sourceMoments.length) : 1;
  frames = Math.max(required, Math.min(frames, ceiling, MAX_FRAMES));
  frames = Math.min(frames, ceiling, MAX_FRAMES);
  if (frames === 1) beats = [];
  else {
    const fallback = visualBeatFallback(body);
    while (beats.length < frames) {
      const next = fallback[beats.length] ?? fallback[fallback.length - 1];
      beats.push(next ?? `the next consecutive moment of the same action`);
    }
    beats = beats.slice(0, frames);
  }
  bubbles = bubbles.slice(0, frames);
  narration = narration.slice(0, frames);

  return { body, frames, beats, bubbles, narration };
}


const ORDINAL = ["first", "second", "third", "fourth"];

/** Small stable hash so the same panel always gets the same layout. */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/**
 * Dynamic manhwa page layouts — never a plain equal grid. Each option is a real
 * published-webtoon composition: floating crops, offset frames, dramatic white
 * pacing, uneven weights, one dominant frame, and art that breaks a border.
 */
const SINGLE_FRAME_COMPOSITIONS = [
  "a deliberately off-centre cinematic composition with the subject anchored in one third, a strong foreground occluder creating depth, and meaningful open background space balancing the action",
  "an intimate cropped composition that isolates the story's most expressive detail while environmental edges and directional light still identify the location",
  "a bold low-angle composition with exaggerated foreground scale, converging background perspective and the subject breaking the implied picture edge",
  "a tense high-angle composition with the subject small and displaced from centre, architecture or terrain forming graphic leading lines around them",
  "a layered over-the-shoulder composition with a large soft foreground silhouette, the decisive interaction in the middle distance and clear location detail behind it",
  "a dynamic Dutch-angle composition with a sweeping diagonal action path, asymmetric negative space and foreground elements cropped by the picture edge",
  "a quiet wide composition using generous breathing room, a small expressive figure and environmental storytelling arranged in a strong asymmetrical balance",
  "an extreme close-up crop selected from the exact emotional or physical detail that carries this beat, with bold partial forms entering from two image edges",
  "a deep three-plane composition with a sharply cropped foreground prop, the active subject crossing the middle plane and a distant landmark completing the visual path",
  "a centered iconic reveal framed by surrounding architecture, cloth, foliage or energy as a natural vignette, with dramatic scale contrast and clean silhouette",
];

const LAYOUTS: Record<number, string[]> = {
  2: [
    "exactly 2 unequal cinematic horizontal frames: a shallow letterbox establishing strip above one huge dominant action frame, separated by a thick white diagonal gutter with crisp black edge lines; the lower action and energy break beyond its border into the gutter",
    "exactly 2 unequal frames divided by one steep white diagonal gutter: a compact upper reaction frame and a dominant lower impact frame occupying most of the canvas, with foreground debris and energy crossing the lower border",
    "exactly 2 frames: one large full-width action frame with a narrow tilted close-up strip cutting across its top edge, thick clean white gutter, strong top-to-bottom reading flow and a border-breaking subject",
    "exactly 2 separated floating frames on a clean white webtoon page: a smaller upper-right detail crop followed after generous vertical breathing room by a much larger lower-left emotional close-up; offset edges, different widths and no rigid alignment",
    "exactly 2 radically different views: a dominant near-square interaction frame pushed to the upper-left and a narrow panoramic reaction frame low on the page, linked by gaze direction across a broad white pause",
    "exactly 2 frames with a tall narrow reveal intruding beside a wide low action panel; one border is broken by hair, cloth, weapon or energy, while the clean white gutter creates a dramatic reading beat",
  ],
  3: [
    "exactly 3 unequal horizontal webtoon frames stacked vertically: a shallow wide establishing strip, a larger full-width power-up frame, then a huge tilted climax frame occupying nearly half the canvas; bold black frame edges, thick white diagonal gutters, effects breaking across the final border",
    "exactly 3 staggered horizontal bands of clearly different heights: narrow reaction, broad action, dominant impact; each boundary slants in a different direction, leaving clean white gutters while speed lines and debris bridge the action panels",
    "exactly 3 frames with a slim panoramic top strip, a medium diagonal middle strip and an oversized bottom splash frame; maintain an effortless vertical reading path, deep cinematic crops and one subject breaking the final frame edge",
    "exactly 3 floating panels with generous white vertical spacing: a small off-centre detail crop, a broad conversational frame, then an oversized extreme close-up shifted toward the opposite edge; every panel has a different width and crop",
    "exactly 3 asymmetrical frames built around one borderless central character reveal: a narrow environmental strip above and a tilted reaction inset below, with the central figure extending into the white gutter without becoming a collage",
    "exactly 3 panels in a zigzag reading rhythm: compact upper-left reaction, long diagonal middle action panel and large lower-right consequence frame, with strong directional gaze and motion connecting them",
  ],
  4: [
    "exactly 4 unequal frames in a vertical action rhythm: a thin panoramic setup strip, two compact angled progression frames, then one enormous bottom climax frame; thick white gutters, black edge lines, diagonal cuts and effects crossing only into the gutters",
    "exactly 4 staggered cinematic bands wrapped around one dominant diagonal action frame, with three smaller reaction and detail strips; strong vertical reading order, broad white gutters and a border-breaking focal figure",
    "exactly 4 asymmetric frames of dramatically unequal scale: two narrow setup strips, one medium escalation frame and one huge impact splash; steep diagonal white gutters, bold black edges, flying debris and energy extending beyond the climax border",
    "exactly 4 floating webtoon frames paced with broad white gaps: tiny detail, medium reaction, narrow movement strip and enormous emotional payoff; offset left-right alignment and no repeated frame dimensions",
    "exactly 4 frames orbiting one dominant borderless action figure: two slim close-up fragments above, one tilted environmental frame behind and one wide consequence panel below, with a clear top-to-bottom path",
    "exactly 4 irregular panels using alternating tall and wide crops: a vertical reveal, a tiny eye or hand detail, a sweeping diagonal action panel and a broad quiet aftermath frame, each separated by clean white space",
  ],
};

function layoutOf(frames: number, key: string): string {
  const options = LAYOUTS[Math.min(4, Math.max(2, frames))] ?? LAYOUTS[2]!;
  return options[hash(key) % options.length]!;
}

function singleComposition(key: string): string {
  return SINGLE_FRAME_COMPOSITIONS[hash(key) % SINGLE_FRAME_COMPOSITIONS.length]!;
}

function balloonFor(b: Bubble, where: string): string {
  const who = b.speaker ? `${b.speaker}'s` : "the speaking character's";
  return (
    `${where} draw one clean white manhwa speech balloon with a smooth bold black outline and a pointed tail aimed at ` +
    `${who} mouth, placed over empty background so it covers no face, containing ONLY this exact English text, ` +
    `spelled exactly, in bold upright comic lettering fully inside the balloon: "${b.text}"`
  );
}

function storyBoxFor(text: string, where: string): string {
  return (
    `${where} place one clean solid black rectangular Korean webtoon narration box with a crisp white border, ` +
    `generous inner spacing and no pointer tail, positioned over quiet negative space without covering a face or action, ` +
    `containing ONLY this exact English story text, spelled exactly, in clear upright bold white comic lettering: "${text}"`
  );
}

/**
 * The lettering and layout instruction, appended AFTER the sanitised picture
 * prompt so it survives untouched. Returns "" for a silent single frame, which
 * keeps the old wordless behaviour byte for byte.
 */
export function panelDirective(plan: PanelPlan): string {
  const spoken = plan.bubbles.filter((b) => b.text.length > 0);
  const narrated = plan.narration.filter((text) => text.length > 0);

  const out: string[] = [];

  if (plan.frames > 1) {
    out.push(
      `render this as ONE manhwa comic page in ${layoutOf(plan.frames, plan.body)}, every frame in the same art ` +
        `style with the same characters and the same location, showing consecutive moments of this one scene, ` +
        `cinematic varied camera distance per frame, clear top-to-bottom reading order, dramatic size contrast, ` +
        `clean white page gutters and bold black frame edges; use a narrow establishing view, a closer escalation view, ` +
        `and the largest space for the decisive action as applicable`,
    );
    plan.beats.forEach((beat, i) => {
      out.push(`the ${ORDINAL[i] ?? `frame ${i + 1}`} frame shows ${beat.replace(/\.$/, "")}`);
    });
  } else {
    out.push(
      `compose this single webtoon image as ${singleComposition(plan.body)}; choose the crop, camera height and perspective ` +
        `for this exact story beat rather than defaulting to a centred medium shot; preserve all story-essential people, action and location clues`,
    );
  }

  plan.bubbles.forEach((b, i) => {
    if (!b.text) return;
    const where =
      plan.frames > 1 ? `in the ${ORDINAL[i] ?? `frame ${i + 1}`} frame,` : "in the upper area of the frame,";
    out.push(balloonFor(b, where));
  });

  plan.narration.forEach((text, i) => {
    if (!text) return;
    const where =
      plan.frames > 1
        ? `in the ${ORDINAL[i] ?? `frame ${i + 1}`} frame, near the top or bottom edge,`
        : "near the top or bottom edge of the illustration,";
    out.push(storyBoxFor(text, where));
  });

  if (spoken.length > 0 || narrated.length > 0) {
    out.push(
      "the specified speech-balloon and narration-box text is the only readable writing in the image apart from a script-matched action SFX; no subtitles, signs or watermark",
    );
  }

  return out.join(". ");
}

