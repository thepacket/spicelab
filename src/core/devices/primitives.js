/**
 * Linear primitives: R, C, L, K, and the four controlled sources.
 *
 * These carry the stamp conventions everything else follows:
 *   nodes[0] = positive terminal, current flows in at nodes[0].
 *   branches[] holds indices of extra unknowns owned by this device.
 */
import { Device } from '../device.js';

/** Two-terminal conductance stamp handles. */
function reserve2(sys, p, n) {
  sys.reserve(p, p); sys.reserve(p, n); sys.reserve(n, p); sys.reserve(n, n);
}
function bind2(sys, p, n) {
  return [sys.handle(p, p), sys.handle(p, n), sys.handle(n, p), sys.handle(n, n)];
}
function stamp2(sys, h, g) {
  sys.add(h[0], g); sys.add(h[1], -g); sys.add(h[2], -g); sys.add(h[3], g);
}
function stamp2c(sys, h, gr, gi) {
  sys.addComplex(h[0], gr, gi); sys.addComplex(h[1], -gr, -gi);
  sys.addComplex(h[2], -gr, -gi); sys.addComplex(h[3], gr, gi);
}

export class Resistor extends Device {
  constructor(name, p, n, r) {
    super(name);
    this.nodes = [p, n];
    this.r = r;
    this.tc1 = 0;
    this.tc2 = 0;
    this.g = 1 / r;
  }
  temperature(ctx) {
    const dt = ctx.temp - ctx.nomTemp;
    const rEff = this.r * (1 + this.tc1 * dt + this.tc2 * dt * dt);
    this.g = 1 / rEff;
  }
  reserve(sys) { reserve2(sys, this.nodes[0], this.nodes[1]); }
  bind(sys) { this.h = bind2(sys, this.nodes[0], this.nodes[1]); }
  loadDC(ctx) { stamp2(ctx.sys, this.h, this.g); }
  loadNoise(ctx, out) {
    // Johnson noise: 4kTG A^2/Hz, injected between the terminals.
    out.push({ device: this.name, type: 'thermal', nodes: this.nodes, psd: 4 * 1.380649e-23 * ctx.temp * this.g });
  }
}

export class Capacitor extends Device {
  constructor(name, p, n, c) {
    super(name);
    this.nodes = [p, n];
    this.c = c;
    this.ic = null;      // initial condition, applied when uic is set
    this.nStates = 2;    // [charge, current]
  }
  reserve(sys) { reserve2(sys, this.nodes[0], this.nodes[1]); }
  bind(sys) { this.h = bind2(sys, this.nodes[0], this.nodes[1]); }

  loadDC(ctx) {
    // Open circuit at DC. gmin across the branch keeps the matrix nonsingular
    // when a capacitor is the only element on a node.
    stamp2(ctx.sys, this.h, ctx.gmin);
  }

  loadTran(ctx) {
    const [p, n] = this.nodes;
    const v = ctx.v(p) - ctx.v(n);
    const st = ctx.state.at(0);
    st[this.stateOff] = this.c * v;
    ctx.integrate(this.stateOff, this.c, v);
    stamp2(ctx.sys, this.h, ctx.geq);
    ctx.rhs(p, -ctx.ieq);
    ctx.rhs(n, ctx.ieq);
  }

  loadAC(ctx) {
    stamp2c(ctx.sys, this.h, 0, ctx.omega * this.c);
  }

  maxTimestep(ctx) {
    return this._lte === undefined ? Infinity : this._lte;
  }
}

export class Inductor extends Device {
  constructor(name, p, n, l) {
    super(name);
    this.nodes = [p, n];
    this.l = l;
    this.ic = null;
    this.nBranches = 1;
    this.nStates = 2;    // [flux, voltage]
    /** @type {Inductor[]} mutual couplings, filled in by Coupling */
    this.couples = [];
  }
  reserve(sys) {
    const [p, n] = this.nodes;
    const b = this.branches[0];
    sys.reserve(p, b); sys.reserve(n, b);
    sys.reserve(b, p); sys.reserve(b, n); sys.reserve(b, b);
    for (const { other } of this.couples) sys.reserve(b, other.branches[0]);
  }
  bind(sys) {
    const [p, n] = this.nodes;
    const b = this.branches[0];
    this.hPB = sys.handle(p, b);
    this.hNB = sys.handle(n, b);
    this.hBP = sys.handle(b, p);
    this.hBN = sys.handle(b, n);
    this.hBB = sys.handle(b, b);
    this.hMut = this.couples.map((c) => sys.handle(b, c.other.branches[0]));
  }
  _stampTopology(sys) {
    sys.add(this.hPB, 1);
    sys.add(this.hNB, -1);
    sys.add(this.hBP, 1);
    sys.add(this.hBN, -1);
  }
  loadDC(ctx) {
    // A short at DC: V(p) - V(n) = 0.
    this._stampTopology(ctx.sys);
  }
  loadTran(ctx) {
    const b = this.branches[0];
    const i = ctx.x[b];
    const st = ctx.state.at(0);
    let flux = this.l * i;
    for (const c of this.couples) flux += c.m * ctx.x[c.other.branches[0]];
    st[this.stateOff] = flux;
    ctx.integrate(this.stateOff, this.l, i);
    this._stampTopology(ctx.sys);
    ctx.sys.add(this.hBB, -ctx.geq);
    // ctx.ieq already folds in the mutual flux through the charge state, so the
    // linear mutual term is subtracted out of the RHS as it is added to the
    // matrix. scale converts dq/dv=L into the method's coefficient (L/dt for BE).
    let ieq = ctx.ieq;
    const scale = ctx.geq / this.l;
    this.couples.forEach((c, k) => {
      const gm = scale * c.m;
      ctx.sys.add(this.hMut[k], -gm);
      ieq -= gm * ctx.x[c.other.branches[0]];
    });
    ctx.rhs(b, ieq);
  }
  loadAC(ctx) {
    this._stampTopology(ctx.sys);
    ctx.sys.addComplex(this.hBB, 0, -ctx.omega * this.l);
    this.couples.forEach((c, k) => {
      ctx.sys.addComplex(this.hMut[k], 0, -ctx.omega * c.m);
    });
  }
}

