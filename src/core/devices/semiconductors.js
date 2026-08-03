/**
 * Nonlinear semiconductor devices.
 *
 * Each device follows the same shape: compute currents and their derivatives at
 * the present iterate, compute junction and diffusion charges, hand the charges
 * to the integrator, then stamp a linearized companion model. AC reuses the
 * conductances and capacitances left behind by the last DC load, which is why
 * an .ac run always requires an operating point first.
 */
import { Device } from '../device.js';
import { pnjLimit, junctionCritical } from '../limiting.js';

const Q = 1.602176634e-19;
const K = 1.380649e-23;

export const DiodeDefaults = {
  is: 1e-14, n: 1, rs: 0, cjo: 0, vj: 1, m: 0.5, tt: 0,
  bv: Infinity, ibv: 1e-3, eg: 1.11, xti: 3, fc: 0.5, kf: 0, af: 1, area: 1,
};

/**
 * Junction charge for an abrupt/graded junction, with the standard linearized
 * extension above fc*vj that keeps the model differentiable.
 * @returns {[number, number]} charge and capacitance
 */
function junctionCharge(v, cjo, vj, m, fc) {
  if (cjo === 0) return [0, 0];
  if (v < fc * vj) {
    const arg = 1 - v / vj;
    const q = (cjo * vj * (1 - Math.pow(arg, 1 - m))) / (1 - m);
    const c = cjo * Math.pow(arg, -m);
    return [q, c];
  }
  const f1 = (vj * (1 - Math.pow(1 - fc, 1 - m))) / (1 - m);
  const f2 = Math.pow(1 - fc, 1 + m);
  const f3 = 1 - fc * (1 + m);
  const q = cjo * (f1 + (1 / f2) * (f3 * (v - fc * vj) + (m / (2 * vj)) * (v * v - (fc * vj) ** 2)));
  const c = (cjo / f2) * (f3 + (m * v) / vj);
  return [q, c];
}

export class Diode extends Device {
  constructor(name, p, n, model = {}) {
    super(name);
    this.nodes = [p, n];       // [anode, cathode]
    this.m = { ...DiodeDefaults, ...model };
    this.nonlinear = true;
    this.nStates = 2;          // [charge, current]
    this.vd = 0;
    this.gd = 0;
    this.cd = 0;
    /** internal node between rs and the junction, allocated if rs > 0 */
    this.internal = -1;
  }

  /** Number of internal nodes this device needs. */
  get nInternal() { return this.m.rs > 0 ? 1 : 0; }

  temperature(ctx) {
    const m = this.m;
    const t = ctx.temp;
    const tnom = ctx.nomTemp;
    const vt = (K * t) / Q;
    const vtnom = (K * tnom) / Q;
    const ratio = t / tnom;
    const egNom = m.eg;
    this.isT = m.is * m.area * Math.exp(
      ((ratio - 1) * egNom) / (m.n * vt) + (m.xti / m.n) * Math.log(ratio)
    );
    this.vjT = m.vj * ratio - 3 * vt * Math.log(ratio) - egNom * (ratio - 1);
    this.cjoT = m.cjo * m.area * (1 + m.m * (400e-6 * (t - tnom) - (this.vjT - m.vj) / m.vj));
    this.vcrit = junctionCritical(this.isT, m.n * vt);
  }

  get a() { return this.internal >= 0 ? this.internal : this.nodes[0]; }

  reserve(sys) {
    const [p, n] = this.nodes;
    const a = this.a;
    sys.reserve(a, a); sys.reserve(a, n); sys.reserve(n, a); sys.reserve(n, n);
    if (this.internal >= 0) {
      sys.reserve(p, p); sys.reserve(p, a); sys.reserve(a, p);
    }
  }
  bind(sys) {
    const [p, n] = this.nodes;
    const a = this.a;
    this.h = [sys.handle(a, a), sys.handle(a, n), sys.handle(n, a), sys.handle(n, n)];
    if (this.internal >= 0) {
      this.hRs = [sys.handle(p, p), sys.handle(p, a), sys.handle(a, p)];
      this.gs = 1 / (this.m.rs / this.m.area);
    }
  }

  limit(ctx) {
    const vt = this.m.n * ctx.vt;
    const vnew = ctx.v(this.a) - ctx.v(this.nodes[1]);
    const [v, changed] = pnjLimit(vnew, this.vd, vt, this.vcrit);
    if (changed) {
      ctx.limited = true;
      const delta = v - vnew;
      if (this.a >= 0) ctx.x[this.a] += delta;
    }
  }

