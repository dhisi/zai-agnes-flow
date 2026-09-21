import type { Segment } from "./script";
import { withImageKey, noteRateLimit, noteImageSuccess } from "./keys.server";
import {
  parsePanelPlan,
  panelDirective,
  frameCeiling,
  type PanelPlan,
} from "./panels";
import { textChat } from "./text-engine.server";
import { assertActive, killableSignal, KilledError } from "./kill-switch.server";

/** The ONLY image provider and model in this app. */
const AGNES_URL = "https://apihub.agnes-ai.com/v1/images/generations";
const AGNES_IMAGE_MODEL = "agnes-image-2.5-flash";
// Generation can legitimately take minutes when the renderer is busy. A short
// deadline used to kill healthy renders at 60s and made long runs look stuck,
// so this is only a very generous safety net, never a fast-fail.
const IMAGE_REQUEST_TIMEOUT_MS = 1_800_000;

/**
 * Renderer-only art direction. The writing model describes only scene content;
 * this exact block is added at the final Agnes image request for every image.
 * Flux has no negative-prompt channel, so this stays entirely positive: naming
 * unwanted media such as photography or pencil sketches can make Flux draw them.
 */
export const STYLE =
  "FIXED VISUAL STYLE: premium full-colour Korean action-fantasy webtoon/manhwa, crisp black contour lines over highly " +
  "finished digital painting, controlled cel shading blended with luminous atmospheric rendering, cool blue-violet shadows, " +
  "brilliant energy rim light, expressive detailed faces, dynamic anatomy, cinematic depth and foreshortening, dense speed lines, " +
  "impact bursts, flying debris and glow integrated into the action, polished serialized-webtoon finish";



/**
 * The single authoritative light statement for every panel: natural, faithful
 * to the script, and always readable. Deliberately neutral — no darkness, no
 * mystery, no mood grade.
 */
export const TONE_LOCK =
  "LIGHTING: story-led and readable, exactly matching the scene's emotional beat and setting; preserve bright daylight, " +
  "clear night detail and visible faces while allowing dramatic contrast, rim light, hard shadows and intense colour accents when appropriate";

/**
 * Flux has NO negative prompt: every noun written here is a token the model can
 * draw. Long "no speech bubbles, no posters, no billboards..." lists were being
 * rendered literally (walls of speech bubbles and signage). So the guards are
 * now short and phrased POSITIVELY wherever possible.
 */
export const NO_TEXT_GUARD =
  "a pure wordless artwork, completely free of any text, lettering, signage, speech balloons or captions";

/** Single-image guard. Deliberately short; see NO_TEXT_GUARD note above. */
export const SINGLE_PANEL_GUARD =
  "one single full-bleed illustration of this one moment, one continuous scene edge to edge, fully drawn and detailed";

/** Added only when the scene has no people in it. */
export const NO_PEOPLE_GUARD =
  "an empty environment shot with no people, no figures and no characters anywhere in frame";

/** Added only when the scene does have named/described people. */
export const CAST_GUARD =
  "only the described cast is present, each person drawn once with their stated identity";

/**
 * Anatomy guard. Panels came back with two figures sharing one shirt and fused
 * torsos, so every body is now explicitly stated to be whole and separate.
 */
export const ANATOMY_GUARD =
  "anatomically correct bodies, one head, two arms and two legs per person, every figure a complete separate body with its own clothing, clearly spaced apart, never fused, merged, overlapping into one another or duplicated";

/**
 * Every text call in the app goes through Z.ai GLM (glm-4.5-flash)
 * (see zai.server.ts): one request at a time, with an automatic retry on
 * the next key when a daily free-model quota runs out. No other provider is
 * used anywhere in this app.
 */
export { textChat };

function stripFences(s: string): string {
  return s
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
}

/**
 * Forgiving reader for the prompt-writing answer.
 *
 * The free model kept refusing to emit a strict JSON array (unescaped quotes,
 * trailing prose, half-closed brackets), so the whole chunk was thrown away and
 * no panels ever appeared. The writing step now asks for plain "n) prompt"
 * lines and this parser accepts almost anything shaped like that:
 *
 *   - "1)" / "1." / "1:" / "1 -" / "[1]" / "Prompt 1:" numbering
 *   - leftover bullets, quotes, brackets, commas and code fences
 *   - a stray JSON array (parsed as such when it happens to be valid)
 *   - continuation lines, which are appended to the prompt above them
 *
 * Returns a sparse array indexed by (number - 1). Unnumbered output falls back
 * to reading the non-empty lines in order.
 */
export function parseNumberedList(raw: string, expected: number): string[] {
  const text = stripFences(raw);

  // If the model did return valid JSON after all, take it.
  const s = text.indexOf("[");
  const e = text.lastIndexOf("]");
  if (s !== -1 && e > s) {
    try {
      const parsed = JSON.parse(text.slice(s, e + 1)) as unknown;
      if (Array.isArray(parsed) && parsed.some((v) => typeof v === "string" && v.length > 30)) {
        return parsed.map((v) => (typeof v === "string" ? clean(v) : ""));
      }
    } catch {
      /* not JSON — fall through to the line reader */
    }
  }

  const out: string[] = [];
  const loose: string[] = [];
  let last = -1;
  const numbered = /^\s*(?:prompt\s*)?[[(]?(\d{1,3})[\])]?\s*[).:\-–—]\s*(.*)$/i;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = numbered.exec(line);
    if (m) {
      const n = Number(m[1]);
      const body = clean(m[2] ?? "");
      // Guard against a stray number inside prose restarting the list.
      if (n >= 1 && n <= expected + 5) {
        out[n - 1] = body;
        last = n - 1;
        continue;
      }
    }
    if (last >= 0) {
      // Continuation of the previous prompt (the model wrapped a long line).
      out[last] = `${out[last] ?? ""} ${clean(line)}`.trim();
    } else {
      loose.push(clean(line));
    }
  }

  const got = out.filter((v) => v && v.length > 30).length;
  if (got === 0 && loose.length > 0) {
    return loose.filter((v) => v.length > 30);
  }
  return out;
}

