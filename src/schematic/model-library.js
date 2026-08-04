/**
 * Bulk download of the KiCad Spice Library, into the user's browser.
 *
 * ## What this does
 *
 * On one explicit user action, fetch **every** file under `Models/` in the
 * KiCad Spice Library — 2,073 files, 66.2 MB — scan all of them for `.model`
 * and `.subckt` definitions, and hand back a definition table plus the file
 * text. `model-store.js` persists that so the download happens once, and the
 * definitions then behave like SpiceLab's built-in parts.
 *
 * ## Nothing is redistributed
 *
 * The library is aggregated manufacturer material: 1,080 of its files assert
 * vendor copyright, and its own README says the GPLv3 it carries covers only
 * the `Scripts` folder. It is free to download and use and it is NOT ours to
 * ship. So no byte of it is vendored, committed, or served from SpiceLab's
 * origin — the user's browser fetches it from GitHub directly, on their
 * request, exactly as if they had cloned the repository themselves. This file
 * contains URLs and parsing code and no model data.
 *
 * ## Why 2,073 individual requests instead of one archive
 *
 * Verified, not assumed: GitHub's archive host answers
 * `https://codeload.github.com/.../zip/refs/heads/master` with
 * `access-control-allow-origin: https://render.githubusercontent.com`. That is
 * not `*`, so a cross-origin `fetch` from SpiceLab's origin fails the CORS
 * check and the body cannot be read. (`mode: 'no-cors'` would be permitted by
 * its `cross-origin-resource-policy: cross-origin`, but yields an opaque
 * response with an unreadable body, which is useless here.) jsDelivr refuses
 * the repository outright — "Package size exceeded the configured limit of
 * 50 MB".
 *
 * `raw.githubusercontent.com` sends `access-control-allow-origin: *` AND
 * `cross-origin-resource-policy: cross-origin`, so it is readable and it
 * satisfies the COEP `require-corp` that SpiceLab cannot drop (see the hosting
 * note in CLAUDE.md). It is therefore the only path to the complete set, and
 * the cost is one request per file. Measured at browser-like concurrency this
 * is tens of seconds, which is acceptable for a once-ever action.
 *
 * ## Why the file list does not come from the library's own index
 *
 * `Supported.pickle` maps model name -> file, and it is the right thing for
 * *lookup* (`model-index.js`). It is the WRONG thing for deciding what to
 * download: it references only 1,159 of the 2,073 files. The repository's
 * `generate_supported.py` scans a fixed set of extensions, so 914 files —
 * 17.6 MB, 700 of them `.spi` — carry real `.model` and `.subckt` cards that
 * its index never lists. Downloading the indexed subset silently loses them.
 * The file list comes from the git tree instead, and every file is parsed here.
 */

export const LIBRARY = {
  name: 'KiCad Spice Library',
  owner: 'kicad-spice-library',
  repo: 'KiCad-Spice-Library',
  ref: 'master',
  /** Everything worth having lives under this directory. */
  root: 'Models',
  home: 'https://github.com/kicad-spice-library/KiCad-Spice-Library',
  raw: 'https://raw.githubusercontent.com',
  api: 'https://api.github.com',
};

/** Raw URL for one repository path. Each SEGMENT is encoded separately —
 *  encoding the whole path would escape the separating slashes into %2F and
 *  every request would 404. Real paths here contain spaces
 *  (`Manufacturer/Texas Instruments/tl072.mod`). */
export function rawUrl(path, lib = LIBRARY) {
  const parts = String(path).split('/').filter((s) => s.length);
  if (!parts.length) throw new Error('empty path');
  if (parts.some((s) => s === '.' || s === '..')) {
    throw new Error(`refusing traversal in path: ${path}`);
  }
  return `${lib.raw}/${lib.owner}/${lib.repo}/${lib.ref}/` +
         parts.map(encodeURIComponent).join('/');
}

