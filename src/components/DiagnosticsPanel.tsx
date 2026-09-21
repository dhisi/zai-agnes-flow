import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  diagAsText,
  diagClear,
  diagSnapshot,
  diagSubscribe,
  type DiagEntry,
} from "@/lib/diag";

function time(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour12: false });
}

/** Stable reference: React requires getServerSnapshot to be cached. */
const EMPTY: DiagEntry[] = [];

const COLOR: Record<DiagEntry["level"], string> = {
  info: "text-muted-foreground",
  warn: "text-primary",
  error: "text-destructive",
};

/**
 * The live activity + problem log, shown on the page itself.
 *
 * It opens itself the first time anything fails, so an error never hides in the
 * browser console: the exact message, status and stack are on screen and one
 * tap away from being copied.
 */
export function DiagnosticsPanel() {
  const entries = useSyncExternalStore(diagSubscribe, diagSnapshot, () => EMPTY);
  const [open, setOpen] = useState(false);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [copied, setCopied] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const autoOpened = useRef(false);

  const errors = useMemo(() => entries.filter((e) => e.level === "error"), [entries]);

  useEffect(() => {
    if (errors.length > 0 && !autoOpened.current) {
      autoOpened.current = true;
      setOpen(true);
      setErrorsOnly(true);
    }
  }, [errors.length]);

  const shown = errorsOnly ? errors : entries;

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [open, shown.length]);

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(diagAsText());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const download = () => {
    const blob = new Blob([diagAsText()], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `manga-log-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="mt-8 border-4 border-foreground bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 border-b-2 border-foreground px-4 py-3 text-left"
      >
        <span className="font-display text-lg font-black uppercase">
          Log &amp; problems
          <span className="ml-2 font-mono text-xs font-semibold uppercase text-muted-foreground">
            {entries.length} lines
          </span>
        </span>
        <span className="flex items-center gap-2 font-mono text-xs font-bold uppercase">
          {errors.length > 0 && (
            <span className="border-2 border-destructive bg-destructive/10 px-2 py-0.5 text-destructive">
              {errors.length} problem{errors.length === 1 ? "" : "s"}
            </span>
          )}
          <span>{open ? "Hide ▲" : "Show ▼"}</span>
        </span>
      </button>

      {open && (
        <div className="p-3">
          <div className="mb-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setErrorsOnly((v) => !v)}
              className={`border-2 border-foreground px-3 py-1 font-mono text-xs font-semibold uppercase ${
                errorsOnly ? "bg-foreground text-background" : "hover:bg-foreground hover:text-background"
              }`}
            >
              {errorsOnly ? "Showing problems only" : "Show problems only"}
            </button>
            <button
              type="button"
              onClick={() => void copyAll()}
              className="border-2 border-foreground px-3 py-1 font-mono text-xs font-semibold uppercase hover:bg-foreground hover:text-background"
            >
              {copied ? "Copied ✓" : "Copy log"}
            </button>
            <button
              type="button"
              onClick={download}
              className="border-2 border-foreground px-3 py-1 font-mono text-xs font-semibold uppercase hover:bg-foreground hover:text-background"
            >
              Download log
            </button>
            <button
              type="button"
              onClick={() => {
                autoOpened.current = false;
                diagClear();
              }}
              className="border-2 border-foreground px-3 py-1 font-mono text-xs font-semibold uppercase hover:bg-foreground hover:text-background"
            >
              Clear
            </button>
          </div>

          <div className="max-h-96 overflow-auto border-2 border-foreground bg-background p-2">
            {shown.length === 0 ? (
              <p className="font-mono text-xs text-muted-foreground">
                {errorsOnly ? "No problems so far." : "Nothing logged yet."}
              </p>
            ) : (
              <ul className="space-y-1">
                {shown.map((e) => (
                  <li key={e.id} className={`font-mono text-[11px] leading-snug ${COLOR[e.level]}`}>
                    <span className="opacity-60">{time(e.at)}</span>{" "}
                    <span className="font-bold uppercase">[{e.scope}]</span>{" "}
                    <span className="whitespace-pre-wrap break-words">{e.text}</span>
                  </li>
                ))}
              </ul>
            )}
            <div ref={bottomRef} />
          </div>
        </div>
      )}
    </section>
  );
}
