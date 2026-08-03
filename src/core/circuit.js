/**
 * Circuit container and build pipeline.
 *
 * The build is split into two phases on purpose:
 *
 *   buildTopology()  — allocates unknowns, reserves the matrix pattern, runs
 *                      symbolic analysis, binds handles. Expensive. Runs only
 *                      when wires or component counts change.
 *
 *   everything else  — stamps values into the already-analysed matrix.
 *
 * This split is the whole basis of interactive real-time. Dragging a
 * potentiometer changes a value, not a topology, so it never touches phase one.
 */
import { SparseSystem } from './sparse.js';
import { Context, Mode } from './device.js';

export class Circuit {
  constructor(title = 'circuit') {
    this.title = title;
    /** @type {import('./device.js').Device[]} */
    this.devices = [];
    /** @type {Map<string, number>} node name -> unknown index */
    this.nodeMap = new Map();
    /** @type {string[]} unknown index -> label */
    this.labels = [];
    this.numNodes = 0;
    this.numUnknowns = 0;
    this.sys = null;
    this.ctx = null;
    this.topologyDirty = true;
    this.options = {
      gmin: 1e-12,
      reltol: 1e-3,
      vntol: 1e-6,
      abstol: 1e-12,
      chgtol: 1e-14,
      itl1: 100,   // DC operating point iteration limit
      itl2: 50,    // DC sweep iteration limit
      itl4: 10,    // transient iteration limit per timepoint
      trtol: 7,
      temp: 300.15,
      nomTemp: 300.15,
      method: 'trap',
      maxord: 2,
    };
  }

  /** Resolve a node name to an unknown index. "0", "gnd" and "" are ground. */
  node(name) {
    const key = String(name).toLowerCase();
    if (key === '0' || key === 'gnd' || key === 'ground' || key === '') return -1;
    let idx = this.nodeMap.get(key);
    if (idx === undefined) {
      idx = this.numNodes++;
      this.nodeMap.set(key, idx);
      this.labels[idx] = String(name);
      this.topologyDirty = true;
    }
    return idx;
  }

  add(device) {
    this.devices.push(device);
    this.topologyDirty = true;
    return device;
  }

  remove(device) {
    const i = this.devices.indexOf(device);
    if (i >= 0) {
      this.devices.splice(i, 1);
      this.topologyDirty = true;
    }
  }

  /** Full topology build. Expensive; call only when structure changes. */
  buildTopology() {
    let unknown = this.numNodes;
    let stateSize = 0;

    for (const d of this.devices) {
      // Internal nodes (series resistances inside compact models).
      const nInt = d.nInternal ?? 0;
      if (nInt > 0) {
        d.internal = unknown++;
        this.labels[d.internal] = `${d.name}:int`;
      }
      d.branches = [];
      for (let k = 0; k < d.nBranches; k++) {
        d.branches.push(unknown);
        this.labels[unknown] = `I(${d.name})`;
        unknown++;
      }
      d.stateOff = stateSize;
      stateSize += d.nStates;
    }

    this.numUnknowns = unknown;
    this.sys = new SparseSystem(unknown);
    for (const d of this.devices) d.reserve(this.sys);
    this.sys.analyze();
    for (const d of this.devices) d.bind(this.sys);

    this.ctx = new Context(this.sys, unknown, Math.max(stateSize, 1));
    Object.assign(this.ctx, {
      gmin: this.options.gmin,
      reltol: this.options.reltol,
      vntol: this.options.vntol,
      abstol: this.options.abstol,
      chgtol: this.options.chgtol,
      temp: this.options.temp,
      nomTemp: this.options.nomTemp,
    });
    for (const d of this.devices) d.temperature(this.ctx);
    this.topologyDirty = false;
    return this;
  }

  ensureBuilt() {
    if (this.topologyDirty || !this.sys) this.buildTopology();
    return this;
  }

  /** Stamp every device for the current mode. Allocation-free. */
  load(mode) {
    const ctx = this.ctx;
    ctx.mode = mode;
    this.sys.zero();
    ctx.rhsRe.fill(0);
    ctx.rhsIm.fill(0);
    if (mode === Mode.TRAN) {
      for (const d of this.devices) d.loadTran(ctx);
    } else if (mode === Mode.AC) {
      for (const d of this.devices) d.loadAC(ctx);
    } else {
      for (const d of this.devices) d.loadDC(ctx);
    }
  }

  /** Index of a named node, or throw. */
  indexOf(name) {
    const key = String(name).toLowerCase();
    if (key === '0' || key === 'gnd') return -1;
    const i = this.nodeMap.get(key);
    if (i === undefined) throw new Error(`unknown node: ${name}`);
    return i;
  }

  /** Voltage at a named node in the current solution. */
  voltage(name) {
    const i = this.indexOf(name);
    return i < 0 ? 0 : this.ctx.x[i];
  }

  /** Current through a named voltage source in the current solution. */
  current(deviceName) {
    const d = this.devices.find((x) => x.name.toLowerCase() === String(deviceName).toLowerCase());
    if (!d || !d.branches.length) throw new Error(`no branch current for ${deviceName}`);
    return this.ctx.x[d.branches[0]];
  }

  /** Snapshot of every unknown, keyed by label. */
  snapshot() {
    const out = {};
    for (let i = 0; i < this.numUnknowns; i++) out[this.labels[i] ?? `x${i}`] = this.ctx.x[i];
    return out;
  }
}
