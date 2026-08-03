/**
 * Independent voltage and current sources.
 *
 * A source carries three independent values: a DC level (operating point and DC
 * sweep), a transient waveform, and an AC magnitude/phase. They are separate on
 * purpose — that is what lets one netlist serve .op, .dc, .ac and .tran without
 * editing, and it is why the signal generator UI has separate DC/AC/transient
 * panels rather than one value field.
 */
import { Device } from '../device.js';

/** Evaluate a transient waveform spec at time t. */
export function waveform(w, t, tstep = 1e-9, tstop = 1) {
  if (!w) return null;
  switch (w.type) {
    case 'dc':
      return w.v0 ?? 0;

    case 'sin': {
      const { vo = 0, va = 0, freq = 1 / tstop, td = 0, theta = 0, phase = 0 } = w;
      if (t < td) return vo + va * Math.sin((Math.PI / 180) * phase);
      const dt = t - td;
      return vo + va * Math.exp(-dt * theta) *
        Math.sin(2 * Math.PI * freq * dt + (Math.PI / 180) * phase);
    }

    case 'pulse': {
      const { v1 = 0, v2 = 1, td = 0, tr = tstep, tf = tstep, pw = tstop, per = tstop } = w;
      if (t < td) return v1;
      let x = t - td;
      if (per > 0 && x >= per) x -= Math.floor(x / per) * per;
      if (x < tr) return v1 + ((v2 - v1) * x) / (tr || 1e-300);
      if (x < tr + pw) return v2;
      if (x < tr + pw + tf) return v2 + ((v1 - v2) * (x - tr - pw)) / (tf || 1e-300);
      return v1;
    }

    case 'pwl': {
      const pts = w.points;
      if (!pts.length) return 0;
      let x = t;
      if (w.repeat && w.period > 0 && x > w.period) x -= Math.floor(x / w.period) * w.period;
      if (x <= pts[0][0]) return pts[0][1];
      for (let i = 1; i < pts.length; i++) {
        if (x <= pts[i][0]) {
          const [t0, v0] = pts[i - 1];
          const [t1, v1] = pts[i];
          return t1 === t0 ? v1 : v0 + ((v1 - v0) * (x - t0)) / (t1 - t0);
        }
      }
      return pts[pts.length - 1][1];
    }

    case 'exp': {
      const { v1 = 0, v2 = 1, td1 = 0, tau1 = tstep, td2 = tstop, tau2 = tstep } = w;
      let v = v1;
      if (t > td1) v += (v2 - v1) * (1 - Math.exp(-(t - td1) / tau1));
      if (t > td2) v += (v1 - v2) * (1 - Math.exp(-(t - td2) / tau2));
      return v;
    }

    case 'sffm': {
      const { vo = 0, va = 1, fc = 1 / tstop, mdi = 0, fs = 1 / tstop } = w;
      return vo + va * Math.sin(2 * Math.PI * fc * t + mdi * Math.sin(2 * Math.PI * fs * t));
    }

    case 'am': {
      const { va = 1, vo = 0, mf = 1, fc = 1 / tstop, td = 0 } = w;
      if (t < td) return 0;
      const dt = t - td;
      return va * (vo + Math.sin(2 * Math.PI * mf * dt)) * Math.sin(2 * Math.PI * fc * dt);
    }

    default:
      return 0;
  }
}

