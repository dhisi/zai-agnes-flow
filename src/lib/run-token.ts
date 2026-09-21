/**
 * Browser side of Insta Kill.
 *
 * Every run carries a stamp minted by the server (so client clocks cannot make
 * a brand-new run look older than the last kill), and every in-flight browser
 * request is tracked so one click can drop them all.
 */

let runStamp = 0;
const controllers = new Set<AbortController>();

export function setRunStamp(stamp: number): void {
  runStamp = stamp;
}

/** The current run's stamp, or undefined when no run is active. */
export function runStampOrUndefined(): number | undefined {
  return runStamp > 0 ? runStamp : undefined;
}

export function trackRequest(controller: AbortController): () => void {
  controllers.add(controller);
  return () => controllers.delete(controller);
}

/** Drops every request this page still has open. */
export function abortTrackedRequests(): number {
  const open = [...controllers];
  controllers.clear();
  for (const controller of open) {
    try {
      controller.abort(new DOMException("Insta Kill", "AbortError"));
    } catch {
      /* already finished */
    }
  }
  return open.length;
}