/** Strips leftover quoting/bullet punctuation from one recovered prompt. */
function clean(v: string): string {
  return v
    .replace(/^[\s*•\-–—]+/, "")
    .replace(/^["'`“”]+/, "")
    .replace(/["'`“”]?\s*,?\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Builds a compact, reusable character bible from the script.
 *
 * Only the OPENING portion of the script is sent: characters are introduced in
 * the first scenes, so the head alone is enough to fix their look, and it keeps
 * the request far inside the free model's context window (a multi-hour script
 * would otherwise come back as a hard 400). Budgets shrink on each retry.
 * It never throws: an empty bible only costs some consistency, while a throw
 * would kill the whole storyboard for a long script.
 */
export async function buildCharacterBible(script: string): Promise<string> {
  const system =
    "You are a character continuity editor. Read the WHOLE script (it may be " +
    "Hinglish/Hindi) and list the recurring characters. For each, give ONE compact English line of FIXED, highly " +
    "specific visual traits usable verbatim inside an image prompt: exact hair colour + length + style, " +
    "eye colour, skin tone, face shape, one distinguishing feature (scar, mole, glasses, bandage), build/height, and " +
    "signature clothing WITH exact colours. Be concrete — these traits must let an artist redraw the same person " +
    "hundreds of times identically. 16-28 words per character. Max 10 characters. " +
    "After the characters, add up to 6 recurring LOCATIONS the same way, one line each, prefixed 'Place - ', with " +
    "fixed visual details (materials, colours, key furniture/landmarks, time of day if fixed) so the same place is " +
    "drawn identically every time it appears, e.g. 'Place - Henan's home: small brick village house, blue wooden " +
    "door, clay-tiled roof, neem tree in the yard, string cot outside'. " +
    "Include age, gender, relationship status or similar identity details ONLY when the script explicitly establishes them; " +
    "otherwise leave them unspecified and never guess or impose a default. The lead has no special demographic override. " +
    "Output plain lines like: Henan: messy jet-black hair, dark brown eyes, tan skin, " +
    "thin wiry build, faded grey school shirt with frayed collar, small scar above left eyebrow. " +
    "No headings, no numbering, no extra commentary.";

  // A server function cannot pass Z.ai' streamed bytes through to the browser;
  // the published request therefore looks idle until the whole answer is ready.
  // Keep the call bounded, while sampling the whole story so characters first
  // introduced late are still represented.
  const body = representativeScript(script, BIBLE_INPUT_CHARS);

  try {
    const out = await textChat(system, `FULL SCRIPT:\n${body}`, {
      temperature: 0.4,
      maxOutputTokens: 4_000,
      timeoutMs: 1_800_000,
      attempts: 2,
    });
    const bible = normalizeLeadCharacter(stripFences(out).slice(0, 4000));
    if (bible.length > 20) return bible;
  } catch (e) {
    if (e instanceof KilledError) throw e;
    console.error("buildCharacterBible failed, continuing without a bible:", e);
  }
  return "";
}

/**
 * Character sheets are now authoritative and unrestricted. Kept as a named
 * boundary for callers and old saved runs, but it deliberately changes nothing.
 */
export function normalizeLeadCharacter(bible: string): string {
  return bible;
}

const PROMPT_SYSTEM =
  "You are a storyboard writer. Describe scene CONTENT only; do not name or request any art style, medium, rendering " +
  "technique or visual genre because the image renderer applies one fixed style separately. You are given a " +
  "character bible and the COMPLETE script (Hindi/Hinglish/English), every line numbered with its timestamp. You are " +
  "then asked for a set of line numbers. For EACH requested number write ONE English image prompt that draws EXACTLY " +
  "WHAT THAT LINE LITERALLY DESCRIBES.\n" +
  "TIMESTAMP FIDELITY (absolute): the prompt for a numbered line must show THAT line's own moment and action. Never " +
  "draw a different timestamp or blend two timestamps into one image. Story continuity is equally absolute: unless " +
  "that line explicitly changes place, time or cast, retain the established location, time of day and active characters " +
  "from the immediately preceding lines. A new sentence is not a new scene. Resolve Hindi/Hinglish pronouns such as " +
  "वह, उसके, उसकी, उसे, उन्होंने and English he/she/they from the surrounding lines and write the resolved character's " +
  "NAME in the prompt. Never replace an active character with an empty room or landscape.\n" +
  "EVERY prompt must contain, in this order: (1) the place/setting the line itself describes, (2) who or what is in " +
  "frame — with bible traits woven inline ONLY for characters the line itself is about; if the line involves no person, " +
  "the shot has no people at all, (3) the exact action, body pose and facial expression, (4) 4-6 concrete environmental " +
  "details, (5) the most effective cinematic camera angle, shot size, composition and perspective for this exact beat, " +
  "chosen from wide shot, medium shot, close-up, extreme close-up, over-the-shoulder, low angle, high angle, side angle, " +
  "Dutch angle or dramatic foreshortening according to the action and emotion, " +
  "(6) the natural lighting and colour the line implies.\n" +
  "RULES:\n" +
  "- CHARACTER IDENTITY: never impose an age, gender, relationship status or other demographic on the protagonist or " +
  "any character. Preserve such details only when the script or user-written character sheet explicitly provides them.\n" +
  "- ONE LINE = ONE IMAGE (absolute): exactly one prompt per requested number, in the same order, never merged, never " +
  "split, never skipped, never a placeholder. Each prompt must be visibly DIFFERENT from its neighbours.\n" +
  "- NOTHING INVENTED (absolute): every person, place, object, prop and event in the prompt must come from the script — " +
  "from the requested line itself, from its neighbouring lines, or from the character bible. Never invent a room type, " +
  "building, institution, machine, vehicle, furniture, clock time, weather or event the script never mentions (no " +
  "'investigation room', 'office', 'laboratory' or similar unless the script says so). If the line does not state a " +
  "place, reuse the last place the SCRIPT itself stated — never a new one you made up. Before writing, translate the " +
  "Hindi/Hinglish line to yourself and make sure every noun and verb of that translation is visible in your prompt; if " +
  "your prompt could not be recognised as a drawing of that exact line, rewrite it.\n" +
  "- LITERAL SUBJECT (the most important rule): draw the visible event happening at THAT timestamp and nothing else. " +

  "First classify the line. If a named person says, tells, explains, warns, asks, answers, thinks, remembers or learns " +
  "information, show that present speaker/listener interaction and its emotion — DO NOT illustrate nouns inside their " +
  "speech or thought as if those events are happening now. For example, a woman warning someone about an army shows " +
  "the woman warning them in the established room, not a lineup of soldiers. Only draw demons, a massacre, a city, " +
  "an army, a war or a past event directly when the timestamp explicitly presents it as visible action, a clearly " +
  "introduced flashback, or detached historical narration with no present speaker. Never replace a conversation with " +
  "the topic being discussed.\n" +
  "- SCENE CONTINUITY: default to the same location, time and active cast as the previous line. Change them ONLY when " +
  "the current line explicitly names a different location/time/cast or clearly begins a flashback, memory, dream or " +
  "separate narrated event. Keep continuing actions spatially coherent: the same room layout, doors, furniture and " +
  "character positions should remain recognisable while pose, expression and camera angle advance.\n" +
  "crowds, villagers, strangers or unnamed people show THOSE people — never insert a main character into them.\n" +
  "- CAST RESOLUTION: put every bible character named in the current line in frame. Also retain a bible character when " +
  "the current line uses a pronoun or continues that character's action from the preceding line. Write every resolved " +
  "character by NAME and repeat their sheet traits. Lines explicitly about soldiers, demons, crowds, villagers, " +
  "strangers or unnamed people show those people instead of unrelated main characters.\n" +
  "crowds, villagers, strangers or unnamed people show THOSE people — never insert a main character into them.\n" +
  "- A memory, flashback, dream or story-within-the-story is drawn as the remembered event itself, in the place and " +
  "time it happened, not as someone remembering it.\n" +
  "- LIGHTING & COLOUR: direct the lighting to support the exact story beat while preserving the established time and " +
  "place. Calm moments may use soft light; tense, violent, emotional or mysterious moments may use harder separation, " +
  "dramatic shadows, rim light or intense colour accents. Keep faces and essential action readable. Name the light source " +
  "and dominant colours, and never change day, night or weather without script support.\n" +
  "- RICH DETAIL (critical): every prompt is dense with concrete visual detail — at least 4-6 specific drawable things " +
  "in the environment; for each person the posture, hand position, exact expression (eyes, eyebrows, mouth) and " +
  "clothing state. Foreground, midground and background must each have something drawn in them.\n" +
  "- STAGING & GAZE (critical): stage each character according to the exact action and emotional beat. Use natural body " +
  "orientation, interaction, gesture, weight distribution and gaze direction, with dynamic poses for movement or conflict. " +
  "Walking looks like walking, attacks show committed attack mechanics, falls show lost balance, fear creates defensive body " +
  "language, anger creates aggressive posture, shock creates a full reactive pose, and conversations use natural interaction. " +
  "People are absorbed in the action; nobody poses for the viewer unless the line itself requires it.\n" +
  "- ALWAYS A SCENE, NEVER A DESIGN: every prompt is one continuous location with a full background — floor, walls or ground, sky or ceiling, and 4-6 props. Never write a reference sheet, model sheet, character design, turnaround, multiple views, a lineup, a floating head, an isolated portrait on a plain backdrop, a duplicated copy of the same character, or an empty blank background.\n" +
  "- CARRY THE SCENE FORWARD: begin from the place, time of day and cast already established by the previous lines, and say that place explicitly in this prompt even if the line does not repeat it.\n" +
  "- Weave a character's fixed traits INLINE (e.g. 'Henan, a thin 17-year-old boy with messy jet-black hair, sits...'). " +
  "NEVER write a separate character description block, sheet, reference, lineup or 'plus portrait of'.\n" +
  "- CONSISTENCY: when a bible character DOES appear, repeat their bible traits (hair, eyes, clothing colours) using " +
  "the bible's own words. Never redesign, re-age or re-dress a character between shots.\n" +
  "- THE CHARACTER BIBLE IS APPEARANCE REFERENCE ONLY. Never turn its wording into the panel's action, setting or " +
  "composition. The timestamped script alone decides what happens. First describe the exact visible story action and " +
  "location; attach fixed appearance traits only to the people actually present.\n" +
  "- NEVER SUBSTITUTE SCENERY FOR A HUMAN MOMENT: if a line names, quotes, remembers, describes, follows or uses a " +
  "pronoun for a person, that person must be visibly present performing the line's action. An empty room, empty road, " +
  "empty field or landscape is valid only when the line explicitly establishes an unoccupied place.\n" +
  "- IDENTITY CONTINUITY: preserve age, gender and other identity details when they are explicitly supplied by the " +
  "script or character sheet; when absent, leave them open rather than guessing.\n" +
  "- TWO OR MORE PEOPLE IN FRAME (critical): name each person separately with their own " +
  "their own distinct traits, and say where each one stands. Never write 'two figures' or 'the two of them', and " +
  "never let one character's hair, clothing, age or body type bleed onto the other.\n" +
  "- DISTINCT CAST (critical): when two people share a frame, preserve each person's explicitly supplied traits and " +
  "make their silhouettes, hair, clothing and position clearly distinct without inventing demographic traits.\n" +
  "- HEAD COUNT: state explicitly how many people are in frame and that nobody else is present.\n" +
  "- FIGHTING & MAGIC (critical): these stories are action fantasy. Whenever the line contains combat, a technique, a " +
  "spell, an awakening, a transformation, a curse, an aura, a summon, a beast, a weapon clash or any supernatural " +
  "ability, the prompt MUST describe it as visible drawable energy and motion: the exact stance and mid-motion body " +
  "mechanics of every fighter (which foot forward, which arm extended, where the fist/blade/palm is), the precise " +
  "shape, colour and direction of the power (for example 'jagged violet lightning spiralling up his right forearm and " +
  "bursting forward in a cone'), the point of impact, and the physical consequence in the environment (cracked ground, " +
  "shattered stone, torn cloth, dust ring, splintered trees, displaced air, scattered debris, blood, sweat, cuts). " +
  "State the eyes glowing or not, the aura around each body, the speed lines implied by the pose, and where each " +
  "fighter's gaze is locked. Copy each character's own established ability, weapon and power colour from the bible and " +
  "the earlier script lines so the same ability always looks the same; never give a character a power the script did " +
  "not give them. Also describe the battlefield itself in full — terrain, weather, sky, surrounding structures, " +
  "onlookers if the line has them — so the fight reads as happening in a real place at that exact timestamp.\n" +
  "- ACTION CHOREOGRAPHY (critical): for every physical action explicitly direct ACTION, POSE, BODY ROTATION, WEIGHT " +
  "SHIFT, DIRECTION OF MOVEMENT, CAMERA PERSPECTIVE, FOREGROUND ELEMENT, IMPACT POINT, ENVIRONMENTAL RESPONSE and FACIAL " +
  "EXPRESSION. Use clear silhouettes, foreshortening and a decisive peak-action instant. A punch, for example, must show " +
  "the torso twisting, rear foot driving, arm extending, fist prominent in foreground, target and impact point aligned, " +
  "and dust or debris reacting where appropriate rather than two characters standing near each other.\n" +
  "- COMPLETE MANHWA STORYTELLING: compose every image like a finished vertical Korean webtoon episode panel, with " +
  "confident cinematic crops, expressive acting, purposeful negative space for lettering, strong depth, and clean visual flow. " +
  "Use wide establishing compositions, intimate close-ups, extreme detail crops, tall reveals, offset subjects, foreground occlusion, " +
  "border-breaking action and quiet breathing space as the story requires. Never default to a centred waist-up character.\n" +
  "- WEBTOON EFFECTS: select only effects that strengthen this exact beat. Action may use speed lines, impact bursts, " +
  "directional streaks, motion blur, debris, dust, shockwaves, exaggerated motion, energy or slash trails and impact " +
  "distortion. Emotion may use subtle background rays, tension lines, dramatic shadow, eye emphasis, atmospheric particles " +
  "and emotional accents. Power or fantasy may use established aura, energy particles, glow, magic circles, elemental " +
  "trails and environmental reaction. Do not write an SFX word yourself; the renderer adds one script-matched action SFX. " +
  "Never describe lettering in the prompt body; spoken words and story narration go only in their dedicated tail fields.\n" +
  "- CAMERA & COMPOSITION: choose the camera specifically for the current story beat; never repeat one fixed shot type. " +
  "Use wide shots for geography and large-scale action, medium shots for interaction, close-ups for facial emotion, extreme " +
  "close-ups for intense reactions, low angles for power, high angles for vulnerability or scale, over-the-shoulder shots " +
  "for conversations, dramatic perspective and foreshortening for attacks, and Dutch angles for instability or tension. " +
  "The camera must serve the story beat while the established location remains recognisable. Treat neighbouring timestamps as a visual sequence: " +
  "alternate wide, medium, close and extreme-detail views; alternate left, centre and right subject placement; change camera height and foreground layer. " +
  "Two consecutive prompts must not use the same shot size, angle, crop or subject placement unless the script explicitly holds on an unchanged view.\n" +
  "- SETTINGS ARE FAITHFUL AND REPEATED (critical): describe each place exactly as the script has it, plainly and " +
  "simply, with no invented spectacle. Add only fantasy or magical features the script itself establishes. The FIRST " +
  "time a place appears, fix 4-6 concrete physical facts about it (wall and floor material and colour, one or two " +
  "windows or doors and where they are, 2-3 pieces of fixed furniture or landmarks, and the direction the light comes " +
  "from). For EVERY later line that stays in that same place, repeat those same physical facts in the same words — the " +
  "place must read as one single unchanged room or location across all its panels, with only pose, expression and " +
  "camera angle changing. Never redesign, re-furnish, rescale or restyle an established place, and never swap it for a " +
  "grander version of itself.\n" +

  "- One continuous scene, one place, one instance of each character. Never ask for insets, collages or a character sheet; frame splitting is decided ONLY by the FRAMES tail below.\n" +
  "- NO-CHARACTER LINES (critical): if the line describes only a place, an object, the sky, weather or a phenomenon and " +
  "involves no person, the prompt MUST be a pure environment shot with NOBODY in it. Start it with 'Empty environment " +
  "shot, no people:'. Never add a silhouette, an onlooker or a main character just to fill the frame.\n" +
  "- CROWD LINES: if the line says many people, everyone, a crowd, an army, soldiers or people running, show that " +
  "crowd or force, made of unnamed people who are not the main cast.\n" +
  "- NO TEXT IN THE PROMPT BODY: never describe captions, letters, numbers, signs, posters, banners, newspapers, book " +
  "pages, screens with writing, labels or logos. All story lettering belongs ONLY in DIALOGUE and NARRATION below.\n" +
  "- SHORT / NEARLY EMPTY LINES (critical): some lines are very short — a shout, a name, one word, a reaction, or a " +
  "silent beat with almost no words. Such a line has NO new setting of its own, so you MUST hold the SAME place, the " +
  "SAME people and the SAME time of day as the surrounding lines, and change only the camera or the person's acting. " +
  "A close-up or extreme close-up is appropriate when the short line's primary event is an intense facial reaction. " +
  "NEVER invent a new location, new characters, a new era or an unrelated event for a short line, and never jump to a " +
  "scene the script does not have. When such a line is marked with CONTEXT below, take its place and people from that " +
  "context verbatim.\n" +
  "- 65 to 95 words each — put the exact visible action, named cast and place in the FIRST sentence. Keep every word visual and load-bearing. English only. The image engine gives the beginning much more weight, so never open with mood, history or explanation.\n" +
  "\nFRAMES + LETTERING TAIL (required on every prompt). After the prompt body, append this exact tail:\n" +
  "|| FRAMES: n || BEATS: 1) ... ; 2) ... || DIALOGUE: 1) Name: spoken line ; 2) NONE || NARRATION: 1) story text ; 2) NONE\n" +
  "- FRAMES is how many comic frames that ONE timestamp is drawn as. Hard ceiling by length: under 5s = 1, 5-9s = 2, " +
  "9-15s = 3, over 15s = 4. Count the timestamp's separate sentences and consecutive visible actions. When a timestamp " +
  "has two or more such story moments, FRAMES MUST be at least that count up to its duration ceiling; never collapse a " +
  "multi-sentence timestamp to one frame. A genuinely single-moment timestamp stays one frame however long it lasts.\n" +
  "- BEATS: write one only when FRAMES is 2 or more — exactly FRAMES short phrases (4-12 words each), in story order, " +
  "each the visible action of that frame, all in the SAME place with the SAME characters. Omit BEATS when FRAMES is 1.\n" +
  "- DIALOGUE: exactly FRAMES entries. For a frame where someone SPEAKS or SHOUTS in the script line, give the speaker's " +
  "name, a colon, then that speech translated into short natural spoken ENGLISH (max 12 words, no quotation marks, no " +
  "Hindi, no transliteration, keep the emotion — a shout stays a shout). If the script line is narration, description " +
  "or silence with no spoken words, write NONE for that frame. Never invent dialogue that the script does not speak.\n" +
  "- NARRATION: exactly FRAMES entries. Preserve the remaining non-spoken story from this timestamp as concise, natural " +
  "ENGLISH webtoon narration (max 20 words per box). Use NONE only when that frame is fully communicated by spoken dialogue " +
  "or contains no narrative wording. Translate faithfully: do not discard exposition, inner narration, time/place transitions " +
  "or story context, and do not turn spoken dialogue into narration. For multi-frame timestamps, divide the narration across " +
  "the matching beats without repeating or padding it.\n" +
  "OUTPUT FORMAT (strict about the shape, nothing else): one plain line per requested script line, each starting with " +
  "that script line's own number, then ') ', then the whole prompt AND its tail on that same single line. Example:\n" +
  "37) In the sunlit courtyard, Henan steps back ... || FRAMES: 1 || DIALOGUE: 1) Henan: Stay back! || NARRATION: 1) NONE\n" +
  "38) In the same courtyard, Henan turns ... || FRAMES: 2 || BEATS: 1) Henan turns towards the gate ; 2) he draws his " +
  "blade in one sweep || DIALOGUE: 1) NONE ; 2) Henan: Who sent you? || NARRATION: 1) At dusk, danger found him again. ; 2) NONE\n" +
  "No JSON, no quotes, no brackets, no bullets, no headings, no blank lines, and never break one prompt across lines.";

/** Hard ceiling for one published text request; larger payloads can sit idle at the edge. */
const MAX_SCRIPT_CHARS = 72_000;
const BIBLE_INPUT_CHARS = 48_000;

/** Samples opening, middle and ending without cutting the request at only the opening. */
function representativeScript(script: string, limit: number): string {
  if (script.length <= limit) return script;
  const slices = 4;
  const width = Math.floor(limit / slices);
  const maxStart = script.length - width;
  return Array.from({ length: slices }, (_, i) => {
    const start = Math.floor((maxStart * i) / (slices - 1));
    return `[SCRIPT EXCERPT ${i + 1}/${slices}]\n${script.slice(start, start + width)}`;
  }).join("\n\n…\n\n");
}

/**
 * How much of the script is pasted in for continuity on one prompt-writing
 * request. A full two-hour script is hundreds of thousands of characters; on a
 * long story that made every single request enormous and slow, which is why
 * long scripts finished with no prompts at all. Below this size the whole
 * script still goes in; above it, the request carries the story opening plus a
 * generous window around the lines being drawn.
 */
const CONTEXT_CHARS = 28_000;
/** Lines of story kept before/after the batch when the script is long. */
const CONTEXT_BEFORE = 120;
const CONTEXT_AFTER = 60;

/** Numbers the WHOLE script, 1-based, exactly as the model must answer it. */
function numberScript(all: Segment[]): string {
  return all.map((s, i) => `${i + 1}. [${s.start}s-${s.end}s] ${s.text}`).join("\n");
}

/**
 * True for a line with almost nothing drawable in it: a very short shout, a
 * name, a reaction, or a silent beat. These are the lines that used to come
 * back as a completely unrelated scene, because the model had nothing to work
 * from and invented one.
 */
export function isShortLine(text: string): boolean {
  const t = text.trim();
  if (/^continuation of the same moment/i.test(t)) return true;
  const words = t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  return words.length < 6 || t.length < 28;
}

/** Nearest substantial neighbour line (previous first, then next) for anchoring. */
function nearestSubstantialLine(all: Segment[], n: number): string | null {
  for (let i = n - 2; i >= 0 && i >= n - 8; i--) {
    const t = all[i]?.text?.trim();
    if (t && !isShortLine(t)) return t.slice(0, 400);
  }
  for (let i = n; i < all.length && i < n + 6; i++) {
    const t = all[i]?.text?.trim();
    if (t && !isShortLine(t)) return t.slice(0, 400);
  }
  return null;
}


function numberRange(all: Segment[], from: number, to: number): string {
  return all
    .slice(from - 1, to)
    .map((s, i) => `${from + i}. [${s.start}s-${s.end}s] ${s.text}`)
    .join("\n");
}

/** Story context for one batch: the whole script when short, a window when long. */
function contextFor(all: Segment[], full: string, want: number[]): string {
  if (full.length <= CONTEXT_CHARS) return full;
  const first = Math.max(1, (want[0] as number) - CONTEXT_BEFORE);
  const last = Math.min(all.length, (want[want.length - 1] as number) + CONTEXT_AFTER);
  const opening = numberRange(all, 1, Math.min(30, all.length));
  const windowed = numberRange(all, first, last);
  return first > 31
    ? `STORY OPENING:\n${opening}\n\n...\n\nSTORY AROUND THESE LINES:\n${windowed}`
    : windowed;
}

/**
 * Writes image prompts for lines `from`..`to` (1-based, inclusive).
 *
 * Prompts are written in batches (the caller decides the batch size) because a
 * single answer covering an entire long script never completes: the answer, not
 * the input, is what has a ceiling. Each request carries the character bible
 * plus as much surrounding story as fits, so continuity is kept, and only
 * genuinely missing lines are asked for again.
 */
export async function writePrompts(
  bible: string,
  all: Segment[],
  from: number,
  to: number,
  requested?: number[],
): Promise<string[]> {
  bible = normalizeLeadCharacter(bible);
  const wanted = requested?.length
    ? [...new Set(requested)].filter((n) => n >= from && n <= to).sort((a, b) => a - b)
    : Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const count = wanted.length;
  if (count <= 0) return [];

  const full = numberScript(all);

  const ask = async (want: number[], temp: number) => {
    const first = want[0] as number;
    const last = want[want.length - 1] as number;
    const contiguous = want.length === last - first + 1;
    const script = contextFor(all, full, want);
    const listing = want
      .map((n) => {
        const s = all[n - 1] as Segment;
        const base = `${n}. [${s.start}s-${s.end}s] ${s.text}`;
        const before = all[n - 2]?.text?.trim();
        const after = all[n]?.text?.trim();
        const neighbours = [
          before ? `PREVIOUS: ${before.slice(0, 500)}` : "",
          after ? `NEXT: ${after.slice(0, 500)}` : "",
        ].filter(Boolean);
        const shortAnchor = isShortLine(s.text) ? nearestSubstantialLine(all, n) : null;
        return [
          base,
          neighbours.length
            ? `   CONTINUITY CONTEXT (resolve place, cast and pronouns; do not draw this context's action): ${neighbours.join(" | ")}`
            : "",
          shortAnchor
            ? `   SHORT-LINE ANCHOR (hold this scene and change only action/expression/camera): ${shortAnchor}`
            : "",
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n");


    return textChat(
      PROMPT_SYSTEM,
      `CHARACTER BIBLE:\n${bible || "(none)"}\n\n` +
        `NUMBERED SCRIPT (read it for continuity):\n${script}\n\n` +
        `LINES TO DRAW — write ONE prompt for EACH of these ${want.length} lines and nothing else. ` +
        `Each prompt draws ONLY its own numbered line's moment, place and action, and must be ` +
        `recognisable as that line:\n${listing}\n\n` +
        `Output exactly ${want.length} lines, numbered with each line's OWN number` +
        `${contiguous ? ` (${first} to ${last})` : ` (${want.join(", ")})`}, then ') ', ` +
        `then that same line's OWN start time copied exactly from the list above in square ` +
        `brackets (for example "12) [86s] ..."), then the prompt, all on that same single line. ` +
        `The number and the start time must both belong to the line the prompt draws. Nothing else.`,
      {
        temperature: temp,
        // One-prompt requests get a generous budget so a single timestamp can be
        // described with full fight/magic/environment detail.
        maxOutputTokens:
          want.length === 1 ? 2_000 : Math.min(32_000, 700 + want.length * 160),
        timeoutMs: 3_600_000,
        attempts: 6,
      },
    );
  };


  const byNumber = new Map<number, string>();

  const absorb = (raw: string, want: number[]) => {
    // Answers are numbered with the GLOBAL line number, so the parser is fed
    // the highest expected number and the results re-keyed.
    const parsed = parseNumberedList(raw, all.length);
    const entries: { n: number; text: string }[] = [];
    parsed.forEach((v, idx) => {
      if (typeof v === "string" && v.trim().length > 30)
        entries.push({ n: idx + 1, text: v.trim() });
    });
    if (entries.length === 0) return;

    // Timestamp fidelity gate: accept a prompt only when it shares a content
    // word with its OWN script line (checked for English lines; Hindi lines
    // cannot be word-matched, so they are checked later, per line, by the
    // scene checker just before rendering).
    const accept = (n: number, text: string) => {
      const seg = all[n - 1];
      if (seg && isEnglishish(seg.text) && !mentionsLine(text, seg.text)) return;
      byNumber.set(n, text);
    };

    const wantSet = new Set(want);
    const first = want[0] as number;
    const last = want[want.length - 1] as number;

    // TIMESTAMP ECHO (authoritative). Each prompt repeats its own line's start
    // time. When every prompt carries one and they map cleanly onto distinct
    // requested lines, that mapping wins over the answer's numbering — this is
    // what stops a whole range sliding one line late.
    const echoed: { n: number; text: string }[] = [];
    let echoes = 0;
    for (const e of entries) {
      const m = /^\[\s*(\d+(?:\.\d+)?)\s*s?\s*\]\s*/.exec(e.text);
      if (!m) {
        echoed.push(e);
        continue;
      }
      echoes++;
      const at = Number(m[1]);
      const body = e.text.slice(m[0].length).trim();
      const hit = want.find((n) => Math.abs(((all[n - 1] as Segment).start ?? -1) - at) < 0.5);
      echoed.push({ n: hit ?? e.n, text: body });
    }
    if (echoes === entries.length && echoes > 0) {
      const keys = echoed.map((e) => e.n);
      const unique = new Set(keys).size === keys.length;
      if (unique && keys.every((n) => wantSet.has(n))) {
        for (const e of echoed) accept(e.n, e.text);
        return;
      }
    }
    // No usable echo: fall back to the numbering rules below, with any echo
    // prefix stripped so it never leaks into the image prompt.
    entries.splice(0, entries.length, ...echoed);

    // TIMESTAMP ALIGNMENT (this is what used to shift panels onto the wrong
    // moment). Two numbering styles come back:
    //   global    — the answer uses this script's own line numbers
    //   renumbered— the answer restarts at 1) regardless of what was asked
    // The old code trusted ANY number that happened to fall inside the
    // requested range. When a range started low enough (say lines 30-89) a
    // renumbered answer's "30)" — really the 30th prompt of the range, i.e.
    // script line 59 — was accepted as line 30, so every panel in that range
    // drew a scene from ~29 lines later in the script. Decide the style ONCE,
    // from the whole answer, and never mix the two.
    const lowest = entries.reduce((m, e) => Math.min(m, e.n), entries[0]!.n);
    const highest = entries.reduce((m, e) => Math.max(m, e.n), entries[0]!.n);
    const ascending = entries.every((e, i) => i === 0 || e.n > entries[i - 1]!.n);
    const looksGlobal = lowest >= first && highest <= last;

    if (looksGlobal) {
      // Every number in the answer belongs to this request: trust them.
      for (const e of entries) if (wantSet.has(e.n)) accept(e.n, e.text);
      return;
    }

    // Renumbered: the answer restarts at 1. Map by the answer's own number
    // (1 -> want[0], 2 -> want[1], ...) — safe even when the answer is
    // truncated or skips a number, because each prompt still carries its own
    // position in the requested list.
    if (ascending && lowest === 1 && highest <= want.length) {
      for (const e of entries) accept(want[e.n - 1] as number, e.text);
      return;
    }

    // Unnumbered / oddly numbered but exactly the right amount, in order:
    // positional mapping is unambiguous.
    if (ascending && entries.length === want.length) {
      entries.forEach((e, i) => accept(want[i] as number, e.text));
      return;
    }

    // Anything else: keep only the numbers that clearly belong to this request
    // instead of throwing the whole answer away (which stalled long runs).
    let kept = 0;
    for (const e of entries) {
      if (wantSet.has(e.n)) {
        accept(e.n, e.text);
        kept++;
      }
    }
    if (kept === 0) {
      console.error(
        `writePrompts: answer numbering does not match request ` +
          `(${entries.length} prompts numbered ${lowest}-${highest} for lines ${first}-${last}) — discarded`,
      );
    }

  };

  // One compact request for the range. The browser deliberately keeps ranges
  // small so the writer can give every timestamp enough attention.
  const t0 = Date.now();
  console.log(`[prompts] START lines ${from}-${to} (${count} lines)`);
  let mainError: unknown;
  try {
    const raw = await ask(wanted, 0.7);
    console.log(
      `[prompts] main answer for ${from}-${to}: ${raw.length} chars in ${Date.now() - t0}ms`,
    );
    absorb(raw, wanted);
    console.log(`[prompts] after main pass ${from}-${to}: ${byNumber.size}/${count} filled`);
  } catch (e) {
    if (e instanceof KilledError) throw e;
    mainError = e;
    console.error(
      `[prompts] main pass FAILED ${from}-${to} after ${Date.now() - t0}ms:`,
      e instanceof Error ? e.message : e,
    );
  }


  /**
   * Timestamp fidelity, applied BEFORE the repair pass.
   *
   * A prompt that shares no content word with its OWN line was written from
   * some other part of the script. These used to be discarded only at the very
   * end, after the repair pass had already run, so the line came back empty and
   * the panel failed. Dropping them here folds them into the same repair
   * request as truncated gaps.
   */
  const dropUnfaithful = () => {
    for (const n of wanted) {
      const own = byNumber.get(n);
      if (!own) continue;
      const seg = all[n - 1] as Segment;
      if (isEnglishish(seg.text) && !mentionsLine(own, seg.text)) byNumber.delete(n);
    }
  };
  dropUnfaithful();

  // Repair what is missing (a truncated answer or a rejected prompt) in as few
  // extra requests as possible: one request for all the gaps together, and a
  // second round for anything still unusable.
  for (let round = 0; round < 2; round++) {
    const gap = wanted.filter((n) => !byNumber.has(n));
    if (gap.length === 0) break;
    const t1 = Date.now();
    console.log(`[prompts] repair pass ${round + 1} for ${gap.length} gaps in ${from}-${to}`);
    try {
      absorb(await ask(gap, 0.5 + round * 0.2), gap);
      dropUnfaithful();
      mainError = undefined;
      console.log(
        `[prompts] after repair ${round + 1} ${from}-${to}: ${byNumber.size}/${count} filled in ${Date.now() - t1}ms`,
      );
    } catch (e) {
      if (e instanceof KilledError) throw e;
      mainError = e;
      console.error(
        `[prompts] repair FAILED ${from}-${to} after ${Date.now() - t1}ms:`,
        e instanceof Error ? e.message : e,
      );
      break;
    }
  }

  // The whole range came back empty because the writing service itself failed
  // (bad/missing key, outage, rate limit). Report that instead of returning a
  // range of blanks: silently blank prompts made every panel show "failed" with
  // no reason, and pushed the browser into its slow one-line-at-a-time repair.
  if (byNumber.size === 0) {
    const why = mainError instanceof Error ? mainError.message : String(mainError ?? "no prompts");
    throw new Error(`Prompt writer unavailable for lines ${from}-${to}: ${why}`);
  }


  // Duplicate diagnostic only. Prompts commonly share a long style/character
  // prefix while describing different actions later in the text. The previous
  // guard compared only the first 160 characters and deleted those valid
  // timestamp-mapped prompts after the repair pass, leaving panels with no
  // prompt and therefore no image. Timestamp echoes/numbering above are the
  // authoritative mapping; never erase a mapped prompt here.
  const seen = new Map<string, number>();
  for (const n of wanted) {
    const own = byNumber.get(n);
    if (!own) continue;
    const fingerprint = own.trim().toLowerCase().replace(/\s+/g, " ");
    const first = seen.get(fingerprint);
    if (first !== undefined && first !== n) {
      console.warn(`writePrompts: lines ${first} and ${n} returned identical prompts; keeping both timestamp slots`);
    } else {
      seen.set(fingerprint, n);
    }
  }

  // ONE ENTRY PER REQUESTED LINE, ALWAYS. The array is positional: the caller
  // maps built[i] onto line (from + i), so a missing prompt must stay in place
  // as an empty string. Throwing (the old behaviour) killed the prompts of the
  // whole range because of one unusable line, which is why some timestamps
  // ended up with no prompt of their own at all.
  const built: string[] = [];
  for (const n of wanted) {
    const seg = all[n - 1] as Segment;
    const own = byNumber.get(n);
    // Timestamp fidelity: a prompt that shares no content word with its OWN
    // line was written from some other part of the script. Reject it so the
    // per-line repair below replaces it instead of drawing the wrong moment.
    if (own && isEnglishish(seg.text) && !mentionsLine(own, seg.text)) {
      byNumber.delete(n);
    } else if (own) {
      built.push(sanitizePrompt(enforceTimestampCast(own, all, n, bible)));
      continue;
    }

    // Never silently turn a failed Hindi/Hinglish interpretation into a generic
    // nearby scene. An empty slot is safer: the browser's repair pass asks the
    // writer again with a much smaller neighbourhood. Generic fallback prompts
    // were the direct cause of plausible-looking but incorrect panels.
    console.warn(`writePrompts: line ${n} needs a focused repair`);
    built.push("");

  }

  const empties = built.filter((p) => !p.trim()).length;
  console.log(
    `[prompts] DONE lines ${from}-${to} in ${Date.now() - t0}ms: ${built.length - empties}/${count} written, ${empties} empty`,
  );
  return chainContinuity(built, all, wanted, bible);
}


/** Locations the image engine can actually stage, as written in prompts. */
const SETTING_WORDS: string[] = [
  "bedroom",
  "kitchen",
  "bathroom",
  "living room",
  "drawing room",
  "hallway",
  "corridor",
  "staircase",
  "rooftop",
  "terrace",
  "balcony",
  "courtyard",
  "veranda",
  "room",
  "house",
  "home",
  "hut",
  "mansion",
  "haveli",
  "temple",
  "shrine",
  "church",
  "mosque",
  "school",
  "classroom",
  "college",
  "office",
  "hospital",
  "clinic",
  "police station",
  "prison",
  "cell",
  "shop",
  "market",
  "bazaar",
  "restaurant",
  "cafe",
  "hotel",
  "street",
  "road",
  "alley",
  "village",
  "town",
  "city",
  "railway station",
  "bus stop",
  "airport",
  "train",
  "bus",
  "car",
  "jungle",
  "forest",
  "woods",
  "field",
  "farm",
  "garden",
  "park",
  "mountain",
  "valley",
  "hill",
  "cave",
  "desert",
  "river",
  "riverbank",
  "lake",
  "beach",
  "sea",
  "boat",
  "graveyard",
  "cremation ground",
  "ruins",
  "factory",
  "warehouse",
  "workshop",
  "well",
  "hall",
  "great hall",
  "dining hall",
  "examination hall",
  "assembly hall",
  "throne room",
  "library",
  "dormitory",
  "training ground",
  "arena",
  "stadium",
  "courtroom",
  "dungeon",
  "tower",
  "castle",
  "palace",
  "fort",
  "camp",
  "tent",
  "bridge",
  "gate",
  "yard",
  "shed",
  "barn",
  "stable",
  "basement",
  "attic",
  "roof",
  "lift",
  "elevator",
  "canteen",
  "cafeteria",
  "playground",
  "gym",
  "laboratory",
  "lab",
  "studio",
  "stage",
  "port",
  "harbour",
  "island",
  "swamp",
  "meadow",
  "orchard",
  "tunnel",
  "mine",
  "quarry",
];


/** The first staged location named in a written prompt, or null. */
function detectSetting(prompt: string): string | null {
  const p = prompt.toLowerCase();
  let best: { word: string; at: number } | null = null;
  for (const word of SETTING_WORDS) {
    const at = p.indexOf(word);
    if (at === -1) continue;
    if (!best || at < best.at || (at === best.at && word.length > best.word.length)) {
      best = { word, at };
    }
  }
  return best ? best.word : null;
}

/** Hindi / romanised place words that mark a genuine change of location. */
const PLACE_CUES: RegExp = new RegExp(
  [
    "घर", "कमरे?", "कमरा", "रसोई", "आँगन|आंगन", "छत", "बरामदा", "जंगल", "सड़क", "गली",
    "बाज़ार|बाजार", "दुकान", "स्कूल", "कॉलेज", "दफ़्तर|दफ्तर", "अस्पताल", "थाना", "जेल",
    "मंदिर", "मस्जिद", "गिरजा", "गाँव|गांव", "शहर", "खेत", "बग़ीचा|बगीचा", "पहाड़", "नदी",
    "तालाब", "समुंदर|समुद्र", "गुफ़ा|गुफा", "श्मशान", "कुआँ|कुआं", "स्टेशन", "ट्रेन", "बस",
    "गाड़ी", "कार", "होटल", "छत पर",
    "ghar", "kamra", "kamre", "rasoi", "aangan", "chhat", "jungle", "sadak", "gali",
    "bazaar", "dukan", "school", "college", "office", "hospital", "thana", "jail",
    "mandir", "masjid", "gaon", "gaanv", "shehar", "khet", "bagicha", "pahad", "nadi",
    "talab", "samundar", "gufa", "shamshan", "kuan", "station", "train", "bus",
    "gaadi", "car", "hotel",
  ].join("|"),
  "i",
);

/* ------------------------------------------------------------------ */
/* Canonical set sheets — the fix for "same hall, ten different halls" */
/* ------------------------------------------------------------------ */

/**
 * Why this exists.
 *
 * The renderer has no memory: telling it "keep the same hall" carries no
 * information, so it invented a brand new hall for every panel of the same
 * scene. Continuity only survives when the SAME concrete physical description
 * of the place is repeated word for word in every prompt of that scene.
 *
 * The sheet is derived DETERMINISTICALLY from the place word plus the story's
 * own character sheet, so any panel, in any batch, on any server instance,
 * computes the identical text without needing shared memory.
 */
function stableHash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function pick<T>(list: readonly T[], seed: number, salt: number): T {
  return list[(seed + salt * 7919) % list.length] as T;
}

const OUTDOOR_WORDS = new Set([
  "rooftop", "terrace", "balcony", "courtyard", "veranda", "street", "road", "alley", "village",
  "town", "city", "market", "bazaar", "jungle", "forest", "woods", "field", "farm", "garden",
  "park", "mountain", "valley", "hill", "desert", "river", "riverbank", "lake", "beach", "sea",
  "graveyard", "cremation ground", "ruins", "well", "bus stop", "railway station", "airport",
]);

const INDOOR_SHEET = {
  shell: [
    "warm ivory plastered walls, charcoal stone floor, one tall arched window on the left",
    "whitewashed brick walls, worn light-wood floor, two square windows on the right wall",
    "deep green panelled walls, polished tiled floor, wide doorway at the far end",
    "cool grey stone walls, rich red brick floor, narrow window high on the back wall",
  ],
  fixtures: [
    "a long dark wooden table, four plain chairs, a low bench against the back wall",
    "a wide wooden desk, a tall shelf of books, a single hanging lamp",
    "two long benches, a heavy closed door with iron hinges, a plain cupboard",
    "a low table, a rolled mat on the floor, a framed picture on the wall",
  ],
  light: [
    "clear directional daylight entering from the left, defined cast shadows",
    "strong overhead daylight, controlled shadows grounding the furniture",
    "focused window light from the right, crisp shadow separation",
    "bright ambient daylight crossed by strong architectural shadows",
  ],
} as const;

const OUTDOOR_SHEET = {
  shell: [
    "clear cyan sky, ochre sandy ground, a line of dark green trees along the left edge",
    "layered overcast sky, textured grey path underfoot, low stone wall running along the right",
    "rich blue sky, golden dry grass, distant violet-grey hills on the horizon",
    "bright mist-edged sky, packed earth ground, a row of weathered low buildings behind",
  ],
  fixtures: [
    "a leaning wooden post, a shallow ditch, scattered small rocks",
    "a single broad tree, a worn bench, a narrow footpath",
    "a low stone platform, a cart wheel resting on the ground, sparse bushes",
    "a wooden fence, a clay water pot, tall dry weeds at the edge",
  ],
  light: [
    "strong daylight from above, crisp shadows on the ground",
    "directional daylight, long defined shadows to the right",
    "clear lateral light with atmospheric depth along the horizon",
    "bright daylight with strong shape-defining shadow separation",
  ],
} as const;

/**
 * The fixed, repeated physical description of one place. Identical for every
 * panel that stays in that place, because it depends only on the place word and
 * the story key.
 */
export function setSheetFor(place: string, storyKey = ""): string {
  const key = place.trim().toLowerCase();
  const seed = stableHash(`${key}|${storyKey}`);
  const book = OUTDOOR_WORDS.has(key) ? OUTDOOR_SHEET : INDOOR_SHEET;
  return [
    pick(book.shell, seed, 1),
    pick(book.fixtures, seed, 2),
    pick(book.light, seed, 3),
  ].join(", ");
}

/** One lock clause, written the same way everywhere. */
function lockClause(name: string, details: string): string {
  return (
    `LOCATION LOCK — ${name}: ${details}. ` +
    `This is the same single physical place in every panel of this scene: identical architecture, ` +
    `identical layout, identical materials and colours, identical fixed furniture and landmarks, identical light direction`
  );
}

/**
 * Panel-to-panel setting continuity.
 *
 * A panel may only move to a new location when its OWN script line names a
 * place (or it is the first of the run). Otherwise the established location is
 * restated — with its full canonical set sheet — so the picture stays in it.
 */
export function chainContinuity(
  prompts: string[],
  all?: Segment[],
  wanted?: number[],
  bible?: string,
): string[] {
  if (!all || !wanted || wanted.length !== prompts.length) return prompts;
  const storyKey = (bible ?? "").slice(0, 400);
  let active: string | null = null;
  let activeLock: PlaceLock | null = null;
  return prompts.map((prompt, i) => {
    if (!prompt.trim()) return prompt;
    const segment = all[(wanted[i] as number) - 1];
    const here = detectSetting(prompt);
    // The character sheet's own fixed places win, and they are matched against
    // BOTH the script line and the written prompt.
    const place = matchingPlace(`${segment?.text ?? ""} ${prompt}`, bible);
    const sourceChangesPlace = segment ? PLACE_CUES.test(segment.text) : false;
    PLACE_CUES.lastIndex = 0;
    if (place && (active === null || sourceChangesPlace)) {
      active = detectSetting(`${place.name} ${place.details}`) ?? place.name;
      activeLock = place;
      return `${prompt}. ${lockClause(place.name, place.details)}`;
    }
    if (here && (active === null || sourceChangesPlace)) {
      // The writer named a place for THIS timestamp; it is never overwritten
      // with an earlier panel's location.
      active = here;
      activeLock = { name: here, details: setSheetFor(here, storyKey) };
      return `${prompt}. ${lockClause(activeLock.name, activeLock.details)}`;
    }
    if (!active) return prompt;
    // A prompt with no place of its own inherits the running location, restated
    // with the very same concrete sheet as the panel that established it.
    const lock = activeLock ?? { name: active, details: setSheetFor(active, storyKey) };
    return `${prompt}. ${lockClause(lock.name, lock.details)}`;
  });
}




/** True when a string is mostly Latin-script text the image engine can read. */
export function isEnglishish(s: string): boolean {
  const letters = s.replace(/[^\p{L}]/gu, "");
  if (!letters) return false;
  const latin = letters.replace(/[^A-Za-z]/g, "").length;
  return latin / letters.length >= 0.85;
}

/**
 * True when a written image prompt shares at least one meaningful word with
 * the script line it belongs to. A prompt that shares nothing was almost
 * certainly written from a different timestamp, so the caller rejects it.
 */
export function mentionsLine(prompt: string, line: string): boolean {
  const stop = new Set([
    "this",
    "that",
    "with",
    "from",
    "then",
    "than",
    "they",
    "them",
    "their",
    "there",
    "here",
    "when",
    "what",
    "into",
    "over",
    "under",
    "about",
    "have",
    "has",
    "had",
    "were",
    "was",
    "are",
    "and",
    "the",
    "his",
    "her",
    "him",
    "she",
    "but",
    "not",
  ]);
  const words = line
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !stop.has(w));
  if (words.length === 0) return true;
  const p = prompt.toLowerCase();
  return words.some((w) => p.includes(w));
}

function fallbackPrompt(s: Segment, action?: string): string {
  const moment = action ? action : s.text;
  // A non-English line still MUST get a timestamp-specific prompt. This branch
  // is enriched with an adjacent written prompt by guaranteedPrompt below.
  if (!isEnglishish(moment)) {
    return (
      "Continue the established scene at this exact next story beat, retaining the same location, " +
      "time of day, room layout and active characters; advance their visible action, pose and expression, " +
      "with a different camera angle and no text anywhere in frame"
    );
  }
  return (
    "A single detailed scene in clear natural lighting, with a fully drawn background, " +
    `depicting this exact story moment: ${moment}`
  );
}

/**
 * Guaranteed prompt for a line the model would not write.
 *
 * Borrows the nearest English line around it so the picture still belongs to
 * this part of the story, then falls back to a neutral scene. Never empty.
 */
function guaranteedPrompt(
  all: Segment[],
  n: number,
  bible: string,
  written: Map<number, string>,
): string {
  const self = all[n - 1] as Segment;
  if (isEnglishish(self.text)) return fallbackPrompt(self);
  const named = namedBibleEntries(self.text, bible);
  const cast = named.length
    ? ` The current line explicitly includes ${named.map((e) => `${e.name}: ${e.traits}`).join("; ")}. Show them in frame.`
    : "";
  for (let d = 1; d <= 6; d++) {
    for (const neighbour of [n - d, n + d]) {
      const existing = written.get(neighbour);
      if (existing) {
        return (
          `Continue the established story scene from this nearby timestamp: ${clip(existing, 520)}. ` +
          `This is timestamp ${n}, a distinct next beat: preserve the location, time, set details and continuing cast, ` +
          `but advance the visible action, pose, expression and camera composition.${cast}`
        );
      }
    }
  }
  for (let d = 1; d <= 6; d++) {
    for (const i of [n - 1 - d, n - 1 + d]) {
      const near = all[i];
      if (near && isEnglishish(near.text)) {
        return (
          "A single detailed scene in clear natural lighting, with a fully drawn background " +
          `and no text in frame, set in the same place and moment as: ${near.text}`
        );
      }
    }
  }
  return fallbackPrompt(self);
}


/** Phrases that make Flux draw letterforms. Replaced with a neutral equivalent. */
const TEXT_TRIGGERS: [RegExp, string][] = [
  [
    /\b(sign(board|age)?s?|street sign|shop sign)\b\s*(that\s+)?(reads?|saying|says)?[^,.]*/gi,
    "weathered wall",
  ],
  [
    /\b(poster|posters|billboard|billboards|banner|banners|placard|flyer|leaflet|brochure)\b/gi,
    "bare wall",
  ],
  // Paper props only when they are the object itself. A trailing noun means the
  // word is an adjective for real furniture ("ticket machine", "note board"),
  // which must be left intact — rewriting it produced nonsense like
  // "a small worn paper object machine on the wall".
  [
    /\b(newspaper|newspapers|magazine|magazines|letter|letters|envelope|note|notes|notebook|diary|book page|pages of a book|document|documents|contract|receipt|ticket|label|labels|tag|tags)\b(?!\s+(machine|machines|counter|booth|stand|window|holder|dispenser|rack|box|board|shelf|kiosk|gate|barrier|office|hall|desk))/gi,
    "worn paper object",
  ],
  [
    /\b(text|texts|writing|written words?|words?\s+written|caption|captions|subtitle|subtitles|title card|handwriting|calligraphy|graffiti|inscription|slogan|logo|logos|brand name|watermark|number plate|license plate|numberplate)\b/gi,
    "",
  ],
  [/\b(that|which)\s+(reads?|says?)\b[^,.]*/gi, ""],
  [/\breading\s+(a|an|the)\s+\w+/gi, "holding an object"],
  [
    /\b(screen|display|monitor|phone screen|laptop screen)\s+(showing|displaying|with)\b[^,.]*/gi,
    "dark glowing screen",
  ],
  // Balloons/lettering furniture: naming them at all makes Flux draw them.
  [/\b(speech|thought|dialogue|word)\s*(bubble|balloon)s?\b/gi, ""],
  [
    /\b(comic|manga|manhwa|webtoon)\s+(page|panel|panels|strip|layout|gutters?)\b/gi,
    "illustration",
  ],
  [
    /\b(says?|saying|said|speaks?|speaking|spoke|tells?|telling|replies|replied|answers?|answered|adds?|added|asks?|asking|states?|declares?|continues?|shouts?|shouting|whispers?|whispering|yells?|screams?|mutters?|exclaims?)\b[^"“]{0,40}["“][^"”]{0,400}(?:["”']|$)/gi,
    "",
  ],
  [/"[^"]{0,400}"/g, ""],
  // An unterminated quote (the writer's sentence was cut mid-speech) used to
  // survive every rule and reached the renderer as lettering.
  [/["“][^"”]{0,400}$/g, ""],
  // Single quotes: ONLY a genuine quoted span. The old /'[^']{2,120}'/ treated
  // two possessive apostrophes as a pair and deleted everything between them —
  // "Henan's ... demon's" lost the whole middle of the description. An opening
  // quote may not follow a letter, and a closing quote may not sit between
  // letters (that is a possessive or a contraction, not a quote).
  [/(?<![A-Za-z0-9])'(?=\S)[^'\n]{2,120}(?<=\S)'(?![A-Za-z0-9])/g, ""],
  [/“[^”]{0,120}”/g, ""],
];

/**
 * Metaphor scrubber. "his lungs burned with fire" was rendered LITERALLY —
 * flames erupting from a character's chest. Figurative body/soul imagery is
 * rewritten into the visible human reaction instead.
 */
const METAPHOR_TRIGGERS: [RegExp, string][] = [
  [
    /\b(lungs?|chest|throat|veins?|blood|body|skin|heart|soul|mind|nerves?)\s+(burning|on fire|aflame|ablaze|engulfed in flames?|filled with fire|searing with fire)\b/gi,
    "face contorted in pain, hand clutching the chest",
  ],
  [
    /\b(fire|flames?|embers?|lightning|electricity|energy)\s+(erupting|bursting|pouring|radiating|spreading)\s+(from|out of|through)\s+(his|her|their|the)\s+(chest|body|lungs?|throat|skin|veins?|mouth|eyes)\b/gi,
    "body tensed, breath sharp, expression strained",
  ],
  [
    /\b(glowing|luminous|visible|exposed|raw|pulsing)\s+(organs?|flesh|muscle|lungs?|veins?|anatomy|innards?)\b/gi,
    "strained expression",
  ],
  [
    /\b(soul|spirit|consciousness|essence)\s+(torn|ripped|wrenched|extracted|pulled|dragged)\s+\w*\s*(from|out of)[^,.]*/gi,
    "whole body convulsing, eyes wide with shock",
  ],
  [
    /\b(x-?ray|anatomical cutaway|see-through body|transparent body|internal organs? view)\b/gi,
    "normal opaque body",
  ],
  [
    /\b(surreal|symbolic|abstract|metaphorical|dreamlike|otherworldly)\s+(imagery|vision|representation|overlay|effect)s?\b/gi,
    "grounded realistic depiction",
  ],
];

/**
 * Dark-tone scrubber. The storyboard has no mood filter any more, so any
 * leftover "dim / gloomy / mysterious" phrasing the text model still slips in
 * is rewritten into neutral, well-lit wording. Genuine script facts (night,
 * rain, a candle) are left alone — only the atmosphere adjectives go.
 */
const DARK_TRIGGERS: [RegExp, string][] = [];

/**
 * Art-style scrubber.
 *
 * The written prompt must describe CONTENT ONLY. Any medium/style/genre word
 * the writing model slips in (realistic, photo, 3D render, oil painting, and
 * even "anime"/"manga" themselves) is deleted here, so the ONLY style
 * statement that ever reaches the renderer is the fixed American print-comic block added in
 * composeImagePrompt.
 */
const STYLE_TRIGGERS: [RegExp, string][] = [
  // "in the style of X", "X style", "rendered in X", "X art"
  [/\b(?:drawn|rendered|painted|illustrated|shot|captured)\s+(?:in|as|with)\s+[^,.]{0,60}/gi, ""],
  [/\bin\s+(?:the\s+)?style\s+of\s+[^,.]{0,60}/gi, ""],
  [/\b[\w-]+\s+(?:art\s+)?style\b/gi, ""],
  [
    /\b(photo[- ]?realistic|photorealism|photorealistic|hyper[- ]?realistic|realistic|realism|lifelike|true[- ]to[- ]life|photograph(y|ic)?|photo|dslr|bokeh|35mm|50mm|film grain|cinematic still|movie still|render(ed|ing)?|3d|cgi|unreal engine|octane|blender|pixar|disney|claymation|stop[- ]motion|low[- ]poly|voxel|pixel art|vector art|flat design|isometric)\b/gi,
    "",
  ],
  [
    /\b(anime|manga|comic book|cartoon|chibi|ghibli|shonen|shoujo|seinen|ink(ed)? drawing|pencil sketch|sketch(y)?|charcoal|watercolou?r|oil painting|acrylic|gouache|pastel drawing|digital painting|matte painting|concept art|illustration style|storybook illustration|woodcut|engraving|impressionist|surrealist|abstract|noir film)\b/gi,
    "",
  ],
  [/\b(4k|8k|hdr|ultra[- ]detailed|highly detailed render|trending on artstation|artstation)\b/gi, ""],
  // Photographic camera/lens/skin cues drag Flux back to its default photo look.
  [
    /\b(shallow depth of field|depth of field|telephoto|wide[- ]angle lens|macro lens|studio lighting|softbox|golden hour photo|candid|documentary|editorial|portrait photo|headshot|skin pores|subsurface scattering|ray[- ]?traced|volumetric lighting|lens flare|chromatic aberration|long exposure|real[- ]life|true colour photo)\b,?\s*/gi,
    "",
  ],
];

/** Removes phrasing that makes the model draw a sheet/portrait, text, or a dark mood grade. */
export function sanitizePrompt(p: string): string {
  let out = p
    .replace(
      /\b(character (sheet|reference|design|lineup|turnaround|bible)|reference sheet|model sheet|inset portrait|split panel|multiple panels|panel grid|collage|side-by-side|two panels|comic page layout|storyboard grid)\b/gi,
      "",
    )
    .replace(
      /\b(black[- ]and[- ]white|black ?& ?white|monochrome|monochromatic|gr[ae]yscale|sepia|screentone|halftone|ink wash only)\b/gi,
      "rich controlled cel colours",
    );
  for (const [re, to] of TEXT_TRIGGERS) out = out.replace(re, to);
  for (const [re, to] of METAPHOR_TRIGGERS) out = out.replace(re, to);
  for (const [re, to] of DARK_TRIGGERS) out = out.replace(re, to);
  for (const [re, to] of STYLE_TRIGGERS) out = out.replace(re, to);


  return out
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .replace(/(,\s*){2,}/g, ", ")
    .replace(/^[\s,.-]+/, "")
    .trim();
}

/** Splits the text-only consistency sheet into `Name -> fixed traits` entries. */
export function parseBible(bible: string): { name: string; traits: string }[] {
  return bible
    .split("\n")
    .map((l) => l.replace(/^[\s\-*•\d.)]+/, "").trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(":");
      if (i < 1) return null;
      const name = l.slice(0, i).trim();
      const traits = l.slice(i + 1).trim();
      if (!name || name.length > 40 || !traits) return null;
      if (/^(?:place|location|setting)\s*-/i.test(name)) return null;
      return { name, traits };
    })
    .filter((v): v is { name: string; traits: string } => v !== null)
    .slice(0, 12);
}

export type PlaceLock = { name: string; details: string };

/** Fixed locations from either the generated bible or the user's manual sheet. */
export function parsePlaces(bible?: string): PlaceLock[] {
  if (!bible) return [];
  return bible
    .split("\n")
    .map((line) => line.replace(/^[\s\-*•\d.)]+/, "").trim())
    .map((line) => {
      const match = /^(?:place|location|setting)\s*-\s*([^:]+):\s*(.+)$/i.exec(line);
      if (!match) return null;
      const name = (match[1] ?? "").trim();
      const details = (match[2] ?? "").trim().replace(/\.$/, "");
      return name && details ? { name, details } : null;
    })
    .filter((value): value is PlaceLock => value !== null)
    .slice(0, 12);
}

function normalizedWords(value: string): string[] {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2);
}

/** Match a written scene to the most specific reusable location in the bible. */
function matchingPlace(text: string, bible?: string): PlaceLock | null {
  const folded = text.toLocaleLowerCase();
  let best: { place: PlaceLock; score: number } | null = null;
  for (const place of parsePlaces(bible)) {
    const words = normalizedWords(place.name);
    const score = words.reduce((sum, word) => sum + (folded.includes(word) ? word.length : 0), 0);
    if (score > 0 && (!best || score > best.score)) best = { place, score };
  }
  return best?.place ?? null;
}

/**
 * A stable set fingerprint repeated verbatim in every panel of one continuing
 * scene. This is data, not a creative suggestion: the renderer must preserve
 * the architecture, furniture, colours, landmarks and light between shots.
 */
export function locationLock(prompt: string, bible?: string, continuity?: string): string {
  const combined = `${prompt} ${continuity ?? ""}`;
  const place = matchingPlace(combined, bible);
  if (place) return lockClause(place.name, place.details);
  const setting = detectSetting(combined);
  if (!setting) return "";
  // Same deterministic sheet the prompt chain uses, so a panel composed on its
  // own (a Fix or a Reroll) lands in exactly the same room as its neighbours.
  return lockClause(setting, setSheetFor(setting, (bible ?? "").slice(0, 400)));
}


/** Characters explicitly named in script text or a written prompt. */
function namedBibleEntries(text: string, bible?: string): { name: string; traits: string }[] {
  if (!bible) return [];
  const folded = text.toLocaleLowerCase();
  return parseBible(bible).filter((entry) => folded.includes(entry.name.toLocaleLowerCase()));
}

/** True when a line continues a previously established person's action. */
function hasPersonReference(text: string): boolean {
  return /\b(he|she|him|her|his|hers|they|them|their)\b|(?:वह|वो|उसने|उसका|उसकी|उसके|उसे|उन्होंने|उनका|उनकी|उनके|वे|उस|अपने|अपनी|अपना)/iu.test(
    text,
  );
}

/**
 * Deterministic timestamp cast repair. It handles the common Hindi/Hinglish
 * pattern where a character is named once and subsequent timestamps use only a
 * pronoun. The nearest recently named sheet character is carried forward only
 * for a person-referencing line, preventing unrelated narration from inheriting
 * the cast.
 */
function enforceTimestampCast(
  prompt: string,
  all: Segment[],
  n: number,
  bible?: string,
): string {
  if (!bible) return prompt;
  const current = all[n - 1];
  if (!current) return prompt;
  let required = namedBibleEntries(current.text, bible);
  if (required.length === 0 && hasPersonReference(current.text)) {
    for (let i = n - 2; i >= 0 && i >= n - 10; i--) {
      required = namedBibleEntries(all[i]?.text ?? "", bible);
      if (required.length > 0) break;
    }
  }
  if (required.length === 0) return prompt;
  const p = prompt.toLocaleLowerCase();
  const absent = required.filter((entry) => !p.includes(entry.name.toLocaleLowerCase()));
  if (absent.length === 0) return prompt;
  return `${prompt}. Required continuing cast visibly in frame: ${absent
    .map((entry) => entry.name)
    .join(", ")}.`;
}

/**
 * A pasted character sheet is authoritative. If the current timestamp names a
 * character but the writing model omitted that name, require the character
 * after the scene action. Full traits are appended later by characterLock; they
 * must not displace the timestamp action from the image encoder's short window.
 */
function enforceLineCast(prompt: string, line?: string, bible?: string): string {
  if (!line || !bible) return prompt;
  const named = namedBibleEntries(line, bible);
  if (named.length === 0) return prompt;
  const absent = named.filter(
    (entry) => !prompt.toLocaleLowerCase().includes(entry.name.toLocaleLowerCase()),
  );
  if (absent.length === 0) return prompt;
  const cast = absent.map((entry) => entry.name).join(" and ");
  // Natural sentence, never a metadata label: a line such as "Required cast:
  // Yuki, Sora" reads like a character sheet to Flux and came back as a lineup
  // of figures on blank paper instead of a scene.
  return `${prompt} ${cast} ${absent.length > 1 ? "are" : "is"} also in the shot, taking part in the same action.`;
}

/** Reads an explicit gender out of a bible line's traits. */
export function genderOf(traits: string): "male" | "female" | null {
  const t = ` ${traits.toLowerCase()} `;
  const male = /\b(male|man|boy|father|dad|brother|son|uncle|husband|he|his)\b/.test(t);
  const female = /\b(female|woman|girl|mother|mom|sister|daughter|aunt|wife|she|her)\b/.test(t);
  if (male && !female) return "male";
  if (female && !male) return "female";
  // both matched: trust whichever token appears first
  const mi = t.search(/\b(male|man|boy)\b/);
  const fi = t.search(/\b(female|woman|girl)\b/);
  if (mi === -1 && fi === -1) return null;
  if (fi === -1) return "male";
  if (mi === -1) return "female";
  return mi < fi ? "male" : "female";
}

/**
 * Deterministic gender repair. The text model occasionally writes "she" for a
 * male character (or the reverse), and Flux then draws the wrong person. This
 * rewrites pronouns and gendered nouns in the prompt to match the bible, and
 * stamps an explicit gendered noun right after each character's name.
 */
export function enforceGender(prompt: string, bible?: string): string {
  if (!bible) return prompt;
  const entries = parseBible(bible).filter((e) => genderOf(e.traits));
  if (entries.length === 0) return prompt;

  const present = entries.filter((e) => new RegExp(`\\b${escapeRe(e.name)}\\b`, "i").test(prompt));
  if (present.length === 0) return prompt;

  let out = prompt;

  // Only rewrite pronouns when a single character is in frame — with two
  // characters we cannot tell which pronoun belongs to whom.
  if (present.length === 1) {
    const g = genderOf(present[0]!.traits)!;
    const map: Record<string, string> =
      g === "male"
        ? {
            she: "he",
            her: "his",
            hers: "his",
            herself: "himself",
            woman: "man",
            girl: "boy",
            lady: "man",
            "young woman": "young man",
          }
        : {
            he: "she",
            his: "her",
            him: "her",
            himself: "herself",
            man: "woman",
            boy: "girl",
            gentleman: "woman",
            "young man": "young woman",
          };
    for (const [from, to] of Object.entries(map)) {
      out = out.replace(new RegExp(`\\b${from}\\b`, "gi"), (m) =>
        m[0] === m[0]!.toUpperCase() ? to[0]!.toUpperCase() + to.slice(1) : to,
      );
    }
  }

  // Put one compact identity tag at the character's FIRST mention. Repeating
  // long identity instructions after every name made Flux focus on generic
  // portraits and ignore the timestamp's setting/action.
  for (const e of present) {
    const g = genderOf(e.traits)!;
    const noun = g === "male" ? "male" : "female";
    // Short label only ("23-year-old"). The full look description
    // ("visibly older, lined face, greying hair") made the tag read as
    // "a 60-year-old visibly older, lined face, greying hair man".
    const age = ageLabel(e.traits);
    const person = noun === "male" ? "man" : "woman";
    const tag = age ? `a ${age} ${person}` : `a ${person}`;
    out = out.replace(
      new RegExp(`\\b${escapeRe(e.name)}\\b(?!\\s*\\((male|female)\\b)`, "i"),
      `${e.name} (${tag})`,
    );
  }

  // No cast ledger. A trailing "Distinct cast: Yuki: male, 23; Mio: female, 16"
  // is sheet metadata: Flux answered it with a row of separated figures facing
  // the camera. Each person is already tagged inline at their first mention.
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Just the age words ("23-year-old", "elderly"), never the look sentence. */
export function ageLabel(traits: string): string {
  const num = /\b(\d{1,2})\s*(?:-|\s)?year[s]?[- ]old\b/.exec(traits.toLowerCase());
  if (num) return `${num[1]}-year-old`;
  const t = traits.toLowerCase();
  if (/\b(elderly|old|aged|grand(mother|father|ma|pa)|buzurg|budhi|budha)\b/.test(t)) return "elderly";
  if (/\b(middle[- ]aged|forties|fifties|40s|50s)\b/.test(t)) return "middle-aged";
  if (/\b(teen(age[rd]?)?|adolescent|schoolboy|schoolgirl)\b/.test(t)) return "teenage";
  if (/\b(child|kid|little (boy|girl)|toddler)\b/.test(t)) return "young";
  return "";
}

/**
 * One body per person. The writing model often repeats a character right after
 * their name — "Kai (a 19-year-old man), a 19-year-old young man with a short
 * black undercut, ..." — and Flux drew a separate figure for each mention, so
 * panels came back with twins. The repeated appositive is dropped; the traits
 * still reach the renderer once through the identity brief.
 */
export function collapseRepeatedIdentity(prompt: string, bible?: string): string {
  if (!bible) return prompt;
  let out = prompt;
  for (const entry of parseBible(bible)) {
    const name = escapeRe(entry.name);
    // Name (tag), <a/an ... man|woman|boy|girl ...>,  -> Name (tag),
    out = out.replace(
      new RegExp(
        `(\\b${name}\\b\\s*\\([^)]*\\))\\s*,\\s*(?:an?|the)\\s+[^.;]{0,180}?\\b(?:man|woman|boy|girl|male|female|person)\\b[^.;]{0,120}?(?=\\s*[,.;]|$)`,
        "gi",
      ),
      "$1",
    );
    // A bare second mention of the same identity phrasing right after the name.
    out = out.replace(
      new RegExp(`(\\b${name}\\b)\\s*,\\s*(?:an?|the)\\s+\\d{1,2}-year-old\\b[^.;]{0,150}?(?=\\s*[,.;]|$)`, "gi"),
      "$1",
    );
  }
  return out.replace(/\s+,/g, ",").replace(/,\s*,/g, ",").replace(/\s{2,}/g, " ");
}

/**
 * Deterministic character lock: whichever API key renders this scene, the same
 * fixed traits are appended verbatim, so characters never drift between shots.
 * The sheet is text only — it is injected as traits, never drawn as a sheet.
 */
export function characterLock(prompt: string, bible?: string): string {
  if (!bible) return "";
  const entries = parseBible(bible);
  if (entries.length === 0) return "";
  // NAMED CHARACTERS ONLY. The old pronoun fallback pulled a main character
  // into any panel containing "he"/"she" — including panels about soldiers,
  // crowds and strangers — which is exactly how narration lines turned into
  // generic "main couple standing somewhere" pictures. No name, no lock.
  const matched = entries.filter((e) => new RegExp(`\\b${escapeRe(e.name)}\\b`, "i").test(prompt));
  if (matched.length === 0) return "";

  // The lock is the single strongest consistency tool we have: it repeats each
  // named character's FIXED traits verbatim in every panel they appear in, and
  // then forbids the three things that actually drifted between shots —
  // clothing, gender and small facial/hair details.
  const traits = matched
    .map((e) => `${e.name}: ${e.traits.replace(/\.$/, "")}`)
    .join("; ");
  return (
    `Appearance lock (identical in every panel): ${traits}. ` +
    `Same exact outfit, same garment colours, same hairstyle and hair colour, same eye colour, ` +
    `same skin tone, same face shape, same gender and same age for each named person — ` +
    `never change, restyle, re-dress, re-age or swap the gender of a named character.`
  );
}

/**
 * Reads a character's age out of their bible line. Age drift was a top
 * complaint — the same "old lady" came back young in the next panel — so
 * whatever age the bible fixed is restated as an explicit render instruction.
 */
export function ageOf(traits: string): string {
  const t = traits.toLowerCase();
  const num = /\b(\d{1,2})\s*(?:-|\s)?(?:to|–|-)?\s*(\d{1,2})?\s*(?:-|\s)?year[s]?[- ]old\b/.exec(
    t,
  );
  if (num) {
    const n = Number(num[1]);
    const look =
      n >= 65
        ? "elderly, deeply wrinkled, grey-haired"
        : n >= 50
          ? "visibly older, lined face, greying hair"
          : n >= 38
            ? "clearly middle-aged, faint lines on the face"
            : n >= 25
              ? "a grown adult"
              : n >= 19
                ? "a young adult"
                : "";
    const label = num[2] ? `${num[1]}-to-${num[2]}-year-old` : `${num[1]}-year-old`;
    return look ? `${label} ${look}` : label;
  }
  const bands: [RegExp, string][] = [
    [
      /\b(elderly|old|aged|ancient|grand(mother|father|ma|pa)|buzurg|budhi|budha)\b/,
      "elderly, clearly aged 65 or older, with deeply wrinkled skin, sagging features and grey or white hair",
    ],
    [
      /\b(middle[- ]aged|forties|fifties|40s|50s)\b/,
      "middle-aged, clearly 40 to 55, with faint lines on the face",
    ],
    [/\b(young adult|twenties|thirties|20s|30s)\b/, "a young adult in their twenties or thirties"],
    [/\b(teen(age[rd]?)?|adolescent|schoolboy|schoolgirl)\b/, "a teenager, clearly 13 to 18"],
    [/\b(child|kid|little (boy|girl)|toddler|infant|baby)\b/, "a young child"],
  ];
  for (const [re, label] of bands) if (re.test(t)) return label;
  return "";
}

/**
 * True when the prompt describes at least one human in frame.
 *
 * Order matters. A named cast member ALWAYS wins: the old version tested the
 * "no people / empty environment" wording FIRST, so a two-person scene whose
 * prompt happened to carry an empty-frame phrase anywhere in it (a leftover
 * guard, "no people watching", "unpopulated street") was declared peopleless.
 * The composer then dropped every character description and appended "empty
 * location, scenery only" to a scene with two people in it — the single largest
 * source of pictures showing the wrong thing.
 *
 * An empty-frame declaration is now only believed when nothing else in the
 * prompt names a person: the phrases are removed before the human-noun scan so
 * "no people" cannot count as the noun "people" in either direction.
 */
export function hasPeople(prompt: string, bible?: string): boolean {
  const p = prompt.toLowerCase();

  // 1. A character from the consistency sheet is named -> people are in frame.
  if (
    bible &&
    parseBible(bible).some((e) => new RegExp(`\\b${escapeRe(e.name)}\\b`, "i").test(prompt))
  )
    return true;

  const emptyPhrase =
    /\bno (?:people|figures?|characters?|humans?)\b|\bempty environment\b|\bunpopulated\b|\bscenery only\b/g;
  const withoutEmptyPhrases = p.replace(emptyPhrase, " ");

  // 2. A human is described somewhere outside those phrases -> people in frame.
  if (
    /\b(man|men|woman|women|boy|boys|girl|girls|child|children|person|people|crowd|figure|silhouette|soldier|guard|villager|student|teacher|shopkeeper|worker|stranger|face|faces|he|she|they)\b/.test(
      withoutEmptyPhrases,
    )
  )
    return true;

  // 3. Nothing but an empty-frame declaration -> a true scenery shot.
  return false;
}

/**
 * Hard budget for what actually reaches the image model.
 *
 * Flux reads the prompt through TWO encoders: T5 (~256 tokens, ~1000 chars)
 * and CLIP, which sees ONLY the first ~77 tokens (~300 chars). Whatever sits
 * in those first 300 characters is what the picture is "about".
 *
 * The old composition opened with a 200-character style block whose nouns
 * were "large expressive anime eyes and stylised anime faces" — so for CLIP
 * almost every panel was a request for an anime face, and the story moment
 * only started at character ~230. Depending on the seed, the renderer then
 * drew a generic anime close-up (a random girl's face, a grinning boy) with
 * nothing of the line in it. A retry on a new seed sometimes landed on the
 * scene instead, which made the fault look random. Same prompt, same code
 * path — the composition itself was the cause.
 *
 * So: the STORY MOMENT comes first, after only a five-word medium tag, and
 * the style words never name eyes or faces. Style is restated compactly at
 * the end, inside the T5 window.
 */
// Flux reads the prompt with T5, but attention thins out badly past roughly a
// thousand characters: a 1900-character prompt rendered a pretty picture of
// the WRONG moment, which is what the Fix/Reroll buttons were compensating
// for. Short and dense beats long and complete.
const IMAGE_PROMPT_BUDGET = 1500;
// Flux CLIP gives the first ~300 characters the strongest influence. Keep the
// exact action inside that window rather than allowing decorative detail to
// displace it.
const SCENE_BUDGET = 620;
// Enough for hair, eyes, skin and outfit of up to three characters without
// turning the prompt into a character sheet.
const LOCK_BUDGET = 300;


/**
 * Removes writing-model bookkeeping from a prompt before it reaches the
 * renderer. Written prompts arrived carrying their own line number and
 * timestamp ("3. [24s-31s] In the examination hall, ..."). Flux has no idea
 * that is metadata: it drew the digits into the picture and treated the
 * bracketed block as a caption, which is why panels came back with numbers,
 * stray lettering and sheet-like framing.
 */
function stripPromptMeta(p: string): string {
  return p
    // Instructions to the writing model are not drawable content.
    .replace(/\b(?:do not|don't|never|avoid|make sure|ensure|remember to)\b[^.]*\.?/gi, "")
    .replace(/\b(?:setting continuity|continuity|required cast|cast)\s*:\s*/gi, "")
    .replace(/^\s*\d{1,3}\s*[.)]\s*/, "")
    .replace(/\[\s*\d+\s*s?\s*(?:[-–—to]+\s*\d+\s*s?)?\s*\]/gi, "")
    .replace(/\b(?:timestamp|panel|shot|frame|line|scene)\s*#?\s*\d{1,3}\s*[:.)-]?\s*/gi, "")
    .replace(/\b\d{1,3}\s*s\s*[-–—]\s*\d{1,3}\s*s\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,.:;-]+/, "")
    .trim();
}

/** Collapses accidental word doubling ("young young spiky hair"). */
function dedupeWords(p: string): string {
  return p.replace(/\b(\w{3,})(\s+\1\b)+/gi, "$1");
}

/** Trims to a length without cutting mid-word. */
function clip(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(", "), cut.lastIndexOf(" "));
  return cut.slice(0, stop > max * 0.6 ? stop : max).replace(/[\s,.;-]+$/, "");
}

/**
 * Minimal medium tag. Just enough to keep Flux off its photographic default
 * without spending CLIP's short window on style nouns — and, critically,
 * without ever naming faces or eyes as things to draw.
 */
const STYLE_LEAD =
  "premium full-colour Korean action-fantasy webtoon/manhwa artwork showing";



/**
 * The fixed look. This is appended AFTER the scene has been trimmed, never
 * inside the trimmed block: when it lived inside the clipped body it was the
 * first thing cut on a long scene, and those panels came back in a different
 * art style from their neighbours.
 *
 * Kept SHORT on purpose. A long decorative style paragraph competes with the
 * story sentence for the model's attention and is a main reason a picture came
 * back beautiful but wrong — which is exactly what the fix/reroll buttons were
 * being used for.
 */
const STYLE_TAIL =
  "premium full-colour Korean action-fantasy webtoon artwork, crisp black contour lines over meticulously finished digital " +
  "painting, controlled cel shading blended with luminous atmospheric rendering, cool blue-violet shadow depth, brilliant " +
  "story-led rim light and energy glow, expressive detailed faces, dynamic anatomy, cinematic depth and aggressive foreshortening, " +
  "dense directional speed lines, impact bursts, flying debris and environmental reaction, polished serialized-webtoon finish, " +
  "consistent character and environment design across the sequence";



/**
 * Single-panel guard. The look is now explicitly a comic PANEL, so this states
 * positively that there is exactly ONE panel filling the image — otherwise Flux
 * reads "comic panel" as permission to draw a whole multi-panel page. Flux has
 * no negative channel, so everything here describes the wanted result: naming
 * "speech bubbles" or "collage" — even to forbid them — puts those very tokens
 * into the picture, which is what kept producing pages with balloons.
 */
const SINGLE_FRAME_GUARD =
  "exactly one single illustration filling the entire image edge to edge, one continuous scene at one moment from one camera, " +
  "a single uninterrupted picture with nothing dividing it";



/**
 * ONE short identity line per character in frame.
 *
 * The old composition wrote each character twice: a compact "anchor" early and
 * then the full `characterLock` paragraph ("Appearance lock (identical in every
 * panel): ...") later. That repetition is what pushed Flux towards reference
 * sheets and isolated portraits — the prompt read more like a character sheet
 * than a scene. Now every character is described exactly once, briefly.
 */
function identityBrief(prompt: string, bible?: string): string {
  if (!bible) return "";
  // "Sora's room" is a place name, not a person in the picture. Counting it as
  // one put an extra character in the headcount and the renderer duly drew a
  // second person who is not in the scene.
  const present = prompt.replace(/\b([A-Za-z]+)(\s*\([^)]*\))?'s\b/g, "the");
  const matched = parseBible(bible).filter((entry) =>
    new RegExp(`\\b${escapeRe(entry.name)}\\b`, "i").test(present),
  );
  if (matched.length === 0) return "";
  const shown = matched.slice(0, 3);
  const folded = prompt.toLocaleLowerCase();
  const briefs = shown.map((entry) => {
    // DESCRIBE EACH PERSON ONCE. The writing model already weaves a character's
    // hair, eyes and outfit into the scene sentence; repeating those traits here
    // read to Flux as a second, similar-looking person, and panels came back
    // with twin Kais and two Harutos. So when the scene already carries the
    // traits, this list contributes the NAME only.
    const traits = dedupeWords(entry.traits.replace(/\.$/, ""));
    const tokens = traits
      .toLocaleLowerCase()
      .match(/\b[a-z]{4,}\b/g)
      ?.filter((w) => !/(year|male|female|build|expression|posture|young|old)/.test(w));
    const already = (tokens ?? []).filter((w) => folded.includes(w)).length;
    return already >= 2 ? entry.name : `${entry.name} is ${clip(traits, 95)}`;
  });
  // An explicit headcount is what stopped the renderer inventing extra copies.
  const count =
    shown.length === 1 ? "exactly one person" : `exactly ${["", "one", "two", "three"][shown.length]} people`;
  return `${count} in this frame: ${briefs.join("; ")}`;
}

/**
 * Story staging. Flux's default for a described person is a front-facing
 * portrait looking straight at the viewer, so the intended staging is stated
 * positively and concretely instead of being left to the model.
 */
const STAGING_GUARD =
  "stage each character according to the exact story action and emotional beat; use natural body orientation, interaction, " +
  "gesture, weight shift and gaze direction, with dynamic poses whenever the moment involves movement or conflict";

/**
 * Framing guard. Panels came back with a head cut off at the top edge or a
 * torso filling the frame, so the safe area is stated positively.
 */
const FRAMING_RULE =
  "choose the most effective cinematic webtoon framing for the exact moment: wide shot, medium shot, close-up, extreme " +
  "close-up, over-the-shoulder, low angle, high angle, side angle, Dutch angle or dramatic perspective as appropriate to the action and emotion";

const WEBTOON_EFFECTS =
  "use story-appropriate high-energy Korean webtoon effects: dense speed lines converging on the action, explosive impact bursts, " +
  "layered motion streaks, dust, airborne rubble, shockwaves, luminous energy or slash trails, dramatic shadows, eye emphasis, " +
  "atmospheric particles and visible environmental reaction, integrated with the drawing rather than added as decoration";

const ACTION_BEAT =
  /\b(attack(?:s|ed|ing)?|fight(?:s|ing)?|battle|combat|punch(?:es|ed|ing)?|kick(?:s|ed|ing)?|strike(?:s|uck|iking)?|slash(?:es|ed|ing)?|stab(?:s|bed|bing)?|shoot(?:s|ing)?|fire[sd]?|charge(?:s|d|ing)?|rush(?:es|ed|ing)?|run(?:s|ning)?|sprint(?:s|ed|ing)?|chase(?:s|d|ing)?|jump(?:s|ed|ing)?|leap(?:s|t|ed|ing)?|dodge(?:s|d|ing)?|fall(?:s|ing)?|fell|throw(?:s|ing)?|threw|smash(?:es|ed|ing)?|crash(?:es|ed|ing)?|collid(?:e|es|ed|ing)|impact|explod(?:e|es|ed|ing)|blast(?:s|ed|ing)?|transform(?:s|ed|ing|ation)?|awaken(?:s|ed|ing)?|spell|magic|aura|energy|lightning|flames?|shockwave|weapon|sword|blade|arrow|bullet|monster|demon|beast|war|army|running|flying|escaping|struggling|grabbing|pushing|pulling)\b|(?:टक्कर|हमला|लड़ाई|दौड़|भाग|कूद|मुक्का|लात|तलवार|गोली|जादू|शक्ति)/i;

const ACTION_DIRECTION =
  "ACTION PANEL — stage a premium Korean action-webtoon climax, freezing the decisive peak-motion instant rather than a standing pose: show a clear movement path, forceful body rotation and weight transfer, aggressive foreshortening or a tilted camera, deep foreground-to-background scale and a readable impact or destination; layer dense directional speed lines, motion trails, a radiant impact burst or shockwave, flying dust and fractured debris, displaced clothing and hair, luminous energy or slash trails, and visible environmental reaction; let the subject, aura or debris break the frame edge while expressions and gaze communicate effort, speed, danger and impact";

function actionSfx(prompt: string, line?: string): string {
  const beat = `${line ?? ""} ${prompt}`;
  const match = (pattern: RegExp) => pattern.test(beat);
  if (match(/\b(punch|kick|fast attack|rush attack)\b|मुक्का|लात/i)) return "WHOOSH! → BAM!";
  if (match(/\b(explosion|explode|detonate|massive blast)\b/i)) return "KRA-BOOM!";
  if (match(/\b(power release|huge blast|energy burst)\b|शक्ति/i)) return "BOOOOM!";
  if (match(/\b(electric|electricity|lightning|thunder)\b/i)) return "ZZZTT!";
  if (match(/\b(charge|charging|vibrat|charged energy)\b/i)) return "VWOOM!";
  if (match(/\b(flame|fire burst|energy flame)\b/i)) return "FWOOM!";
  if (match(/\b(shockwave|shock wave)\b/i)) return "WHOOM!";
  if (match(/\b(draw|unsheath).{0,20}\b(sword|blade)\b|तलवार.*(?:निकाल|खींच)/i)) return "SHING!";
  if (match(/\b(weapon|sword|blade).{0,30}\b(collide|clash|block)\b|तलवार.*टक्कर/i)) return "CLANG!";
  if (match(/\b(stab|pierce)\b/i)) return "SHNK!";
  if (match(/\b(slash|slice|sword swing|blade swing)\b|तलवार/i)) return "SWOOSH!";
  if (match(/\b(crash|smash|collision)\b|टक्कर/i)) return "CRASH!";
  if (match(/\b(slam|slammed)\b/i)) return "SLAM!";
  if (match(/\b(crack|breaking|bone breaks?)\b/i)) return "KRAK!";
  if (match(/\b(fall|fell|hits? the ground|body hitting)\b/i)) return "THUD!";
  if (match(/\b(heavy landing|lands? heavily)\b/i)) return "THUMP!";
  if (match(/\b(heavy impact|brutal hit|powerful hit)\b|हमला/i)) return "WHAM!";
  if (match(/\b(dash|launches? forward|explosive acceleration)\b/i)) return "DASH!";
  if (match(/\b(teleport|too fast|extremely fast|vanish(?:es|ed)?|blur)\b/i)) return "ZOOOM!";
  if (match(/\b(sudden movement|quick movement|dodge)\b/i)) return "SHHHK!";
  if (match(/\b(rush of air|air rushing|powerful rush)\b/i)) return "FWOOSH!";
  if (match(/\b(slash|swift|swish)\b/i)) return "SWISH!";
  if (match(/\b(run|sprint|chase|rush|jump|leap|fly|flying|escape)\b|दौड़|भाग|कूद/i)) return "WHOOSH!";
  return "BAM!";
}

function sfxDirection(prompt: string, line?: string): string {
  const sfx = actionSfx(prompt, line);
  return `render exactly one large stylized SFX reading “${sfx}”, integrated beside the matching movement or impact with bold hand-drawn webtoon lettering, perspective distortion and an effect-matched outline; this SFX is the only visible lettering in the image`;
}

function isActionBeat(prompt: string, line?: string): boolean {
  return ACTION_BEAT.test(`${line ?? ""} ${prompt}`);
}

/**
 * STRICT combat test — the only case where a visible SFX word is allowed.
 * Running, jumping, flying, glowing auras, magic objects, crowds and ordinary
 * movement are action for STAGING purposes but stay completely wordless.
 */
const COMBAT_SFX_BEAT =
  /\b(attack(?:s|ed|ing)?|fight(?:s|ing)?|battle|combat|punch(?:es|ed|ing)?|kick(?:s|ed|ing)?|slash(?:es|ed|ing)?|stab(?:s|bed|bing)?|strike(?:s|ing)?|struck|clash(?:es|ed|ing)?|smash(?:es|ed|ing)?|slam(?:s|med|ming)?|collide[sd]?|collision|explosion|explod(?:e|es|ed|ing)|detonat\w*|blast(?:s|ed|ing)?|shockwave|gunshot|shoot(?:s|ing)?|shot|sword|blade|weapon|bullet|impact(?:s|ed)?|crash(?:es|ed|ing)?)\b|(?:टक्कर|हमला|लड़ाई|मुक्का|लात|तलवार|गोली|विस्फोट)/i;

function isCombatBeat(prompt: string, line?: string): boolean {
  return COMBAT_SFX_BEAT.test(`${line ?? ""} ${prompt}`);
}

/**
 * Scale direction. Big real-world subjects kept coming back miniature (a school
 * drawn as one small cottage, a hall as a tiny room, a ship as a rowing boat),
 * so their true size is stated positively with human size references. Genuinely
 * small subjects are left alone.
 */
const BIG_SUBJECT =
  /\b(school|academy|college|university|campus|hall|auditorium|stadium|arena|palace|castle|fortress|temple|shrine|cathedral|tower|skyscraper|city|town|street|market|harbou?r|port|ship|vessel|boat|warship|train|station|airport|bridge|mountain|cliff|valley|forest|army|crowd|hangar|factory|gate|courtyard|library|mansion|dome|wall)\b/i;
const SMALL_HINT = /\b(tiny|small|little|miniature|toy|model|cramped|narrow little)\b/i;

function scaleDirection(sceneText: string): string {
  if (!BIG_SUBJECT.test(sceneText) || SMALL_HINT.test(sceneText)) return "";
  return (
    "TRUE SCALE — draw every large structure, vehicle, landscape and gathering at its full monumental real-world size: " +
    "towering height, great width and deep distance, with people, doors and nearby objects placed in frame as clear size references " +
    "that make the subject read as vast; use a wide establishing camera and strong perspective so the sheer scale is obvious"
  );
}

/** Environment requirement — a scene, never a floating figure on blank paper. */
const BACKGROUND_GUARD =
  "detailed environment with depth, props and scenery behind them";


/** Keep the timestamp's decisive place/subject/action sentence at the front. */
export function openingBeat(prompt: string): { lead: string; rest: string } {
  const firstStop = prompt.search(/[.!?](?:\s|$)/);
  // The old version took everything up to the first full stop as the lead and
  // then clipped that to 220 characters — and since these scene descriptions
  // are usually ONE long sentence, everything past character 220 (clothing,
  // props, lighting, the rest of the action) was silently thrown away with no
  // "rest" left. Cut at a comma near 220 instead and keep the remainder.
  const hardEnd = firstStop >= 80 && firstStop + 1 <= 220 ? firstStop + 1 : 0;
  let end = hardEnd || Math.min(prompt.length, 220);
  if (!hardEnd && prompt.length > 220) {
    const comma = prompt.lastIndexOf(",", 220);
    if (comma > 80) end = comma + 1;
  }
  return {
    lead: prompt.slice(0, end).trim(),
    rest: prompt.slice(end).trim(),
  };
}

export function composeImagePrompt(
  prompt: string,
  bible?: string,
  line?: string,
  /** The previous panel's place and cast, carried forward for continuity. */
  continuity?: string,
  /** Frame count + translated speech balloons for this timestamp. */
  plan?: PanelPlan,
): string {
  bible = bible ? normalizeLeadCharacter(bible) : bible;
  // Frame layout and balloon lettering are parsed off FIRST: the sanitisers
  // below strip every mention of text from the picture body on purpose, so the
  // lettering instruction is re-attached at the very end, untouched.
  const panels = plan ?? parsePanelPlan(prompt);
  const directive = panelDirective(panels);
  prompt = panels.body;
  // The set sheet travels at the END of the written prompt, where the scene
  // trimming below would have thrown it away — which is exactly why panels of
  // one continuing scene kept coming back in a different room. Lift it out
  // first and re-attach it as reserved, never-trimmed text.
  const lockSplit = prompt.search(/LOCATION LOCK\b/i);
  const carriedLock = lockSplit >= 0 ? prompt.slice(lockSplit).trim().replace(/^\W+/, "") : "";
  const promptBody = lockSplit >= 0 ? prompt.slice(0, lockSplit).replace(/[\s,.;-]+$/, "") : prompt;
  const clean = stripPromptMeta(dedupeWords(promptBody));

  const withCast = enforceLineCast(clean, line, bible);
  const fixed = collapseRepeatedIdentity(
    stripPromptMeta(enforceGender(sanitizePrompt(withCast), bible)),
    bible,
  );
  const peopled = hasPeople(fixed, bible);
  const action = isActionBeat(fixed, line);
  // Flux has no negative channel, so an "no people / unpopulated" phrase left
  // inside a PEOPLED scene both confused the cast decision above and drew extra
  // bystanders. Once the scene is known to have people, the phrase is dropped.
  const scenedText = peopled
    ? fixed
        .replace(
          /,?\s*\b(?:with\s+|and\s+)?no (?:people|figures?|characters?|humans?)\b[^.,;:]*/gi,
          "",
        )
        .replace(/,?\s*\bunpopulated\b/gi, "")
        // The writing model sometimes opens a two-person beat with "Empty
        // environment shot, no people:" — the phrase used to survive into the
        // first, most influential words of the picture instruction.
        .replace(
          /^\s*(?:an?\s+)?empty\s+(?:environment|location|place|scene|street|room)\s*(?:shot|view)?\s*[:,-]?\s*/i,
          "",
        )
        .replace(
          /,?\s*\b(?:an?\s+)?empty\s+(?:environment|location)\s*(?:shot|view)?\b\s*[:,-]?/gi,
          "",
        )
        .replace(/,?\s*\bscenery only\b/gi, "")
        .replace(/\s{2,}/g, " ")
        .replace(/\s+([,.])/g, "$1")
        .replace(/(,\s*){2,}/g, ", ")
        .replace(/^[\s,.:;-]+/, "")
        .trim()
    : fixed;
  const beat = openingBeat(scenedText);
  const restText = clip(beat.rest, Math.max(120, SCENE_BUDGET - beat.lead.length));
  // Identity is judged against the text that ACTUALLY ships, not the untrimmed
  // one: a character whose clothing was trimmed off the scene used to be listed
  // by bare name, so the renderer dressed her however it liked.
  const sceneText = `${beat.lead}. ${restText}`;
  // Exactly ONE identity description per character, and only when someone is
  // actually in frame. No second appearance-lock paragraph.
  const identity = peopled ? clip(identityBrief(sceneText, bible), LOCK_BUDGET) : "";
  // The set sheet that came with the written prompt wins: it is the one shared
  // by every other panel of the same scene. Only a panel that arrived without
  // one derives its own (same deterministic sheet, so it still matches).
  const setLock = clip(carriedLock || locationLock(sceneText, bible, continuity), 380);


  // The place owns the very first words. A close-up line ("Close-up of Yuki
  // shouting") used to open the prompt with a face and nothing else, and the
  // renderer answered with a portrait floating in an invented backdrop. When
  // the running location is known and the line does not name its own, it is
  // stated before the action so the picture stays in the story's own place.
  const ownPlace = detectSetting(beat.lead);
  const carried = !ownPlace && continuity ? detectSetting(continuity) : null;
  const placeLead = carried ? `inside the same ${carried} as the previous picture, ` : "";

  // Order: the story moment, then WHO is in it, then a SHORT set of guards.
  //
  // Why this got shorter: every extra clause dilutes the model's attention, and
  // a diluted prompt is exactly what produced a good-looking picture of the
  // wrong moment — the panels that needed Fix/Reroll. The guards are now
  // phrased positively too, because Flux has no negative channel: writing
  // "no speech bubbles" literally puts speech bubbles into the picture.
  const parts = [
    `${STYLE_LEAD} ${placeLead}${beat.lead}`,
    restText,
    identity,
    continuity ? clip(`continue the same action and spatial positions from the previous picture: ${continuity}`, 140) : "",
    peopled ? STAGING_GUARD : "",
    peopled ? FRAMING_RULE : "",
    peopled && !action ? WEBTOON_EFFECTS : "",
    peopled ? "each person appears once" : "empty location, scenery only",
    BACKGROUND_GUARD,
  ].filter(Boolean);


  // The set sheet and the fixed look are BOTH reserved: neither may ever be
  // trimmed away, because a trimmed set sheet is a redrawn room and a trimmed
  // look is a panel in a different art style from its neighbours.
  //
  // A visible SFX word belongs ONLY to a real combat impact. Running, jumping,
  // flying and glowing magic are staged as action but stay wordless.
  const combat = action && isCombatBeat(fixed, line);
  const actionLead = action
    ? `${ACTION_DIRECTION}. ${combat ? `${sfxDirection(fixed, line)}. ` : directive ? "" : `${NO_TEXT_GUARD}. `}`
    : "";
  const scaleLead = scaleDirection(`${line ?? ""} ${sceneText}`);
  const lead = `${scaleLead ? `${scaleLead}. ` : ""}${actionLead}`;
  const tail = `${setLock ? `${setLock}. ` : ""}${STYLE_TAIL}${panels.frames > 1 ? "" : `. ${SINGLE_FRAME_GUARD}`}`;
  const scene = clip(
    parts
      .join(". ")
      .replace(/,\s*\./g, ".")
      .replace(/\.\s*\./g, ".")
      .replace(/\s{2,}/g, " "),
    Math.max(200, IMAGE_PROMPT_BUDGET - lead.length - tail.length - 2),
  );

  // Scale and action direction sit before the scene and outside its trimming
  // budget, so the image model always receives size, movement and effect instructions.
  return `${lead}${scene}. ${tail}${directive ? `. ${directive}` : ""}`;
}


/* ------------------------------------------------------------------ */
/* Quick size check                                                    */
/* ------------------------------------------------------------------ */

/** Anything smaller than this is not a real panel. */
const MIN_IMAGE_BYTES = 40_000;

/**
 * Fast sanity check: ask the server how big the file is. No download, no
 * entropy maths, no end-of-file probing — those were the slow part.
 */
async function isRealImage(url: string): Promise<boolean> {
  const gate = killableSignal(20_000);
  try {
    const res = await fetch(url, { method: "HEAD", signal: gate.signal });
    if (!res.ok) return true; // can't tell — keep the panel
    const len = Number(res.headers.get("content-length"));
    if (!Number.isFinite(len) || len === 0) return true;
    return len >= MIN_IMAGE_BYTES;
  } catch (e) {
    if (e instanceof KilledError) throw e;
    return true;
  } finally {
    gate.release();
  }
}


/** A wait that ends the moment the run is killed or the caller hangs up. */
async function pause(ms: number): Promise<void> {
  const step = 100;
  for (let waited = 0; waited < ms; waited += step) {
    assertActive();
    await new Promise((r) => setTimeout(r, Math.min(step, ms - waited)));
  }
  assertActive();
}

/** Calls Flux.1 Schnell (free tier) at balanced quality/speed with retries. Always 16:9. */
export async function generateImage(
  prompt: string,
  seed: number,
  slot = 0,
  bible?: string,
  attempts = 6,
  line?: string,
  continuity?: string,
  /** Frame layout + translated balloons for this timestamp. */
  plan?: PanelPlan,
): Promise<string> {
  const body = composeImagePrompt(prompt, bible, line, continuity, plan);
  // Anchor the noise to the PLACE, not to the panel number. Flux rebuilds a
  // room from scratch for every unrelated seed, which is why ten panels in one
  // hall were ten different halls. Panels sharing a location now share a seed
  // family (a small spread keeps the action varied without redesigning the set).
  const placeKey = detectSetting(`${prompt} ${continuity ?? ""}`);
  const anchored = placeKey
    ? (stableHash(`${placeKey}|${(bible ?? "").slice(0, 400)}`) % 900_000) + (seed % 6)
    : seed;


  let lastErr = "";
  // A rate-limit answer is not a failed render — it means "not yet". Those
  // rounds are waited out instead of spending one of the real attempts, so a
  // busy free tier no longer burns the whole retry ladder in a few seconds.
  const maxAttempts = Math.max(1, attempts);
  let attempt = 0;
  let rateLimited = 0;
  while (attempt < maxAttempts && rateLimited < 8) {
    // A killed run never spends another image credit.
    assertActive();
    let throttled = false;
    // withImageKey owns the provider's request budget: this waits for a free
    // slot (including any shared cooldown), so the free tier is respected.
    const url = await withImageKey(slot, attempt, async (key) => {
      const gate = killableSignal(IMAGE_REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(AGNES_URL, {
          method: "POST",
          signal: gate.signal,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            model: AGNES_IMAGE_MODEL,
            // The model has no seed channel, so a retry must differ in the
            // text itself; the variation note is neutral art direction and
            // never changes the scene.
            prompt: attempt === 0 ? body : `${body} [render variation ${anchored + attempt}]`,
            // 16:9 tier output: 1312x736, the closest match to the panel frame.
            size: "1K",
            ratio: "16:9",
            extra_body: { response_format: "url" },
          }),
        });
        if (res.ok) {
          const json = (await res.json()) as {
            data?: { url?: string | null; b64_json?: string | null }[];
          };
          const out = json.data?.[0]?.url ?? undefined;
          if (out) {
            if (await isRealImage(out)) {
              noteImageSuccess();
              return out;
            }
            lastErr = "blank image rejected";
          } else {
            lastErr = "no output url";
          }
        } else {
          const errorBody = await res.text().catch(() => "");
          // Agnes' Cloudflare edge sometimes reports error 1015 as HTTP 403,
          // not 429. Treat the response body as authoritative so that case
          // joins the shared cooldown instead of burning ordinary retries.
          const limited =
            res.status === 429 ||
            res.status === 503 ||
            /error code:?\s*1015|too many requests|rate[ -]?limit|temporarily overloaded/i.test(errorBody);
          if (limited) {
            const retryAfterHeader = res.headers.get("retry-after");
            const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : Number.NaN;
            const retryAfterDate = retryAfterHeader ? Date.parse(retryAfterHeader) : Number.NaN;
            const headerWait = Number.isFinite(retryAfterSeconds)
              ? retryAfterSeconds * 1000
              : Number.isFinite(retryAfterDate)
                ? Math.max(0, retryAfterDate - Date.now())
                : undefined;
            // Cloudflare 1015 is a rolling-window block. Give it a full minute
            // when no longer Retry-After is supplied; short retries prolong it.
            const waitMs = noteRateLimit(
              /1015/.test(errorBody) ? Math.max(headerWait ?? 0, 15_000) : headerWait,
            );
            throttled = true;
            lastErr = `${res.status} rate limited, waiting ${Math.round(waitMs / 1000)}s`;
          } else {
            lastErr = `${res.status} ${errorBody}`.slice(0, 300);
          }
        }
        if (lastErr) console.warn(`[agnes] seed=${seed} attempt ${attempt + 1}: ${lastErr}`);
      } catch (e) {
        if (e instanceof KilledError) throw e;
        lastErr = e instanceof Error ? e.message : String(e);
        console.warn(`[agnes] seed=${seed} attempt ${attempt + 1} threw: ${lastErr}`);
        assertActive();
      } finally {
        gate.release();
      }
      return null;
    });
    if (url) return url;
    if (throttled) {
      // A published server call has a finite lifetime and may be running in an
      // isolate that cannot share this module's limiter with sibling calls.
      // Return capacity pressure to the browser immediately; its durable queue
      // will retry without consuming the panel's render-attempt budget.
      rateLimited++;
      throw new Error(lastErr || "429 rate limited");
    }
    attempt++;
    // Short breather only: long back-offs made panels look stuck.
    await pause(100);
  }
  throw new Error(`Image generation failed: ${lastErr}`);
}

/* ------------------------------------------------------------------ */
/* Never-give-up render ladder                                         */
/* ------------------------------------------------------------------ */

/**
 * The ONLY permitted prompt rewrite: softening.
 *
 * A failed render is never shortened, truncated or reduced to a stub — that
 * produced generic, off-script panels. The full scene description is always
 * kept; the only rewrite replaces wording the free renderer refuses, and it is
 * applied only when the failure itself was a content refusal.
 */
export function promptVariant(prompt: string, level: number, _line?: string): string {
  const base = sanitizePrompt(prompt);
  if (level <= 0) return base;

  const soft: [RegExp, string][] = [
    [
      /\b(blood|bloody|bleeding|gore|gory|mutilated|dismembered|corpse|corpses|dead bodies?|severed)\b/gi,
      "aftermath",
    ],
    [
      /\b(kill(s|ing|ed)?|murder(s|ing|ed)?|slaughter(s|ing|ed)?|massacre(s|d)?|stab(s|bing|bed)?|torture(s|d)?)\b/gi,
      "attack",
    ],
    [/\b(naked|nude|nudity|topless|lingerie|seductive|sensual|erotic)\b/gi, "fully clothed"],
    [/\b(child|children|kid|kids|toddler|infant|baby)\b/gi, "young person"],
  ];
  let out = base;
  for (const [re, to] of soft) out = out.replace(re, to);
  return out.replace(/\s{2,}/g, " ").trim();
}

/**
 * Corrective rewrite used ONLY after the automatic review rejected a render.
 * Reroll changes the seed; this changes the composition, steering away from
 * the exact fault the reviewer named.
 */
export function correctiveVariant(prompt: string, reason: string): string {
  const fixes: Record<string, string> = {
    sketch: "fully finished production artwork with matte flat print-ink fills",
    sheet: "a single continuous story moment inside one real location, one appearance of each person",
    no_background:
      "a fully painted location filling the entire background with depth, furniture, props and scenery",
    facing_viewer:
      "characters naturally engaged in the exact action, with body orientation, gesture and gaze serving the story beat",
    duplicate: "each named person appears exactly once, whole separate bodies, clearly spaced apart",
    bad_crop:
      "a deliberate cinematic composition preserving every story-essential feature; crop only when a close-up or extreme close-up serves the emotional beat",
    underage_lead:
      "preserve the protagonist's exact appearance and identity from the supplied character sheet without adding or changing demographic traits",
    wrong_scene: "exactly the location, cast and action described above and nothing else",
    text: "a completely wordless picture with no lettering anywhere",
  };
  const fix = fixes[reason.toLowerCase().trim()] ?? fixes["wrong_scene"];
  return `${prompt}. Composition correction: ${fix}.`;
}

/** True when the renderer refused the wording rather than simply failing. */
function contentRefusal(message: string): boolean {
  return /nsfw|safety|moderat|blocked|prohibit|forbidden|policy|inappropriate|not allowed|flagged|400|422/i.test(
    message,
  );
}


/**
 * Renders one panel with the FULL prompt.
 *
 * A failure is simply retried with the same complete prompt on a fresh seed and
 * the next image key. The prompt is never shortened or replaced by a stub; the
 * only rewrite is a softened version of the same full scene, and only when the
 * renderer refused the wording on content grounds.
 */

export async function renderPanel(
  written: string,
  seed: number,
  slot = 0,
  bible?: string,
  line?: string,
  timestamp?: string,
  /** Previous panel's place and cast, so a reroll cannot relocate the scene. */
  continuity?: string,
  /** This timestamp's own length in seconds; it caps the frame count. */
  duration?: number,
): Promise<{
  url: string;
  prompt: string;
  level: number;
  tries: number;
  rewritten: boolean;
}> {
  const errors: string[] = [];
  let tries = 0;

  // NO TEXT OR VISION CALLS ON THE RENDER PATH.
  //
  // Prompt writing already receives each exact timestamp and its own script
  // line, so the prompt is drawn as written. Both the prompt re-check and the
  // post-render image review are gone: they added one rate-limited request per
  // panel and were the slowest part of a long run. Quality is controlled by the
  // prompt composition in composeImagePrompt instead.
  //
  // The frame/balloon tail is split off here, once, so every retry below draws
  // the same layout and the same translated dialogue as the first attempt.
  // The timestamp itself ("12s-18s") carries the length, so the frame ceiling
  // needs nothing extra from the caller.
  const span = /(-?\d+(?:\.\d+)?)s?\s*-\s*(-?\d+(?:\.\d+)?)s?/.exec(timestamp ?? "");
  const seconds =
    duration ?? (span ? Math.max(0, Number(span[2]) - Number(span[1])) : undefined);
  const plan = parsePanelPlan(written, seconds, line);
  const prompt = plan.body;
  const rewritten = false;
  if (plan.frames > 1 || plan.bubbles.some((b) => b.text) || plan.narration.some(Boolean))
    console.log(
      `[panels] ${plan.frames} frame(s), ${plan.bubbles.filter((b) => b.text).length} balloon(s)` +
        `, ${plan.narration.filter(Boolean).length} narration box(es)` +
        `${seconds === undefined ? "" : ` for ${seconds.toFixed(1)}s (max ${frameCeiling(seconds)})`}`,
    );


  // Stage 1 — the prompt exactly as written, retried in full on fresh seeds and
  // fresh keys. Each round itself retries inside generateImage, so a busy or
  // flaky renderer is worked through instead of failing the panel.
  let refused = false;
  for (let round = 0; round < 3; round++) {
    tries++;
    try {
      const url = await generateImage(
        prompt,
        seed + round * 1861,
        slot + round,
        bible,
        3,
        line,
        continuity,
        plan,
      );
      return { url, prompt, level: 0, tries, rewritten };
    } catch (e) {
      if (e instanceof KilledError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (/429|rate limited|1015|too many requests|quota/i.test(msg)) throw e;
      errors.push(`round ${round + 1}: ${msg}`);
      if (contentRefusal(msg)) refused = true;
    }
    await pause(400 * (round + 1));
  }
  // Stage 2 — softened wording (same scene, same length). Tried whenever the
  // full prompt could not be rendered, not only on an explicit refusal: a free
  // renderer often reports a content block as a plain failure.
  const softened = promptVariant(prompt, 1, line);
  if (softened && softened !== prompt) {
    for (let round = 0; round < (refused ? 3 : 2); round++) {
      tries++;
      try {
        const url = await generateImage(
          softened,
          seed + 5471 + round * 977,
          slot + round,
          bible,
          3,
          line,
          continuity,
          plan,
        );
        return { url, prompt: softened, level: 1, tries, rewritten };
      } catch (e) {
        if (e instanceof KilledError) throw e;
        errors.push(`softened ${round + 1}: ${e instanceof Error ? e.message : String(e)}`);
      }
      await pause(500 * (round + 1));
    }
  }

  // Stage 3 — last resort: the same scene rendered in the plainest possible
  // wording, so a panel is produced rather than a hole in the story.
  const plain = sanitizePrompt(softened || prompt)
    .replace(/["'“”‘’]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 900);
  if (plain.length >= 20) {
    for (let round = 0; round < 3; round++) {
      tries++;
      try {
        const url = await generateImage(plain, seed + 9109 + round * 613, slot + round, bible, 3, line, continuity, plan);
        return { url, prompt: plain, level: 2, tries, rewritten };
      } catch (e) {
        if (e instanceof KilledError) throw e;
        errors.push(`plain ${round + 1}: ${e instanceof Error ? e.message : String(e)}`);
      }
      await pause(600 * (round + 1));
    }
  }

  throw new Error(`Image generation failed after ${tries} tries — ${errors.slice(-2).join(" | ")}`);

}


