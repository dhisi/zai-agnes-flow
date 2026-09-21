/**
 * The only text engine in this app: Z.ai GLM (OpenAI-compatible API).
 *
 * Rules baked in here:
 *  - ONE model only (`ZAI_MODEL`, default `glm-4.5-flash` — the newest,
 *    strongest free Z.ai text model as of September 2026).
 *  - Requests are queued: one call in flight at a time, with a small gap so
 *    the account's rate limit is never raced.
 *  - The key lives only in the server environment; it is never sent to the
 *    browser and never written into the codebase.
 */

import { assertActive, killableSignal, KilledError } from "./kill-switch.server";

const API = "https://api.z.ai/api/paas/v4/chat/completions";

/**
 * Free Z.ai text model. `glm-4.5-flash` is used exclusively: the reasoning
 * reasoning model `glm-4.7-flash` burned its budget on hidden thinking and returned
 * degenerate answers (it echoes the input script instead of writing prompts).
 */
export function modelChain(): string[] {
  const override = process.env["ZAI_MODEL"]?.trim();
  const chain = override ? [override] : ["glm-4.5-flash"];
  const extra = process.env["ZAI_MODEL_FALLBACK"]?.trim();
  if (extra && !chain.includes(extra)) chain.push(extra);
  return chain;
}

/** Fixed model. Override with the ZAI_MODEL secret if the id changes. */
export function model(): string {
  return modelChain()[0] as string;
}


function apiKey(): string {
  const key = process.env["ZAI_API_KEY"]?.trim();
  if (!key) throw new Error("Missing ZAI_API_KEY (Z.ai key)");
  return key;
}

/** Largest answer to ask for. */
const MAX_OUT = 60_000;
/**
 * No queue, no spacing, no slot bookkeeping.
 *
 * A single global "one request at a time" gate used to be held by handlers the
 * platform tore down mid-request, so a later run could not get the slot at all:
 * the first script worked, the second crawled and the third looked frozen at
 * start-up. Requests now go straight upstream; only a genuine provider 429/1015
 * causes a wait, and that wait is bounded.
 */
const MAX_RETRY_DELAY_MS = 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Random spread so retries never line up into a new burst. */
const jitter = (ms: number) => Math.round(ms * (0.75 + Math.random() * 0.5));


/**
 * Shared cool-down. A 429 / Cloudflare 1015 is an edge block on the whole
 * account, not on one request, so EVERY caller waits it out instead of each
 * one discovering the block for itself and extending it.
 */
let blockedUntil = 0;
/** When the last upstream call was started, used to space calls apart. */
let lastStart = 0;
const MIN_GAP_MS = 2_000;

/**
 * Exactly ONE text request may be in flight per server process — this is what
 * the earlier version of this app did, and why it never tripped the provider's
 * edge rate limit (Cloudflare 1015). Spacing request STARTS is not enough on
 * its own: several long streams still overlap and count as a burst.
 */
const MAX_IN_FLIGHT = 1;
/** Longest a call may wait for its turn before failing instead of hanging. */
const MAX_QUEUE_WAIT_MS = 900_000;
let inFlight = 0;
const waitingForSlot: (() => void)[] = [];

async function acquireSlot(): Promise<void> {
  if (inFlight >= MAX_IN_FLIGHT) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = waitingForSlot.indexOf(wake);
        if (i >= 0) waitingForSlot.splice(i, 1);
        reject(new Error("Text engine busy: too many requests queued, please retry"));
      }, MAX_QUEUE_WAIT_MS);
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      waitingForSlot.push(wake);
    });
  }
  assertActive();
  inFlight++;
}

function releaseSlot(): void {
  inFlight = Math.max(0, inFlight - 1);
  waitingForSlot.shift()?.();
}

async function waitForSlot(): Promise<void> {
  for (;;) {
    assertActive();
    const now = Date.now();
    const wait = Math.max(blockedUntil - now, lastStart + MIN_GAP_MS - now);
    if (wait <= 0) break;
    console.log(`[zai] holding ${Math.round(wait / 1000)}s (shared cool-down)`);
    await backoff(Math.min(wait, 10_000));
  }
  lastStart = Date.now();
}

/** Waits in short slices, giving up the moment the run is killed. */
async function backoff(ms: number): Promise<void> {
  const total = Math.max(0, Math.min(ms, MAX_RETRY_DELAY_MS));
  const step = 250;
  for (let waited = 0; waited < total; waited += step) {
    assertActive();
    await sleep(Math.min(step, total - waited));
  }
  assertActive();
}

/** True when the provider is momentarily busy — retry the same model. */
function busy(status: number, body: string): boolean {
  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    // Cloudflare 1015 = "you are being rate limited" in front of the provider.
    /error code:?\s*1015|\b1015\b/i.test(body) ||
    /overloaded|temporarily|rate limit|Upstream error|Provider returned error|no available channel/i.test(body)
  );
}

export type ChatOptions = {
  system?: string;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** Total attempts before giving up. */
  attempts?: number;
};

/** One text completion. Concurrent visitors are served in parallel. */
export function zaiChat(user: string, opts: ChatOptions = {}): Promise<string> {
  return callZai(user, opts);
}


