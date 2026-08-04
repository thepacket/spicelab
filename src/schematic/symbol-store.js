/**
 * Downloading and keeping the KiCad symbol library.
 *
 * Same shape as `model-store.js`, and for the same reasons: one explicit user
 * action, parsed in the browser, kept in IndexedDB so it happens once, and not
 * one byte of it vendored here. See `symbol-library.js` for the source routing
 * and the licence.
 *
 * Deliberately a SEPARATE IndexedDB database from the model library. They are
 * independent downloads with independent licences, and a user who wants
 * symbols but not models — or who clears one — must not lose the other.
 */
import { parseSymbolLib } from './symbol-library.js';

const DB = 'spicelab-symbols';
const VERSION = 1;
const SYMS = 'symbols';
const META = 'meta';

export const SYMBOL_LIB = {
  owner: 'KiCad',
  repo: 'kicad-symbols',
  ref: 'master',
  raw: 'https://raw.githubusercontent.com',
  api: 'https://api.github.com',
  home: 'https://github.com/KiCad/kicad-symbols',
  /** Why this mirror and not the live one — see symbol-library.js. */
  note: 'GitHub mirror, archived 2021, legacy .lib format',
};

export function storageAvailable() {
  return typeof indexedDB !== 'undefined';
}

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SYMS)) db.createObjectStore(SYMS);
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run(db, stores, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    fn(tx);
  });
}

/** List the `.lib` files in the repository. One API request. */
export async function listSymbolFiles({ fetchImpl, signal, lib = SYMBOL_LIB } = {}) {
  const f = fetchImpl ?? globalThis.fetch;
  const url = `${lib.api}/repos/${lib.owner}/${lib.repo}/git/trees/` +
              `${encodeURIComponent(lib.ref)}?recursive=1`;
  const res = await f(url, { signal, headers: { Accept: 'application/vnd.github+json' } });
  if (res.status === 403 || res.status === 429) {
    throw new Error(
      `GitHub's API rate limit is exhausted for your network (60/hour). ` +
      `Try again later, or download the library yourself from ${lib.home}.`);
  }
  if (!res.ok) throw new Error(`listing failed: HTTP ${res.status}`);
  const tree = await res.json();
  if (tree.truncated) {
    throw new Error('GitHub truncated the listing; refusing a partial library');
  }
  return tree.tree
    .filter((e) => e.type === 'blob' && /\.lib$/i.test(e.path))
    .map((e) => ({ path: e.path, size: e.size ?? 0 }));
}

export function symbolFileUrl(path, lib = SYMBOL_LIB) {
  const parts = String(path).split('/').filter(Boolean);
  if (parts.some((s) => s === '.' || s === '..')) {
    throw new Error(`refusing traversal in path: ${path}`);
  }
  return `${lib.raw}/${lib.owner}/${lib.repo}/${lib.ref}/` +
         parts.map(encodeURIComponent).join('/');
}

/**
 * Fetch and parse every file, then store.
 *
 * One record per SYMBOL rather than per file, keyed by lowercased name. That
 * is what lookup needs, and it is why a per-file store would be the wrong
 * shape: a name resolves through an ALIAS in another file's `DEF` often
 * enough that searching files at read time would miss most of the library.
 */
export async function downloadSymbols({
  files, fetchImpl, signal, concurrency = 8, onProgress, lib = SYMBOL_LIB,
} = {}) {
  const f = fetchImpl ?? globalThis.fetch;
  const all = new Map();
  let done = 0, bytes = 0, failed = 0;
  const queue = [...files];

  const worker = async () => {
    for (;;) {
      const file = queue.shift();
      if (!file) return;
      try {
        const res = await f(symbolFileUrl(file.path, lib), { signal });
        if (res.ok) {
          const text = await res.text();
          bytes += text.length;
          for (const [key, sym] of parseSymbolLib(text)) {
            // First file wins. The library has no duplicate DEF names, but an
            // ALIAS can collide with a real DEF elsewhere, and a real
            // definition is the better answer.
            if (!all.has(key)) all.set(key, { ...sym, path: file.path });
          }
        } else { failed++; }
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        failed++;      // one bad file must not lose the library
      }
      onProgress?.({ done: ++done, total: files.length, bytes, symbols: all.size });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { symbols: all, bytes, failed };
}

export async function saveSymbols({ symbols, meta = {}, onProgress } = {}) {
  const db = await open();
  try {
    await run(db, [SYMS, META], 'readwrite', (tx) => {
      tx.objectStore(SYMS).clear();
      tx.objectStore(META).clear();
    });
    const entries = [...symbols];
    const CHUNK = 500;
    for (let i = 0; i < entries.length; i += CHUNK) {
      const slice = entries.slice(i, i + CHUNK);
      await run(db, [SYMS], 'readwrite', (tx) => {
        const s = tx.objectStore(SYMS);
        // Enumerated, not spread. `model-store.js` learned this the hard way:
        // a field added in the parser and forgotten here is silently lost, and
        // a fully downloaded library registered ZERO usable parts.
        for (const [key, v] of slice) {
          s.put({ name: v.name, ref: v.ref, units: v.units, path: v.path,
                  pins: v.pins, shapes: v.shapes, aliases: v.aliases }, key);
        }
      });
      onProgress?.({ done: Math.min(i + CHUNK, entries.length), total: entries.length });
    }
    const record = { ...meta, symbols: entries.length, installedAt: Date.now() };
    // Written LAST and alone: it is the marker that says a COMPLETE library is
    // installed, so a failure part-way leaves no meta and the next startup
    // correctly reports nothing rather than offering half a library.
    await run(db, [META], 'readwrite', (tx) => {
      tx.objectStore(META).put(record, 'library');
    });
    return record;
  } finally { db.close(); }
}

export async function symbolMeta() {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction([META], 'readonly').objectStore(META).get('library');
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}

export async function getSymbol(name) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction([SYMS], 'readonly').objectStore(SYMS)
        .get(String(name).toLowerCase());
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}

/** Names matching a query, exact then prefix then substring. */
export async function searchSymbols(query, limit = 30) {
  const q = String(query).trim().toLowerCase();
  if (!q) return [];
  const db = await open();
  try {
    const hits = [];
    await new Promise((resolve, reject) => {
      const req = db.transaction([SYMS], 'readonly').objectStore(SYMS).openKeyCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) { resolve(); return; }
        const k = String(cur.key);
        const rank = k === q ? 0 : k.startsWith(q) ? 1 : k.includes(q) ? 2 : -1;
        if (rank >= 0) hits.push({ name: k, rank });
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
    return hits.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
               .slice(0, limit);
  } finally { db.close(); }
}

export async function clearSymbols() {
  const db = await open();
  try {
    await run(db, [SYMS, META], 'readwrite', (tx) => {
      tx.objectStore(SYMS).clear();
      tx.objectStore(META).clear();
    });
  } finally { db.close(); }
}