  /** Evaluate current and conductance at the present junction voltage. */
  _evaluate(ctx, vd) {
    const m = this.m;
    const vt = m.n * ctx.vt;
    let id, gd;
    if (vd >= -3 * vt) {
      const e = Math.exp(Math.min(vd / vt, 40));
      id = this.isT * (e - 1);
      gd = (this.isT * e) / vt;
    } else if (vd > -m.bv) {
      const arg = (3 * vt) / (vd * Math.E);
      const a3 = arg * arg * arg;
      id = -this.isT * (1 + a3);
      gd = (this.isT * 3 * a3) / vd;
    } else {
      const e = Math.exp(-(m.bv + vd) / vt);
      id = -m.ibv * e;
      gd = (m.ibv * e) / vt;
    }
    return [id + vd * ctx.gmin, gd + ctx.gmin];
  }

  loadDC(ctx) {
    const a = this.a;
    const n = this.nodes[1];
    let vd = ctx.initJunction ? 0.6 : ctx.v(a) - ctx.v(n);
    if (ctx.initTransient && this.icSet) vd = this.vd;
    const [id, gd] = this._evaluate(ctx, vd);
    this.vd = vd;
    this.id = id;
    this.gd = gd;

    const s = ctx.sys;
    s.add(this.h[0], gd); s.add(this.h[1], -gd);
    s.add(this.h[2], -gd); s.add(this.h[3], gd);
    const ieq = id - gd * vd;
    ctx.rhs(a, -ieq);
    ctx.rhs(n, ieq);

    if (this.internal >= 0) {
      s.add(this.hRs[0], this.gs); s.add(this.hRs[1], -this.gs);
      s.add(this.hRs[2], -this.gs); s.add(this.h[0], this.gs);
    }

    // Charge is computed even in DC so that .ac has capacitances available.
    const [qj, cj] = junctionCharge(vd, this.cjoT, this.vjT, this.m.m, this.m.fc);
    this.qd = qj + this.m.tt * id;
    this.cd = cj + this.m.tt * gd;
  }

  loadTran(ctx) {
    this.loadDC(ctx);
    const a = this.a;
    const n = this.nodes[1];
    ctx.state.at(0)[this.stateOff] = this.qd;
    ctx.integrate(this.stateOff, this.cd, this.vd);
    const s = ctx.sys;
    s.add(this.h[0], ctx.geq); s.add(this.h[1], -ctx.geq);
    s.add(this.h[2], -ctx.geq); s.add(this.h[3], ctx.geq);
    ctx.rhs(a, -ctx.ieq);
    ctx.rhs(n, ctx.ieq);
  }

  loadAC(ctx) {
    const a = this.a;
    const n = this.nodes[1];
    const s = ctx.sys;
    const g = this.gd;
    const b = ctx.omega * this.cd;
    s.addComplex(this.h[0], g, b); s.addComplex(this.h[1], -g, -b);
    s.addComplex(this.h[2], -g, -b); s.addComplex(this.h[3], g, b);
    if (this.internal >= 0) {
      s.addComplex(this.hRs[0], this.gs, 0); s.addComplex(this.hRs[1], -this.gs, 0);
      s.addComplex(this.hRs[2], -this.gs, 0); s.addComplex(this.h[0], this.gs, 0);
    }
  }

  checkConvergence(ctx) {
    const vd = ctx.v(this.a) - ctx.v(this.nodes[1]);
    const [id] = this._evaluate(ctx, vd);
    const tol = ctx.reltol * Math.max(Math.abs(id), Math.abs(this.id)) + ctx.abstol;
    if (Math.abs(id - this.id) > tol) ctx.deviceConverged = false;
  }

  loadNoise(ctx, out) {
    out.push({ device: this.name, type: 'shot', nodes: [this.a, this.nodes[1]], psd: 2 * Q * Math.abs(this.id) });
    if (this.m.kf > 0) {
      out.push({ device: this.name, type: 'flicker', nodes: [this.a, this.nodes[1]],
                 psd: (this.m.kf * Math.pow(Math.abs(this.id), this.m.af)) });
    }
  }
}

export const BJTDefaults = {
  type: 'npn',
  is: 1e-16, bf: 100, nf: 1, vaf: Infinity, ikf: Infinity, ise: 0, ne: 1.5,
  br: 1, nr: 1, var: Infinity, ikr: Infinity, isc: 0, nc: 2,
  rb: 0, re: 0, rc: 0,
  cje: 0, vje: 0.75, mje: 0.33, cjc: 0, vjc: 0.75, mjc: 0.33, xcjc: 1,
  tf: 0, tr: 0, fc: 0.5, eg: 1.11, xti: 3, xtb: 0, area: 1, kf: 0, af: 1,
};

/**
 * Gummel-Poon bipolar transistor.
 *
 * Includes forward and reverse Early effect, high-injection knee, and
 * non-ideal base leakage. Base resistance modulation (irb/rbm) is not modelled;
 * everything else in the standard parameter set is.
 */
