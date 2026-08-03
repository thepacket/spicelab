//! Nonlinear semiconductor devices. Port of `src/core/devices/semiconductors.js`.
//!
//! Each device follows the same shape: compute currents and their derivatives at
//! the present iterate, compute junction and diffusion charges, hand the charges
//! to the integrator, then stamp a linearized companion model. AC reuses the
//! conductances and capacitances left behind by the last DC load, which is why
//! an `.ac` run always requires an operating point first.

use crate::context::Context;
use crate::device::{Common, DeviceOps, NoiseSource};
use crate::limiting::{junction_critical, pnj_limit};
use crate::sparse::SparseSystem;
use std::f64::consts::E;

const Q: f64 = 1.602176634e-19;
const K: f64 = 1.380649e-23;

/// Junction charge for an abrupt/graded junction, with the standard linearized
/// extension above `fc * vj` that keeps the model differentiable.
/// Returns (charge, capacitance).
fn junction_charge(v: f64, cjo: f64, vj: f64, m: f64, fc: f64) -> (f64, f64) {
    if cjo == 0.0 {
        return (0.0, 0.0);
    }
    if v < fc * vj {
        let arg = 1.0 - v / vj;
        let q = (cjo * vj * (1.0 - arg.powf(1.0 - m))) / (1.0 - m);
        let c = cjo * arg.powf(-m);
        return (q, c);
    }
    let f1 = (vj * (1.0 - (1.0 - fc).powf(1.0 - m))) / (1.0 - m);
    let f2 = (1.0 - fc).powf(1.0 + m);
    let f3 = 1.0 - fc * (1.0 + m);
    let q = cjo
        * (f1
            + (1.0 / f2)
                * (f3 * (v - fc * vj) + (m / (2.0 * vj)) * (v * v - (fc * vj) * (fc * vj))));
    let c = (cjo / f2) * (f3 + (m * v) / vj);
    (q, c)
}

#[derive(Clone, Debug)]
pub struct DiodeModel {
    pub is: f64,
    pub n: f64,
    pub rs: f64,
    pub cjo: f64,
    pub vj: f64,
    pub m: f64,
    pub tt: f64,
    pub bv: f64,
    pub ibv: f64,
    pub eg: f64,
    pub xti: f64,
    pub fc: f64,
    pub kf: f64,
    pub af: f64,
    pub area: f64,
}

impl Default for DiodeModel {
    fn default() -> Self {
        DiodeModel {
            is: 1e-14,
            n: 1.0,
            rs: 0.0,
            cjo: 0.0,
            vj: 1.0,
            m: 0.5,
            tt: 0.0,
            bv: f64::INFINITY,
            ibv: 1e-3,
            eg: 1.11,
            xti: 3.0,
            fc: 0.5,
            kf: 0.0,
            af: 1.0,
            area: 1.0,
        }
    }
}

pub struct Diode {
    pub c: Common,
    pub m: DiodeModel,
    // temperature-adjusted parameters
    is_t: f64,
    vj_t: f64,
    cjo_t: f64,
    vcrit: f64,
    // operating point
    pub vd: f64,
    pub id: f64,
    pub gd: f64,
    pub cd: f64,
    pub qd: f64,
    gs: f64,
    h: [i32; 4],
    h_rs: [i32; 3],
}

impl Diode {
    /// `nodes` are [anode, cathode].
    pub fn new(name: &str, p: i32, n: i32, m: DiodeModel) -> Self {
        Diode {
            c: Common::new(name, vec![p, n]),
            m,
            is_t: 1e-14,
            vj_t: 1.0,
            cjo_t: 0.0,
            vcrit: 0.6,
            vd: 0.0,
            id: 0.0,
            gd: 0.0,
            cd: 0.0,
            qd: 0.0,
            gs: 0.0,
            h: [-1; 4],
            h_rs: [-1; 3],
        }
    }

    /// The junction anode: the internal node when `rs > 0`, else the terminal.
    #[inline]
    fn a(&self) -> i32 {
        match self.c.internals.first() {
            Some(&i) => i,
            None => self.c.nodes[0],
        }
    }

    #[inline]
    fn has_rs(&self) -> bool {
        !self.c.internals.is_empty()
    }