/** Largest timestep a waveform wants near time t, so edges are never skipped. */
export function waveformBreakpoints(w, tstop) {
  if (!w) return [];
  const bp = [];
  if (w.type === 'pulse') {
    const { td = 0, tr = 0, tf = 0, pw = 0, per = 0 } = w;
    if (per > 0) {
      for (let t = td; t < tstop; t += per) {
        bp.push(t, t + tr, t + tr + pw, t + tr + pw + tf);
      }
    } else {
      bp.push(td, td + tr, td + tr + pw, td + tr + pw + tf);
    }
  } else if (w.type === 'pwl') {
    for (const [t] of w.points) bp.push(t);
    if (w.repeat && w.period > 0) {
      for (let k = 1; k * w.period < tstop; k++) {
        for (const [t] of w.points) bp.push(t + k * w.period);
      }
    }
  } else if (w.type === 'exp') {
    bp.push(w.td1 ?? 0, w.td2 ?? 0);
  } else if (w.type === 'sin') {
    bp.push(w.td ?? 0);
  }
  return bp.filter((t) => t >= 0 && t <= tstop).sort((a, b) => a - b);
}

export class VoltageSource extends Device {
  /**
   * @param {string} name
   * @param {number} p @param {number} n
   * @param {{dc?:number, ac?:{mag:number, phase:number}, tran?:object}} spec
   */
  constructor(name, p, n, spec = {}) {
    super(name);
    this.nodes = [p, n];
    this.dc = spec.dc ?? 0;
    this.ac = spec.ac ?? null;
    this.tran = spec.tran ?? null;
    this.nBranches = 1;
  }
  reserve(sys) {
    const [p, n] = this.nodes;
    const b = this.branches[0];
    sys.reserve(p, b); sys.reserve(n, b); sys.reserve(b, p); sys.reserve(b, n);
  }
  bind(sys) {
    const [p, n] = this.nodes;
    const b = this.branches[0];
    this.h = [sys.handle(p, b), sys.handle(n, b), sys.handle(b, p), sys.handle(b, n)];
  }
  _topology(sys) {
    sys.add(this.h[0], 1); sys.add(this.h[1], -1);
    sys.add(this.h[2], 1); sys.add(this.h[3], -1);
  }
  value(ctx) {
    if (ctx.mode === 2 && this.tran) {
      return waveform(this.tran, ctx.time, ctx.tstep, ctx.tstop);
    }
    return this.dc;
  }
  loadDC(ctx) {
    this._topology(ctx.sys);
    ctx.rhs(this.branches[0], this.value(ctx) * ctx.sourceFactor);
  }
  loadTran(ctx) {
    this._topology(ctx.sys);
    ctx.rhs(this.branches[0], this.value(ctx));
  }
  loadAC(ctx) {
    this._topology(ctx.sys);
    if (this.ac) {
      const ph = (Math.PI / 180) * (this.ac.phase ?? 0);
      ctx.rhsC(this.branches[0], this.ac.mag * Math.cos(ph), this.ac.mag * Math.sin(ph));
    }
  }
  /** Current through the source, positive flowing from p to n internally. */
  current(ctx) { return ctx.x[this.branches[0]]; }
}

export class CurrentSource extends Device {
  constructor(name, p, n, spec = {}) {
    super(name);
    this.nodes = [p, n];
    this.dc = spec.dc ?? 0;
    this.ac = spec.ac ?? null;
    this.tran = spec.tran ?? null;
  }
  value(ctx) {
    if (ctx.mode === 2 && this.tran) {
      return waveform(this.tran, ctx.time, ctx.tstep, ctx.tstop);
    }
    return this.dc;
  }
  loadDC(ctx) {
    const i = this.value(ctx) * ctx.sourceFactor;
    ctx.rhs(this.nodes[0], -i);
    ctx.rhs(this.nodes[1], i);
  }
  loadTran(ctx) {
    const i = this.value(ctx);
    ctx.rhs(this.nodes[0], -i);
    ctx.rhs(this.nodes[1], i);
  }
  loadAC(ctx) {
    if (!this.ac) return;
    const ph = (Math.PI / 180) * (this.ac.phase ?? 0);
    const re = this.ac.mag * Math.cos(ph);
    const im = this.ac.mag * Math.sin(ph);
    ctx.rhsC(this.nodes[0], -re, -im);
    ctx.rhsC(this.nodes[1], re, im);
  }
}
