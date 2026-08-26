// Tiny promise-based IndexedDB wrapper for workstation persistence.
// Stores:
//   conversations — { id, appId, title, messages, files?, createdAt, updatedAt }
//   reports       — { id, title, markdown, createdAt, updatedAt }
//   documents     — { id, name, kind, size, pages, text, chunks?, addedAt }
//   settings      — plain key/value rows { key, value }

const DB_NAME = "gemma4-workstation-v1";
const DB_VERSION = 1;
export const STORES = ["conversations", "reports", "documents", "settings"];

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const store of STORES) {
        if (!db.objectStoreNames.contains(store)) {
          // keyPath "id" for content stores; settings uses out-of-line keys
          if (store === "settings") db.createObjectStore(store);
          else db.createObjectStore(store, { keyPath: "id" });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    try { result = fn(s); } catch (err) { reject(err); return; }
    t.oncomplete = () => resolve(result?.result !== undefined ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("transaction aborted"));
  }));
}

export const db = {
  async put(store, value, key) {
    return tx(store, "readwrite", (s) => (key !== undefined ? s.put(value, key) : s.put(value)));
  },
  async get(store, key) {
    return tx(store, "readonly", (s) => s.get(key));
  },
  async all(store) {
    return tx(store, "readonly", (s) => s.getAll());
  },
  async delete(store, key) {
    return tx(store, "readwrite", (s) => s.delete(key));
  },
  async clearStore(store) {
    return tx(store, "readwrite", (s) => s.clear());
  },
};

export function newId(prefix = "id") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---- Storage usage (topbar meter + settings) ----
export async function storageEstimate() {
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est) return null;
    return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
  } catch { return null; }
}

export function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"]; let v = bytes, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  const digits = u === 3 ? 2 : (v >= 10 || u === 0 ? 0 : 1);
  return `${v.toFixed(digits)} ${units[u]}`;
}