/**
 * List every file under `Models/`, with sizes.
 *
 * One request to the git tree API, which sends `access-control-allow-origin: *`
 * so it is readable cross-origin. `recursive=1` returns the whole tree; the
 * response carries a `truncated` flag and this repository is well under the
 * limit, but the flag is checked rather than assumed because a silently
 * truncated list would mean a silently partial library.
 *
 * The API is rate-limited to 60 requests/hour per IP for anonymous callers.
 * That is ample for a once-ever download, but users behind a shared NAT can hit
 * it, so a 403 is reported as the rate limit it is rather than as a failure of
 * the library.
 */
export async function listLibraryFiles({ fetchImpl, signal, lib = LIBRARY } = {}) {
  const f = fetchImpl ?? globalThis.fetch;
  if (!f) throw new Error('no fetch available');
  const url = `${lib.api}/repos/${lib.owner}/${lib.repo}/git/trees/` +
              `${encodeURIComponent(lib.ref)}?recursive=1`;
  const res = await f(url, { signal, headers: { Accept: 'application/vnd.github+json' } });
  if (res.status === 403 || res.status === 429) {
    const reset = res.headers?.get?.('x-ratelimit-reset');
    const when = reset ? new Date(Number(reset) * 1000).toLocaleTimeString() : 'later';
    throw new Error(
      `GitHub's API rate limit is exhausted for your network (60/hour). ` +
      `Try again after ${when}, or download the repository yourself from ` +
      `${lib.home} and use Import model file….`);
  }
  if (!res.ok) throw new Error(`listing failed: HTTP ${res.status}`);
  const tree = await res.json();
  if (tree.truncated) {
    throw new Error('GitHub truncated the file listing; refusing to download ' +
                    'a partial library');
  }
  const prefix = lib.root + '/';
  return tree.tree
    .filter((e) => e.type === 'blob' && e.path.startsWith(prefix))
    .map((e) => ({ path: e.path, size: e.size ?? 0 }));
}

// ------------------------------------------------------------------ decoding

const UTF8 = new TextDecoder('utf-8', { fatal: true });
const CP1252 = new TextDecoder('windows-1252');

/**
 * Decode one model file.
 *
 * Tries UTF-8 strictly first and falls back to windows-1252. This is not
 * pedantry: SPICE values use the MICRO SIGN constantly, and in a Latin-1 file
 * it is the single byte 0xB5. Decoded leniently as UTF-8 that becomes U+FFFD
 * and the suffix is gone — which is the same 10^6 error as the `470µF` bug in
 * CLAUDE.md, arriving by a different route. Strict-then-fallback keeps it.
 */
export function decodeModelFile(bytes) {
  try { return UTF8.decode(bytes); } catch { return CP1252.decode(bytes); }
}

// ------------------------------------------------------------------- parsing

/** True for a line that carries no netlist content. */
function isSkippable(line) {
  const t = line.trimStart();
  return t === '' || t[0] === '*' || t[0] === ';';
}

/** True if `line` continues the previous card. */
function isContinuation(line) {
  return line.trimStart()[0] === '+';
}

/**
 * Find every `.model` and `.subckt` definition in one file.
 *
 * Returns entries carrying byte-free character offsets into `text`, so the
 * caller can slice out a definition later without a second parse and without
 * storing a second copy of the text.
 *
 * `.subckt` blocks are captured whole, to their matching `.ends`, tracked with
 * a STACK of open frames rather than a depth counter. That distinction is not
 * academic: `Ltc_Old_Big.lib` in this very library has 540 `.subckt` against
 * 539 `.ends`. With a counter, the one unbalanced block means depth never
 * returns to zero, every later `.subckt` looks nested, and 113 real
 * macromodels — LT1673, LT1818, LTC2055 and the rest — vanish from the library
 * with no error. A stack pops each frame on its own `.ends`, so one malformed
 * block costs only itself.
 *
 * Every definition is emitted, with the `depth` it was found at, and blocks
 * left open at end of file are marked `unterminated`. Emitting them is the
 * right call for a library index: a caller can prefer `depth === 0`, but it
 * cannot recover a definition that was never reported.
 *
 * @param {string} text
 * @param {string} path
 * @returns {{name:string, kind:'model'|'subckt', type:string, pins:string[],
 *            path:string, line:number, start:number, end:number,
 *            depth:number, unterminated?:boolean}[]}
 */