    /// Current and conductance at the present junction voltage.
    fn evaluate(&self, ctx: &Context, vd: f64) -> (f64, f64) {
        let m = &self.m;
        let vt = m.n * ctx.vt();
        let (id, gd);
        if vd >= -3.0 * vt {
            let e = (vd / vt).min(40.0).exp();
            id = self.is_t * (e - 1.0);
            gd = (self.is_t * e) / vt;
        } else if vd > -m.bv {
            let arg = (3.0 * vt) / (vd * E);
            let a3 = arg * arg * arg;
            id = -self.is_t * (1.0 + a3);
            gd = (self.is_t * 3.0 * a3) / vd;
        } else {
            let e = (-(m.bv + vd) / vt).exp();
            id = -m.ibv * e;
            gd = (m.ibv * e) / vt;
        }
        (id + vd * ctx.gmin, gd + ctx.gmin)
    }
}

impl DeviceOps for Diode {
    fn common(&self) -> &Common {
        &self.c
    }
    fn common_mut(&mut self) -> &mut Common {
        &mut self.c
    }
    fn is_nonlinear(&self) -> bool {
        true
    }
    /// [charge, current]
    fn n_states(&self) -> usize {
        2
    }
    fn n_internal(&self) -> usize {
        if self.m.rs > 0.0 {
            1
        } else {
            0
        }
    }

    fn temperature(&mut self, ctx: &Context) {
        let m = &self.m;
        let t = ctx.temp;
        let tnom = ctx.nom_temp;
        let vt = (K * t) / Q;
        let ratio = t / tnom;
        let eg_nom = m.eg;
        self.is_t = m.is
            * m.area
            * (((ratio - 1.0) * eg_nom) / (m.n * vt) + (m.xti / m.n) * ratio.ln()).exp();
        self.vj_t = m.vj * ratio - 3.0 * vt * ratio.ln() - eg_nom * (ratio - 1.0);
        self.cjo_t =
            m.cjo * m.area * (1.0 + m.m * (400e-6 * (t - tnom) - (self.vj_t - m.vj) / m.vj));
        self.vcrit = junction_critical(self.is_t, m.n * vt);
    }

    fn reserve(&self, sys: &mut SparseSystem) {
        let (p, n) = (self.c.nodes[0], self.c.nodes[1]);
        let a = self.a();
        sys.reserve(a, a);
        sys.reserve(a, n);
        sys.reserve(n, a);
        sys.reserve(n, n);
        if self.has_rs() {
            sys.reserve(p, p);
            sys.reserve(p, a);
            sys.reserve(a, p);
        }
    }

    fn bind(&mut self, sys: &SparseSystem) {
        let (p, n) = (self.c.nodes[0], self.c.nodes[1]);
        let a = self.a();
        self.h = [
            sys.handle(a, a),
            sys.handle(a, n),
            sys.handle(n, a),
            sys.handle(n, n),
        ];
        if self.has_rs() {
            self.h_rs = [sys.handle(p, p), sys.handle(p, a), sys.handle(a, p)];
            self.gs = 1.0 / (self.m.rs / self.m.area);
        }
    }

    fn limit(&mut self, ctx: &mut Context) {
        let vt = self.m.n * ctx.vt();
        let a = self.a();
        let vnew = ctx.v(a) - ctx.v(self.c.nodes[1]);
        let (v, changed) = pnj_limit(vnew, self.vd, vt, self.vcrit);
        if changed {
            ctx.limited = true;
            let delta = v - vnew;
            if a >= 0 {
                ctx.x[a as usize] += delta;
            }
        }
    }

