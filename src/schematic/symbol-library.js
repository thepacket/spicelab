/**
 * KiCad schematic symbols, so a macromodel draws as the part it is.
 *
 * A `subckt` block draws as a plain box today. That is functionally complete
 * and visually wrong, and the reason it matters is not decoration: **pin ORDER
 * is the netlist contract**, and a labelled symbol is how you check it at a
 * glance. A five-pin box tells you nothing about which terminal is the
 * inverting input.
 *
 * ## Which library, and why the archived one
 *
 * `raw.githubusercontent.com/KiCad/kicad-symbols` sends both
 * `access-control-allow-origin: *` and
 * `cross-origin-resource-policy: cross-origin`, so a browser can read it under
 * the COEP `require-corp` this app cannot drop. It is ARCHIVED at 2021 and
 * carries the legacy `.lib` format — 451 files.
 *
 * The live upstream is GitLab (`gitlab.com/kicad/libraries/kicad-symbols`,
 * 23,052 entries, `.kicad_symdir`) and it sends NEITHER header, so its bytes
 * are unreadable from our origin however the request is framed. That path is
 * `Import…`, from a copy the user downloads — the same shape as the model
 * library, and the same rule: fetched or imported by the user, never bundled.
 *
 * Licence: CC-BY-SA 4.0 with an exception waiving article 3 for designs that
 * USE the library. Using symbols in a schematic is unencumbered; redistributing
 * the collection is not. So SpiceLab does not carry a byte of it.
 *
 * ## Coordinates
 *
 * KiCad legacy units are mils, with **Y increasing upward**. Canvas Y
 * increases downward and this editor's grid puts a pin 20 units from centre
 * where KiCad puts it 100. So every coordinate is scaled by 0.2 and every Y is
 * negated. Getting the negation wrong mirrors a symbol vertically, which for
 * an op-amp swaps `+` and `-` — a schematic that reads as one circuit and
 * simulates as another. That is why `symbolPins` is checked against a real
 * op-amp's geometry in the tests rather than against itself.
 */

/** KiCad legacy mils -> this editor's grid units. 100 mil pin pitch -> 20. */
export const SCALE = 0.2;

/** @typedef {{name:string, num:string, x:number, y:number,
 *             dir:'U'|'D'|'L'|'R', len:number}} SymPin */
/** @typedef {{name:string, ref:string, aliases:string[],
 *             pins:SymPin[], shapes:object[]}} KiSymbol */

/**
 * Parse a legacy `.lib` file into symbols, keyed by lowercased name.
 *
 * Deliberately tolerant: an unrecognised record inside `DRAW` is SKIPPED
 * rather than aborting the symbol, because these files carry primitives this
 * renderer does not draw (`T` text, `B` bezier) and a whole library refusing
 * to load over one of them would be the wrong trade. A malformed `DEF`, by
 * contrast, drops only its own symbol — the `.lib` equivalent of the frame
 * STACK that keeps one unbalanced `.subckt` from swallowing a model library.
 */
export function parseSymbolLib(text) {
  const out = new Map();
  let cur = null;
  let drawing = false;

  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('DEF ')) {
      const t = line.split(/\s+/);
      cur = { name: t[1] ?? '', ref: t[2] ?? 'U', aliases: [],
              units: Math.max(1, Number(t[7]) || 1), pins: [], shapes: [] };
      drawing = false;
      continue;
    }
    if (!cur) continue;

    if (line.startsWith('ALIAS ')) {
      cur.aliases.push(...line.split(/\s+/).slice(1));
      continue;
    }
    if (line === 'DRAW') { drawing = true; continue; }
    if (line === 'ENDDRAW') { drawing = false; continue; }
    if (line === 'ENDDEF') {
      if (cur.name) {
        out.set(cur.name.toLowerCase(), cur);
        // An alias is a distinct part sharing one drawing — 2,000+ of the
        // library's names exist only as aliases, so dropping them would lose
        // most of it.
        for (const a of cur.aliases) {
          if (a && !out.has(a.toLowerCase())) out.set(a.toLowerCase(), { ...cur, name: a });
        }
      }
      cur = null;
      continue;
    }
    if (!drawing) continue;

    const t = line.split(/\s+/);
    const n = (i) => Number(t[i]);

    /**
     * Keep only unit 1 and the De Morgan-normal body.
     *
     * A dual or quad part is ONE `DEF` carrying several units — a TL072's
     * records cover both halves, with the supply pins marked unit 0 meaning
     * "shared". Merging them stacked both halves on top of each other and
     * returned EIGHT pins for a dual op-amp, two of them a duplicated `+` and
     * `-`. Nothing errored; the symbol simply had the wrong terminals, which
     * for pin order is the failure that matters.
     *
     * `convert` is the alternate (De Morgan) body, drawn instead of the normal
     * one rather than as well as it, so taking both overlays two shapes.
     */
    const keep = (unit, convert) =>
      (unit === 0 || unit === 1) && (convert === 0 || convert === 1);

    switch (t[0]) {
      case 'S':   // rectangle: S x1 y1 x2 y2 unit convert thickness fill
        if (!keep(n(5), n(6))) break;
        cur.shapes.push({ k: 'rect', x1: n(1), y1: n(2), x2: n(3), y2: n(4),
                          fill: t[7] });
        break;
      case 'C':   // circle: C x y radius unit convert thickness fill
        if (!keep(n(4), n(5))) break;
        cur.shapes.push({ k: 'circle', x: n(1), y: n(2), r: n(3), fill: t[7] });
        break;
      case 'A': { // arc: A x y r start end unit convert thickness fill x1 y1 x2 y2
        if (!keep(n(6), n(7))) break;
        cur.shapes.push({ k: 'arc', x: n(1), y: n(2), r: n(3),
                          a1: n(4) / 10, a2: n(5) / 10, fill: t[9] });
        break;
      }
      case 'P': { // polyline: P count unit convert thickness x1 y1 ... fill
        if (!keep(n(2), n(3))) break;
        const count = n(1);
        const pts = [];
        for (let i = 0; i < count; i++) {
          pts.push([n(5 + i * 2), n(6 + i * 2)]);
        }
        cur.shapes.push({ k: 'poly', pts, fill: t[5 + count * 2] });
        break;
      }
      case 'X': { // pin: X name num x y len dir Snum Snam unit convert etype [shape]
        const dir = t[6];
        if (!'UDLR'.includes(dir)) break;
        if (!keep(n(9), n(10))) break;
        cur.pins.push({ name: t[1] ?? '~', num: t[2] ?? '', x: n(3), y: n(4),
                        len: n(5), dir });
        break;
      }
      default:
        // T (text), B (bezier) and anything else: skipped, not fatal.
        break;
    }
  }
  return out;
}