export function parseDefinitions(text, path = '') {
  const out = [];
  // Split while recording each line's REAL start and end offsets.
  //
  // Deriving the offset instead — `at += line.length + 1` — charges one
  // character for the terminator, and a CRLF file spends two. These files are
  // overwhelmingly CRLF, so the error compounds line by line: by line 2,800 a
  // slice lands 2,800 characters away, inside some other model card, and the
  // stored text of every definition is quietly wrong. Measure the terminator,
  // never assume it.
  const lines = [];
  const offset = [];
  const ends = [];
  {
    const term = /\r\n|\r|\n/g;
    let at = 0, m;
    while ((m = term.exec(text)) !== null) {
      lines.push(text.slice(at, m.index));
      offset.push(at);
      ends.push(m.index);
      at = m.index + m[0].length;
    }
    lines.push(text.slice(at));
    offset.push(at);
    ends.push(text.length);
  }
  const endOf = (i) => ends[i];

  /** Index of the last line of the card starting at `i`, following `+`. */
  const cardEnd = (i) => {
    let j = i;
    while (j + 1 < lines.length &&
           (isContinuation(lines[j + 1]) ||
            (isSkippable(lines[j + 1]) && hasLaterContinuation(j + 1)))) j++;
    return j;
  };
  // A comment line between a card and its `+` continuation is legal and common
  // in vendor files; it must not terminate the card.
  const hasLaterContinuation = (j) => {
    for (let k = j + 1; k < lines.length; k++) {
      if (isSkippable(lines[k])) continue;
      return isContinuation(lines[k]);
    }
    return false;
  };

  /** Open `.subckt` frames, innermost last. */
  const open = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isSkippable(line)) continue;
    const t = line.trimStart();
    if (t[0] !== '.') continue;
    const word = /^\.([A-Za-z_]+)/.exec(t);
    if (!word) continue;
    const dir = word[1].toLowerCase();

    if (dir === 'subckt') {
      const tok = tokenize(t.slice(word[0].length));
      const name = tok[0] ?? '';
      // Pins are the positional tokens after the name, stopping at the first
      // `params:` keyword or `name=value` pair. Pin ORDER is the netlist
      // contract (CLAUDE.md), so this must not absorb parameters into it.
      const pins = [];
      for (let k = 1; k < tok.length; k++) {
        const s = tok[k];
        if (/^params:?$/i.test(s) || s.includes('=')) break;
        pins.push(s);
      }
      open.push({ name, pins, start: offset[i], line: i + 1 });
      continue;
    }
    if (dir === 'ends' || dir === 'eom') {
      const frame = open.pop();
      if (frame?.name) {
        out.push({
          name: frame.name.toLowerCase(), kind: 'subckt', type: '',
          pins: frame.pins, path, line: frame.line,
          start: frame.start, end: endOf(i), depth: open.length,
        });
      }
      continue;
    }
    if (dir === 'model') {
      const tok = tokenize(t.slice(word[0].length));
      const name = tok[0];
      if (!name) continue;
      // The type may be glued to its parameter list — `D(IS=1E-12)` — so take
      // the part before the first parenthesis.
      const type = (tok[1] ?? '').split('(')[0];
      const last = cardEnd(i);
      const card = text.slice(offset[i], endOf(last));
      out.push({
        name: name.toLowerCase(), kind: 'model', type, pins: [],
        path, line: i + 1, start: offset[i], end: endOf(last),
        depth: open.length,
        // Stored inline, unlike a `.subckt` body. A model card is a few
        // hundred bytes, so keeping it here costs little and lets a part be
        // rebuilt from the definition index alone — without reading 66 MB of
        // file text back out of storage to place one diode.
        params: modelParams(card, type),
      });
      i = last;
    }
  }
  // Anything still open never got its `.ends`. Report it rather than drop it:
  // the block is real and usually usable, and staying silent here is exactly
  // how the 113 LTC macromodels went missing.
  for (const frame of open) {
    if (!frame.name) continue;
    out.push({
      name: frame.name.toLowerCase(), kind: 'subckt', type: '',
      pins: frame.pins, path, line: frame.line,
      start: frame.start, end: text.length, depth: 0, unterminated: true,
    });
  }
  return out;
}

