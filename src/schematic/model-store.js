/**
 * Client-side storage for a downloaded model library.
 *
 * The download is meant to happen ONCE — 2,073 files and 66 MB is not
 * something to repeat on every page load — so the result is persisted in
 * IndexedDB and re-read on startup. Nothing here ever leaves the browser and
 * nothing is uploaded; this is the user's own copy of a third-party library,
 * held on their machine, exactly as a cloned repository would be. See the
 * header of `model-library.js` for why it is never redistributed.
 *
 * ## Why IndexedDB rather than localStorage
 *
 * `localStorage` is synchronous, string-only, and capped around 5 MB in every
 * browser — an order of magnitude too small, and writing 66 MB to it would
 * block the main thread even if it fit. IndexedDB is asynchronous, stores
 * structured values, and is bounded by a quota measured in gigabytes.
 *
 * ## What is stored, and why the text is kept whole
 *
 * Two stores: `files` maps a repository path to that file's text, and `defs`
 * maps a lowercased model name to the list of places it is defined, each
 * carrying character offsets into its file. Storing offsets rather than
 * extracted snippets keeps exactly one copy of the 66 MB — the alternative
 * duplicates most of it, since nearly every byte of these files is inside some
 * definition.
 */

const DB_NAME = 'spicelab-models';
const DB_VERSION = 1;
const META = 'meta';
const FILES = 'files';
const DEFS = 'defs';
/** Single key in the `meta` store describing the installed library. */
const META_KEY = 'library';

/** True when this browser can persist a library at all. */
export function storageAvailable() {
  return typeof indexedDB !== 'undefined';
}

function open() {
  return new Promise((resolve, reject) => {
    if (!storageAvailable()) { reject(new Error('IndexedDB is not available')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES);
      if (!db.objectStoreNames.contains(DEFS)) db.createObjectStore(DEFS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error(
      'another SpiceLab tab is holding the model database open; close it and retry'));
  });
}

/** Wrap one transaction as a promise that settles on the TRANSACTION, not on
 *  the last request. A request can succeed and the transaction still abort —
 *  on a quota error, most importantly — and resolving early would report a
 *  successful install that is not there after reload. */
function run(db, stores, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let out;
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
    out = fn(tx);
  });
}

const asPromise = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

/**
 * Write a freshly downloaded library, replacing whatever is installed.
 *
 * Written in chunked transactions rather than one: a single transaction
 * spanning 2,073 file writes and ~50,000 definition writes holds a lock for
 * the whole run and gives no progress, and if it aborts near the end the user
 * waits through the entire download again for nothing.
 *
 * The meta record is written LAST and on its own. It is the marker that says
 * "a complete library is installed", so if anything fails part-way there is no
 * meta record and the next startup correctly reports nothing installed rather
 * than silently offering a half-library.
 */
export async function saveLibrary({ files, defs, meta = {}, onProgress } = {}) {
  const db = await open();
  try {
    await run(db, [FILES, DEFS, META], 'readwrite', (tx) => {
      tx.objectStore(FILES).clear();
      tx.objectStore(DEFS).clear();
      tx.objectStore(META).clear();
    });

    const entries = [...files];
    const CHUNK = 200;
    for (let i = 0; i < entries.length; i += CHUNK) {
      const slice = entries.slice(i, i + CHUNK);
      await run(db, [FILES], 'readwrite', (tx) => {
        const s = tx.objectStore(FILES);
        for (const [path, text] of slice) s.put(text, path);
      });
      onProgress?.({ phase: 'files', done: Math.min(i + CHUNK, entries.length),
                     total: entries.length });
    }

    // Group by name here rather than storing one record per definition: a
    // lookup then costs one `get` instead of a cursor scan, which is what
    // makes the search feel instant over 50k names.
    const byName = new Map();
    for (const d of defs) {
      let a = byName.get(d.name);
      if (!a) byName.set(d.name, a = []);
      // This object ENUMERATES fields, so a new one is silently dropped —
      // exactly how `enabled` went missing from `toJSON` and broke save/reload
      // and undo (CLAUDE.md). `params` was dropped here on the first pass and
      // the whole library registered ZERO placeable parts: the cards were all
      // present and every one of them had lost its parameters. If you add a
      // field in `parseDefinitions`, add it here in the same edit.
      a.push({ path: d.path, kind: d.kind, type: d.type, pins: d.pins,
               line: d.line, start: d.start, end: d.end, depth: d.depth ?? 0,
               ...(d.params ? { params: d.params } : {}),
               ...(d.unterminated ? { unterminated: true } : {}) });
    }
    const names = [...byName];
    for (let i = 0; i < names.length; i += CHUNK) {
      const slice = names.slice(i, i + CHUNK);
      await run(db, [DEFS], 'readwrite', (tx) => {
        const s = tx.objectStore(DEFS);
        for (const [name, list] of slice) s.put(list, name);
      });
      onProgress?.({ phase: 'defs', done: Math.min(i + CHUNK, names.length),
                     total: names.length });
    }

    const record = {
      ...meta,
      files: entries.length,
      names: byName.size,
      definitions: defs.length,
      installedAt: new Date().toISOString(),
    };
    await run(db, [META], 'readwrite', (tx) => tx.objectStore(META).put(record, META_KEY));
    return record;
  } catch (e) {
    if (e?.name === 'QuotaExceededError') {
      throw new Error(
        'the browser refused to store the library — not enough space. Free ' +
        'storage for this site, or use Import model file… for single parts.');
    }
    throw e;
  } finally {
    db.close();
  }
}

