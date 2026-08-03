/**
 * Net extraction: schematic geometry -> electrical nets.
 *
 * Union-find over two kinds of element: lattice POINTS (`P:x,y`) and WIRES
 * (`W:id`). Coincidence is handled for free by keying points on their
 * coordinates, so two pins at the same spot are literally the same DSU element.
 *
 * The connection rules, which are the conventions every schematic editor
 * follows and which users will assume without being told:
 *
 *   1. A wire connects its own two endpoints.
 *   2. Anything at the same point is connected (pin-to-pin, pin-to-wire-end).
 *   3. T-JUNCTION: a pin or wire endpoint lying strictly INSIDE another wire
 *      connects to it. This is implicit — no dot required.
 *   4. CROSSING: two wires that cross without either's endpoint touching the
 *      other do NOT connect. This is the rule that makes schematics readable,
 *      and the one whose violation is silent — a crossing that wrongly connects
 *      still simulates, it just simulates a different circuit.
 *   5. An explicit junction dot connects everything at that point, INCLUDING
 *      wires merely passing through. That is how you deliberately connect a
 *      crossing.
 *
 * Rules 3 and 4 are the same geometric test with a different endpoint policy,
 * which is exactly why they are easy to conflate. They are written as two
 * separate predicates below rather than one with a flag.
 *
 * COMPLEXITY: the point-versus-wire sweep is O(points x wires). For the
 * schematic sizes this editor targets (hundreds of components) that is
 * comfortably fast; a spatial hash is the obvious optimization if it ever shows
 * up in a profile.
 */
import { key } from './model.js';