    fn load_dc(&mut self, ctx: &mut Context) {
        let a = self.a();
        let n = self.c.nodes[1];
        let vd = if ctx.init_junction {
            0.6
        } else {
            ctx.v(a) - ctx.v(n)
        };
        let (id, gd) = self.evaluate(ctx, vd);
        self.vd = vd;
        self.id = id;
        self.gd = gd;

        ctx.sys.add(self.h[0], gd);
        ctx.sys.add(self.h[1], -gd);
        ctx.sys.add(self.h[2], -gd);
        ctx.sys.add(self.h[3], gd);
        let ieq = id - gd * vd;
        ctx.rhs(a, -ieq);
        ctx.rhs(n, ieq);

        if self.has_rs() {
            ctx.sys.add(self.h_rs[0], self.gs);
            ctx.sys.add(self.h_rs[1], -self.gs);
            ctx.sys.add(self.h_rs[2], -self.gs);
            ctx.sys.add(self.h[0], self.gs);
        }

        // Charge is computed even in DC so that .ac has capacitances available.
        let (qj, cj) = junction_charge(vd, self.cjo_t, self.vj_t, self.m.m, self.m.fc);
        self.qd = qj + self.m.tt * id;
        self.cd = cj + self.m.tt * gd;
    }

    fn load_tran(&mut self, ctx: &mut Context) {
        self.load_dc(ctx);
        let a = self.a();
        let n = self.c.nodes[1];
        let off = self.c.state_off;
        ctx.state.at_mut(0)[off] = self.qd;
        ctx.integrate(off, self.cd, self.vd);
        let (geq, ieq) = (ctx.geq, ctx.ieq);
        ctx.sys.add(self.h[0], geq);
        ctx.sys.add(self.h[1], -geq);
        ctx.sys.add(self.h[2], -geq);
        ctx.sys.add(self.h[3], geq);
        ctx.rhs(a, -ieq);
        ctx.rhs(n, ieq);
    }

    fn load_ac(&mut self, ctx: &mut Context) {
        let g = self.gd;
        let b = ctx.omega * self.cd;
        ctx.sys.add_complex(self.h[0], g, b);
        ctx.sys.add_complex(self.h[1], -g, -b);
        ctx.sys.add_complex(self.h[2], -g, -b);
        ctx.sys.add_complex(self.h[3], g, b);
        if self.has_rs() {
            ctx.sys.add_complex(self.h_rs[0], self.gs, 0.0);
            ctx.sys.add_complex(self.h_rs[1], -self.gs, 0.0);
            ctx.sys.add_complex(self.h_rs[2], -self.gs, 0.0);
            ctx.sys.add_complex(self.h[0], self.gs, 0.0);
        }
    }

    fn check_convergence(&mut self, ctx: &mut Context) {
        let vd = ctx.v(self.a()) - ctx.v(self.c.nodes[1]);
        let (id, _) = self.evaluate(ctx, vd);
        let tol = ctx.reltol * id.abs().max(self.id.abs()) + ctx.abstol;
        if (id - self.id).abs() > tol {
            ctx.device_converged = false;
        }
    }

