/**
 * MOSFET Level 1 (Shichman-Hodges) with body effect, channel-length modulation,
 * bulk junction diodes and Meyer gate capacitances.
 *
 * Level 1 is not accurate enough for submicron design, and it is not trying to
 * be. It is accurate enough for discrete power MOSFETs, switch models, and
 * teaching, and it shares its terminal handling and charge structure with
 * higher levels, so adding Level 2/3 later means adding a current equation
 * rather than restructuring the device.
 */
import { Device } from '../device.js';
import { pnjLimit, fetLimit, limVds, junctionCritical } from '../limiting.js';

export const MosDefaults = {
  type: 'nmos',
  vto: 1, kp: 2e-5, gamma: 0, phi: 0.6, lambda: 0,
  rd: 0, rs: 0, is: 1e-14, js: 0,
  cbd: 0, cbs: 0, pb: 0.8, cgso: 0, cgdo: 0, cgbo: 0,
  cj: 0, mj: 0.5, cjsw: 0, mjsw: 0.33, fc: 0.5, tox: 0,
  l: 1e-4, w: 1e-4, ad: 0, as: 0, pd: 0, ps: 0, nrd: 0, nrs: 0,
  kf: 0, af: 1,
};

export class MOSFET extends Device {
  /** nodes: [drain, gate, source, bulk] */
  constructor(name, d, g, s, b, model = {}, inst = {}) {
    super(name);
    this.nodes = [d, g, s, b];
    this.m = { ...MosDefaults, ...model, ...inst };
    this.nonlinear = true;
    this.nStates = 6; // [qgs,igs, qgd,igd, qgb,igb]
    this.sign = this.m.type === 'pmos' ? -1 : 1;
    this.vgs = 0; this.vds = 0; this.vbs = 0;
  }

  temperature(ctx) {
    this.vcrit = junctionCritical(Math.max(this.m.is, 1e-30), ctx.vt);
    const m = this.m;
    // Oxide capacitance per unit area, used for the Meyer model. tox = 0 means
    // "not stated", and a Level 1 card without it gets no intrinsic gate
    // capacitance at all — only the overlaps. That is what ngspice and SPICE3f5
    // do; defaulting to 1e-7 adds a cox*W*L to every gate that the reference
    // simulator does not have. Kept identical to the Rust core's `temperature`.
    this.cox = m.tox > 0 ? (3.9 * 8.854e-12) / m.tox : 0;
    this.beta = m.kp * (m.w / m.l);
  }

  reserve(sys) {
    const [d, g, s, b] = this.nodes;
    for (const i of [d, g, s, b]) for (const j of [d, g, s, b]) sys.reserve(i, j);
  }
  bind(sys) {
    const [d, g, s, b] = this.nodes;
    const H = (i, j) => sys.handle(i, j);
    this.h = {
      dd: H(d, d), dg: H(d, g), ds: H(d, s), db: H(d, b),
      gd: H(g, d), gg: H(g, g), gs: H(g, s), gb: H(g, b),
      sd: H(s, d), sg: H(s, g), ss: H(s, s), sb: H(s, b),
      bd: H(b, d), bg: H(b, g), bs: H(b, s), bb: H(b, b),
    };
  }

  limit(ctx) {
    const sgn = this.sign;
    const [d, g, s, b] = this.nodes;
    let vgs = sgn * (ctx.v(g) - ctx.v(s));
    let vds = sgn * (ctx.v(d) - ctx.v(s));
    const [ngs, c1] = fetLimit(vgs, this.vgs, this.vtoEff);
    const [nds, c2] = limVds(vds, this.vds);
    if (c1 || c2) {
      ctx.limited = true;
      if (d >= 0) ctx.x[d] += sgn * (nds - vds);
      if (g >= 0) ctx.x[g] += sgn * (ngs - vgs);
    }
  }

  /**
   * Threshold in the sign-flipped frame the current equation works in.
   *
   * A PMOS card states vto as NEGATIVE, and loadDC already mirrors the terminal
   * voltages so a p-channel device looks n-channel here. The threshold has to
   * be mirrored with them; using the raw vto turns a PMOS on 2*|vto| too early.
   * Found by diffing against ngspice — no MOSFET test here used a p-channel
   * device, so both this oracle and the Rust port had it wrong.
   */
  get vtoEff() {
    return this.sign * this.m.vto;
  }