async function callZai(user: string, opts: ChatOptions): Promise<string> {
  await acquireSlot();
  try {
    // The free model is shared capacity: a short overload is normal and clears
    // on its own, so patience beats failing the panel.
    const attempts = opts.attempts ?? 14;

    let lastErr = "";
    // Best model first; a busy one is swapped for the next free model instead
    // of failing the batch.
    const models = modelChain();
    let mi = 0;
    const current = () => models[Math.min(mi, models.length - 1)] as string;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const started = Date.now();
      // A killed run never makes another upstream request.
      assertActive();
      // Respects any shared cool-down and keeps calls spaced apart, so a burst
      // never triggers the provider's edge rate limit in the first place.
      await waitForSlot();
      console.log(
        `[zai] request attempt ${attempt + 1}/${attempts} model=${current()} inChars=${user.length} maxOut=${Math.min(MAX_OUT, opts.maxOutputTokens ?? 16_000)}`,
      );
      // Generous by design: a long answer may legitimately stream for an hour.
      const gate = killableSignal(opts.timeoutMs ?? 3_600_000);
      try {
      const res = await fetch(API, {
        method: "POST",
        // This bounds one broken upstream attempt, not the user's workflow.
        // The caller checkpoints and retries later, so a five-hour run remains unlimited.
        signal: gate.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${apiKey()}`,
        },
        body: JSON.stringify({
          model: current(),

          messages: [
            ...(opts.system ? [{ role: "system", content: opts.system }] : []),
            { role: "user", content: user },
          ],
          temperature: opts.temperature ?? 0.7,
          max_tokens: Math.min(MAX_OUT, opts.maxOutputTokens ?? 16_000),
          // The model is a reasoning model by default: its hidden thinking eats
          // the whole answer budget and the reply comes back EMPTY, which used
          // to look like the app hanging on "reading script". Thinking off.
          thinking: { type: "disabled" },

          // STREAMING IS REQUIRED for long answers: a buffered request that
          // sends no bytes for ~2 minutes is severed by the hosting platform.
          stream: true,
        }),
      });

        if (res.ok) {
          const { text, err } = await readStream(res);
          console.log(
            `[zai] attempt ${attempt + 1} ok=200 outChars=${text.length} in ${Date.now() - started}ms${err ? ` streamError=${JSON.stringify(err).slice(0, 200)}` : ""}`,
          );
          if (text) return text;
          lastErr = err
            ? `${err.code ?? "error"} ${err.message ?? ""}`.trim()
            : "empty completion";
          await backoff(1_500 * (attempt + 1));
          continue;
        }

        const body = (await res.text().catch(() => "")).slice(0, 600);
        lastErr = `${res.status} ${body}`;
        console.error(
          `[zai] attempt ${attempt + 1} HTTP ${res.status} in ${Date.now() - started}ms: ${body.slice(0, 300)}`,
        );


        if (busy(res.status, body)) {
          // Z.ai answers a momentary capacity shortage on the free tier with
          // HTTP 429 + code 1305 ("temporarily overloaded"). That is NOT a
          // quota block: retrying a few seconds later succeeds. A real
          // rate-limit block (1015) pauses everyone for much longer.
          const overloaded = /\b1305\b|temporarily overloaded/i.test(body);
          // The best free model being full is not a reason to stall the whole
          // run: switch to the next free model right away.
          if (overloaded && mi + 1 < models.length) {
            const from = current();
            mi++;
            console.error(`[zai] ${from} is full — switching to ${current()}`);
            continue;
          }
          const rateLimited =
            !overloaded && (/1015/.test(body) || /rate limit|too many requests/i.test(body));
          const retryAfter = Number(res.headers.get("retry-after") ?? 0);

          const base = rateLimited
            ? Math.min(MAX_RETRY_DELAY_MS, 60_000 * 2 ** attempt)
            : Math.min(30_000, 3_000 * 2 ** Math.min(attempt, 3));
          const wait = jitter(
            retryAfter > 0 ? Math.max(retryAfter * 1000 + 500, base) : base,
          );

          // Both cases hold back EVERY caller in this process, so parallel
          // panels stop marching into the same wall and deepening the block.
          blockedUntil = Math.max(blockedUntil, Date.now() + wait);
          console.error(
            `[zai] ${rateLimited ? "rate limited" : "overloaded"} (${res.status}) — all requests paused for ${Math.round(wait / 1000)}s`,
          );
          if (attempt + 1 < attempts) {
            await backoff(wait);
          }
          // After the wait, start again from the best model.
          mi = 0;
          continue;

        }


        if (res.status === 400 || res.status === 401 || res.status === 403) break;
        await backoff(1_200 * (attempt + 1));
      } catch (e) {
        if (e instanceof KilledError) throw e;
        lastErr = e instanceof Error ? e.message : String(e);
        console.error(`[zai] attempt ${attempt + 1} threw after ${Date.now() - started}ms: ${lastErr}`);
        assertActive();
        await backoff(1_000 * (attempt + 1));
      } finally {
        gate.release();
      }
    }

    throw new Error(`Z.ai request failed: ${lastErr}`);
  } finally {
    releaseSlot();
  }
}


export function engineStatus(): { model: string; keyIndex: number; keys: number } {
  return { model: model(), keyIndex: 1, keys: 1 };
}

/** Reads a streamed completion. */
async function readStream(
  res: Response,
): Promise<{ text: string; err?: { message?: string; code?: number | string } | undefined }> {
  const body = res.body;
  if (!body) return { text: "" };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let out = "";
  let err: { message?: string; code?: number | string } | undefined;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith(":")) continue;
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const json = JSON.parse(data) as {
          choices?: { delta?: { content?: string }; message?: { content?: string } }[];
          error?: { message?: string; code?: number | string };
        };
        if (json.error) err = json.error;
        const piece = json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.message?.content;
        if (piece) out += piece;
      } catch {
        /* keep reading: a partial frame arrives complete on the next chunk */
      }
    }
  }

  return { text: out.trim(), err };
}

/* Automatic image review removed: panels are no longer inspected by a vision
 * model, so a run spends no time or quota on per-panel review. */