    fn load_noise(&self, _ctx: &Context, out: &mut Vec<NoiseSource>) {
        out.push(NoiseSource {
            device: self.c.name.clone(),
            kind: "shot",
            nodes: [self.a(), self.c.nodes[1]],
            psd: 2.0 * Q * self.id.abs(),
        });
        if self.m.kf > 0.0 {
            out.push(NoiseSource {
                device: self.c.name.clone(),
                kind: "flicker",
                nodes: [self.a(), self.c.nodes[1]],
                psd: self.m.kf * self.id.abs().powf(self.m.af),
            });
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BjtType {
    Npn,
    Pnp,
}

#[derive(Clone, Debug)]
pub struct BjtModel {
    pub kind: BjtType,
    pub is: f64,
    pub bf: f64,
    pub nf: f64,
    pub vaf: f64,
    pub ikf: f64,
    pub ise: f64,
    pub ne: f64,
    pub br: f64,
    pub nr: f64,
    pub var: f64,
    pub ikr: f64,
    pub isc: f64,
    pub nc: f64,
    pub rb: f64,
    pub re: f64,
    pub rc: f64,
    pub cje: f64,
    pub vje: f64,
    pub mje: f64,
    pub cjc: f64,
    pub vjc: f64,
    pub mjc: f64,
    pub xcjc: f64,
    pub tf: f64,
    pub tr: f64,
    pub fc: f64,
    pub eg: f64,
    pub xti: f64,
    pub xtb: f64,
    pub area: f64,
    pub kf: f64,
    pub af: f64,
}

impl Default for BjtModel {
    fn default() -> Self {
        BjtModel {
            kind: BjtType::Npn,
            is: 1e-16,
            bf: 100.0,
            nf: 1.0,
            vaf: f64::INFINITY,
            ikf: f64::INFINITY,
            ise: 0.0,
            ne: 1.5,
            br: 1.0,
            nr: 1.0,
            var: f64::INFINITY,
            ikr: f64::INFINITY,
            isc: 0.0,
            nc: 2.0,
            rb: 0.0,
            re: 0.0,
            rc: 0.0,
            cje: 0.0,
            vje: 0.75,
            mje: 0.33,
            cjc: 0.0,
            vjc: 0.75,
            mjc: 0.33,
            xcjc: 1.0,
            tf: 0.0,
            tr: 0.0,
            fc: 0.5,
            eg: 1.11,
            xti: 3.0,
            xtb: 0.0,
            area: 1.0,
            kf: 0.0,
            af: 1.0,
        }
    }
}

#[derive(Clone, Copy, Default)]
struct BjtOp {
    ict: f64,
    gmf: f64,
    gmr: f64,
    ib: f64,
    gpi: f64,
    gmu: f64,
    cbe: f64,
    cbc: f64,
    gbe_i: f64,
    gbc_i: f64,
}

/// Gummel-Poon bipolar transistor.
///
/// Includes forward and reverse Early effect, high-injection knee, and
/// non-ideal base leakage. Base resistance modulation (irb/rbm) is not
/// modelled; everything else in the standard parameter set is.
pub struct Bjt {
    pub c: Common,
    pub m: BjtModel,
    sign: f64,
    is_t: f64,
    bf_t: f64,
    br_t: f64,
    vcrit: f64,
    pub vbe: f64,
    pub vbc: f64,
    pub ic: f64,
    pub ib: f64,
    op: BjtOp,
    qbe: f64,
    qbc: f64,
    cbe_tot: f64,
    cbc_tot: f64,
    /// Indexed [row][col] over the INTRINSIC (c, b, e) nodes = (0, 1, 2).
    h: [[i32; 3]; 3],
    /// Series ohmic resistance stamps, one set per non-zero rb / re / rc.
    /// Each entry is (terminal, internal, conductance, four handles).
    ohmic: Vec<(i32, i32, f64, [i32; 4])>,
}

impl Bjt {
    /// `nodes` are [collector, base, emitter, substrate].
    pub fn new(name: &str, c: i32, b: i32, e: i32, s: i32, m: BjtModel) -> Self {
        let sign = if m.kind == BjtType::Pnp { -1.0 } else { 1.0 };
        Bjt {
            c: Common::new(name, vec![c, b, e, s]),
            m,
            sign,
            is_t: 1e-16,
            bf_t: 100.0,
            br_t: 1.0,
            vcrit: 0.7,
            vbe: 0.0,
            vbc: 0.0,
            ic: 0.0,
            ib: 0.0,
            op: BjtOp::default(),
            qbe: 0.0,
            qbc: 0.0,
            cbe_tot: 0.0,
            cbc_tot: 0.0,
            h: [[-1; 3]; 3],
            ohmic: Vec::new(),
        }
    }

    /// Which ohmic resistances this model asks for, in the order internal nodes
    /// are allocated: base, emitter, collector.
    ///
    /// Only non-zero resistances get an internal node. A model with `rb=0`
    /// should not pay for an extra unknown, and more importantly the intrinsic
    /// node must then BE the terminal so nothing is inserted in series.
    #[inline]
    fn ohmic_spec(&self) -> [(usize, f64); 3] {
        [(1, self.m.rb), (2, self.m.re), (0, self.m.rc)]
    }

    /// Intrinsic node for terminal `t` (0 = c, 1 = b, 2 = e): the internal node
    /// if this terminal has a series resistance, otherwise the terminal itself.
    #[inline]
    fn inner(&self, t: usize) -> i32 {
        let mut k = 0;
        for (term, r) in self.ohmic_spec() {
            if r > 0.0 {
                if term == t {
                    return self.c.internals.get(k).copied().unwrap_or(self.c.nodes[t]);
                }
                k += 1;
            }
        }
        self.c.nodes[t]
    }

    /// Stamp the series ohmic resistances. Linear, so identical in every mode.
    fn stamp_ohmic(&self, sys: &mut SparseSystem) {
        for (_, _, g, h) in &self.ohmic {
            crate::device::stamp2(sys, h, *g);
        }
    }

    fn stamp_ohmic_ac(&self, sys: &mut SparseSystem) {
        for (_, _, g, h) in &self.ohmic {
            crate::device::stamp2c(sys, h, *g, 0.0);
        }
    }

    fn evaluate(&self, ctx: &Context, vbe: f64, vbc: f64) -> BjtOp {
        let m = &self.m;
        let vt = ctx.vt();
        let ex = |v: f64, nn: f64| (v / (nn * vt)).min(40.0).exp();

        let ebe = ex(vbe, m.nf);
        let ebc = ex(vbc, m.nr);

        // Ideal transport currents.
        let cbe = self.is_t * (ebe - 1.0);
        let gbe_i = (self.is_t * ebe) / (m.nf * vt);
        let cbc = self.is_t * (ebc - 1.0);
        let gbc_i = (self.is_t * ebc) / (m.nr * vt);

        // Non-ideal base leakage.
        let cle = m.ise * m.area * (ex(vbe, m.ne) - 1.0);
        let gle = (m.ise * m.area * ex(vbe, m.ne)) / (m.ne * vt);
        let clc = m.isc * m.area * (ex(vbc, m.nc) - 1.0);
        let glc = (m.isc * m.area * ex(vbc, m.nc)) / (m.nc * vt);

        // Base charge factor: Early effect and high-injection.
        let q1 = 1.0 / (1.0 - vbc / m.vaf - vbe / m.var);
        let q2 = (if m.ikf.is_finite() { cbe / m.ikf } else { 0.0 })
            + (if m.ikr.is_finite() { cbc / m.ikr } else { 0.0 });
        let (qb, dqbdvbe, dqbdvbc);
        if q2 <= 0.0 {
            qb = q1;
            dqbdvbe = (q1 * q1) / m.var;
            dqbdvbc = (q1 * q1) / m.vaf;
        } else {
            let sqarg = (1.0 + 4.0 * q2).sqrt();
            qb = (q1 * (1.0 + sqarg)) / 2.0;
            dqbdvbe = q1
                * (qb / m.var
                    + if m.ikf.is_finite() {
                        gbe_i / (m.ikf * sqarg)
                    } else {
                        0.0
                    });
            dqbdvbc = q1
                * (qb / m.vaf
                    + if m.ikr.is_finite() {
                        gbc_i / (m.ikr * sqarg)
                    } else {
                        0.0
                    });
        }

        let ict = (cbe - cbc) / qb;
        let gmf = gbe_i / qb - (ict / qb) * dqbdvbe;
        let gmr = -gbc_i / qb - (ict / qb) * dqbdvbc;

        let ib = cbe / self.bf_t + cle + cbc / self.br_t + clc;
        let gpi = gbe_i / self.bf_t + gle;
        let gmu = gbc_i / self.br_t + glc;

        BjtOp {
            ict,
            gmf,
            gmr,
            ib,
            gpi,
            gmu,
            cbe,
            cbc,
            gbe_i,
            gbc_i,
        }
    }

    /// Forward transconductance at the last operating point. Exposed so tests
    /// can check small-signal gain against `gm * Rout` without recomputing the
    /// Gummel-Poon base charge.
    pub fn gmf(&self) -> f64 {
        self.op.gmf
    }

    /// Output conductance contribution from the Early effect at the last
    /// operating point.
    pub fn gmr(&self) -> f64 {
        self.op.gmr
    }

    fn charges(&mut self, vbe: f64, vbc: f64, r: &BjtOp) {
        let m = &self.m;
        let (qje, cje) = junction_charge(vbe, m.cje * m.area, m.vje, m.mje, m.fc);
        let (qjc, cjc) = junction_charge(vbc, m.cjc * m.area * m.xcjc, m.vjc, m.mjc, m.fc);
        self.qbe = qje + m.tf * r.cbe;
        self.cbe_tot = cje + m.tf * r.gbe_i;
        self.qbc = qjc + m.tr * r.cbc;
        self.cbc_tot = cjc + m.tr * r.gbc_i;
    }
}

impl DeviceOps for Bjt {
    fn common(&self) -> &Common {
        &self.c
    }
    fn common_mut(&mut self) -> &mut Common {
        &mut self.c
    }
    fn is_nonlinear(&self) -> bool {
        true
    }
    /// [qbe, ibe, qbc, ibc]
    fn n_states(&self) -> usize {
        4
    }

    /// One internal node per non-zero ohmic resistance.
    ///
    /// These matter more than they look: a real BJT card almost always
    /// specifies rb/re/rc, and omitting them shifts Vbe by the IR drop —
    /// about 2.5 mV on a general-purpose part at a few mA, which is a 0.4%
    /// error that no closed-form test would catch. It showed up immediately
    /// against ngspice.
    fn n_internal(&self) -> usize {
        self.ohmic_spec().iter().filter(|(_, r)| *r > 0.0).count()
    }

    fn temperature(&mut self, ctx: &Context) {
        let m = &self.m;
        let t = ctx.temp;
        let ratio = t / ctx.nom_temp;
        let vt = (K * t) / Q;
        self.is_t =
            m.is * m.area * (((ratio - 1.0) * m.eg) / vt + m.xti * ratio.ln()).exp();
        self.bf_t = m.bf * ratio.powf(m.xtb);
        self.br_t = m.br * ratio.powf(m.xtb);
        self.vcrit = junction_critical(self.is_t, m.nf * vt);
    }

    fn reserve(&self, sys: &mut SparseSystem) {
        // The intrinsic transistor sits between the INNER nodes.
        let t = [self.inner(0), self.inner(1), self.inner(2)];
        for &i in &t {
            for &j in &t {
                sys.reserve(i, j);
            }
        }
        // Each series resistance is a two-terminal conductance from the package
        // terminal to its inner node.
        for (term, r) in self.ohmic_spec() {
            if r > 0.0 {
                crate::device::reserve2(sys, self.c.nodes[term], self.inner(term));
            }
        }
    }

    fn bind(&mut self, sys: &SparseSystem) {
        let t = [self.inner(0), self.inner(1), self.inner(2)];
        for i in 0..3 {
            for j in 0..3 {
                self.h[i][j] = sys.handle(t[i], t[j]);
            }
        }
        self.ohmic.clear();
        for (term, r) in self.ohmic_spec() {
            if r > 0.0 {
                let outer = self.c.nodes[term];
                let inner = self.inner(term);
                self.ohmic.push((
                    outer,
                    inner,
                    1.0 / (r / self.m.area),
                    crate::device::bind2(sys, outer, inner),
                ));
            }
        }
    }


    fn limit(&mut self, ctx: &mut Context) {
        let (c, b, e) = (self.inner(0), self.inner(1), self.inner(2));
        let vt = ctx.vt();
        let s = self.sign;
        let vbe = s * (ctx.v(b) - ctx.v(e));
        let vbc = s * (ctx.v(b) - ctx.v(c));
        let (nbe, ch1) = pnj_limit(vbe, self.vbe, self.m.nf * vt, self.vcrit);
        let (nbc, ch2) = pnj_limit(vbc, self.vbc, self.m.nr * vt, self.vcrit);
        if ch1 || ch2 {
            ctx.limited = true;
            // Move the base node so both junctions land on their limited values.
            if b >= 0 {
                ctx.x[b as usize] += s * ((nbe - vbe) + (nbc - vbc)) / 2.0;
            }
            if e >= 0 {
                ctx.x[e as usize] -= s * (nbe - vbe) / 2.0;
            }
            if c >= 0 {
                ctx.x[c as usize] -= s * (nbc - vbc) / 2.0;
            }
        }
    }

    fn load_dc(&mut self, ctx: &mut Context) {
        let s = self.sign;
        let (c, b, e) = (self.inner(0), self.inner(1), self.inner(2));
        let (vbe, vbc) = if ctx.init_junction {
            (0.7, 0.0)
        } else {
            (
                s * (ctx.v(b) - ctx.v(e)),
                s * (ctx.v(b) - ctx.v(c)),
            )
        };
        self.vbe = vbe;
        self.vbc = vbc;

        let r = self.evaluate(ctx, vbe, vbc);
        self.op = r;
        self.ic = s * r.ict;
        self.ib = s * r.ib;

        let gpi = r.gpi + ctx.gmin;
        let gmu = r.gmu + ctx.gmin;
        let (gmf, gmr, ict, ib) = (r.gmf, r.gmr, r.ict, r.ib);

        let m = &mut ctx.sys;
        m.add(self.h[1][1], gpi + gmu);
        m.add(self.h[1][2], -gpi);
        m.add(self.h[1][0], -gmu);

        m.add(self.h[0][1], -gmu + gmf + gmr);
        m.add(self.h[0][0], gmu - gmr);
        m.add(self.h[0][2], -gmf);

        m.add(self.h[2][1], -gpi - gmf - gmr);
        m.add(self.h[2][0], gmr);
        m.add(self.h[2][2], gpi + gmf);

        let ceqbe = ict - gmf * vbe - gmr * vbc;
        let ceqbc = ib - gpi * vbe - gmu * vbc;
        ctx.rhs(b, -s * ceqbc);
        ctx.rhs(c, -s * ceqbe);
        ctx.rhs(e, s * (ceqbe + ceqbc));

        self.stamp_ohmic(&mut ctx.sys);
        self.charges(vbe, vbc, &r);
    }

    fn load_tran(&mut self, ctx: &mut Context) {
        self.load_dc(ctx);
        let s = self.sign;
        let (c, b, e) = (self.inner(0), self.inner(1), self.inner(2));
        let off = self.c.state_off;

        ctx.state.at_mut(0)[off] = self.qbe;
        ctx.integrate(off, self.cbe_tot, self.vbe);
        let (gbe_c, ibe_c) = (ctx.geq, ctx.ieq);

        ctx.state.at_mut(0)[off + 2] = self.qbc;
        ctx.integrate(off + 2, self.cbc_tot, self.vbc);
        let (gbc_c, ibc_c) = (ctx.geq, ctx.ieq);

        let m = &mut ctx.sys;
        m.add(self.h[1][1], gbe_c + gbc_c);
        m.add(self.h[1][2], -gbe_c);
        m.add(self.h[1][0], -gbc_c);
        m.add(self.h[2][1], -gbe_c);
        m.add(self.h[2][2], gbe_c);
        m.add(self.h[0][1], -gbc_c);
        m.add(self.h[0][0], gbc_c);

        ctx.rhs(b, -s * (ibe_c + ibc_c));
        ctx.rhs(e, s * ibe_c);
        ctx.rhs(c, s * ibc_c);
    }

    fn load_ac(&mut self, ctx: &mut Context) {
        self.stamp_ohmic_ac(&mut ctx.sys);
        let r = self.op;
        let w = ctx.omega;
        let gpi = r.gpi;
        let gmu = r.gmu;
        let bpi = w * self.cbe_tot;
        let bmu = w * self.cbc_tot;
        let m = &mut ctx.sys;

        m.add_complex(self.h[1][1], gpi + gmu, bpi + bmu);
        m.add_complex(self.h[1][2], -gpi, -bpi);
        m.add_complex(self.h[1][0], -gmu, -bmu);
        m.add_complex(self.h[0][1], -gmu + r.gmf + r.gmr, -bmu);
        m.add_complex(self.h[0][0], gmu - r.gmr, bmu);
        m.add_complex(self.h[0][2], -r.gmf, 0.0);
        m.add_complex(self.h[2][1], -gpi - r.gmf - r.gmr, -bpi);
        m.add_complex(self.h[2][0], r.gmr, 0.0);
        m.add_complex(self.h[2][2], gpi + r.gmf, bpi);
    }

    fn check_convergence(&mut self, ctx: &mut Context) {
        let s = self.sign;
        let (c, b, e) = (self.inner(0), self.inner(1), self.inner(2));
        let vbe = s * (ctx.v(b) - ctx.v(e));
        let vbc = s * (ctx.v(b) - ctx.v(c));
        let tol = ctx.reltol * vbe.abs().max(self.vbe.abs()) + ctx.vntol;
        if (vbe - self.vbe).abs() > tol || (vbc - self.vbc).abs() > tol {
            ctx.device_converged = false;
        }
    }
}
