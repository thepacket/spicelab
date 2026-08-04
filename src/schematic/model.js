/**
 * Schematic document model and pin geometry.
 *
 * Everything is on an integer grid. That is not a cosmetic choice: net
 * extraction decides whether two things are connected by comparing coordinates,
 * and floating-point coordinates make "the same point" a tolerance question
 * that silently changes the circuit when a rotation introduces a rounding
 * error. Positions are integers, rotations are multiples of 90 degrees, and
 * equality is exact.
 *
 * Pins are declared in the component's local frame and transformed by the
 * instance's rotation and mirroring. `pinPositions` is the single place that
 * transform happens, so the editor, the net extractor and the renderer cannot
 * disagree about where a pin is.
 */

/** Grid spacing in document units. Pins and wire ends must land on multiples. */
export const GRID = 10;

/**
 * Component library. `pins` are ordered — the order is the netlist terminal
 * order, so it must match what the netlist emitter expects for each type.
 */
export const SYMBOLS = {
  // Two-terminal passives: pin 0 is the positive terminal.
  resistor: { prefix: 'R', pins: [{ name: '1', x: 0, y: -20 }, { name: '2', x: 0, y: 20 }] },
  capacitor: { prefix: 'C', pins: [{ name: '1', x: 0, y: -20 }, { name: '2', x: 0, y: 20 }] },
  inductor: { prefix: 'L', pins: [{ name: '1', x: 0, y: -20 }, { name: '2', x: 0, y: 20 }] },
  diode: { prefix: 'D', pins: [{ name: 'A', x: 0, y: -20 }, { name: 'K', x: 0, y: 20 }] },
  vsource: { prefix: 'V', pins: [{ name: '+', x: 0, y: -20 }, { name: '-', x: 0, y: 20 }] },
  isource: { prefix: 'I', pins: [{ name: '+', x: 0, y: -20 }, { name: '-', x: 0, y: 20 }] },
  // Three-terminal actives, in netlist order.
  npn: {
    prefix: 'Q',
    pins: [
      { name: 'C', x: 20, y: -20 },
      { name: 'B', x: -20, y: 0 },
      { name: 'E', x: 20, y: 20 },
    ],
  },
  pnp: {
    prefix: 'Q',
    pins: [
      { name: 'C', x: 20, y: -20 },
      { name: 'B', x: -20, y: 0 },
      { name: 'E', x: 20, y: 20 },
    ],
  },
  nmos: {
    prefix: 'M',
    pins: [
      { name: 'D', x: 20, y: -20 },
      { name: 'G', x: -20, y: 0 },
      { name: 'S', x: 20, y: 20 },
      { name: 'B', x: 20, y: 0 },
    ],
  },
  pmos: {
    prefix: 'M',
    pins: [
      { name: 'D', x: 20, y: -20 },
      { name: 'G', x: -20, y: 0 },
      { name: 'S', x: 20, y: 20 },
      { name: 'B', x: 20, y: 0 },
    ],
  },
  /**
   * Junction FETs, `J<name> D G S <model>`.
   *
   * Three terminals, unlike the MOSFET's four — a JFET has no bulk, and adding
   * a fourth pin "for symmetry" would put the model name in the node list and
   * every JFET netlist would be malformed.
   *
   * The interactive core does not implement element `J`, so these route to
   * ngspice. That is the two-engine design working as intended rather than a
   * limitation: 4,804 JFET cards in the KiCad library become usable, and the
   * editor reports which engine ran.
   */
  njf: {
    prefix: 'J',
    pins: [
      { name: 'D', x: 20, y: -20 },
      { name: 'G', x: -20, y: 0 },
      { name: 'S', x: 20, y: 20 },
    ],
  },
  pjf: {
    prefix: 'J',
    pins: [
      { name: 'D', x: 20, y: -20 },
      { name: 'G', x: -20, y: 0 },
      { name: 'S', x: 20, y: 20 },
    ],
  },

  /**
   * Power MOSFETs, `M<name> D G S <model>` against a `.model ... VDMOS`.
   *
   * Three terminals where the level 1/3 MOSFET has four: a VDMOS's body diode
   * is intrinsic to the model, so the substrate is not a separate node. Same
   * card letter, different arity — which is exactly why the model TYPE has to
   * be checked, and now is.
   *
   * Polarity is carried by the card's `pchan` flag rather than by the type
   * token, so `partsFromDefs` reads it and assigns `nvdmos` or `pvdmos`. That
   * keeps the existing safety rule usable: `Use for selected` refuses a kind
   * mismatch, and without the split a p-channel card would drop onto an
   * n-channel symbol and simulate happily.
   */
  nvdmos: {
    prefix: 'M',
    pins: [
      { name: 'D', x: 20, y: -20 },
      { name: 'G', x: -20, y: 0 },
      { name: 'S', x: 20, y: 20 },
    ],
  },
  pvdmos: {
    prefix: 'M',
    pins: [
      { name: 'D', x: 20, y: -20 },
      { name: 'G', x: -20, y: 0 },
      { name: 'S', x: 20, y: 20 },
    ],
  },

  /**
   * Voltage-controlled switch, `S<name> N+ N- NC+ NC- <model>`.
   *
   * The interactive core implements this device; it simply had no symbol, so
   * the one nonlinear element available for behavioural modelling — comparator
   * thresholds, Schmitt triggers, ideal switching — was reachable only by
   * typing a netlist.
   *
   * Only `.model ... SW` maps here. `VSWITCH` is the PSpice spelling and is a
   * DIFFERENT device: it states thresholds as VON/VOFF where SW uses VT/VH, so
   * a VSWITCH card read as an SW would take vt=vh=0 from the defaults and
   * switch at 0 V. The core refuses it; see `check_model_kind` in build.rs.
   */
  sw: {
    prefix: 'S',
    pins: [
      { name: '+', x: -20, y: -20 },
      { name: '-', x: 20, y: -20 },
      { name: 'C+', x: -20, y: 20 },
      { name: 'C-', x: 20, y: 20 },
    ],
  },

  /** Ground reference. One pin; forces its net to node 0. */
  ground: { prefix: 'GND', pins: [{ name: '1', x: 0, y: 0 }], ground: true },

  // ---- Analyses, as placeable objects -----------------------------------
  //
  // An analysis is an ordinary component with no pins. That is not a trick to
  // reuse the array: it is what makes analyses inherit everything components
  // already have — placement, selection, undo, save/reload, and above all the
  // `enabled` flag, so a `.tran` is switched off exactly the way a resistor is,
  // with no separate "which analyses are on" state to keep in sync. The idiom
  // is Qucs's, whose file format stores a `.TR` with the same tuple as an `R`.
  //
  // `params` is the single source of truth for both the property editor and
  // the emitted card, so the two cannot drift.
  tran: {
    prefix: 'TRAN', pins: [], directive: true, label: 'Transient',
    params: [
      { key: 'tstep', def: '10u' },
      { key: 'tstop', def: '5m' },
      { key: 'tstart', def: '' },
    ],
    card: (p) => `.tran ${p.tstep} ${p.tstop}${p.tstart ? ` ${p.tstart}` : ''}`,
  },
  ac: {
    prefix: 'AC', pins: [], directive: true, label: 'AC sweep',
    params: [
      { key: 'scale', def: 'dec', choices: ['dec', 'oct', 'lin'] },
      { key: 'points', def: '20' },
      { key: 'start', def: '1' },
      { key: 'stop', def: '1meg' },
    ],
    card: (p) => `.ac ${p.scale} ${p.points} ${p.start} ${p.stop}`,
  },
  op: {
    prefix: 'OP', pins: [], directive: true, label: 'Operating point',
    params: [],
    card: () => '.op',
  },
  /**
   * DC sweep. `source` names an independent source by its REFERENCE — `V1`,
   * not a net — because that is what the `.dc` card takes and what
   * `dc_sweep` looks up.
   *
   * The solver has had this analysis since the first port and the parser has
   * always accepted the card; it simply was not exposed across the wasm
   * boundary, was not in the engine contract, and had no block here, so
   * nothing in the application could run it.
   */
  dc: {
    prefix: 'DC', pins: [], directive: true, label: 'DC sweep',
    params: [
      { key: 'source', def: 'V1' },
      { key: 'start', def: '0' },
      { key: 'stop', def: '5' },
      { key: 'step', def: '0.05' },
    ],
    card: (p) => `.dc ${p.source} ${p.start} ${p.stop} ${p.step}`,
  },
  /**
   * `.tf` — small-signal transfer function about the operating point.
   *
   * `output` is a NET name; the card is emitted in SPICE's `V(out)` spelling
   * because that is what every textbook and vendor deck writes, and the parser
   * accepts both forms.
   *
   * `input` must be an independent VOLTAGE source, because the analysis
   * excites that source's own MNA row and only a source owning a branch
   * current has one. The core says so by name rather than silently using
   * unknown 0, which would return a plausible number for something else.
   */
  tf: {
    prefix: 'TF', pins: [], directive: true, label: 'Transfer function',
    params: [
      { key: 'output', def: 'out' },
      { key: 'input', def: 'V1' },
    ],
    card: (p) => `.tf V(${p.output}) ${p.input}`,
  },
  /**
   * `.four <freq> V(<node>)` — Fourier analysis of a transient.
   *
   * Unlike every other block here, this one names an analysis the SOLVER does
   * not run: it is post-processing on transient samples, done above both
   * engines (`src/instruments/fourier.js`). The card is still emitted, and the
   * host reads it back out of the netlist — so a `.four` typed by hand into a
   * SPICE text block works exactly like a placed one, rather than being
   * silently ignored.
   */
  four: {
    prefix: 'FOUR', pins: [], directive: true, label: 'Fourier',
    params: [
      { key: 'freq', def: '1k' },
      { key: 'output', def: 'out' },
    ],
    card: (p) => `.four ${p.freq} V(${p.output})`,
  },

  /**
   * An instance of a `.subckt` macromodel.
   *
   * This is how REAL parts get into a design: vendor op-amps, regulators and
   * power FETs ship as subcircuits, and the parser already handles `.subckt`,
   * nested definitions and parameter passing. Without a way to instantiate one
   * from the canvas, all of that was reachable only by typing netlists.
   *
   * Pins are per instance because they come from the macromodel. **Their ORDER
   * is the netlist contract**, exactly as for a transistor's terminals: it must
   * match the order the `.subckt` line declares, and getting it wrong wires the
   * part up differently while simulating perfectly happily.
   */
  subckt: {
    prefix: 'X', label: 'Subcircuit',
    params: [
      { key: 'name', def: '' },
      { key: 'pins', def: 'in out' },
      { key: 'params', def: '' },
    ],
    pins: [],
    pinsFor(c) {
      const names = subcktPins(c.props?.pins);
      if (!names.length) return [];
      // Laid out down both sides of a box, in declaration order: left column
      // top to bottom, then right column top to bottom.
      const left = Math.ceil(names.length / 2);
      return names.map((name, i) => {
        const onLeft = i < left;
        const col = onLeft ? i : i - left;
        const rows = onLeft ? left : names.length - left;
        const span = (rows - 1) * 20;
        return { name, x: onLeft ? -30 : 30, y: col * 20 - span / 2 };
      });
    },
  },

  /**
   * Raw netlist text, placed on the canvas.
   *
   * The escape hatch, and the reason a vendor macromodel can be used at all in
   * a browser with no filesystem: paste the `.subckt ... .ends` block (or a
   * `.model` card, or `.param` lines) and it is emitted verbatim. Generalises
   * this project's existing rule that anything drawable is also typeable —
   * anything typeable should also be placeable.
   */
  spice: {
    prefix: 'TXT', pins: [], directive: true, label: 'SPICE text',
    params: [{ key: 'text', def: '', multiline: true }],
    card: (p) => String(p.text ?? '').trim(),
  },
};