/**
 * The parameter text of a `.model` card: everything after the type token, with
 * continuations folded onto one line and the outer parentheses removed.
 *
 * Parentheses are optional in SPICE (`.model d1 D is=1e-14` is as legal as
 * `.model d1 D(is=1e-14)`), so the paren is stripped only when it is actually
 * there. Comment lines interleaved with `+` continuations are dropped, since
 * folding them in would put a `*` in the middle of a parameter list.
 */
export function modelParams(card, type) {
  const body = card
    .split(/\r\n|\r|\n/)
    .filter((l) => !isSkippable(l))
    .map((l, i) => (i === 0 ? l.trimStart() : l.trimStart().replace(/^\+/, ' ')))
    .join('')
    .replace(/;.*$/, '');
  // Drop `.model`, the name, and the type — the type may be glued to `(`.
  const m = new RegExp(`^\\s*\\.model\\s+\\S+\\s*[,\\s]\\s*${
    type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').exec(body);
  let rest = m ? body.slice(m[0].length) : body;
  rest = rest.trim();
  if (rest.startsWith('(')) {
    rest = rest.slice(1);
    if (rest.endsWith(')')) rest = rest.slice(0, -1);
  }
  return rest.trim();
}

/**
 * Split a card's arguments.
 *
 * Commas are separators in SPICE — `.MODEL DEN D(IS=1E-12, RS=14.61K)` is a
 * stock Analog Devices card, and treating whitespace as the only separator is
 * what made it parse as malformed (CLAUDE.md). An inline `;` comment ends the
 * line.
 */
function tokenize(s) {
  const semi = s.indexOf(';');
  return (semi >= 0 ? s.slice(0, semi) : s).split(/[\s,]+/).filter(Boolean);
}

// ---------------------------------------------------------------- downloading

/**
 * Fetch every file under `Models/` and parse it.
 *
 * Concurrency is bounded because 2,073 simultaneous requests is hostile to the
 * host and slower in practice than a modest window; browsers cap per-origin
 * connections anyway, so an unbounded launch just builds a queue that cannot be
 * cancelled or reported on.
 *
 * Individual failures do NOT abort the run. One 404 or dropped connection out
 * of 2,073 should cost that file, not the whole download; the failures are
 * returned so the caller can report and retry them.
 *
 * @returns {Promise<{files: Map<string,string>, defs: object[],
 *                    failed: {path:string, error:string}[], bytes: number}>}
 */
export async function downloadLibrary({
  fetchImpl, signal, lib = LIBRARY, concurrency = 12, onProgress, files: list,
} = {}) {
  const f = fetchImpl ?? globalThis.fetch;
  if (!f) throw new Error('no fetch available');
  const entries = list ?? await listLibraryFiles({ fetchImpl: f, signal, lib });

  const files = new Map();
  const defs = [];
  const failed = [];
  let done = 0, bytes = 0;
  const total = entries.length;
  let next = 0;

  const report = () => onProgress?.({
    done, total, bytes, failed: failed.length,
    // Fraction of files, not of bytes: sizes vary by four orders of magnitude
    // and a byte-based bar would stall on one 7 MB file and then jump.
    fraction: total ? done / total : 1,
  });

  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= total) return;
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const { path } = entries[i];
      try {
        const res = await f(rawUrl(path, lib), { signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = new Uint8Array(await res.arrayBuffer());
        const text = decodeModelFile(buf);
        files.set(path, text);
        bytes += buf.length;
        for (const d of parseDefinitions(text, path)) defs.push(d);
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        failed.push({ path, error: String(e.message ?? e) });
      }
      done++;
      report();
    }
  };

  report();
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return { files, defs, failed, bytes };
}

/**
 * Group definitions by lowercased name.
 *
 * A name is genuinely ambiguous across this library — `2n2222` is defined in
 * five different files — so this maps to a LIST and the caller chooses. See
 * `rankDefs` for the ordering.
 */
export function indexDefs(defs) {
  const byName = new Map();
  for (const d of defs) {
    let a = byName.get(d.name);
    if (!a) byName.set(d.name, a = []);
    a.push(d);
  }
  for (const [, a] of byName) rankDefs(a);
  return byName;
}

/**
 * Turn `.model` definitions into placeable parts.
 *
 * Only model types this editor draws a symbol for become parts: diode, NPN,
 * PNP, NMOS, PMOS, NJF, PJF, VDMOS (split n/p on its `pchan` flag) and SW.
 * Together those are 93,538 of the KiCad library's definitions.
 *
 * What stays out, and why it is not an oversight:
 *
 *   - The 47,799 `.subckt` macromodels. They have no fixed terminal set, so
 *     they are placed as Subcircuit instances instead — with the pin list
 *     filled in from the parsed `.subckt` line rather than retyped.
 *   - `VSWITCH`, PSpice's spelling of a different switch (VON/VOFF, not
 *     VT/VH). See `kindForModelType`.
 *   - XSPICE code models (`D_NAND`, `UGATE`, …), which this wasm build of
 *     ngspice cannot run at all because its code models are `dlopen`ed.
 *
 * The rule behind all three: inventing a symbol for a part whose terminals we
 * cannot name would put pin ORDER, which is the netlist contract, at the mercy
 * of a guess.
 *
 * The label names the part and its source file, because in this library one
 * name is often defined several times with different parameters — `2n2222`
 * exists in five files — and the file is the only thing that distinguishes
 * them at the point of choosing.
 *
 * `note` states plainly that the card is unvalidated. The built-in parts each
 * carry a measured forward drop or beta checked against this solver; these
 * have had nothing run against them at all, and presenting the two alike would
 * borrow credibility the downloaded ones have not earned.
 */
export function partsFromDefs(defs, kindFor) {
  const parts = [];
  for (const d of defs) {
    if (d.kind !== 'model') continue;
    // The params go in as well as the type: a VDMOS card carries its polarity
    // as a `pchan` FLAG rather than in the type token, so the type alone cannot
    // decide which symbol it belongs on.
    const kind = kindFor(d.type, d.params);
    if (!kind || !d.params) continue;
    parts.push({
      id: `lib:${d.name}@${d.path}#${d.line}`,
      label: `${d.name} — ${d.path.replace(/^Models\//, '')}`,
      kind,
      model: String(d.type).toUpperCase(),
      params: d.params,
      source: `${LIBRARY.name} ${d.path} line ${d.line}`,
      note: 'Downloaded third-party model card, used verbatim and NOT ' +
            'validated against this solver. Not redistributable.',
    });
  }
  return parts;
}

/**
 * Order the definitions of one name, best provenance first.
 *
 * The library's README states the priority its own tool uses — Manufacturer
 * beats `spice_complete` beats `uncategorized` — and it is the right one: a
 * card from the manufacturer's own directory is a better provenance claim than
 * the same name in a scraped bucket. A `.subckt` outranks a bare `.model` of
 * the same name because a macromodel is the more complete part. Ties break on
 * path so the order is deterministic and testable.
 */
export function rankDefs(defs) {
  const rank = (d) => {
    const p = d.path.toLowerCase();
    if (p.startsWith('models/manufacturer/')) return 0;
    if (p.startsWith('models/uncategorized/spice_complete/')) return 2;
    if (p.startsWith('models/uncategorized/')) return 3;
    return 1;
  };
  return defs.sort((a, b) =>
    rank(a) - rank(b) ||
    (a.kind === b.kind ? 0 : a.kind === 'subckt' ? -1 : 1) ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
    a.line - b.line);
}
