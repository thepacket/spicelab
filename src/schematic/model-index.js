/**
 * On-demand access to the KiCad Spice Library, by DOWNLOAD rather than by
 * bundling.
 *
 * ## The licensing shape, which drives the whole design
 *
 * The KiCad Spice Library is an aggregation of 50,093 models, and 1,080 of its
 * files assert someone else's copyright — Toshiba, ON Semi, Cree and others.
 * Its own README says so, and says the GPLv3 it carries covers only the
 * `Scripts` folder. So it is free to download and use, and it is NOT ours to
 * redistribute. See the note at the top of `libraries.js`.
 *
 * The rule that follows: **nothing from that repository is ever vendored into
 * SpiceLab, committed, or served from SpiceLab's own origin.** The user's
 * browser fetches from the third party directly, exactly as if they had clicked
 * the link and saved the file — which is the manufacturer's intended use. This
 * module therefore contains URLs and parsing code, and no model data.
 *
 * That also means the feature depends on someone else's repository staying up,
 * so every entry point here fails with a message pointing at the manual path
 * (`Import model file…`) rather than leaving a dead button.
 *
 * ## Why the index is a Python pickle, and why that is safe here
 *
 * The repository publishes two indexes. `Supported.txt` is 50,093 model NAMES
 * and nothing else — it can tell you a part exists but not which file defines
 * it, which is the one thing we need. The mapping lives in `Supported.pickle`,
 * a `dict[str, list[str]]` from lowercased model name to paths under `Models/`.
 *
 * Unpickling arbitrary data is famously equivalent to executing it, because the
 * `GLOBAL`/`STACK_GLOBAL` and `REDUCE` opcodes look up and CALL arbitrary
 * Python. `readPickleIndex` is not a general unpickler: it implements only the
 * container-and-string opcodes and throws on every other byte. The dangerous
 * opcodes are not "blocked", they are absent — there is no code path that
 * constructs or calls anything, so a hostile index can at worst fail to parse.
 * The allowlist is asserted directly in `tests/model-library.test.mjs` against
 * real code-executing pickles produced by Python.
 *
 * This matters because we are parsing a file from a third-party repository we
 * do not control, over the network, on the user's machine.
 */

/** Where the library lives. Pinned to a branch ref so the URLs are explicit. */
export const KICAD_LIBRARY = {
  name: 'KiCad Spice Library',
  repo: 'https://github.com/kicad-spice-library/KiCad-Spice-Library',
  /** Raw host. Verified to send both `access-control-allow-origin: *` and
   *  `cross-origin-resource-policy: cross-origin`, so it is reachable from a
   *  page served under COOP/COEP — which SpiceLab requires and cannot drop. */
  raw: 'https://raw.githubusercontent.com/kicad-spice-library/KiCad-Spice-Library',
  ref: 'master',
  /** Model name -> file paths. ~1.1 MB, fetched once per session. */
  index: 'Supported.pickle',
  /** Every path in the index is relative to this directory. */
  models: 'Models',
  licence: 'mixed',
  note: 'Aggregated manufacturer material: free to download and use, not ' +
        'redistributable. Fetched by your browser from GitHub, not by or ' +
        'through SpiceLab.',
};

/** URL of the name -> path index. */
export function indexUrl(lib = KICAD_LIBRARY) {
  return `${lib.raw}/${lib.ref}/${encodeURIComponent(lib.index)}`;
}

/**
 * URL of one model file.
 *
 * Paths in the index contain spaces and other characters that are legal in a
 * filename and not in a URL path (`Manufacturer/Texas Instruments/tl072.mod`).
 * Each SEGMENT is encoded separately — `encodeURIComponent` on the whole path
 * would escape the separating slashes and produce a 404.
 */
export function modelFileUrl(path, lib = KICAD_LIBRARY) {
  const parts = String(path).split('/').filter((s) => s.length);
  if (!parts.length) throw new Error('empty model path');
  // A `..` segment would let an index entry reach outside the models tree.
  // The index is third-party data, so it is checked rather than trusted.
  if (parts.some((s) => s === '.' || s === '..')) {
    throw new Error(`refusing traversal in model path: ${path}`);
  }
  const enc = parts.map(encodeURIComponent).join('/');
  return `${lib.raw}/${lib.ref}/${encodeURIComponent(lib.models)}/${enc}`;
}

// --------------------------------------------------------------- the reader

/** Pickle opcodes this reader implements. Anything else is a hard error. */
const OP = {
  MARK: 0x28, STOP: 0x2e, BINGET: 0x68, LONG_BINGET: 0x6a,
  EMPTY_DICT: 0x7d, EMPTY_LIST: 0x5d, APPEND: 0x61, APPENDS: 0x65,
  SETITEM: 0x73, SETITEMS: 0x75, MEMOIZE: 0x94, PROTO: 0x80, FRAME: 0x95,
  SHORT_BINUNICODE: 0x8c, BINUNICODE: 0x58,
};