/** Symbol types that emit a directive card rather than a device instance. */
export const isDirective = (type) => !!SYMBOLS[type]?.directive;

/**
 * The pins of a specific INSTANCE.
 *
 * Almost every symbol has a fixed pin list, but a subcircuit's depends on the
 * macromodel it names, so it is derived per instance. Everything that walks
 * pins must go through here — reading `SYMBOLS[type].pins` directly works for
 * ten symbol types and silently gives a subcircuit no pins at all.
 */
export function pinsOf(c) {
  const sym = SYMBOLS[c.type];
  return sym.pinsFor ? sym.pinsFor(c) : sym.pins;
}

/** Split a user-typed pin list. Order is the netlist contract — see below. */
export function subcktPins(spec) {
  return String(spec ?? '')
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Snap a coordinate to the grid. */
export const snap = (v) => Math.round(v / GRID) * GRID;

/** Canonical key for a lattice point. */
export const key = (x, y) => `${x},${y}`;

/**
 * Rotate a local offset by `rot` degrees (0/90/180/270) and optionally mirror
 * in X. Integer-exact for the four allowed angles.
 */
export function transform(dx, dy, rot = 0, mirror = false) {
  let x = mirror ? -dx : dx;
  let y = dy;
  const r = ((rot % 360) + 360) % 360;
  switch (r) {
    case 90: return { x: -y, y: x };
    case 180: return { x: -x, y: -y };
    case 270: return { x: y, y: -x };
    default: return { x, y };
  }
}

export class Schematic {
  constructor() {
    /** @type {Array<{id:string,type:string,ref:string,value:string,x:number,y:number,rot:number,mirror:boolean,props:object}>} */
    this.components = [];
    /** @type {Array<{id:string,x1:number,y1:number,x2:number,y2:number}>} */
    this.wires = [];
    /** Explicit junction dots. Only these connect CROSSING wires. */
    this.junctions = [];
    /** Net labels: name a net at a point. */
    this.labels = [];
    this._seq = 0;
  }

  _id(p) {
    return `${p}${++this._seq}`;
  }

  /**
   * Add a component. `ref` is auto-assigned from the symbol prefix if omitted.
   */
  add(type, x, y, opts = {}) {
    const sym = SYMBOLS[type];
    if (!sym) throw new Error(`unknown symbol type: ${type}`);
    const c = {
      id: this._id('c'),
      type,
      ref: opts.ref ?? `${sym.prefix}${this.components.filter((k) => k.type === type).length + 1}`,
      value: opts.value ?? '',
      x: snap(x),
      y: snap(y),
      rot: opts.rot ?? 0,
      mirror: opts.mirror ?? false,
      /**
       * Disabled components are kept in the document and skipped by the
       * emitter. Uniform across parts and analyses on purpose: "try it without
       * R3" and "try it without the AC sweep" are the same operation.
       */
      enabled: opts.enabled ?? true,
      props: opts.props ?? {},
    };
    // Seed declared defaults so a freshly placed analysis emits a valid card
    // without the user opening a dialog first.
    for (const d of sym.params ?? []) {
      if (c.props[d.key] === undefined && d.def !== '') c.props[d.key] = d.def;
    }
    this.components.push(c);
    return c;
  }

  /** Add a wire segment. Zero-length wires are rejected, not silently kept. */
  wire(x1, y1, x2, y2) {
    const w = {
      id: this._id('w'),
      x1: snap(x1), y1: snap(y1), x2: snap(x2), y2: snap(y2),
    };
    if (w.x1 === w.x2 && w.y1 === w.y2) {
      throw new Error('zero-length wire');
    }
    this.wires.push(w);
    return w;
  }

  junction(x, y) {
    const j = { x: snap(x), y: snap(y) };
    this.junctions.push(j);
    return j;
  }

  label(x, y, name) {
    const l = { x: snap(x), y: snap(y), name };
    this.labels.push(l);
    return l;
  }

  /** Absolute positions of a component's pins, in declaration order. */
  pinPositions(c) {
    const sym = SYMBOLS[c.type];
    return pinsOf(c).map((p) => {
      const t = transform(p.x, p.y, c.rot, c.mirror);
      return { name: p.name, x: c.x + t.x, y: c.y + t.y };
    });
  }

  /** Every pin in the document, tagged with its owning component. */
  allPins() {
    const out = [];
    for (const c of this.components) {
      for (const [index, p] of this.pinPositions(c).entries()) {
        out.push({ component: c, index, name: p.name, x: p.x, y: p.y });
      }
    }
    return out;
  }
}

/**
 * Serialize to a plain object. Save/reload is a product requirement, and the
 * format is deliberately the document model itself rather than a derived form:
 * anything reconstructable from geometry (nets, junction dots, ERC state) is
 * recomputed on load, so a saved file can never disagree with what the
 * extractor would say about it.
 */
Schematic.prototype.toJSON = function toJSON() {
  return {
    version: 1,
    components: this.components.map((c) => ({
      id: c.id, type: c.type, ref: c.ref, value: c.value,
      x: c.x, y: c.y, rot: c.rot, mirror: c.mirror, props: c.props,
      // Explicitly listed, not spread: this serialiser enumerates fields, so a
      // new one is silently dropped unless added here. `enabled` was, and a
      // disabled part came back enabled after save/reload — and since `clone()`
      // round-trips through this, so did every undo step.
      enabled: c.enabled !== false,
    })),
    wires: this.wires.map((w) => ({ id: w.id, x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2 })),
    junctions: this.junctions.map((j) => ({ x: j.x, y: j.y })),
    labels: this.labels.map((l) => ({ x: l.x, y: l.y, name: l.name })),
  };
};

Schematic.fromJSON = function fromJSON(data) {
  const s = new Schematic();
  if (!data || typeof data !== 'object') return s;
  // `enabled` defaults true so documents saved before it existed keep working.
  s.components = (data.components ?? []).map((c) => ({
    ...c, props: c.props ?? {}, enabled: c.enabled !== false,
  }));
  s.wires = (data.wires ?? []).map((w) => ({ ...w }));
  s.junctions = (data.junctions ?? []).map((j) => ({ ...j }));
  s.labels = (data.labels ?? []).map((l) => ({ ...l }));
  // Continue ids past anything already used, so new items never collide.
  let max = 0;
  for (const o of [...s.components, ...s.wires]) {
    const n = Number(String(o.id ?? '').replace(/^\D+/, ''));
    if (Number.isFinite(n)) max = Math.max(max, n);
  }
  s._seq = max;
  return s;
};

/** Deep copy, used for undo snapshots. */
Schematic.prototype.clone = function clone() {
  const s = Schematic.fromJSON(this.toJSON());
  s._seq = this._seq;
  return s;
};

/** Remove components and wires by id. */
Schematic.prototype.deleteIds = function deleteIds(ids) {
  const set = new Set(ids);
  this.components = this.components.filter((c) => !set.has(c.id));
  this.wires = this.wires.filter((w) => !set.has(w.id));
};