/** Pin connection points in EDITOR coordinates, in the symbol's pin-number
 *  order. Y is negated: KiCad measures upward. */
export function symbolPins(sym) {
  return [...sym.pins]
    .sort((a, b) => (parseInt(a.num, 10) || 0) - (parseInt(b.num, 10) || 0))
    .map((p) => ({
      name: p.name === '~' ? p.num : p.name,
      num: p.num,
      x: p.x * SCALE,
      y: -p.y * SCALE,
    }));
}

/**
 * Draw a parsed symbol into a 2D context, in editor coordinates.
 *
 * Body only — pin STUBS are drawn, but the connection dots are the renderer's
 * job, exactly as for the built-in symbols, so a KiCad symbol and a native one
 * cannot disagree about where a pin is.
 */
export function drawSymbol(g, sym) {
  const X = (v) => v * SCALE;
  const Y = (v) => -v * SCALE;

  for (const s of sym.shapes) {
    g.beginPath();
    if (s.k === 'rect') {
      g.rect(X(s.x1), Y(s.y1), X(s.x2 - s.x1), Y(s.y2 - s.y1));
    } else if (s.k === 'circle') {
      g.arc(X(s.x), Y(s.y), Math.abs(X(s.r)), 0, Math.PI * 2);
    } else if (s.k === 'arc') {
      // Angles are tenths of a degree, measured counter-clockwise with Y up.
      // Negating Y turns that into a clockwise sweep on screen, so both
      // endpoints negate AND the direction flag flips. Getting only the first
      // half right draws the arc's complement — a plausible but wrong curve.
      const a1 = (-s.a1 * Math.PI) / 180;
      const a2 = (-s.a2 * Math.PI) / 180;
      g.arc(X(s.x), Y(s.y), Math.abs(X(s.r)), a1, a2, true);
    } else if (s.k === 'poly') {
      s.pts.forEach(([px, py], i) => {
        if (i === 0) g.moveTo(X(px), Y(py)); else g.lineTo(X(px), Y(py));
      });
    }
    if (s.fill === 'F' || s.fill === 'f') g.fill();
    g.stroke();
  }

  // Pin stubs, from the connection point inward along the pin's direction.
  const D = { U: [0, 1], D: [0, -1], L: [-1, 0], R: [1, 0] };
  g.beginPath();
  for (const p of sym.pins) {
    const [dx, dy] = D[p.dir] ?? [0, 0];
    g.moveTo(X(p.x), Y(p.y));
    g.lineTo(X(p.x + dx * p.len), Y(p.y + dy * p.len));
  }
  g.stroke();
}

/** Bounding box in editor coordinates, for hit-testing and layout. */
export function symbolBounds(sym) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  const put = (x, y) => {
    x1 = Math.min(x1, x); x2 = Math.max(x2, x);
    y1 = Math.min(y1, y); y2 = Math.max(y2, y);
  };
  for (const s of sym.shapes) {
    if (s.k === 'rect') { put(s.x1 * SCALE, -s.y1 * SCALE); put(s.x2 * SCALE, -s.y2 * SCALE); }
    else if (s.k === 'circle' || s.k === 'arc') {
      const r = Math.abs(s.r * SCALE);
      put(s.x * SCALE - r, -s.y * SCALE - r);
      put(s.x * SCALE + r, -s.y * SCALE + r);
    } else if (s.k === 'poly') {
      for (const [px, py] of s.pts) put(px * SCALE, -py * SCALE);
    }
  }
  for (const p of symbolPins(sym)) put(p.x, p.y);
  if (!Number.isFinite(x1)) return { x1: -20, y1: -20, x2: 20, y2: 20 };
  return { x1, y1, x2, y2 };
}