  /** Shichman-Hodges drain current and its three derivatives. */
  _current(vgs, vds, vbs) {
    const m = this.m;
    const phi = m.phi;
    const vto = this.vtoEff;
    let vth = vto;
    let dvthdvb = 0;
    if (m.gamma !== 0) {
      const arg = Math.max(phi - vbs, 1e-9);
      vth = vto + m.gamma * (Math.sqrt(arg) - Math.sqrt(phi));
      dvthdvb = -m.gamma / (2 * Math.sqrt(arg));
    }
    const vgst = vgs - vth;
    const lam = m.lambda;
    const beta = this.beta;

    if (vgst <= 0) return { id: 0, gm: 0, gds: 0, gmbs: 0, vth, mode: 'off' };

    if (vds < vgst) {
      // Linear region.
      const f = 1 + lam * vds;
      const id = beta * f * (vgst - vds / 2) * vds;
      const gm = beta * f * vds;
      const gds = beta * (f * (vgst - vds) + lam * (vgst - vds / 2) * vds);
      const gmbs = -gm * dvthdvb;
      return { id, gm, gds, gmbs, vth, mode: 'linear' };
    }
    // Saturation.
    const f = 1 + lam * vds;
    const id = (beta / 2) * f * vgst * vgst;
    const gm = beta * f * vgst;
    const gds = (beta / 2) * lam * vgst * vgst;
    const gmbs = -gm * dvthdvb;
    return { id, gm, gds, gmbs, vth, mode: 'sat' };
  }

  loadDC(ctx) {
    const sgn = this.sign;
    const [d, g, s, b] = this.nodes;
    let vgs, vds, vbs;
    if (ctx.initJunction) {
      vgs = this.vtoEff + 0.1; vds = 0.1; vbs = 0;
    } else {
      vgs = sgn * (ctx.v(g) - ctx.v(s));
      vds = sgn * (ctx.v(d) - ctx.v(s));
      vbs = sgn * (ctx.v(b) - ctx.v(s));
    }

    // The device is symmetric: if vds < 0 the roles of drain and source swap.
    const reversed = vds < 0;
    const vgsE = reversed ? vgs - vds : vgs;
    const vdsE = Math.abs(vds);
    const vbsE = reversed ? vbs - vds : vbs;

    const r = this._current(vgsE, vdsE, vbsE);
    this.vgs = vgs; this.vds = vds; this.vbs = vbs;
    this.op = r;
    this.reversed = reversed;
    this.id = sgn * (reversed ? -r.id : r.id);

    // Terminal letters in the effective orientation. When vds < 0 the physical
    // drain acts as the source, so the stamp is written against swapped letters.
    const dL = reversed ? 's' : 'd';
    const sL = reversed ? 'd' : 's';
    this._stampCore(ctx, dL, sL, r.gm, r.gds, r.gmbs);

    const ceq = r.id - r.gm * vgsE - r.gds * vdsE - r.gmbs * vbsE;
    const dNode = reversed ? s : d;
    const sNode = reversed ? d : s;
    ctx.rhs(dNode, -sgn * ceq);
    ctx.rhs(sNode, sgn * ceq);

    this._charges(ctx, vgsE, vdsE, vbsE, r);
    this.vgsE = vgsE; this.vdsE = vdsE; this.vbsE = vbsE;
  }

  /** Stamp the transconductance model using effective terminal letters. */
  _stampCore(ctx, dL, sL, gm, gds, gmbs) {
    const H = this.h;
    const M = ctx.sys;
    M.add(H[dL + dL], gds);
    M.add(H[dL + 'g'], gm);
    M.add(H[dL + sL], -gm - gds - gmbs);
    M.add(H[dL + 'b'], gmbs);
    M.add(H[sL + dL], -gds);
    M.add(H[sL + 'g'], -gm);
    M.add(H[sL + sL], gm + gds + gmbs);
    M.add(H[sL + 'b'], -gmbs);
  }

