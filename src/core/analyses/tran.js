/**
 * Transient analysis.
 *
 * Written as a resumable stepper rather than a run-to-completion loop. The
 * interactive UI needs to advance the simulation for a slice of wall-clock time,
 * hand control back so the browser can paint, and resume where it left off. A
 * blocking loop would have to be rewritten to support that; this does not.
 *
 *   const run = new TransientRun(circuit, { tstop: 1e-3, tstep: 1e-6 });
 *   run.begin();
 *   while (!run.done) run.advanceFor(8);   // 8 ms of wall clock per call
 */
import { Mode } from '../device.js';
import { setIntegrator, lteTimestep, Method } from '../integrator.js';
import { solveDC, newton, ConvergenceError } from '../newton.js';
import { waveformBreakpoints } from '../devices/sources.js';

export class TransientRun {
  /**
   * @param {import('../circuit.js').Circuit} circuit
   * @param {{tstop:number, tstep:number, tstart?:number, tmax?:number,
   *          uic?:boolean, method?:string, onPoint?:Function}} opts
   */
  constructor(circuit, opts) {
    this.c = circuit;
    this.tstop = opts.tstop;
    this.tstep = opts.tstep;
    this.tstart = opts.tstart ?? 0;
    this.tmax = opts.tmax ?? Math.min(this.tstep, (this.tstop - this.tstart) / 50);
    this.uic = opts.uic ?? false;
    this.method = opts.method ?? circuit.options.method;
    this.onPoint = opts.onPoint ?? null;

    this.time = 0;
    this.dt = 0;
    this.done = false;
    this.order = 1;
    this.accepted = 0;
    this.rejected = 0;
    this.iterations = 0;

    /** @type {number[]} times of accepted points */
    this.times = [];
    /** @type {Float64Array[]} solutions at accepted points */
    this.data = [];

    this.breakpoints = [];
    this.bpIndex = 0;
  }

  begin() {
    const c = this.c;
    c.ensureBuilt();
    const ctx = c.ctx;
    ctx.tstep = this.tstep;
    ctx.tstop = this.tstop;

    // Collect waveform breakpoints so no source edge is stepped over.
    const bp = new Set([0, this.tstop]);
    for (const d of c.devices) {
      if (d.tran) for (const t of waveformBreakpoints(d.tran, this.tstop)) bp.add(t);
    }
    this.breakpoints = [...bp].sort((a, b) => a - b);
    this.bpIndex = 0;

    ctx.state.reset();
    if (this.uic) {
      ctx.x.fill(0);
      this._applyInitialConditions();
    } else {
      solveDC(c);
    }
    ctx.xOld.set(ctx.x);

    // First timepoint: charges are seeded from the operating point.
    ctx.mode = Mode.TRAN;
    ctx.time = 0;
    ctx.initTransient = true;
    setIntegrator(ctx, this.method, 1);
    c.load(Mode.TRAN);
    ctx.initTransient = false;

    this.time = 0;
    this.dt = Math.min(this.tmax, this.tstep) / 10;
    this.order = 1;
    this._record(0);
    return this;
  }

  _applyInitialConditions() {
    const ctx = this.c.ctx;
    for (const d of this.c.devices) {
      if (d.ic != null && d.nodes.length >= 2) {
        const [p, n] = d.nodes;
        if (p >= 0) ctx.x[p] = d.ic + (n >= 0 ? ctx.x[n] : 0);
      }
    }
  }

  _record(t) {
    this.times.push(t);
    const snap = Float64Array.from(this.c.ctx.x);
    this.data.push(snap);
    if (this.onPoint) this.onPoint(t, snap);
  }

