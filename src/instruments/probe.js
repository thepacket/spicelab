/**
 * Probes: first-class, persisted, routable measurement points.
 *
 * A probe is NOT a plot line. It is a saved object that names something
 * measurable in the circuit — a node voltage, a branch current, a difference
 * between two nodes — and carries its own identity, label and colour. Any
 * instrument can subscribe to any probe.
 *
 * That indirection is the whole point, and it is why this is not "an array of
 * column indices the scope happens to draw":
 *
 *   - A probe survives save/reload and re-simulation. Column indices do not:
 *     they change whenever the topology changes, so anything holding an index
 *     silently starts displaying a different signal after an edit.
 *   - The same probe can feed the scope, a meter and a Bode plot at once,
 *     without any of them knowing about the others.
 *   - Resolution against a specific run is late and explicit (`resolve`), so a
 *     probe pointing at a net that no longer exists reports that, rather than
 *     reading whatever now occupies that column.
 */

import { SERIES } from '../schematic/render.js';

let seq = 0;

export const ProbeKind = Object.freeze({
  /** Voltage at a node, relative to ground. */
  VOLTAGE: 'voltage',
  /** Voltage between two nodes. */
  DIFFERENTIAL: 'differential',
  /** Current through a device that owns a branch (V sources, inductors). */
  CURRENT: 'current',
});

/**
 * The colour a probe should be drawn in, for the theme active right now.
 *
 * Order matters: an explicit user choice wins, then the probe's palette slot,
 * then the caller's position as a last resort for probes saved before
 * `colorIndex` existed.
 *
 * @param {{color: ?string, colorIndex: ?number}} probe
 * @param {number} fallbackIndex position in the caller's own list
 */
export function probeColor(probe, fallbackIndex = 0) {
  if (probe?.color) return probe.color;
  const i = probe?.colorIndex ?? fallbackIndex;
  return SERIES[((i % SERIES.length) + SERIES.length) % SERIES.length];
}

export class Probe {
  /**
   * @param {object} spec
   * @param {string} spec.kind one of ProbeKind
   * @param {string} spec.target net name, or device ref for a current probe
   * @param {string} [spec.target2] second net, for a differential probe
   */
  constructor(spec) {
    this.id = spec.id ?? `p${++seq}`;
    this.kind = spec.kind ?? ProbeKind.VOLTAGE;
    this.target = spec.target;
    this.target2 = spec.target2 ?? null;
    this.label = spec.label ?? defaultLabel(this);
    /**
     * An EXPLICIT colour, chosen by the user. Null means "use the palette".
     *
     * Kept separate from `colorIndex` on purpose: a colour someone picked must
     * survive a theme change, and a colour the app assigned must not.
     */
    this.color = spec.color ?? null;
    /**
     * Index into the active theme's trace palette, resolved LATE.
     *
     * Storing the resolved hex instead is the colour equivalent of storing a
     * column index — it freezes a decision that depends on state which changes
     * underneath it. A probe assigned `#58a6ff` under the dark theme keeps that
     * washed-out blue on a white background forever. Probes already resolve
     * their SIGNAL late, against each run's labels, for the same reason.
     */
    this.colorIndex = spec.colorIndex ?? null;
    this.enabled = spec.enabled ?? true;
    /** Where the probe was dropped, so the editor can draw it in place. */
    this.at = spec.at ?? null;
  }

  toJSON() {
    return {
      id: this.id, kind: this.kind, target: this.target, target2: this.target2,
      label: this.label, color: this.color, colorIndex: this.colorIndex,
      enabled: this.enabled, at: this.at,
    };
  }

  static fromJSON(o) {
    const p = new Probe(o);
    // Keep the id counter ahead of anything loaded from disk.
    const n = Number(String(o.id ?? '').replace(/^\D+/, ''));
    if (Number.isFinite(n) && n > seq) seq = n;
    return p;
  }