class DisjointSet {
  constructor() {
    this.parent = new Map();
  }
  add(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    return x;
  }
  find(x) {
    this.add(x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    // Path compression.
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur);
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/** Is (px,py) on segment `w`, strictly between its endpoints? */
export function onSegmentInterior(px, py, w) {
  if ((px === w.x1 && py === w.y1) || (px === w.x2 && py === w.y2)) return false;
  return onSegmentInclusive(px, py, w);
}

/** Is (px,py) anywhere on segment `w`, endpoints included? */
export function onSegmentInclusive(px, py, w) {
  const dx = w.x2 - w.x1;
  const dy = w.y2 - w.y1;
  // Collinear?
  if ((px - w.x1) * dy - (py - w.y1) * dx !== 0) return false;
  // Within the span?
  const dot = (px - w.x1) * dx + (py - w.y1) * dy;
  if (dot < 0) return false;
  return dot <= dx * dx + dy * dy;
}

const P = (x, y) => `P:${key(x, y)}`;
const W = (id) => `W:${id}`;

/**
 * Extract nets.
 *
 * @param {import('./model.js').Schematic} sch
 * @returns {{
 *   nets: Array<{name:string, points:string[], pins:Array<object>, isGround:boolean, labelled:boolean}>,
 *   netOfPin: Map<string, number>,
 *   conflicts: Array<{names:string[]}>
 * }}
 */
export function extractNets(sch) {
  const ds = new DisjointSet();

  // Rule 1: a wire ties its own endpoints together.
  for (const w of sch.wires) {
    ds.union(W(w.id), P(w.x1, w.y1));
    ds.union(W(w.id), P(w.x2, w.y2));
  }

  // Every declared point becomes a DSU element. Rule 2 is implicit: two things
  // at one coordinate produce the same key.
  const points = new Set();
  for (const w of sch.wires) {
    points.add(P(w.x1, w.y1));
    points.add(P(w.x2, w.y2));
  }
  const pins = sch.allPins();
  for (const p of pins) points.add(P(p.x, p.y));
  for (const l of sch.labels) points.add(P(l.x, l.y));
  for (const p of points) ds.add(p);

  // Rule 3: T-junctions. A declared point strictly inside a wire joins it.
  // Note this deliberately excludes the wire's own endpoints, so it cannot
  // create the crossing connection that rule 4 forbids.
  const declared = [];
  for (const s of points) {
    const [x, y] = s.slice(2).split(',').map(Number);
    declared.push({ s, x, y });
  }
  for (const w of sch.wires) {
    for (const d of declared) {
      if (onSegmentInterior(d.x, d.y, w)) ds.union(d.s, W(w.id));
    }
  }

  // Rule 5: an explicit dot connects every wire passing through it, endpoints
  // included — this is what deliberately joins a crossing.
  for (const j of sch.junctions) {
    const jp = P(j.x, j.y);
    ds.add(jp);
    for (const w of sch.wires) {
      if (onSegmentInclusive(j.x, j.y, w)) ds.union(jp, W(w.id));
    }
  }

  // Group by root.
  const groups = new Map();
  const wireRoot = new Map();
  for (const w of sch.wires) wireRoot.set(w.id, ds.find(W(w.id)));
  const push = (k, kind, value) => {
    const r = ds.find(k);
    if (!groups.has(r)) groups.set(r, { root: r, points: [], pins: [], labels: [] });
    groups.get(r)[kind].push(value);
  };
  for (const s of points) push(s, 'points', s);
  for (const p of pins) push(P(p.x, p.y), 'pins', p);
  for (const l of sch.labels) push(P(l.x, l.y), 'labels', l);

  // Name the nets. Ground wins over labels; labels win over generated names.
  const conflicts = [];
  const nets = [];
  const netOfPin = new Map();
  const netOfWire = new Map();
  const rootOfNet = [];
  let auto = 0;

  const isGroundName = (n) => ['0', 'gnd', 'ground'].includes(String(n).toLowerCase());

  for (const g of groups.values()) {
    const grounded =
      g.pins.some((p) => p.component.type === 'ground') ||
      g.labels.some((l) => isGroundName(l.name));

    const named = [...new Set(g.labels.map((l) => l.name).filter((n) => !isGroundName(n)))];
    if (named.length > 1) {
      // Two different labels on one net is almost always a mistake, and
      // picking one silently would hide it. Report and take the first.
      conflicts.push({ names: named.slice().sort() });
    }

    let name;
    if (grounded) name = '0';
    else if (named.length) name = named.slice().sort()[0];
    else name = `N${++auto}`;

    const index = nets.length;
    rootOfNet.push(g.root);
    nets.push({
      name,
      points: g.points,
      pins: g.pins,
      labels: g.labels,
      isGround: grounded,
      labelled: named.length > 0 || grounded,
    });
    for (const p of g.pins) {
      netOfPin.set(`${p.component.id}:${p.index}`, index);
    }
  }

  // A wire's net, so a click anywhere along it resolves — not just on the
  // declared lattice points at its ends.
  for (const [wid, root] of wireRoot) {
    const i = rootOfNet.indexOf(root);
    if (i >= 0) netOfWire.set(wid, i);
  }

  return { nets, netOfPin, netOfWire, conflicts };
}

/** Convenience: the net name attached to a given component pin. */
export function netNameOfPin(result, component, pinIndex) {
  const i = result.netOfPin.get(`${component.id}:${pinIndex}`);
  return i === undefined ? null : result.nets[i].name;
}

/**
 * The net occupying a given lattice point, or null.
 *
 * Exact match only: the point must be a DECLARED point (a wire end, a pin or a
 * label). Clicking the middle of a wire will not match — use `netAt`.
 */
export function netAtPoint(result, x, y) {
  const k = `P:${x},${y}`;
  return result.nets.find((n) => n.points.includes(k)) ?? null;
}

/**
 * The net under an arbitrary click, or null.
 *
 * Used by the probe tool. A user clicks the middle of a wire, which is NOT a
 * declared lattice point, so an exact point lookup finds nothing — hence the
 * fallback to wire-body hit testing. The probe still records the NET NAME, never
 * the coordinate: a probe anchored to geometry would drift the moment the wire
 * moved, and would silently measure whatever ended up at that spot.
 *
 * @param {import('./model.js').Schematic} sch
 * @param {ReturnType<extractNets>} result
 * @param {number} tol pick radius in document units
 */
export function netAt(sch, result, x, y, tol = 6) {
  const exact = netAtPoint(result, x, y);
  if (exact) return exact;

  let best = null;
  let bestD = Infinity;
  for (const w of sch.wires) {
    const dx = w.x2 - w.x1;
    const dy = w.y2 - w.y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((x - w.x1) * dx + (y - w.y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(x - (w.x1 + t * dx), y - (w.y1 + t * dy));
    if (d <= tol && d < bestD) { bestD = d; best = w; }
  }
  if (!best) return null;
  const i = result.netOfWire.get(best.id);
  return i === undefined ? null : result.nets[i];
}