  /** Largest step allowed by breakpoints, tmax, and the remaining span. */
  _limitStep(dt) {
    let lim = Math.min(dt, this.tmax, this.tstop - this.time);
    while (this.bpIndex < this.breakpoints.length &&
           this.breakpoints[this.bpIndex] <= this.time + 1e-15) {
      this.bpIndex++;
    }
    if (this.bpIndex < this.breakpoints.length) {
      const next = this.breakpoints[this.bpIndex];
      const toBp = next - this.time;
      if (toBp > 0 && toBp < lim) lim = toBp;
      // Do not leave a sliver of a step just before a breakpoint.
      else if (toBp > 0 && toBp < 1.5 * lim) lim = toBp / 2;
    }
    return Math.max(lim, 1e-18);
  }

  /**
   * Attempt one timestep. Returns true if it was accepted.
   */
  step() {
    const c = this.c;
    const ctx = c.ctx;
    const dt = this._limitStep(this.dt);

    ctx.state.advance();
    ctx.dt[1] = ctx.dt[0];
    ctx.dt[0] = dt;
    ctx.time = this.time + dt;
    ctx.xOld.set(ctx.x);

    const order = Math.min(this.order, c.options.maxord);
    setIntegrator(ctx, this.method, this.accepted < 2 ? 1 : order);

    ctx.forceInit = false;
    const r = newton(c, Mode.TRAN, c.options.itl4);
    this.iterations += r.iterations;

    if (!r.converged) {
      ctx.state.rollback();
      ctx.x.set(ctx.xOld);
      ctx.dt[0] = ctx.dt[1];
      this.rejected++;
      this.dt = dt / 8;
      if (this.dt < 1e-18) {
        throw new ConvergenceError(
          `transient failed to converge at t=${this.time.toExponential(4)} s ` +
          `(timestep collapsed to ${this.dt.toExponential(2)} s)`,
          { time: this.time, reason: r.reason }
        );
      }
      return false;
    }

    // Commit charges at the CONVERGED solution.
    //
    // Devices compute q(v) during load(), which runs before the solve. For a
    // nonlinear circuit Newton iterates until v stops moving, so the stored
    // charge ends up consistent. For a linear circuit Newton exits after one
    // iteration and the stored charge is left one timepoint stale, which
    // silently corrupts every subsequent integration and LTE estimate. One
    // extra stamp pass at the converged solution fixes both cases.
    c.load(Mode.TRAN);

    // Local truncation error check across every charge-storing device.
    let allowed = Infinity;
    for (const d of c.devices) {
      if (d.nStates >= 2) {
        for (let k = 0; k < d.nStates; k += 2) {
          const lim = lteTimestep(ctx, d.stateOff + k, this.method, c.options.trtol);
          if (lim < allowed) allowed = lim;
        }
      }
    }

    if (this.accepted >= 2 && allowed < 0.9 * dt) {
      ctx.state.rollback();
      ctx.x.set(ctx.xOld);
      ctx.dt[0] = ctx.dt[1];
      this.rejected++;
      this.dt = Math.max(allowed, dt / 8);
      return false;
    }

    this.time += dt;
    this.accepted++;
    this.order = 2;
    if (this.time >= this.tstart) this._record(this.time);

    // Grow the step, but never by more than 2x, and never past what LTE allows.
    let next = Math.min(2 * dt, allowed);
    if (r.iterations > c.options.itl4 * 0.7) next = Math.min(next, dt);
    this.dt = next;

    if (this.time >= this.tstop - 1e-15) this.done = true;
    return true;
  }

  /** Run steps until `ms` of wall-clock time has elapsed or the run finishes. */
  advanceFor(ms) {
    const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
    while (!this.done) {
      this.step();
      if (((typeof performance !== 'undefined' ? performance : Date).now() - t0) >= ms) break;
    }
    return this.done;
  }

  /** Run the whole analysis. */
  runToCompletion() {
    while (!this.done) this.step();
    return this.result();
  }

  result() {
    return {
      time: this.times,
      data: this.data,
      labels: this.c.labels.slice(),
      stats: {
        accepted: this.accepted,
        rejected: this.rejected,
        iterations: this.iterations,
      },
    };
  }
}

/** Convenience wrapper for a blocking transient run. */
export function tran(circuit, opts) {
  return new TransientRun(circuit, opts).begin().runToCompletion();
}