/** Mutual inductance: K<name> L1 L2 <coupling coefficient>. */
export class Coupling extends Device {
  constructor(name, l1, l2, k) {
    super(name);
    this.l1 = l1;
    this.l2 = l2;
    this.k = k;
    const m = k * Math.sqrt(l1.l * l2.l);
    this.m = m;
    l1.couples.push({ other: l2, m });
    l2.couples.push({ other: l1, m });
  }
}

export class VCVS extends Device {
  constructor(name, p, n, cp, cn, gain) {
    super(name);
    this.nodes = [p, n, cp, cn];
    this.gain = gain;
    this.nBranches = 1;
  }
  reserve(sys) {
    const [p, n, cp, cn] = this.nodes;
    const b = this.branches[0];
    sys.reserve(p, b); sys.reserve(n, b);
    sys.reserve(b, p); sys.reserve(b, n); sys.reserve(b, cp); sys.reserve(b, cn);
  }
  bind(sys) {
    const [p, n, cp, cn] = this.nodes;
    const b = this.branches[0];
    this.h = [sys.handle(p, b), sys.handle(n, b), sys.handle(b, p),
              sys.handle(b, n), sys.handle(b, cp), sys.handle(b, cn)];
  }
  loadDC(ctx) {
    const s = ctx.sys;
    s.add(this.h[0], 1); s.add(this.h[1], -1);
    s.add(this.h[2], 1); s.add(this.h[3], -1);
    s.add(this.h[4], -this.gain); s.add(this.h[5], this.gain);
  }
}

export class VCCS extends Device {
  constructor(name, p, n, cp, cn, gm) {
    super(name);
    this.nodes = [p, n, cp, cn];
    this.gm = gm;
  }
  reserve(sys) {
    const [p, n, cp, cn] = this.nodes;
    sys.reserve(p, cp); sys.reserve(p, cn); sys.reserve(n, cp); sys.reserve(n, cn);
  }
  bind(sys) {
    const [p, n, cp, cn] = this.nodes;
    this.h = [sys.handle(p, cp), sys.handle(p, cn), sys.handle(n, cp), sys.handle(n, cn)];
  }
  loadDC(ctx) {
    const s = ctx.sys;
    s.add(this.h[0], this.gm); s.add(this.h[1], -this.gm);
    s.add(this.h[2], -this.gm); s.add(this.h[3], this.gm);
  }
}

/** Current-controlled current source. Control is the branch of a voltage source. */
export class CCCS extends Device {
  constructor(name, p, n, ctrl, gain) {
    super(name);
    this.nodes = [p, n];
    this.ctrl = ctrl;
    this.gain = gain;
  }
  reserve(sys) {
    const cb = this.ctrl.branches[0];
    sys.reserve(this.nodes[0], cb);
    sys.reserve(this.nodes[1], cb);
  }
  bind(sys) {
    const cb = this.ctrl.branches[0];
    this.h = [sys.handle(this.nodes[0], cb), sys.handle(this.nodes[1], cb)];
  }
  loadDC(ctx) {
    ctx.sys.add(this.h[0], this.gain);
    ctx.sys.add(this.h[1], -this.gain);
  }
}

/** Current-controlled voltage source. */
export class CCVS extends Device {
  constructor(name, p, n, ctrl, gain) {
    super(name);
    this.nodes = [p, n];
    this.ctrl = ctrl;
    this.gain = gain;
    this.nBranches = 1;
  }
  reserve(sys) {
    const [p, n] = this.nodes;
    const b = this.branches[0];
    const cb = this.ctrl.branches[0];
    sys.reserve(p, b); sys.reserve(n, b);
    sys.reserve(b, p); sys.reserve(b, n); sys.reserve(b, cb);
  }
  bind(sys) {
    const [p, n] = this.nodes;
    const b = this.branches[0];
    this.h = [sys.handle(p, b), sys.handle(n, b), sys.handle(b, p),
              sys.handle(b, n), sys.handle(b, this.ctrl.branches[0])];
  }
  loadDC(ctx) {
    const s = ctx.sys;
    s.add(this.h[0], 1); s.add(this.h[1], -1);
    s.add(this.h[2], 1); s.add(this.h[3], -1);
    s.add(this.h[4], -this.gain);
  }
}

/** Voltage-controlled switch with hysteresis. */
export class VSwitch extends Device {
  constructor(name, p, n, cp, cn, model) {
    super(name);
    this.nodes = [p, n, cp, cn];
    this.m = { vt: 0, vh: 0, ron: 1, roff: 1e12, ...model };
    this.on = false;
    this.nonlinear = true;
  }
  reserve(sys) { reserve2(sys, this.nodes[0], this.nodes[1]); }
  bind(sys) { this.h = bind2(sys, this.nodes[0], this.nodes[1]); }
  loadDC(ctx) {
    const vc = ctx.v(this.nodes[2]) - ctx.v(this.nodes[3]);
    const { vt, vh, ron, roff } = this.m;
    if (vc > vt + vh) this.on = true;
    else if (vc < vt - vh) this.on = false;
    stamp2(ctx.sys, this.h, 1 / (this.on ? ron : roff));
  }
}