export class BJT extends Device {
  constructor(name, c, b, e, s, model = {}) {
    super(name);
    this.nodes = [c, b, e, s ?? -1];
    this.m = { ...BJTDefaults, ...model };
    this.nonlinear = true;
    this.nStates = 4;         // [qbe, ibe, qbc, ibc]
    this.sign = this.m.type === 'pnp' ? -1 : 1;
    this.vbe = 0;
    this.vbc = 0;
  }

  temperature(ctx) {
    const m = this.m;
    const t = ctx.temp;
    const ratio = t / ctx.nomTemp;
    const vt = (K * t) / Q;
    this.isT = m.is * m.area * Math.exp(((ratio - 1) * m.eg) / vt + m.xti * Math.log(ratio));
    this.bfT = m.bf * Math.pow(ratio, m.xtb);
    this.brT = m.br * Math.pow(ratio, m.xtb);
    this.vcrit = junctionCritical(this.isT, m.nf * vt);
  }

  reserve(sys) {
    const [c, b, e] = this.nodes;
    for (const i of [c, b, e]) for (const j of [c, b, e]) sys.reserve(i, j);
  }
  bind(sys) {
    const [c, b, e] = this.nodes;
    const g = (i, j) => sys.handle(i, j);
    this.h = {
      cc: g(c, c), cb: g(c, b), ce: g(c, e),
      bc: g(b, c), bb: g(b, b), be: g(b, e),
      ec: g(e, c), eb: g(e, b), ee: g(e, e),
    };
  }

  limit(ctx) {
    const [c, b, e] = this.nodes;
    const vt = ctx.vt;
    const s = this.sign;
    let vbe = s * (ctx.v(b) - ctx.v(e));
    let vbc = s * (ctx.v(b) - ctx.v(c));
    const [nbe, ch1] = pnjLimit(vbe, this.vbe, this.m.nf * vt, this.vcrit);
    const [nbc, ch2] = pnjLimit(vbc, this.vbc, this.m.nr * vt, this.vcrit);
    if (ch1 || ch2) {
      ctx.limited = true;
      // Move the base node so both junctions land on their limited values.
      if (b >= 0) ctx.x[b] += s * ((nbe - vbe) + (nbc - vbc)) / 2;
      if (e >= 0) ctx.x[e] -= s * (nbe - vbe) / 2;
      if (c >= 0) ctx.x[c] -= s * (nbc - vbc) / 2;
    }
  }

  _evaluate(ctx, vbe, vbc) {
    const m = this.m;
    const vt = ctx.vt;
    const ex = (v, nn) => Math.exp(Math.min(v / (nn * vt), 40));

    const ebe = ex(vbe, m.nf);
    const ebc = ex(vbc, m.nr);

    // Ideal transport currents.
    const cbe = this.isT * (ebe - 1);
    const gbeI = (this.isT * ebe) / (m.nf * vt);
    const cbc = this.isT * (ebc - 1);
    const gbcI = (this.isT * ebc) / (m.nr * vt);

    // Non-ideal base leakage.
    const cle = m.ise * m.area * (ex(vbe, m.ne) - 1);
    const gle = (m.ise * m.area * ex(vbe, m.ne)) / (m.ne * vt);
    const clc = m.isc * m.area * (ex(vbc, m.nc) - 1);
    const glc = (m.isc * m.area * ex(vbc, m.nc)) / (m.nc * vt);

    // Base charge factor: Early effect and high-injection.
    const q1 = 1 / (1 - vbc / m.vaf - vbe / m.var);
    const q2 = (isFinite(m.ikf) ? cbe / m.ikf : 0) + (isFinite(m.ikr) ? cbc / m.ikr : 0);
    let qb, dqbdvbe, dqbdvbc;
    if (q2 <= 0) {
      qb = q1;
      dqbdvbe = (q1 * q1) / m.var;
      dqbdvbc = (q1 * q1) / m.vaf;
    } else {
      const sqarg = Math.sqrt(1 + 4 * q2);
      qb = (q1 * (1 + sqarg)) / 2;
      dqbdvbe = q1 * (qb / m.var + (isFinite(m.ikf) ? gbeI / (m.ikf * sqarg) : 0));
      dqbdvbc = q1 * (qb / m.vaf + (isFinite(m.ikr) ? gbcI / (m.ikr * sqarg) : 0));
    }

    const ict = (cbe - cbc) / qb;
    const gmf = gbeI / qb - (ict / qb) * dqbdvbe;
    const gmr = -gbcI / qb - (ict / qb) * dqbdvbc;

    const ib = cbe / this.bfT + cle + cbc / this.brT + clc;
    const gpi = gbeI / this.bfT + gle;
    const gmu = gbcI / this.brT + glc;

    return { ict, gmf, gmr, ib, gpi, gmu, cbe, cbc, gbeI, gbcI, qb };
  }

