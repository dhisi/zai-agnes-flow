/**
 * On-page diagnostics.
 *
 * Everything the app logs, plus every crash, failed request and rejected
 * promise, is recorded here so the page itself can show the EXACT error text —
 * no browser console needed. The store is intentionally dumb: an append-only
 * ring buffer plus subscribers.
 */

export type DiagLevel = "info" | "warn" | "error";

export type DiagEntry = {
  id: number;
  at: number;
  level: DiagLevel;
  scope: string;
  text: string;
};

/** Plenty for a very long run; oldest entries fall off the end. */
const MAX_ENTRIES = 4000;

let nextId = 1;
let entries: DiagEntry[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      /* a broken subscriber must never break logging */
    }
  }
}

export function diagSnapshot(): DiagEntry[] {
  return entries;
}

export function diagSubscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function diagClear(): void {
  entries = [];
  emit();
}

export function diagErrorCount(): number {
  return entries.filter((e) => e.level === "error").length;
}

/** Records one line. Safe to call from anywhere, at any time. */
export function diag(level: DiagLevel, scope: string, text: string): void {
  const entry: DiagEntry = {
    id: nextId++,
    at: Date.now(),
    level,
    scope,
    text: text.length > 4000 ? `${text.slice(0, 4000)}… (truncated)` : text,
  };
  entries = entries.length >= MAX_ENTRIES ? [...entries.slice(1), entry] : [...entries, entry];
  emit();
}

export const logInfo = (scope: string, text: string) => diag("info", scope, text);
export const logWarn = (scope: string, text: string) => diag("warn", scope, text);

/** Records a failure with its full detail: name, message, stack and causes. */
export function logFailure(scope: string, what: string, error?: unknown): void {
  diag("error", scope, error === undefined ? what : `${what}\n${describe(error)}`);
}

/** Full human-readable detail for anything that was thrown. */
export function describe(error: unknown, depth = 0): string {
  if (depth > 4 || error == null) return String(error);
  if (error instanceof Error) {
    const parts = [`${error.name}: ${error.message}`];
    const status = (error as { status?: unknown; statusCode?: unknown }).status ??
      (error as { statusCode?: unknown }).statusCode;
    if (typeof status === "number") parts.push(`status ${status}`);
    if (error.stack) parts.push(error.stack.split("\n").slice(1, 6).join("\n"));
    if (error.cause != null) parts.push(`caused by → ${describe(error.cause, depth + 1)}`);
    return parts.join("\n");
  }
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error, null, 2) ?? String(error);
  } catch {
    return String(error);
  }
}

export function diagAsText(): string {
  return entries
    .map((e) => `${new Date(e.at).toISOString()} [${e.level.toUpperCase()}] [${e.scope}] ${e.text}`)
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* Global capture                                                      */
/* ------------------------------------------------------------------ */

let installed = false;

function stringifyArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return describe(a);
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

/** Pulls a `[scope]` prefix out of a console line so the panel can group it. */
function splitScope(text: string): { scope: string; rest: string } {
  const m = /^\[([a-z0-9 _.:-]{1,24})\]\s*/i.exec(text);
  if (!m) return { scope: "app", rest: text };
  return { scope: m[1] as string, rest: text.slice(m[0].length) };
}

/**
 * Mirrors console output, uncaught errors, rejected promises and failed network
 * requests into the panel. Idempotent — calling it twice changes nothing.
 */
export function installDiagnostics(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const levels: [DiagLevel, "log" | "info" | "warn" | "error"][] = [
    ["info", "log"],
    ["info", "info"],
    ["warn", "warn"],
    ["error", "error"],
  ];
  for (const [level, method] of levels) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      try {
        const { scope, rest } = splitScope(stringifyArgs(args));
        diag(level, scope, rest);
      } catch {
        /* never let logging break the app */
      }
      original(...args);
    };
  }

  window.addEventListener("error", (event) => {
    const e = event as ErrorEvent;
    const where = e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : "";
    logFailure("crash", `Uncaught error${where}`, e.error ?? e.message);
  });

  window.addEventListener("unhandledrejection", (event) => {
    logFailure("crash", "Unhandled promise rejection", (event as PromiseRejectionEvent).reason);
  });

  // Every failed or error-status request is recorded with its URL and status,
  // so a silent backend failure is visible on the page instead of nowhere.
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const started = Date.now();
    try {
      const res = await originalFetch(input, init);
      if (!res.ok) {
        let body = "";
        try {
          body = (await res.clone().text()).slice(0, 800);
        } catch {
          body = "(body unreadable)";
        }
        diag(
          "error",
          "network",
          `HTTP ${res.status} ${res.statusText} · ${url} · ${Date.now() - started}ms\n${body}`,
        );
      }
      return res;
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === "AbortError";
      diag(
        aborted ? "warn" : "error",
        "network",
        `${aborted ? "Request stopped" : "Request failed"} · ${url} · ${Date.now() - started}ms\n${describe(error)}`,
      );
      throw error;
    }
  };

  const env =
    `${navigator.userAgent} · ${window.innerWidth}x${window.innerHeight}` +
    ` · online=${navigator.onLine}`;
  diag("info", "diag", `Diagnostics started · ${env}`);
  window.addEventListener("offline", () => diag("error", "network", "Internet connection lost"));
  window.addEventListener("online", () => diag("info", "network", "Internet connection back"));
}