  _charges(ctx, vgs, vds, vbs, r) {
    // Meyer capacitance model plus constant overlaps.
    const m = this.m;
    const cox = this.cox * m.w * m.l;
    const ovGS = m.cgso * m.w;
    const ovGD = m.cgdo * m.w;
    const ovGB = m.cgbo * m.l;
    let cgs, cgd, cgb;
    const vgst = vgs - r.vth;
    if (vgst <= 0) {
      cgb = cox; cgs = 0; cgd = 0;
    } else if (vds >= vgst) {
      cgb = 0; cgs = (2 / 3) * cox; cgd = 0;
    } else {
      const den = 2 * vgst - vds;
      cgb = 0;
      cgs = (2 / 3) * cox * (1 - ((vgst - vds) / den) ** 2);
      cgd = (2 / 3) * cox * (1 - (vgst / den) ** 2);
    }
    this.cgs = cgs + ovGS;
    this.cgd = cgd + ovGD;
    this.cgb = cgb + ovGB;
    this.qgs = this.cgs * vgs;
    this.qgd = this.cgd * (vgs - vds);
    this.qgb = this.cgb * (vgs - vbs);
  }

  loadTran(ctx) {
    this.loadDC(ctx);
    const st = ctx.state.at(0);
    const off = this.stateOff;
    const dL = this.reversed ? 's' : 'd';
    const sL = this.reversed ? 'd' : 's';
    const pairs = [
      [off,     this.cgs, this.qgs, 'g', sL, this.vgsE],
      [off + 2, this.cgd, this.qgd, 'g', dL, this.vgsE - this.vdsE],
      [off + 4, this.cgb, this.qgb, 'g', 'b', this.vgsE - this.vbsE],
    ];
    const M = ctx.sys;
    const node = (L) => this.nodes['dgsb'.indexOf(L)];
    for (const [o, c, q, na, nb, vv] of pairs) {
      if (c === 0) continue;
      st[o] = q;
      ctx.integrate(o, c, vv);
      const geq = ctx.geq;
      const ieq = ctx.ieq;
      M.add(this.h[na + na], geq);
      M.add(this.h[na + nb], -geq);
      M.add(this.h[nb + na], -geq);
      M.add(this.h[nb + nb], geq);
      // The equivalent current is computed from sign-mirrored voltages, so it
      // has to be mirrored back before it reaches the nodes; the conductance
      // does not, being dq/dv with both mirrored. Same polarity error as the
      // PMOS threshold, and it only shows on a p-channel device in transient.
      ctx.rhs(node(na), -this.sign * ieq);
      ctx.rhs(node(nb), this.sign * ieq);
    }
  }

  loadAC(ctx) {
    const r = this.op;
    const w = ctx.omega;
    const M = ctx.sys;
    const H = this.h;
    const { gm, gds, gmbs } = r;
    M.addComplex(H.dd, gds, 0);
    M.addComplex(H.dg, gm, 0);
    M.addComplex(H.ds, -gm - gds - gmbs, 0);
    M.addComplex(H.db, gmbs, 0);
    M.addComplex(H.sd, -gds, 0);
    M.addComplex(H.sg, -gm, 0);
    M.addComplex(H.ss, gm + gds + gmbs, 0);
    M.addComplex(H.sb, -gmbs, 0);
    const cap = (na, nb, c) => {
      if (!c) return;
      const bsus = w * c;
      M.addComplex(this.h[`${na}${na}`], 0, bsus);
      M.addComplex(this.h[`${na}${nb}`], 0, -bsus);
      M.addComplex(this.h[`${nb}${na}`], 0, -bsus);
      M.addComplex(this.h[`${nb}${nb}`], 0, bsus);
    };
    cap('g', 's', this.cgs);
    cap('g', 'd', this.cgd);
    cap('g', 'b', this.cgb);
  }

  checkConvergence(ctx) {
    const sgn = this.sign;
    const [d, g, s] = this.nodes;
    const vgs = sgn * (ctx.v(g) - ctx.v(s));
    const vds = sgn * (ctx.v(d) - ctx.v(s));
    const tol = ctx.reltol * Math.max(Math.abs(vgs), Math.abs(this.vgs)) + ctx.vntol;
    if (Math.abs(vgs - this.vgs) > tol || Math.abs(vds - this.vds) > tol) {
      ctx.deviceConverged = false;
    }
  }
}
