/**
 * Device interface and simulation context.
 *
 * This file defines the contract every device implements. It is the single most
 * expensive thing to change later, so the full set of hooks is declared now even
 * where a given device leaves them as no-ops: DC load, transient load, AC
 * small-signal load, noise contribution, Newton limiting, per-device convergence
 * test, and parameter sensitivity. Adding a hook later means touching every
 * device; declaring it now costs nothing.
 *
 * CHARGE-BASED, NOT CAPACITANCE-BASED. Devices report charge q(v) and dq/dv, and
 * the integrator differentiates. Stamping capacitance directly does not conserve
 * charge across timestep changes and produces slow drift in switching circuits —
 * a bug that is very hard to find once the simulator is large.
 */

export const GND = -1;

/** Analysis mode a load() call is running under. */
export const Mode = Object.freeze({
  OP: 0,      // DC operating point
  DC: 1,      // DC sweep (same stamps as OP)
  TRAN: 2,    // transient
  AC: 3,      // small-signal frequency domain
});

/**
 * Per-instance simulation state, shared across devices as flat typed arrays.
 * History depth 3 covers Gear2 and trapezoidal with one spare for rejection.
 */
export class StatePool {
  constructor(size, depth = 4) {
    this.size = size;
    this.depth = depth;
    /** @type {Float64Array[]} ring of state vectors, index 0 = current */
    this.rings = Array.from({ length: depth }, () => new Float64Array(size));
    this.head = 0;
  }
  /** @param {number} k time index back from now (0 = current) */
  at(k) {
    return this.rings[(this.head + k) % this.depth];
  }
  /** Advance to a new timepoint, copying current values forward as the initial guess. */
  advance() {
    this.head = (this.head - 1 + this.depth) % this.depth;
    this.rings[this.head].set(this.rings[(this.head + 1) % this.depth]);
  }
  /** Undo an advance (used when a timestep is rejected). */
  rollback() {
    this.head = (this.head + 1) % this.depth;
  }
  reset() {
    for (const r of this.rings) r.fill(0);
    this.head = 0;
  }
}

/**
 * Everything a device needs during a load pass. One instance per circuit; the
 * analyses mutate its fields rather than allocating, so load() never allocates.
 */
export class Context {
  constructor(system, numUnknowns, stateSize) {
    this.sys = system;
    this.n = numUnknowns;

    /** @type {Float64Array} current Newton iterate */
    this.x = new Float64Array(numUnknowns);
    /** @type {Float64Array} previous Newton iterate */
    this.xPrev = new Float64Array(numUnknowns);
    /** @type {Float64Array} solution at the last accepted timepoint */
    this.xOld = new Float64Array(numUnknowns);
    /** @type {Float64Array} RHS, real part */
    this.rhsRe = new Float64Array(numUnknowns);
    /** @type {Float64Array} RHS, imaginary part (AC only) */
    this.rhsIm = new Float64Array(numUnknowns);

    this.state = new StatePool(stateSize);

    this.mode = Mode.OP;
    this.time = 0;
    /** @type {number[]} dt[0] = current step, dt[1] = previous step */
    this.dt = [1e-9, 1e-9];
    this.omega = 0;

    this.gmin = 1e-12;
    this.temp = 300.15;        // K, instance temperature
    this.nomTemp = 300.15;     // K, model extraction temperature
    this.sourceFactor = 1;     // source ramping for convergence aid
    this.initTransient = false; // first timepoint: use DC values, no integration
    this.initJunction = false;  // first Newton iteration: use nominal guesses
    this.bypass = false;

    this.reltol = 1e-3;
    this.vntol = 1e-6;
    this.abstol = 1e-12;
    this.chgtol = 1e-14;

    /** Set by a device when its own convergence test fails. */
    this.deviceConverged = true;
    /** Set by a device when limiting altered the iterate. */
    this.limited = false;

    /** @type {(qOff:number, dqdv:number, v:number)=>void} installed by the integrator */
    this.integrator = null;
    this.geq = 0;
    this.ieq = 0;
  }

  /** Node voltage, honouring the ground index. */
  v(node) {
    return node < 0 ? 0 : this.x[node];
  }

  vOld(node) {
    return node < 0 ? 0 : this.xOld[node];
  }

  /** Add to the real RHS at a node (ignored for ground). */
  rhs(node, val) {
    if (node >= 0) this.rhsRe[node] += val;
  }

  rhsC(node, valRe, valIm) {
    if (node < 0) return;
    this.rhsRe[node] += valRe;
    this.rhsIm[node] += valIm;
  }

  /** Thermal voltage kT/q at the instance temperature. */
  get vt() {
    return 1.380649e-23 * this.temp / 1.602176634e-19;
  }

  /**
   * Integrate a charge state into an equivalent conductance and current.
   * Reads state[qOff], writes state[qOff+1] (the branch current), and leaves
   * the result in this.geq / this.ieq.
   */
  integrate(qOff, dqdv, v) {
    this.integrator(qOff, dqdv, v);
  }
}

/**
 * Base class for all devices. Subclasses override what they need.
 * Every hook is intentionally present here so that adding, say, noise analysis
 * later does not require editing device files that do not contribute noise.
 */
export class Device {
  /** @param {string} name instance name, e.g. "R1" */
  constructor(name) {
    this.name = name;
    /** @type {number[]} unknown indices, -1 for ground */
    this.nodes = [];
    /** @type {number} offset into the state pool */
    this.stateOff = 0;
    /** @type {number} number of state slots this instance needs */
    this.nStates = 0;
    /** @type {number} number of extra unknowns (branch currents) */
    this.nBranches = 0;
    /** @type {number[]} indices of this device's extra unknowns */
    this.branches = [];
    this.nonlinear = false;
  }

  /** Declare matrix pattern entries. Called once per topology change. */
  reserve(sys) {}

  /** Cache matrix handles after analyze(). Called once per topology change. */
  bind(sys) {}

  /** Recompute temperature-dependent parameters. Called when temp changes. */
  temperature(ctx) {}

  /** Stamp for DC operating point and DC sweep. */
  loadDC(ctx) {}

  /** Stamp for transient. Defaults to the DC stamp for memoryless devices. */
  loadTran(ctx) {
    this.loadDC(ctx);
  }

  /** Stamp small-signal contribution at ctx.omega, linearized about the OP. */
  loadAC(ctx) {
    this.loadDC(ctx);
  }

  /** Add noise current spectral density contributions. */
  loadNoise(ctx, out) {}

  /** Apply voltage limiting to the Newton iterate. Set ctx.limited if changed. */
  limit(ctx) {}

  /** Device-specific convergence test. Clear ctx.deviceConverged to reject. */
  checkConvergence(ctx) {}

  /** Largest safe timestep this device wants, based on local truncation error. */
  maxTimestep(ctx) {
    return Infinity;
  }

  /** Reset internal history. */
  reset(ctx) {}
}
