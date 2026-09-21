/**
 * Browser-side image request scheduler — the single source of truth for how
 * fast panels may be sent to Agnes AI.
 *
 * Why this lives in the browser: every server call can run in a different
 * isolated worker, so a server-side counter only ever sees a fraction of the
 * traffic. The page, on the other hand, sees every image request of this
 * account, and localStorage lets several tabs share one budget. That makes
 * this the only place where the provider's per-minute limit can actually be
 * respected.
 *
 * Shape of the policy:
 *  - a rolling 60s window with an ADAPTIVE budget: it ramps up while renders
 *    succeed and steps down the moment the provider complains, so the run
 *    settles just under the real limit instead of repeatedly crashing into it;
 *  - evenly spaced starts (no bursts — bursts are what trips Cloudflare 1015);
 *  - a short, bounded pause after a limit, never a long freeze.
 *
 * Throughput is not reduced: the ceiling IS the provider's limit, and this
 * keeps the pipeline parked right below it instead of losing whole minutes to
 * edge blocks.
 */

/** Never send more than this many image starts per rolling minute. */
const MAX_RPM = 18;
/** Where a fresh run starts before it has learned anything. */
const START_RPM = 12;
/** Lowest rate we ever fall back to after repeated limits. */
const MIN_RPM = 5;
/** Successful renders needed before the budget widens by one. */
const RAMP_AFTER_OK = 6;
/** Default pause after a rate-limit answer with no Retry-After header. */
const DEFAULT_PAUSE_MS = 30_000;
/** Hard ceiling for any pause, so the page can never look frozen. */
const MAX_PAUSE_MS = 90_000;
const WINDOW_MS = 60_000;

const STORE_KEY = "agnes.rate.v1";

type State = {
  /** Start timestamps inside the rolling window. */
  starts: number[];
  /** No request may start before this. */
  pauseUntil: number;
  /** Current per-minute budget. */
  rpm: number;
  /** Consecutive successes since the last limit. */
  ok: number;
};

const fresh = (): State => ({ starts: [], pauseUntil: 0, rpm: START_RPM, ok: 0 });

let memory: State = fresh();

function read(): State {
  if (typeof localStorage === "undefined") return memory;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return memory;
    const parsed = JSON.parse(raw) as Partial<State>;
    return {
      starts: Array.isArray(parsed.starts) ? parsed.starts.filter((n) => typeof n === "number") : [],
      pauseUntil: typeof parsed.pauseUntil === "number" ? parsed.pauseUntil : 0,
      rpm: typeof parsed.rpm === "number" ? clampRpm(parsed.rpm) : START_RPM,
      ok: typeof parsed.ok === "number" ? parsed.ok : 0,
    };
  } catch {
    return memory;
  }
}

function write(state: State) {
  memory = state;
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    /* private mode / quota — the in-memory copy still paces this tab */
  }
}

function clampRpm(n: number) {
  return Math.max(MIN_RPM, Math.min(MAX_RPM, Math.round(n)));
}

function prune(state: State, now: number) {
  state.starts = state.starts.filter((t) => now - t < WINDOW_MS).sort((a, b) => a - b);
}

/** Milliseconds to wait before the next start is allowed. 0 = go now. */
function waitFor(state: State, now: number): number {
  prune(state, now);
  if (now < state.pauseUntil) return state.pauseUntil - now;
  // Even spacing across the minute: this is what keeps the provider's edge
  // from seeing a burst even when several lanes finish at the same moment.
  const gap = Math.floor(WINDOW_MS / state.rpm);
  const last = state.starts.length ? (state.starts[state.starts.length - 1] as number) : 0;
  if (now - last < gap) return gap - (now - last);
  if (state.starts.length >= state.rpm) {
    const oldest = state.starts[0] as number;
    return Math.max(100, WINDOW_MS - (now - oldest));
  }
  return 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One reservation at a time per tab, so two lanes never claim the same slot. */
let lock: Promise<unknown> = Promise.resolve();

/**
 * Waits until this tab may start one image request, then books the slot.
 * Every image call — batch renders and single redraws alike — must go
 * through this, otherwise the budget is meaningless.
 */
export async function reserveImageSlot(isCancelled?: () => boolean): Promise<void> {
  const turn = lock.then(async () => {
    for (;;) {
      if (isCancelled?.()) return;
      const state = read();
      const wait = waitFor(state, Date.now());
      if (wait <= 0) {
        state.starts.push(Date.now());
        write(state);
        return;
      }
      await sleep(Math.min(wait, 1_000));
    }
  });
  lock = turn.catch(() => undefined);
  await turn;
}

/**
 * Records a provider rate-limit answer: pause briefly for everyone and lower
 * the budget. The pause is always bounded — a long freeze is exactly the
 * "stuck for 15 minutes" behaviour we are removing.
 */
export function noteImageLimited(retryAfterMs?: number): number {
  const state = read();
  const pause = Math.min(
    MAX_PAUSE_MS,
    Math.max(5_000, retryAfterMs && retryAfterMs > 0 ? retryAfterMs : DEFAULT_PAUSE_MS),
  );
  state.pauseUntil = Math.max(state.pauseUntil, Date.now() + pause);
  state.rpm = clampRpm(state.rpm * 0.6);
  state.ok = 0;
  // Forget the window: after the pause the minute starts clean.
  state.starts = [];
  write(state);
  return pause;
}

/** Records a good render: after a streak the budget widens again. */
export function noteImageOk(): void {
  const state = read();
  state.ok += 1;
  if (state.ok >= RAMP_AFTER_OK && state.rpm < MAX_RPM) {
    state.rpm = clampRpm(state.rpm + 1);
    state.ok = 0;
  }
  write(state);
}

/** Current pace, for the on-screen status line. */
export function imageRateStatus(): { rpm: number; pausedFor: number } {
  const state = read();
  return { rpm: state.rpm, pausedFor: Math.max(0, state.pauseUntil - Date.now()) };
}

/** Parses "429 rate limited, waiting 12s" style messages into a wait hint. */
export function limitHintMs(message: string): number | undefined {
  const m = /waiting\s+(\d+)s/i.exec(message);
  if (m) return Number(m[1]) * 1000;
  if (/1015/.test(message)) return 60_000;
  return undefined;
}

/** True when an error message means "provider is busy", not "bad panel". */
export function isRateLimitMessage(message: string): boolean {
  return /429|rate[ -]?limit|quota|1015|too many|overload|busy/i.test(message);
}