  /**
   * Bind this probe to a concrete run.
   *
   * `read(row, base, stride, offset)` indexes unknown `i` at
   * `base + i * stride + offset`. The extra parameters exist because result
   * layouts differ: a transient row is one f64 per unknown (`stride 1`), while
   * an AC row interleaves real and imaginary parts (`stride 2`, `offset 0` or
   * `1`). Putting that arithmetic here rather than in each instrument means a
   * probe resolves the same way regardless of which analysis produced the data.
   *
   * @param {string[]} labels unknown labels from the solver, in column order
   * @returns {{ok:true, read:(row, base:number, stride?:number, offset?:number)=>number,
   *            unit:string} | {ok:false, reason:string}}
   */
  resolve(labels) {
    // CASE-INSENSITIVE, because SPICE identifiers are. `OUT` and `out` are the
    // same net, and the two engines disagree about which case to report: the
    // Rust core preserves what the netlist said, ngspice lowercases everything.
    // Matching exactly would make a probe stop resolving purely because the
    // design was routed to the other engine — the probe would correctly report
    // "net no longer exists" about a net that plainly does.
    const lower = labels.map((l) => l.toLowerCase());
    const idx = (name) => (name == null ? -1 : lower.indexOf(String(name).toLowerCase()));

    if (this.kind === ProbeKind.CURRENT) {
      // The solver labels a device's branch current as "I(<ref>)".
      const i = idx(`I(${this.target})`);
      if (i < 0) {
        return {
          ok: false,
          reason: `no branch current for ${this.target} — only sources and ` +
                  'inductors carry one',
        };
      }
      return {
        ok: true,
        unit: 'A',
        read: (row, base, stride = 1, off = 0) => row[base + i * stride + off],
      };
    }

    if (this.kind === ProbeKind.DIFFERENTIAL) {
      const a = idx(this.target);
      const b = idx(this.target2);
      if (a < 0 && !isGround(this.target)) {
        return { ok: false, reason: `net ${this.target} no longer exists` };
      }
      if (b < 0 && !isGround(this.target2)) {
        return { ok: false, reason: `net ${this.target2} no longer exists` };
      }
      return {
        ok: true,
        unit: 'V',
        read: (row, base, stride = 1, off = 0) =>
          (a < 0 ? 0 : row[base + a * stride + off]) -
          (b < 0 ? 0 : row[base + b * stride + off]),
      };
    }

    if (isGround(this.target)) {
      return { ok: true, unit: 'V', read: () => 0 };
    }
    const i = idx(this.target);
    if (i < 0) return { ok: false, reason: `net ${this.target} no longer exists` };
    return {
      ok: true,
      unit: 'V',
      read: (row, base, stride = 1, off = 0) => row[base + i * stride + off],
    };
  }
}

function isGround(n) {
  return ['0', 'gnd', 'ground'].includes(String(n).toLowerCase());
}

function defaultLabel(p) {
  switch (p.kind) {
    case ProbeKind.CURRENT: return `I(${p.target})`;
    case ProbeKind.DIFFERENTIAL: return `V(${p.target},${p.target2})`;
    default: return `V(${p.target})`;
  }
}

/**
 * The set of probes for a document, plus routing to instruments.
 *
 * Routing is stored here rather than on either side so that deleting a probe
 * cannot leave an instrument holding a dangling reference, and adding an
 * instrument does not require touching the probes.
 */
export class ProbeSet {
  constructor(probes = []) {
    this.probes = probes;
    /** instrumentId -> Set<probeId> */
    this.routes = new Map();
    this._listeners = new Set();
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit() {
    for (const fn of this._listeners) fn(this);
  }

  add(spec) {
    const p = spec instanceof Probe ? spec : new Probe(spec);
    this.probes.push(p);
    this._emit();
    return p;
  }

  remove(id) {
    this.probes = this.probes.filter((p) => p.id !== id);
    for (const set of this.routes.values()) set.delete(id);
    this._emit();
  }

  get(id) {
    return this.probes.find((p) => p.id === id) ?? null;
  }

  /** Route a probe to an instrument. Probes may feed several at once. */
  route(instrumentId, probeId, on = true) {
    if (!this.routes.has(instrumentId)) this.routes.set(instrumentId, new Set());
    const set = this.routes.get(instrumentId);
    if (on) set.add(probeId);
    else set.delete(probeId);
    this._emit();
  }

  routedTo(instrumentId) {
    const set = this.routes.get(instrumentId);
    if (!set) return [];
    return this.probes.filter((p) => set.has(p.id) && p.enabled);
  }

  isRouted(instrumentId, probeId) {
    return this.routes.get(instrumentId)?.has(probeId) ?? false;
  }

  toJSON() {
    return {
      probes: this.probes.map((p) => p.toJSON()),
      routes: [...this.routes].map(([k, v]) => [k, [...v]]),
    };
  }

  static fromJSON(o) {
    const set = new ProbeSet((o?.probes ?? []).map(Probe.fromJSON));
    for (const [k, ids] of o?.routes ?? []) set.routes.set(k, new Set(ids));
    return set;
  }
}
