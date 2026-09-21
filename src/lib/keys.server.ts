/**
 * Image provider access control.
 *
 * ONE key, ONE model: the single Agnes AI key (AGNES_API_KEY) drives every
 * render through `agnes-image-2.5-flash`. The key is read only here, on the
 * server, and is never sent to the browser or written into the codebase.
 *
 * The free tier allows 20 requests per minute, so this module owns a hard
 * 20 RPM sliding-window gate plus a small concurrency cap. Every image request
 * in the process passes through `withImageKey`, so the limit can never be
 * exceeded no matter how many lanes the page runs.
 */

/** Requests allowed per rolling minute (provider limit, kept just under 20). */
export const IMAGE_RPM = 19;
/** Rolling window length. */
const WINDOW_MS = 60_000;
/**
 * Minimum gap between two request starts. Kept small on purpose: the rolling
 * 18/minute window below is the real budget, so several renders may run side by
 * side instead of the queue trickling one image every three seconds.
 */
const SPACING_MS = 200;

/**
 * How many renders may be in flight at once. A render takes ~10s, so four
 * lanes keep the minute budget busy without ever exceeding it.
 */
export const PER_KEY_CONCURRENCY = 8;



export function agnesKey(): string {
  const key = process.env["AGNES_API_KEY"]?.trim();
  if (!key) throw new Error("Missing AGNES_API_KEY (Agnes AI image key)");
  return key;
}

/** Start times of recent requests, oldest first. */
let starts: number[] = [];
let inFlight = 0;
let lastStart = 0;

/* --- Adaptive throttle ------------------------------------------------ *
 * The documented 20 RPM is an upper bound; the provider's edge also rate
 * limits bursts (HTTP 429, "error code: 1015"). When that happens every
 * lane in the process must back off together, otherwise the retries below
 * simply burn the whole ladder in a few seconds — which is exactly what the
 * reported "did not render: 429" panels were. So a 429 opens a shared
 * cooldown and permanently widens the spacing until requests succeed again.
 */

/** No request may start before this timestamp. */
let cooldownUntil = 0;
/** Consecutive rate-limit hits; drives both cooldown length and spacing. */
let throttleLevel = 0;

/** Current minimum gap between two request starts. */
function spacing(): number {
  return SPACING_MS * (1 + Math.min(throttleLevel, 1));
}

/**
 * Record a rate-limit response.
 *
 * A 429 here only means "the rolling minute is already full", not that the
 * account is in trouble: the free tier refills continuously. So the pause is
 * short and flat (never an exponential minute-long freeze), which is what used
 * to leave the whole page waiting while the provider was ready again.
 */
export function noteRateLimit(retryAfterMs?: number): number {
  throttleLevel = Math.min(throttleLevel + 1, 3);
  const backoff =
    retryAfterMs && retryAfterMs > 0
      ? Math.min(Math.max(retryAfterMs, 2_000), 20_000)
      : Math.min(3_000 + 2_000 * (throttleLevel - 1), 12_000);
  cooldownUntil = Math.max(cooldownUntil, Date.now() + backoff);
  return backoff;
}

/**
 * Record a success so the throttle relaxes again. One good render clears the
 * slowdown completely: keeping a widened spacing after the provider is healthy
 * again was what made long runs crawl.
 */
export function noteImageSuccess(): void {
  throttleLevel = 0;
  cooldownUntil = 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function prune(now: number) {
  starts = starts.filter((t) => now - t < WINDOW_MS);
}

/** Milliseconds to wait before another request may start. 0 = go now. */
function waitFor(now: number): number {
  prune(now);
  if (now < cooldownUntil) return cooldownUntil - now;
  if (inFlight >= PER_KEY_CONCURRENCY) return 200;
  const sinceLast = now - lastStart;
  const gap = spacing();
  if (sinceLast < gap) return gap - sinceLast;
  if (starts.length >= IMAGE_RPM) {
    const oldest = starts[0] as number;
    return Math.max(50, WINDOW_MS - (now - oldest));
  }
  return 0;
}

/**
 * Longest a single server call may sit in this gate. The browser scheduler
 * (src/lib/image-rate.ts) owns the account-wide pace; this in-isolate gate is
 * only a safety net, so instead of parking a request for minutes it gives up
 * quickly and reports capacity pressure. The page then re-queues the panel
 * without spending one of its render attempts — which is why a busy minute no
 * longer turns into a 15-minute dead screen.
 */
const MAX_GATE_WAIT_MS = 90_000;

/**
 * Leases a rate-limit slot for the duration of `fn` and hands it the API key.
 * Keeps the historical signature (`slot`, `attempt`) so callers are unchanged;
 * with a single key those only matter for logging.
 */
export async function withImageKey<T>(
  _slot: number,
  _attempt: number,
  fn: (key: string, keyIndex: number) => Promise<T>,
): Promise<T> {
  const key = agnesKey();
  const deadline = Date.now() + MAX_GATE_WAIT_MS;
  // Wait for a free slot inside the per-minute budget, but never indefinitely.
  for (;;) {
    const wait = waitFor(Date.now());
    if (wait <= 0) break;
    if (Date.now() + wait > deadline) {
      throw new Error("429 rate limited, waiting 90s (local pacing gate)");
    }
    await sleep(Math.min(wait, 500));
  }
  const now = Date.now();
  lastStart = now;
  starts.push(now);
  inFlight++;
  try {
    return await fn(key, 0);
  } finally {
    inFlight--;
  }
}