  loadDC(ctx) {
    const s = this.sign;
    const [c, b, e] = this.nodes;
    let vbe, vbc;
    if (ctx.initJunction) {
      vbe = 0.7; vbc = 0;
    } else {
      vbe = s * (ctx.v(b) - ctx.v(e));
      vbc = s * (ctx.v(b) - ctx.v(c));
    }
    this.vbe = vbe;
    this.vbc = vbc;

    const r = this._evaluate(ctx, vbe, vbc);
    this.op = r;
    this.ic = s * r.ict;
    this.ib = s * r.ib;

    const gpi = r.gpi + ctx.gmin;
    const gmu = r.gmu + ctx.gmin;
    const gmf = r.gmf;
    const gmr = r.gmr;
    const ict = r.ict;
    const ib = r.ib;

    const M = ctx.sys;
    M.add(this.h.bb, gpi + gmu);
    M.add(this.h.be, -gpi);
    M.add(this.h.bc, -gmu);

    M.add(this.h.cb, -gmu + gmf + gmr);
    M.add(this.h.cc, gmu - gmr);
    M.add(this.h.ce, -gmf);

    M.add(this.h.eb, -gpi - gmf - gmr);
    M.add(this.h.ec, gmr);
    M.add(this.h.ee, gpi + gmf);

    const ceqbe = ict - gmf * vbe - gmr * vbc;
    const ceqbc = ib - gpi * vbe - gmu * vbc;
    ctx.rhs(b, -s * ceqbc);
    ctx.rhs(c, -s * ceqbe);
    ctx.rhs(e, s * (ceqbe + ceqbc));

    this._charges(ctx, vbe, vbc, r);
  }

  _charges(ctx, vbe, vbc, r) {
    const m = this.m;
    const [qje, cje] = junctionCharge(vbe, m.cje * m.area, m.vje, m.mje, m.fc);
    const [qjc, cjc] = junctionCharge(vbc, m.cjc * m.area * m.xcjc, m.vjc, m.mjc, m.fc);
    this.qbe = qje + m.tf * r.cbe;
    this.cbeTot = cje + m.tf * r.gbeI;
    this.qbc = qjc + m.tr * r.cbc;
    this.cbcTot = cjc + m.tr * r.gbcI;
  }

  loadTran(ctx) {
    this.loadDC(ctx);
    const s = this.sign;
    const [c, b, e] = this.nodes;
    const st = ctx.state.at(0);
    const off = this.stateOff;

    st[off] = this.qbe;
    ctx.integrate(off, this.cbeTot, this.vbe);
    const gbeC = ctx.geq;
    const ibeC = ctx.ieq;

    st[off + 2] = this.qbc;
    ctx.integrate(off + 2, this.cbcTot, this.vbc);
    const gbcC = ctx.geq;
    const ibcC = ctx.ieq;

    const M = ctx.sys;
    M.add(this.h.bb, gbeC + gbcC);
    M.add(this.h.be, -gbeC);
    M.add(this.h.bc, -gbcC);
    M.add(this.h.eb, -gbeC);
    M.add(this.h.ee, gbeC);
    M.add(this.h.cb, -gbcC);
    M.add(this.h.cc, gbcC);

    ctx.rhs(b, -s * (ibeC + ibcC));
    ctx.rhs(e, s * ibeC);
    ctx.rhs(c, s * ibcC);
  }

  loadAC(ctx) {
    const [c, b, e] = this.nodes;
    const r = this.op;
    const w = ctx.omega;
    const M = ctx.sys;
    const gpi = r.gpi;
    const gmu = r.gmu;
    const bpi = w * this.cbeTot;
    const bmu = w * this.cbcTot;

    M.addComplex(this.h.bb, gpi + gmu, bpi + bmu);
    M.addComplex(this.h.be, -gpi, -bpi);
    M.addComplex(this.h.bc, -gmu, -bmu);
    M.addComplex(this.h.cb, -gmu + r.gmf + r.gmr, -bmu);
    M.addComplex(this.h.cc, gmu - r.gmr, bmu);
    M.addComplex(this.h.ce, -r.gmf, 0);
    M.addComplex(this.h.eb, -gpi - r.gmf - r.gmr, -bpi);
    M.addComplex(this.h.ec, r.gmr, 0);
    M.addComplex(this.h.ee, gpi + r.gmf, bpi);
  }

  checkConvergence(ctx) {
    const s = this.sign;
    const [c, b, e] = this.nodes;
    const vbe = s * (ctx.v(b) - ctx.v(e));
    const vbc = s * (ctx.v(b) - ctx.v(c));
    const tol = ctx.reltol * Math.max(Math.abs(vbe), Math.abs(this.vbe)) + ctx.vntol;
    if (Math.abs(vbe - this.vbe) > tol || Math.abs(vbc - this.vbc) > tol) {
      ctx.deviceConverged = false;
    }
  }
}