/**
 * Decode `Supported.pickle` into a `Map<string, string[]>`.
 *
 * Implements exactly the opcodes a `dict[str, list[str]]` needs. There is
 * deliberately no `GLOBAL`, `STACK_GLOBAL`, `REDUCE`, `BUILD` or `INST` case,
 * so this cannot construct or call anything — see the module header.
 *
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {Map<string, string[]>}
 */
export function readPickleIndex(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  // Not `fatal`: one bad byte in a 1.1 MB third-party index should cost that
  // one name, not the whole feature.
  const dec = new TextDecoder('utf-8');
  const stack = [];
  const memo = [];
  const marks = [];
  let i = 0;

  const need = (n) => {
    if (i + n > u8.length) throw new Error(`truncated pickle at byte ${i}`);
  };
  const str = (len) => {
    need(len);
    const s = dec.decode(u8.subarray(i, i + len));
    i += len;
    return s;
  };

  for (;;) {
    if (i >= u8.length) throw new Error('pickle ended before STOP');
    const op = u8[i++];
    switch (op) {
      case OP.PROTO: {
        need(1);
        const p = u8[i++];
        // Protocols 0-1 use a completely different, text-based encoding that
        // this reader does not implement. Say so instead of failing on the
        // first opcode with a confusing message.
        if (p < 2 || p > 5) throw new Error(`unsupported pickle protocol ${p}`);
        break;
      }
      case OP.FRAME: need(8); i += 8; break;             // framing hint only
      case OP.EMPTY_DICT: stack.push(new Map()); break;
      case OP.EMPTY_LIST: stack.push([]); break;
      case OP.SHORT_BINUNICODE: { need(1); stack.push(str(u8[i++])); break; }
      case OP.BINUNICODE: {
        need(4);
        const n = dv.getUint32(i, true); i += 4;
        stack.push(str(n));
        break;
      }
      case OP.MEMOIZE:
        if (!stack.length) throw new Error(`MEMOIZE on empty stack at ${i}`);
        memo.push(stack[stack.length - 1]);
        break;
      case OP.BINGET: { need(1); stack.push(memoAt(memo, u8[i++], i)); break; }
      case OP.LONG_BINGET: {
        need(4);
        const k = dv.getUint32(i, true); i += 4;
        stack.push(memoAt(memo, k, i));
        break;
      }
      case OP.MARK: marks.push(stack.length); break;
      case OP.APPEND: {
        const v = stack.pop();
        const list = stack[stack.length - 1];
        if (!Array.isArray(list)) throw new Error(`APPEND to non-list at ${i}`);
        list.push(v);
        break;
      }
      case OP.APPENDS: {
        const items = popMark(stack, marks, i);
        const list = stack[stack.length - 1];
        if (!Array.isArray(list)) throw new Error(`APPENDS to non-list at ${i}`);
        for (const v of items) list.push(v);
        break;
      }
      case OP.SETITEM: {
        const v = stack.pop(), k = stack.pop();
        const map = stack[stack.length - 1];
        if (!(map instanceof Map)) throw new Error(`SETITEM on non-dict at ${i}`);
        map.set(k, v);
        break;
      }
      case OP.SETITEMS: {
        const items = popMark(stack, marks, i);
        const map = stack[stack.length - 1];
        if (!(map instanceof Map)) throw new Error(`SETITEMS on non-dict at ${i}`);
        if (items.length % 2) throw new Error(`odd SETITEMS run at ${i}`);
        for (let k = 0; k < items.length; k += 2) map.set(items[k], items[k + 1]);
        break;
      }
      case OP.STOP: {
        const top = stack.pop();
        if (!(top instanceof Map)) throw new Error('index is not a dictionary');
        return top;
      }
      default:
        // The refusal is the security property, so it names the byte and says
        // why rather than falling through to a generic parse error.
        throw new Error(
          `unsupported pickle opcode 0x${op.toString(16).padStart(2, '0')} ` +
          `at byte ${i - 1}; this reader handles only strings, lists and ` +
          `dicts, and never executes`);
    }
  }
}

function memoAt(memo, k, at) {
  if (k >= memo.length) throw new Error(`memo ${k} not set at byte ${at}`);
  return memo[k];
}

function popMark(stack, marks, at) {
  if (!marks.length) throw new Error(`no MARK to close at byte ${at}`);
  return stack.splice(marks.pop());
}

