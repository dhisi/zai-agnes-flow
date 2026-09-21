/**
 * Insta Kill — a server-side stop switch for generation work.
 *
 * A browser refresh does not stop work the server already accepted: prompt
 * writing and panel rendering keep going upstream (burning API quota) while the
 * new page starts a second run. Every unit of work therefore runs inside a run
 * context stamped with the moment its run started, and killing raises an epoch:
 * any work whose run started at or before that epoch is aborted immediately and
 * refuses to make another upstream request.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export class KilledError extends Error {
  constructor(message = "Stopped by Insta Kill — this run was cancelled.") {
    super(message);
    this.name = "KilledError";
  }
}

type RunContext = { runAt: number; abort?: AbortSignal | undefined };

const runStore = new AsyncLocalStorage<RunContext>();

/** Runs started at or before this timestamp are dead. */
let killEpoch = 0;

type LiveRequest = { runAt: number; controller: AbortController };
const live = new Set<LiveRequest>();

export function currentRunAt(): number | undefined {
  return runStore.getStore()?.runAt;
}

export function assertRunAlive(runAt: number | undefined = currentRunAt()): void {
  if (typeof runAt === "number" && runAt <= killEpoch) throw new KilledError();
}

/**
 * Wraps one server handler so everything it awaits belongs to the same run.
 *
 * `abort` is the INCOMING request's own signal. The kill epoch only reaches
 * work running in the same server instance, so a browser that drops its
 * requests is the second, instance-proof half of Insta Kill: as soon as the
 * page aborts, every upstream call this handler owns is aborted too and the
 * API key is released instead of finishing its job in the background.
 */
export function withRun<T>(
  runAt: number | undefined,
  fn: () => Promise<T>,
  abort?: AbortSignal | undefined,
): Promise<T> {
  const at = typeof runAt === "number" && runAt > 0 ? runAt : Date.now();
  assertRunAlive(at);
  if (abort?.aborted) throw new KilledError();
  return runStore.run({ runAt: at, abort }, fn);
}

/** True when the caller that started this run has gone away. */
export function callerGone(): boolean {
  return runStore.getStore()?.abort?.aborted === true;
}

/** Throws as soon as the run is killed OR its caller dropped the request. */
export function assertActive(): void {
  assertRunAlive();
  if (callerGone()) throw new KilledError("Stopped — the request was cancelled.");
}

/**
 * A signal for one upstream request: aborts on its own timeout, and instantly
 * when the run it belongs to is killed. Throws before the request is even made
 * if the run is already dead.
 */
export function killableSignal(timeoutMs: number): { signal: AbortSignal; release: () => void } {
  assertActive();
  const runAt = currentRunAt() ?? Number.POSITIVE_INFINITY;
  const controller = new AbortController();
  const entry: LiveRequest = { runAt, controller };
  live.add(entry);

  const timeout = AbortSignal.timeout(timeoutMs);
  const onTimeout = () => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
  if (timeout.aborted) onTimeout();
  else timeout.addEventListener("abort", onTimeout, { once: true });

  // The caller hanging up kills this upstream call immediately, so the API key
  // it occupies is free for the next job instead of finishing a dead render.
  const caller = runStore.getStore()?.abort;
  const onCallerGone = () => controller.abort(new KilledError());
  if (caller) {
    if (caller.aborted) onCallerGone();
    else caller.addEventListener("abort", onCallerGone, { once: true });
  }

  return {
    signal: controller.signal,
    release: () => {
      timeout.removeEventListener("abort", onTimeout);
      caller?.removeEventListener("abort", onCallerGone);
      live.delete(entry);
    },
  };
}

/** Kills every run started up to now. Returns how many requests were aborted. */
export function killAllRuns(): { killedAt: number; aborted: number } {
  killEpoch = Date.now();
  let aborted = 0;
  for (const entry of [...live]) {
    if (entry.runAt <= killEpoch) {
      live.delete(entry);
      aborted++;
      try {
        entry.controller.abort(new KilledError());
      } catch {
        /* already gone */
      }
    }
  }
  console.log(`[kill] insta kill at ${killEpoch}: aborted ${aborted} in-flight request(s)`);
  return { killedAt: killEpoch, aborted };
}

export function liveRequestCount(): number {
  return live.size;
}