/** What is installed, or null. The presence of this record is the definition
 *  of "installed" — see `saveLibrary`. */
export async function libraryMeta() {
  if (!storageAvailable()) return null;
  let db;
  try { db = await open(); } catch { return null; }
  try {
    const tx = db.transaction([META], 'readonly');
    return (await asPromise(tx.objectStore(META).get(META_KEY))) ?? null;
  } catch { return null; }
  finally { db?.close(); }
}

/** Every place `name` is defined, best provenance first, or `[]`. */
export async function lookup(name) {
  const db = await open();
  try {
    const tx = db.transaction([DEFS], 'readonly');
    return (await asPromise(tx.objectStore(DEFS).get(String(name).toLowerCase()))) ?? [];
  } finally { db.close(); }
}

/** The text of one stored file. */
export async function fileText(path) {
  const db = await open();
  try {
    const tx = db.transaction([FILES], 'readonly');
    return (await asPromise(tx.objectStore(FILES).get(path))) ?? null;
  } finally { db.close(); }
}

/**
 * The exact source text of one definition, sliced from its file.
 *
 * Returned verbatim. This is someone else's model card and the user is going
 * to simulate it — silently reformatting or "cleaning" it would make the thing
 * on the canvas differ from the thing in the library.
 */
export async function definitionText(def) {
  const text = await fileText(def.path);
  if (text == null) return null;
  return text.slice(def.start, def.end);
}

/**
 * Names matching `query`, ranked exact-then-prefix-then-substring.
 *
 * Runs a key cursor over the `defs` store rather than loading every name into
 * memory: the values are the definition lists, and pulling ~50,000 of those
 * across to rank names would read most of the library back out of storage to
 * answer one keystroke.
 */
export async function searchNames(query, limit = 50) {
  const q = String(query).trim().toLowerCase();
  if (!q) return [];
  const db = await open();
  try {
    const tx = db.transaction([DEFS], 'readonly');
    const hits = [];
    await new Promise((resolve, reject) => {
      const req = tx.objectStore(DEFS).openKeyCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) { resolve(); return; }
        const name = String(cur.key);
        const at = name.indexOf(q);
        if (at >= 0) hits.push({ name, rank: name === q ? 0 : at === 0 ? 1 : 2 });
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
    hits.sort((a, b) => a.rank - b.rank || a.name.length - b.name.length ||
                        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return hits.slice(0, limit).map((h) => h.name);
  } finally { db.close(); }
}

/**
 * Every stored `.model` definition, for building placeable parts.
 *
 * Walks the definition index only — it never touches the `files` store, so
 * this does not read 66 MB of text back out to register a palette. The
 * `params` string was captured at parse time precisely so this can work from
 * the index alone.
 *
 * `.subckt` definitions are excluded: they have no fixed symbol, and their
 * bodies are the bulk of the library.
 */
export async function modelDefsForParts() {
  const db = await open();
  try {
    const tx = db.transaction([DEFS], 'readonly');
    const out = [];
    await new Promise((resolve, reject) => {
      const req = tx.objectStore(DEFS).openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) { resolve(); return; }
        for (const d of cur.value) {
          if (d.kind === 'model' && d.params) out.push({ ...d, name: String(cur.key) });
        }
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
    return out;
  } finally { db.close(); }
}

/** Remove the installed library. */
export async function clearLibrary() {
  const db = await open();
  try {
    await run(db, [FILES, DEFS, META], 'readwrite', (tx) => {
      tx.objectStore(FILES).clear();
      tx.objectStore(DEFS).clear();
      tx.objectStore(META).clear();
    });
  } finally { db.close(); }
}