/**
 * Check the decoded index really is `name -> [path, ...]` before anything
 * downstream trusts it, and drop entries that are not.
 *
 * Returns the count dropped so a corrupted index shows up as a reported number
 * rather than as parts that mysteriously cannot be found.
 *
 * @returns {{index: Map<string,string[]>, dropped: number}}
 */
export function sanitizeIndex(raw) {
  const index = new Map();
  let dropped = 0;
  for (const [k, v] of raw) {
    if (typeof k !== 'string' || !Array.isArray(v)) { dropped++; continue; }
    const paths = v.filter((p) => typeof p === 'string' && p.length &&
                                  !p.split('/').some((s) => s === '.' || s === '..'));
    if (paths.length !== v.length) dropped++;
    if (paths.length) index.set(k, paths);
  }
  return { index, dropped };
}

// --------------------------------------------------------------- searching

/**
 * Rank the files that define one model, best source first.
 *
 * The library's own README states the priority its GUI uses — Manufacturer
 * beats `spice_complete` beats `uncategorized` — and it is the right one: a
 * card straight from the manufacturer's directory is a better provenance claim
 * than the same name in a scraped bucket. Ties break on path so the order is
 * deterministic and a test can assert it.
 */
export function rankPaths(paths) {
  const rank = (p) => {
    const low = p.toLowerCase();
    if (low.startsWith('manufacturer/')) return 0;
    if (low.startsWith('uncategorized/spice_complete/')) return 2;
    if (low.startsWith('uncategorized/')) return 3;
    return 1;                                  // a named category: Diode/, ...
  };
  return [...paths].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Find models whose name matches `query`.
 *
 * Exact beats prefix beats substring, because searching `tl072` should not
 * bury it under `tl072acd`. Index keys are already lowercase; the query is
 * lowercased to match, which is also correct SPICE — identifiers are
 * case-insensitive.
 *
 * @returns {{name: string, paths: string[]}[]}
 */
export function searchIndex(index, query, limit = 50) {
  const q = String(query).trim().toLowerCase();
  if (!q) return [];
  const hits = [];
  for (const [name, paths] of index) {
    const at = name.indexOf(q);
    if (at < 0) continue;
    hits.push({ name, paths, rank: name === q ? 0 : at === 0 ? 1 : 2 });
  }
  hits.sort((a, b) => a.rank - b.rank || a.name.length - b.name.length ||
                      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return hits.slice(0, limit)
    .map(({ name, paths }) => ({ name, paths: rankPaths(paths) }));
}

// --------------------------------------------------------------- fetching

let cached = null;

/**
 * Fetch and decode the index, once per session.
 *
 * Kept in memory rather than in `localStorage`: the decoded map is ~50k keys
 * and the raw file is 1.1 MB, which is a large fraction of the storage quota,
 * and the failure mode of a quota error would be worse than re-fetching.
 *
 * `fetchImpl` is injectable so the tests never touch the network.
 *
 * @returns {Promise<{index: Map<string,string[]>, bytes: number, dropped: number}>}
 */
export async function fetchIndex({ fetchImpl, signal, lib = KICAD_LIBRARY } = {}) {
  if (cached) return cached;
  const f = fetchImpl ?? globalThis.fetch;
  if (!f) throw new Error('no fetch available');
  const url = indexUrl(lib);
  const res = await f(url, { signal });
  if (!res.ok) throw new Error(`index fetch failed: HTTP ${res.status} — ${url}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const { index, dropped } = sanitizeIndex(readPickleIndex(buf));
  cached = { index, bytes: buf.length, dropped };
  return cached;
}

/** Drop the cached index. Exists for tests and for a manual retry after a
 *  failed or partial fetch. */
export function clearIndexCache() { cached = null; }

/**
 * Fetch one model file's text.
 *
 * The size guard is not paranoia: the largest file in the library is a 7 MB
 * transformer library, and putting that in a canvas text block would wedge the
 * editor to deliver a part the user could have had in 2 KB. Callers extract
 * the one model they asked for; this bound stops the pathological case before
 * it is in memory as a string.
 */
export async function fetchModelFile(path, {
  fetchImpl, signal, lib = KICAD_LIBRARY, maxBytes = 8 << 20,
} = {}) {
  const f = fetchImpl ?? globalThis.fetch;
  if (!f) throw new Error('no fetch available');
  const url = modelFileUrl(path, lib);
  const res = await f(url, { signal });
  if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status} — ${path}`);
  const len = Number(res.headers?.get?.('content-length') ?? 0);
  if (len > maxBytes) {
    throw new Error(
      `${path} is ${(len / 1048576).toFixed(1)} MB, over the ` +
      `${(maxBytes / 1048576).toFixed(0)} MB limit — download it from ` +
      `${lib.repo} and use Import model file…`);
  }
  return await res.text();
}
