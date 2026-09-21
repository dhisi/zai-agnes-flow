/**
 * Crash-safe generation progress store.
 *
 * Progress for a long script (thousands of panels, each with a prompt string)
 * is far too big for localStorage's ~5MB quota — the old implementation threw
 * QuotaExceededError ("exceed its storage quota") mid-run. IndexedDB has a
 * dramatically larger quota, so it is the primary store; localStorage is kept
 * only as a migration source and last-ditch fallback, with old keys evicted
 * first when it fills up.
 */

export type SavedRun<T> = {
  bible: string;
  shots: T[];
  script?: string;
  state?: "running" | "stopped" | "done" | "error";
  updatedAt?: number;
};

const DB_NAME = "sceneweaver-progress";
const STORE = "runs";
const LAST_RUN_KEY = "sceneweaver.lastRun";

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbGet<T>(key: string): Promise<SavedRun<T> | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as SavedRun<T> | undefined) ?? null);
      req.onerror = () => resolve(null);
    });
  } finally {
    db.close();
  }
}

async function idbSet<T>(key: string, data: SavedRun<T>): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  try {
    return await new Promise<boolean>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(data, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    });
  } finally {
    db.close();
  }
}

/** Free room in localStorage by dropping the oldest saved runs. */
function evictLocalRuns(keepKey: string) {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("manga:") && k !== keepKey) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

export async function saveRun<T>(key: string, data: SavedRun<T>): Promise<void> {
  const saved = { ...data, updatedAt: Date.now() };
  try {
    localStorage.setItem(LAST_RUN_KEY, key);
  } catch {
    /* IndexedDB remains the source of truth. */
  }
  // Primary: IndexedDB. On success, make sure no stale localStorage copy
  // keeps wasting the small quota.
  if (await idbSet(key, saved)) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
    return;
  }
  // Fallback: localStorage, evicting older runs first if it is full.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      localStorage.setItem(key, JSON.stringify(saved));
      return;
    } catch {
      evictLocalRuns(key);
    }
  }
}

/** Loads the most recently checkpointed run without requiring the script to be pasted again. */
export async function loadLatestRun<T>(): Promise<{ key: string; run: SavedRun<T> } | null> {
  try {
    const key = localStorage.getItem(LAST_RUN_KEY);
    if (!key) return null;
    const run = await loadRun<T>(key);
    return run ? { key, run } : null;
  } catch {
    return null;
  }
}

export async function loadRun<T>(key: string): Promise<SavedRun<T> | null> {
  const fromIdb = await idbGet<T>(key);
  if (fromIdb) return fromIdb;
  // Migration path: runs saved by the old localStorage-only version.
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const data = JSON.parse(raw) as SavedRun<T>;
    // move it to IndexedDB so the small quota is freed
    void saveRun(key, data);
    return data;
  } catch {
    return null;
  }
}
