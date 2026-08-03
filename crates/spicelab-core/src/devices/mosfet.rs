//! MOSFET Level 1 (Shichman-Hodges) with body effect, channel-length
//! modulation and Meyer gate capacitances. Port of `src/core/devices/mosfet.js`.
//!
//! Level 1 is not accurate enough for submicron design and is not trying to be.
//! It is accurate enough for discrete power MOSFETs, switch models and teaching,
//! and it shares its terminal handling and charge structure with higher levels,
//! so adding Level 2/3 later means adding a current equation rather than
//! restructuring the device.
//!
//! Terminals are indexed d=0, g=1, s=2, b=3 throughout. The JS oracle addresses
//! the handle map with letter pairs ("dg", "sb"); the indices here are the same
//! map with the string concatenation removed from the hot path.

use crate::context::Context;
use crate::device::{Common, DeviceOps};
use crate::limiting::{fet_limit, junction_critical, lim_vds};
use crate::sparse::SparseSystem;

const CHARGE: f64 = 1.6021918e-19;
const EPS_SIL: f64 = 11.7 * 8.854214871e-12;

const D: usize = 0;
const G: usize = 1;
const S: usize = 2;
const B: usize = 3;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MosType {
    Nmos,
    Pmos,
}

#[derive(Clone, Debug)]
pub struct MosModel {
    pub kind: MosType,
    /// 1 = Shichman-Hodges, 3 = the semi-empirical short-channel model.
    pub level: u32,
    pub vto: f64,
    pub kp: f64,
    pub gamma: f64,
    pub phi: f64,
    pub lambda: f64,
    pub rd: f64,
    pub rs: f64,
    pub is: f64,
    pub js: f64,
    pub cbd: f64,
    pub cbs: f64,
    pub pb: f64,
    pub cgso: f64,
    pub cgdo: f64,
    pub cgbo: f64,
    pub cj: f64,
    pub mj: f64,
    pub cjsw: f64,
    pub mjsw: f64,
    pub fc: f64,
    /// Oxide thickness, m. **Zero means "not stated"**, not "infinitely thin":
    /// at Level 1 that leaves the intrinsic gate capacitance out entirely and
    /// only the overlaps remain, which is what SPICE3f5 and ngspice do. Level 3
    /// defaults it to 1e-7 instead. See `temperature`.
    pub tox: f64,
    pub l: f64,
    pub w: f64,
    pub ad: f64,
    pub as_: f64,
    pub pd: f64,
    pub ps: f64,
    pub nrd: f64,
    pub nrs: f64,
    /// Diffusion sheet resistance, ohm/square. With `nrd`/`nrs` this is the
    /// alternative way a process card states `rd`/`rs`; an explicit `rd`/`rs`
    /// wins.
    pub rsh: f64,
    pub kf: f64,
    pub af: f64,

    // ---- Level 3 only ----------------------------------------------------
    /// Substrate doping, cm^-3. Sets `alpha` and hence the depletion width,
    /// which both the short-channel and channel-length-modulation terms need.
    pub nsub: f64,
    /// Metallurgical junction depth, m. Drives the short-channel `fshort`.
    pub xj: f64,
    /// Lateral diffusion, m. Shortens the effective channel.
    pub ld: f64,
    /// Surface mobility, cm^2/Vs. Only used to derive `kp` when kp is absent.
    pub uo: f64,
    /// Maximum drift velocity, m/s. Zero disables velocity saturation.
    pub vmax: f64,
    /// Mobility degradation with gate field, 1/V.
    pub theta: f64,
    /// Static feedback (DIBL): threshold lowering with vds.
    pub eta: f64,
    /// Saturation field factor for channel-length modulation.
    pub kappa: f64,
    /// Narrow-width threshold correction.
    pub delta: f64,
    /// Fast surface state density, cm^-2. Non-zero enables subthreshold.
    pub nfs: f64,
}

impl Default for MosModel {
    fn default() -> Self {
        MosModel {
            kind: MosType::Nmos,
            vto: 1.0,
            kp: 2e-5,
            gamma: 0.0,
            phi: 0.6,
            lambda: 0.0,
            rd: 0.0,
            rs: 0.0,
            is: 1e-14,
            js: 0.0,
            cbd: 0.0,
            cbs: 0.0,
            pb: 0.8,
            cgso: 0.0,
            cgdo: 0.0,
            cgbo: 0.0,
            cj: 0.0,
            mj: 0.5,
            cjsw: 0.0,
            mjsw: 0.33,
            fc: 0.5,
            tox: 0.0,
            l: 1e-4,
            w: 1e-4,
            ad: 0.0,
            as_: 0.0,
            pd: 0.0,
            ps: 0.0,
            nrd: 0.0,
            nrs: 0.0,
            rsh: 0.0,
            kf: 0.0,
            af: 1.0,
            // Level 3 defaults, matching ngspice mos3set.c.
            nsub: 0.0,
            xj: 0.0,
            ld: 0.0,
            uo: 600.0,
            vmax: 0.0,
            theta: 0.0,
            eta: 0.0,
            kappa: 0.2,
            delta: 0.0,
            nfs: 0.0,
            level: 1,
        }
    }
}

/// Depletion-capacitance constants for one bulk junction.
///
/// `cz` is the bottom (area) term and `czsw` the sidewall (perimeter) term;
/// they have different grading coefficients, which is the only reason they are
/// carried separately. `f2`/`f3`/`f4` are the forward-bias linearisation, whose
/// derivation is in `new` below.
#[derive(Clone, Copy, Default)]
struct JuncCap {
    cz: f64,
    czsw: f64,
    mj: f64,
    mjsw: f64,
    pb: f64,
    depcap: f64,
    f2: f64,
    f3: f64,
    f4: f64,
}

impl JuncCap {
    /// Charge of a graded junction, `q(v) = integral of cz*(1 - v/pb)^-m`.
    /// Written out because `m == 1` is a removable singularity, not an error.
    #[inline]
    fn grade_q(cz: f64, pb: f64, m: f64, arg: f64) -> f64 {
        if (1.0 - m).abs() < 1e-9 {
            -cz * pb * arg.ln()
        } else {
            cz * pb * (1.0 - arg.powf(1.0 - m)) / (1.0 - m)
        }
    }

    fn new(cz: f64, czsw: f64, pb: f64, mj: f64, mjsw: f64, fc: f64) -> Self {
        let mut j = JuncCap {
            cz,
            czsw,
            mj,
            mjsw,
            pb,
            ..Default::default()
        };
        if cz == 0.0 && czsw == 0.0 {
            return j;
        }
        // Above fc*pb the depletion formula diverges at v = pb, so SPICE
        // replaces it with the tangent line taken at the crossover — c(v) is
        // linear there, hence q(v) quadratic. f2/f3 are that line's value and
        // slope, f4 the integration constant that makes q continuous at fc*pb.
        j.depcap = fc * pb;
        let arg = 1.0 - fc;
        let sarg = arg.powf(-mj);
        let sargsw = arg.powf(-mjsw);
        j.f2 = cz * (1.0 - fc * (1.0 + mj)) * sarg / arg
            + czsw * (1.0 - fc * (1.0 + mjsw)) * sargsw / arg;
        j.f3 = cz * mj * sarg / arg / pb + czsw * mjsw * sargsw / arg / pb;
        j.f4 = Self::grade_q(cz, pb, mj, arg)
            + Self::grade_q(czsw, pb, mjsw, arg)
            - j.f3 / 2.0 * j.depcap * j.depcap
            - j.depcap * j.f2;
        j
    }

    #[inline]
    fn active(&self) -> bool {
        self.cz != 0.0 || self.czsw != 0.0
    }

    /// Stored charge and small-signal capacitance at bulk-to-diffusion `v`.
    fn eval(&self, v: f64) -> (f64, f64) {
        if !self.active() {
            return (0.0, 0.0);
        }
        if v < self.depcap {
            let arg = 1.0 - v / self.pb;
            (
                Self::grade_q(self.cz, self.pb, self.mj, arg)
                    + Self::grade_q(self.czsw, self.pb, self.mjsw, arg),
                self.cz * arg.powf(-self.mj) + self.czsw * arg.powf(-self.mjsw),
            )
        } else {
            (
                self.f4 + v * (self.f2 + v * self.f3 / 2.0),
                self.f2 + self.f3 * v,
            )
        }
    }
}

#[derive(Clone, Copy, Default)]
struct MosOp {
    id: f64,
    gm: f64,
    gds: f64,
    gmbs: f64,
    vth: f64,
    /// Saturation voltage. The Meyer capacitance model is written in terms of
    /// it, so it has to come out of the current equation rather than be
    /// re-derived: at Level 3 it is not `vgs - vth`.
    vdsat: f64,
}

pub struct Mosfet {
    pub c: Common,
    pub m: MosModel,
    sign: f64,
    cox: f64,
    beta: f64,
    // Level 3 derived constants, computed once in `temperature`.
    l3_beta: f64,
    l3_alpha: f64,
    l3_narrow: f64,
    l3_vbi: f64,
    l3_surf_mob: f64,
    #[allow(dead_code)]
    vcrit: f64,
    pub vgs: f64,
    pub vds: f64,
    pub vbs: f64,
    vgs_e: f64,
    vds_e: f64,
    vbs_e: f64,
    reversed: bool,
    op: MosOp,
    pub id: f64,
    cgs: f64,
    cgd: f64,
    cgb: f64,
    /// Half the non-constant Meyer capacitance at THIS timepoint; the other
    /// half comes from the previous one. ngspice's convention, see `qmeyer`.
    hgs: f64,
    hgd: f64,
    hgb: f64,
    /// Indexed [row][col] over the INTRINSIC (d, g, s, b) nodes.
    h: [[i32; 4]; 4],
    /// Series drain/source ohmic resistance: (conductance, four handles).
    ohmic: Vec<(f64, [i32; 4])>,
    /// Bulk-source and bulk-drain junction operating point.
    gbs: f64,
    ibs: f64,
    gbd: f64,
    ibd: f64,
    /// Bulk junction depletion capacitance, and its operating point.
    jbs: JuncCap,
    jbd: JuncCap,
    capbs: f64,
    qbs: f64,
    capbd: f64,
    qbd: f64,
    /// Physical (sign-mirrored, un-swapped) bulk-to-source/drain voltages.
    vbs_p: f64,
    vbd_p: f64,
}

impl Mosfet {
    /// `nodes` are [drain, gate, source, bulk].
    pub fn new(name: &str, d: i32, g: i32, s: i32, b: i32, m: MosModel) -> Self {
        let sign = if m.kind == MosType::Pmos { -1.0 } else { 1.0 };
        Mosfet {
            c: Common::new(name, vec![d, g, s, b]),
            m,
            sign,
            cox: 0.0,
            beta: 0.0,
            l3_beta: 0.0,
            l3_alpha: 0.0,
            l3_narrow: 0.0,
            l3_vbi: 0.0,
            l3_surf_mob: 0.0,
            vcrit: 0.6,
            vgs: 0.0,
            vds: 0.0,
            vbs: 0.0,
            vgs_e: 0.0,
            vds_e: 0.0,
            vbs_e: 0.0,
            reversed: false,
            op: MosOp::default(),
            id: 0.0,
            cgs: 0.0,
            cgd: 0.0,
            cgb: 0.0,
            hgs: 0.0,
            hgd: 0.0,
            hgb: 0.0,
            h: [[-1; 4]; 4],
            ohmic: Vec::new(),
            gbs: 0.0,
            ibs: 0.0,
            gbd: 0.0,
            ibd: 0.0,
            jbs: JuncCap::default(),
            jbd: JuncCap::default(),
            capbs: 0.0,
            qbs: 0.0,
            capbd: 0.0,
            qbd: 0.0,
            vbs_p: 0.0,
            vbd_p: 0.0,
        }
    }

    /// Bulk-source and bulk-drain junction currents and conductances.
    ///
    /// These are ordinary p-n junctions from the bulk to each diffusion, and
    /// they were absent entirely: with the gate off and the bulk forward biased
    /// to 0.7 V, ngspice conducts 11 mA and this device conducted exactly zero.
    /// It only shows up when the bulk is not tied to the source — which is the
    /// normal case on-chip, and the mechanism behind a power FET's body diode.
    ///
    /// Saturation current is `is` per device, or `js * area` when a current
    /// DENSITY and a diffusion area are both given. Follows ngspice mos1load.c:
    /// below -3*vt the exponential is replaced by a gmin leak, which keeps the
    /// Jacobian well conditioned in deep reverse bias.
    fn bulk_junctions(&mut self, ctx: &Context, vbs: f64, vbd: f64) {
        let m = &self.m;
        let vt = ctx.vt();
        let gmin = ctx.gmin;
        let sat_s = if m.js > 0.0 && m.as_ > 0.0 { m.js * m.as_ } else { m.is };
        let sat_d = if m.js > 0.0 && m.ad > 0.0 { m.js * m.ad } else { m.is };

        let eval = |sat: f64, v: f64| -> (f64, f64) {
            if v <= -3.0 * vt {
                (gmin, gmin * v - sat)
            } else {
                let e = (v / vt).min(40.0).exp();
                (sat * e / vt + gmin, sat * (e - 1.0) + gmin * v)
            }
        };
        let (gbs, ibs) = eval(sat_s, vbs);
        let (gbd, ibd) = eval(sat_d, vbd);
        self.gbs = gbs;
        self.ibs = ibs;
        self.gbd = gbd;
        self.ibd = ibd;
    }

    /// Stamp the two bulk junctions between bulk and the intrinsic drain/source.
    fn stamp_bulk(&self, ctx: &mut Context, vbs: f64, vbd: f64) {
        let n = self.inner_nodes();
        let sgn = self.sign;
        let (gbs, gbd) = (self.gbs, self.gbd);

        ctx.sys.add(self.h[B][B], gbs + gbd);
        ctx.sys.add(self.h[B][S], -gbs);
        ctx.sys.add(self.h[B][D], -gbd);
        ctx.sys.add(self.h[S][B], -gbs);
        ctx.sys.add(self.h[S][S], gbs);
        ctx.sys.add(self.h[D][B], -gbd);
        ctx.sys.add(self.h[D][D], gbd);

        let ceqbs = sgn * (self.ibs - gbs * vbs);
        let ceqbd = sgn * (self.ibd - gbd * vbd);
        ctx.rhs(n[B], -(ceqbs + ceqbd));
        ctx.rhs(n[S], ceqbs);
        ctx.rhs(n[D], ceqbd);
    }

    /// Terminals carrying a series resistance, in internal-node order.
    ///
    /// A process card gives the diffusion resistance either directly as
    /// `rd`/`rs` or as a sheet resistance times a number of squares
    /// (`rsh * nrd`). ngspice prefers the explicit value and falls back to the
    /// sheet form; a card carrying only `rsh`/`nrd` otherwise comes out with no
    /// series resistance at all, which is the same silent IR-drop error that
    /// `rd`/`rs` being unstamped produced.
    #[inline]
    fn ohmic_spec(&self) -> [(usize, f64); 2] {
        let m = &self.m;
        let pick = |r: f64, n: f64| if r > 0.0 { r } else { m.rsh * n };
        [(D, pick(m.rd, m.nrd)), (S, pick(m.rs, m.nrs))]
    }

    /// Intrinsic node for a terminal: the internal node if that terminal has a
    /// series resistance, otherwise the terminal itself.
    ///
    /// Like the BJT's `rb`/`re`/`rc`, `rd` and `rs` were read from the model and
    /// stamped nowhere. Every realistic process card specifies them — the
    /// 74HC-class model here has RS=RD=40 — and omitting them puts the drain
    /// off by Id*(rd+rs), about 68 mV at a milliamp. Diffing against ngspice
    /// found it the moment a real Level 3 card was loaded.
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

    /// The four intrinsic node indices, in (d, g, s, b) order.
    #[inline]
    fn inner_nodes(&self) -> [i32; 4] {
        [
            self.inner(D),
            self.c.nodes[G],
            self.inner(S),
            self.c.nodes[B],
        ]
    }

    fn stamp_ohmic(&self, sys: &mut SparseSystem) {
        for (g, h) in &self.ohmic {
            crate::device::stamp2(sys, h, *g);
        }
    }

    fn stamp_ohmic_ac(&self, sys: &mut SparseSystem) {
        for (g, h) in &self.ohmic {
            crate::device::stamp2c(sys, h, *g, 0.0);
        }
    }

    /// Threshold in the sign-flipped frame the current equations work in.
    ///
    /// A PMOS card states `vto` as a NEGATIVE number, and `load_dc` already
    /// mirrors the terminal voltages so a p-channel device looks n-channel to
    /// the current equation. The threshold has to be mirrored with them — using
    /// the raw `vto` makes a PMOS turn on `2*|vto|` too early, which is exactly
    /// what it did: a level-1 PMOS that ngspice put at -3.000 V sat at -1.127 V
    /// here. Every PMOS in the project was wrong, in both implementations, and
    /// no test caught it because every MOSFET test used an n-channel device.
    #[inline]
    fn vto_eff(&self) -> f64 {
        self.sign * self.m.vto
    }

    /// Shichman-Hodges drain current and its three derivatives.
    fn current(&self, vgs: f64, vds: f64, vbs: f64) -> MosOp {
        let m = &self.m;
        let phi = m.phi;
        let vto = self.vto_eff();
        let mut vth = vto;
        let mut dvthdvb = 0.0;
        if m.gamma != 0.0 {
            let arg = (phi - vbs).max(1e-9);
            vth = vto + m.gamma * (arg.sqrt() - phi.sqrt());
            dvthdvb = -m.gamma / (2.0 * arg.sqrt());
        }
        let vgst = vgs - vth;
        let lam = m.lambda;
        let beta = self.beta;

        if vgst <= 0.0 {
            return MosOp {
                id: 0.0,
                gm: 0.0,
                gds: 0.0,
                gmbs: 0.0,
                vth,
                vdsat: 0.0,
            };
        }

        if vds < vgst {
            // Linear region.
            let f = 1.0 + lam * vds;
            let id = beta * f * (vgst - vds / 2.0) * vds;
            let gm = beta * f * vds;
            let gds = beta * (f * (vgst - vds) + lam * (vgst - vds / 2.0) * vds);
            let gmbs = -gm * dvthdvb;
            return MosOp {
                id,
                gm,
                gds,
                gmbs,
                vth,
                vdsat: vgst,
            };
        }
        // Saturation.
        let f = 1.0 + lam * vds;
        let id = (beta / 2.0) * f * vgst * vgst;
        let gm = beta * f * vgst;
        let gds = (beta / 2.0) * lam * vgst * vgst;
        let gmbs = -gm * dvthdvb;
        MosOp {
            id,
            gm,
            gds,
            gmbs,
            vth,
            vdsat: vgst,
        }
    }


    /// MOSFET Level 3 drain current and its three derivatives.
    ///
    /// The semi-empirical short-channel model. Transcribed from the equations
    /// in ngspice's reference implementation (`src/spicelib/devices/mos3/`,
    /// Modified BSD) so the formulation matches the simulator this is diffed
    /// against; `tests/ngspice-diff.test.mjs` holds it to that.
    ///
    /// The physical effects, in the order they are applied:
    ///
    ///   fshort   short-channel threshold reduction, from xj and ld
    ///   fbody    body effect, plus the narrow-width correction from delta
    ///   eta      static feedback (DIBL): threshold falls with vds
    ///   nfs      weak inversion, blending subthreshold into strong inversion
    ///   theta    mobility degradation by the gate field
    ///   vmax     velocity saturation, which also sets vdsat
    ///   kappa    channel-length modulation via the depletion width alpha
    ///
    /// Every one of those is a multiplicative correction on the Level 1 square
    /// law, which is why a Level 3 card evaluated as Level 1 gives a plausible
    /// but wrong answer rather than an obviously broken one.
    fn current_level3(&self, vgs: f64, vds: f64, vbs: f64, vt: f64) -> MosOp {
        let m = &self.m;
        const COEFF0: f64 = 0.0631353;
        const COEFF1: f64 = 0.8013292;
        const COEFF2: f64 = -0.01110777;

        let leff = (m.l - 2.0 * m.ld).max(1e-9);
        let weff = m.w.max(1e-9);
        let one_over_xl = 1.0 / leff;
        let cox_area = self.cox * weff * leff; // OxideCap
        let mut beta = self.l3_beta;

        // Static feedback coefficient.
        let eta = m.eta * 8.15e-22 / (self.cox * leff * leff * leff);

        // Square-root term, with the standard linearisation for vbs > 0 that
        // keeps it finite when the bulk junction is forward biased.
        let (phibs, sqphbs, dsqdvb);
        if vbs <= 0.0 {
            phibs = m.phi - vbs;
            sqphbs = phibs.sqrt();
            dsqdvb = -0.5 / sqphbs;
        } else {
            let sqphis = m.phi.sqrt();
            let sqphs3 = m.phi * sqphis;
            sqphbs = sqphis / (1.0 + vbs / (m.phi + m.phi));
            phibs = sqphbs * sqphbs;
            dsqdvb = -phibs / (sqphs3 + sqphs3);
        }

        // Short-channel effect: the fraction of bulk charge controlled by the
        // gate rather than by the source/drain junctions.
        let (fshort, dfsdvb);
        if m.xj != 0.0 && self.l3_alpha != 0.0 {
            let coeff_dep = self.l3_alpha.sqrt();
            let wps = coeff_dep * sqphbs;
            let one_over_xj = 1.0 / m.xj;
            let xjonxl = m.xj * one_over_xl;
            let djonxj = m.ld * one_over_xj;
            let wponxj = wps * one_over_xj;
            let wconxj = COEFF0 + COEFF1 * wponxj + COEFF2 * wponxj * wponxj;
            let arga = wconxj + djonxj;
            let argc = wponxj / (1.0 + wponxj);
            let argb = (1.0 - argc * argc).max(0.0).sqrt();
            fshort = 1.0 - xjonxl * (arga * argb - djonxj);
            let dwpdvb = coeff_dep * dsqdvb;
            let dadvb = (COEFF1 + COEFF2 * (wponxj + wponxj)) * dwpdvb * one_over_xj;
            let dbdvb = if argb > 0.0 && wps > 0.0 {
                -argc * argc * (1.0 - argc) * dwpdvb / (argb * wps)
            } else {
                0.0
            };
            dfsdvb = -xjonxl * (dadvb * argb + arga * dbdvb);
        } else {
            fshort = 1.0;
            dfsdvb = 0.0;
        }

        // Body effect, including the narrow-width term.
        let gammas = m.gamma * fshort;
        let fbodys = 0.5 * gammas / (sqphbs + sqphbs);
        let fbody = fbodys + self.l3_narrow / weff;
        let onfbdy = 1.0 / (1.0 + fbody);
        let dfbdvb = -fbodys * dsqdvb / sqphbs
            + if fshort != 0.0 { fbodys * dfsdvb / fshort } else { 0.0 };
        let qbonco = gammas * sqphbs + self.l3_narrow * phibs / weff;
        let dqbdvb = gammas * dsqdvb + m.gamma * dfsdvb * sqphbs - self.l3_narrow / weff;

        // Threshold, with static feedback.
        let vbix = self.l3_vbi - eta * vds;
        let vth = vbix + qbonco;
        let dvtdvd = -eta;
        let dvtdvb = dqbdvb;

        // Weak inversion blend.
        let mut von = vth;
        let mut xn = 1.0;
        let mut dxndvb = 0.0;
        let mut dvodvd = dvtdvd;
        let mut dvodvb = dvtdvb;
        if m.nfs != 0.0 {
            let csonco =
                CHARGE * m.nfs * 1e4 * leff * weff / cox_area;
            let cdonco = qbonco / (phibs + phibs);
            xn = 1.0 + csonco + cdonco;
            von = vth + vt * xn;
            dxndvb = dqbdvb / (phibs + phibs) - qbonco * dsqdvb / (phibs * sqphbs);
            dvodvd = dvtdvd;
            dvodvb = dvtdvb + vt * dxndvb;
        } else if vgs <= von {
            // Hard cutoff when subthreshold conduction is not modelled.
            return MosOp { id: 0.0, gm: 0.0, gds: 0.0, gmbs: 0.0, vth, vdsat: 0.0 };
        }

        let vgsx = vgs.max(von);

        // Mobility modulation by the gate field.
        let onfg = 1.0 + m.theta * (vgsx - vth);
        let fgate = 1.0 / onfg;
        let us = self.l3_surf_mob * fgate;
        let dfgdvg = -m.theta * fgate * fgate;
        let dfgdvd = -dfgdvg * dvtdvd;
        let dfgdvb = -dfgdvg * dvtdvb;

        // Saturation voltage, with velocity saturation if vmax is given.
        let mut vdsat;
        let (dvsdvg, dvsdvd, dvsdvb);
        let mut onvdsc = 0.0;
        if m.vmax <= 0.0 {
            vdsat = (vgsx - vth) * onfbdy;
            dvsdvg = onfbdy;
            dvsdvd = -dvsdvg * dvtdvd;
            dvsdvb = -dvsdvg * dvtdvb - vdsat * dfbdvb * onfbdy;
        } else {
            let vdsc = leff * m.vmax / us;
            onvdsc = 1.0 / vdsc;
            let arga = (vgsx - vth) * onfbdy;
            let argb = (arga * arga + vdsc * vdsc).sqrt();
            vdsat = arga + vdsc - argb;
            let dvsdga = (1.0 - arga / argb) * onfbdy;
            dvsdvg = dvsdga - (1.0 - vdsc / argb) * vdsc * dfgdvg * onfg;
            dvsdvd = -dvsdvg * dvtdvd;
            dvsdvb = -dvsdvg * dvtdvb - arga * dvsdga * dfbdvb;
        }

        let vdsx = vds.min(vdsat);

        // vds == 0 is its own case: no current, but a finite gds.
        if vdsx == 0.0 {
            beta *= fgate;
            let mut gds = beta * (vgsx - vth);
            if m.nfs != 0.0 && vgs < von {
                gds *= ((vgs - von) / (vt * xn)).exp();
            }
            return MosOp { id: 0.0, gm: 0.0, gds, gmbs: 0.0, vth, vdsat };
        }

        // Normalised drain current in the linear region.
        let cdo = vgsx - vth - 0.5 * (1.0 + fbody) * vdsx;
        let dcodvb = -dvtdvb - 0.5 * dfbdvb * vdsx;
        let cdnorm = cdo * vdsx;

        let mut gm = vdsx;
        let mut gds = if vds > vdsat {
            -dvtdvd * vdsx
        } else {
            vgsx - vth - (1.0 + fbody + dvtdvd) * vdsx
        };
        let mut gmbs = dcodvb * vdsx;

        let cd1 = beta * cdnorm;
        beta *= fgate;
        let mut cdrain = beta * cdnorm;
        gm = beta * gm + dfgdvg * cd1;
        gds = beta * gds + dfgdvd * cd1;
        gmbs = beta * gmbs + dfgdvb * cd1;

        // Velocity saturation.
        let mut fdrain = 1.0;
        if m.vmax > 0.0 {
            fdrain = 1.0 / (1.0 + vdsx * onvdsc);
            let fd2 = fdrain * fdrain;
            let arga = fd2 * vdsx * onvdsc * onfg;
            let dfddvg = -dfgdvg * arga;
            let dfddvd = if vds > vdsat {
                -dfgdvd * arga
            } else {
                -dfgdvd * arga - fd2 * onvdsc
            };
            let dfddvb = -dfgdvb * arga;
            gm = fdrain * gm + dfddvg * cdrain;
            gds = fdrain * gds + dfddvd * cdrain;
            gmbs = fdrain * gmbs + dfddvb * cdrain;
            cdrain *= fdrain;
        }

        // Channel-length modulation. Only in saturation, and only when the
        // depletion constant alpha is known (i.e. nsub was given).
        let mut delxl = 0.0;
        let mut ddldvg = 0.0;
        let mut ddldvd = 0.0;
        let mut ddldvb = 0.0;
        let mut dldvd = 0.0;
        let mut apply_clm = false;

        if vds <= vdsat {
            if m.vmax <= 0.0 && self.l3_alpha != 0.0 {
                let arga0 = vds / vdsat;
                delxl = (m.kappa * self.l3_alpha * vdsat / 8.0).sqrt();
                dldvd = 4.0 * delxl * arga0 * arga0 * arga0 / vdsat;
                let mut arga = arga0 * arga0;
                arga *= arga;
                delxl *= arga;
                ddldvd = -dldvd;
                apply_clm = true;
            }
        } else if self.l3_alpha != 0.0 {
            if m.vmax <= 0.0 {
                delxl = (m.kappa * self.l3_alpha * (vds - vdsat + vdsat / 8.0)).sqrt();
                dldvd = 0.5 * delxl / (vds - vdsat + vdsat / 8.0);
                ddldvd = -dldvd;
            } else {
                let cdsat = cdrain;
                let gdsat = (cdsat * (1.0 - fdrain) * onvdsc).max(1.0e-12);
                let gdoncd = gdsat / cdsat;
                let gdonfd = gdsat / (1.0 - fdrain);
                let gdonfg = gdsat * onfg;
                let dfddvg = -dfgdvg * fdrain * fdrain * vdsx * onvdsc * onfg;
                let dfddvd = -dfgdvd * fdrain * fdrain * vdsx * onvdsc * onfg;
                let dfddvb = -dfgdvb * fdrain * fdrain * vdsx * onvdsc * onfg;
                let dgdvg = gdoncd * gm - gdonfd * dfddvg + gdonfg * dfgdvg;
                let dgdvd = gdoncd * gds - gdonfd * dfddvd + gdonfg * dfgdvd;
                let dgdvb = gdoncd * gmbs - gdonfd * dfddvb + gdonfg * dfgdvb;

                let emax = m.kappa * cdsat * one_over_xl / gdsat;
                let emoncd = emax / cdsat;
                let emongd = emax / gdsat;
                let demdvg = emoncd * gm - emongd * dgdvg;
                let demdvd = emoncd * gds - emongd * dgdvd;
                let demdvb = emoncd * gmbs - emongd * dgdvb;

                let arga = 0.5 * emax * self.l3_alpha;
                let argc = m.kappa * self.l3_alpha;
                let argb = (arga * arga + argc * (vds - vdsat)).max(0.0).sqrt();
                delxl = argb - arga;
                let dldem;
                if argb != 0.0 {
                    dldvd = argc / (argb + argb);
                    dldem = 0.5 * (arga / argb - 1.0) * self.l3_alpha;
                } else {
                    dldvd = 0.0;
                    dldem = 0.0;
                }
                ddldvg = dldem * demdvg;
                ddldvd = dldem * demdvd - dldvd;
                ddldvb = dldem * demdvb;
            }
            apply_clm = true;
        }

        let mut gds0 = 0.0;
        if apply_clm {
            // Punch-through: keep the shortened channel physical.
            if delxl > 0.5 * leff {
                delxl = leff - (leff * leff / (4.0 * delxl));
                let arga = 4.0 * (leff - delxl) * (leff - delxl) / (leff * leff);
                ddldvg *= arga;
                ddldvd *= arga;
                ddldvb *= arga;
                dldvd *= arga;
            }
            let dlonxl = delxl * one_over_xl;
            let xlfact = 1.0 / (1.0 - dlonxl);
            cdrain *= xlfact;
            let diddl = cdrain / (leff - delxl);
            gm = gm * xlfact + diddl * ddldvg;
            gmbs = gmbs * xlfact + diddl * ddldvb;
            gds0 = diddl * ddldvd;
            gm += gds0 * dvsdvg;
            gmbs += gds0 * dvsdvb;
            gds = gds * xlfact + diddl * dldvd + gds0 * dvsdvd;
        }

        // Weak inversion tail.
        if m.nfs != 0.0 && vgs < von {
            let onxn = 1.0 / xn;
            let ondvt = onxn / vt;
            let wfact = ((vgs - von) * ondvt).exp();
            cdrain *= wfact;
            let gms = gm * wfact;
            let gmw = cdrain * ondvt;
            gm = gmw;
            if vds > vdsat {
                gm += gds0 * dvsdvg * wfact;
            }
            gds = gds * wfact + (gms - gmw) * dvodvd;
            gmbs = gmbs * wfact + (gms - gmw) * dvodvb - gmw * (vgs - von) * onxn * dxndvb;
        }

        MosOp { id: cdrain, gm, gds, gmbs, vth, vdsat }
    }

    /// Stamp the transconductance model using effective terminal indices.
    fn stamp_core(&self, sys: &mut SparseSystem, dl: usize, sl: usize, r: &MosOp) {
        let (gm, gds, gmbs) = (r.gm, r.gds, r.gmbs);
        sys.add(self.h[dl][dl], gds);
        sys.add(self.h[dl][G], gm);
        sys.add(self.h[dl][sl], -gm - gds - gmbs);
        sys.add(self.h[dl][B], gmbs);
        sys.add(self.h[sl][dl], -gds);
        sys.add(self.h[sl][G], -gm);
        sys.add(self.h[sl][sl], gm + gds + gmbs);
        sys.add(self.h[sl][B], -gmbs);
    }

    /// Meyer gate capacitance, transcribed from ngspice `DEVqmeyer`
    /// (`src/spicelib/devices/devsup.c`, Modified BSD).
    ///
    /// Returns HALF the non-constant capacitance, which is ngspice's convention:
    /// the other half comes from the previous timepoint and the overlaps are
    /// added on top. See `load_tran`.
    ///
    /// This replaced a textbook three-region Meyer expression that jumped
    /// discontinuously at `vgst = 0` — from `(0, 0, cox)` straight to
    /// `(2/3 cox, 0, 0)`. ngspice's form has a transition region and is written
    /// in terms of `vdsat` (clamped below at 25 mV) rather than `vgs - vth`, so
    /// it stays continuous through the point every switching circuit passes
    /// through on every edge. The discontinuous version chattered a p-channel
    /// switch into a timestep collapse.
    fn qmeyer(vgs: f64, vgd: f64, von: f64, vdsat: f64, phi: f64, cox: f64) -> (f64, f64, f64) {
        /// ngspice's MAGIC_VDS: vdsat -> 0 makes the partitioning singular.
        const MAGIC_VDS: f64 = 0.025;
        let vgst = vgs - von;
        let vdsat = vdsat.max(MAGIC_VDS);
        if vgst <= -phi {
            (0.0, 0.0, cox / 2.0)
        } else if vgst <= -phi / 2.0 {
            (0.0, 0.0, -vgst * cox / (2.0 * phi))
        } else if vgst <= 0.0 {
            let capgb = -vgst * cox / (2.0 * phi);
            let capgs0 = vgst * cox / (1.5 * phi) + cox / 3.0;
            let vds = vgs - vgd;
            if vds >= vdsat {
                (capgs0, 0.0, capgb)
            } else {
                let vddif = 2.0 * vdsat - vds;
                let vddif1 = vdsat - vds;
                let vddif2 = vddif * vddif;
                (
                    capgs0 * (1.0 - vddif1 * vddif1 / vddif2),
                    capgs0 * (1.0 - vdsat * vdsat / vddif2),
                    capgb,
                )
            }
        } else {
            let vds = vgs - vgd;
            if vdsat <= vds {
                (cox / 3.0, 0.0, 0.0)
            } else {
                let vddif = 2.0 * vdsat - vds;
                let vddif1 = vdsat - vds;
                let vddif2 = vddif * vddif;
                (
                    cox * (1.0 - vddif1 * vddif1 / vddif2) / 3.0,
                    cox * (1.0 - vdsat * vdsat / vddif2) / 3.0,
                    0.0,
                )
            }
        }
    }

    /// Half-capacitances for this timepoint, mapped onto the physical terminals.
    fn charges(&mut self, vgs: f64, vds: f64, r: &MosOp) {
        let m = &self.m;
        let cox = self.cox * m.w * m.l;
        let vgd = vgs - vds;
        let (hgs, hgd, hgb) = Self::qmeyer(vgs, vgd, r.vth, r.vdsat, m.phi, cox);
        // Map the INTRINSIC channel charge back onto the physical terminals.
        //
        // The values above are in the effective frame, where drain and source
        // have already exchanged roles if vds < 0, and the channel partitioning
        // genuinely does swap with them. The OVERLAPS do not: a gate-drain
        // overlap capacitance is a fixed piece of geometry and stays on the
        // drain whichever way current flows. Adding them before the swap moved
        // cgdo onto the source the instant vds crossed zero — a step change in
        // the Jacobian at a point circuits pass through routinely. It also left
        // `load_ac` (which never swapped) disagreeing with `load_tran` (which
        // did) about where the same capacitance lived. ngspice swaps the
        // `DEVqmeyer` outputs and adds the overlaps afterwards; so does this.
        let (hgs, hgd) = if self.reversed { (hgd, hgs) } else { (hgs, hgd) };
        self.hgs = hgs;
        self.hgd = hgd;
        self.hgb = hgb;
        // Full capacitances for AC and for the first transient point, where
        // there is no previous timepoint to average against.
        self.cgs = 2.0 * hgs + m.cgso * m.w;
        self.cgd = 2.0 * hgd + m.cgdo * m.w;
        self.cgb = 2.0 * hgb + m.cgbo * m.l;
    }
}

impl DeviceOps for Mosfet {
    fn common(&self) -> &Common {
        &self.c
    }
    fn common_mut(&mut self) -> &mut Common {
        &mut self.c
    }
    fn is_nonlinear(&self) -> bool {
        true
    }
    /// Ten integrated slots — [qgs, igs, qgd, igd, qgb, igb, qbs, ibs, qbd,
    /// ibd] — followed by six carried across timepoints but never integrated:
    /// the three Meyer half-capacitances and the three terminal voltages that
    /// `load_tran` needs from the previous timepoint. They live in the state
    /// pool rather than on the struct so a rejected timestep rolls them back
    /// with everything else.
    fn n_states(&self) -> usize {
        16
    }

    fn n_lte_states(&self) -> usize {
        10
    }

    /// One internal node per non-zero drain/source ohmic resistance.
    fn n_internal(&self) -> usize {
        self.ohmic_spec().iter().filter(|(_, r)| *r > 0.0).count()
    }

    fn temperature(&mut self, ctx: &Context) {
        self.vcrit = junction_critical(self.m.is.max(1e-30), ctx.vt());
        // Oxide capacitance per unit area, used for the Meyer model.
        //
        // A Level 1 card that does not state TOX gets NO intrinsic gate
        // capacitance, only the overlaps. That is ngspice's behaviour and
        // SPICE3f5's before it, and defaulting to 1e-7 here instead put an
        // extra cox*W*L on every gate — 13.8 fF on a 20u/2u device, silently
        // present in every transient and AC result and in nothing ngspice
        // computed. Level 3 does default TOX to 1e-7; the asymmetry is real.
        self.cox = if self.m.tox > 0.0 {
            (3.9 * 8.854e-12) / self.m.tox
        } else {
            0.0
        };
        self.beta = self.m.kp * (self.m.w / self.m.l);

        // Bulk junction depletion capacitance. Zero-bias capacitance comes
        // either per-device (`cbd`/`cbs`) or from the per-area `cj` times the
        // diffusion area; the sidewall term is always per-perimeter. Both were
        // parsed and stamped nowhere, so DC was right and every transient and
        // AC result was missing the bulk charge entirely.
        let m = self.m.clone();
        let czd = if m.cbd > 0.0 { m.cbd } else { m.cj * m.ad };
        let czs = if m.cbs > 0.0 { m.cbs } else { m.cj * m.as_ };
        let pb = if m.pb > 0.0 { m.pb } else { 0.8 };
        self.jbd = JuncCap::new(czd, m.cjsw * m.pd, pb, m.mj, m.mjsw, m.fc);
        self.jbs = JuncCap::new(czs, m.cjsw * m.ps, pb, m.mj, m.mjsw, m.fc);

        if self.m.level == 3 {
            let m = &self.m;
            // ngspice uses a slightly more precise oxide permittivity here; use
            // the same one so the two agree to more than plotting accuracy.
            let tox3 = if m.tox > 0.0 { m.tox } else { 1e-7 };
            let cox3 = 3.9 * 8.854214871e-12 / tox3;
            let leff = (m.l - 2.0 * m.ld).max(1e-9);
            // kp defaults to uo * cox when the card does not give it. uo is in
            // cm^2/Vs, hence the 1e-4.
            let kp = if m.kp > 0.0 { m.kp } else { m.uo * cox3 * 1e-4 };
            self.l3_beta = kp * (m.w / leff);
            self.l3_surf_mob = m.uo * 1e-4;
            // alpha is the depletion-width constant; without nsub there is no
            // channel-length modulation and no short-channel correction.
            self.l3_alpha = if m.nsub > 0.0 {
                (EPS_SIL + EPS_SIL) / (CHARGE * m.nsub * 1e6)
            } else {
                0.0
            };
            self.l3_narrow = m.delta * 0.5 * std::f64::consts::PI * EPS_SIL / cox3;
            // Flat-band plus 2*phi, i.e. the long-channel threshold with the
            // bulk-charge term removed (it is added back as qbonco).
            // Same mirroring as Level 1: a PMOS card gives vto negative.
            let vto = if m.kind == MosType::Pmos { -m.vto } else { m.vto };
            let vbi = vto - m.gamma * m.phi.sqrt() - m.phi;
            self.l3_vbi = vbi + m.phi;
            self.cox = cox3;
        }
    }

    fn reserve(&self, sys: &mut SparseSystem) {
        let n = self.inner_nodes();
        for &i in &n {
            for &j in &n {
                sys.reserve(i, j);
            }
        }
        for (term, r) in self.ohmic_spec() {
            if r > 0.0 {
                crate::device::reserve2(sys, self.c.nodes[term], self.inner(term));
            }
        }
    }

    fn bind(&mut self, sys: &SparseSystem) {
        let n = self.inner_nodes();
        for i in 0..4 {
            for j in 0..4 {
                self.h[i][j] = sys.handle(n[i], n[j]);
            }
        }
        self.ohmic.clear();
        for (term, r) in self.ohmic_spec() {
            if r > 0.0 {
                let outer = self.c.nodes[term];
                let inner = self.inner(term);
                self.ohmic
                    .push((1.0 / r, crate::device::bind2(sys, outer, inner)));
            }
        }
    }

    fn limit(&mut self, ctx: &mut Context) {
        let sgn = self.sign;
        let n = self.inner_nodes();
        let (d, g, s) = (n[D], n[G], n[S]);
        let vgs = sgn * (ctx.v(g) - ctx.v(s));
        let vds = sgn * (ctx.v(d) - ctx.v(s));
        let vgd = vgs - vds;
        let vto = self.vto_eff();

        // Limit in whichever frame the device is actually operating in.
        //
        // `lim_vds` refuses to let vds fall below -0.5 V per iteration — it is
        // written for a forward-biased device, where a large negative excursion
        // is a Newton overshoot rather than an answer. Applied unconditionally
        // it makes reverse conduction UNREACHABLE: the drain of a switch being
        // turned off, a body diode, either half of a transmission gate. Newton
        // cannot get past -0.5 V, the step is rejected, and the timestep
        // collapses to a hard convergence error on an entirely ordinary
        // circuit. When vds is already negative, limit the mirrored quantities
        // instead, exactly as ngspice's mos1load does.
        let (ngs, nds, limited) = if self.vds >= 0.0 {
            let (a, c1) = fet_limit(vgs, self.vgs, vto);
            let (b, c2) = lim_vds(a - vgd, self.vds);
            (a, b, c1 || c2)
        } else {
            let (gd, c1) = fet_limit(vgd, self.vgs - self.vds, vto);
            let (b, c2) = lim_vds(-(vgs - gd), -self.vds);
            (gd - b, -b, c1 || c2)
        };
        if limited {
            ctx.limited = true;
            if d >= 0 {
                ctx.x[d as usize] += sgn * (nds - vds);
            }
            if g >= 0 {
                ctx.x[g as usize] += sgn * (ngs - vgs);
            }
        }
    }

    fn load_dc(&mut self, ctx: &mut Context) {
        let sgn = self.sign;
        let n = self.inner_nodes();
        let (d, g, s, b) = (n[D], n[G], n[S], n[B]);
        let (vgs, vds, vbs) = if ctx.init_junction {
            (self.vto_eff() + 0.1, 0.1, 0.0)
        } else {
            (
                sgn * (ctx.v(g) - ctx.v(s)),
                sgn * (ctx.v(d) - ctx.v(s)),
                sgn * (ctx.v(b) - ctx.v(s)),
            )
        };

        // The device is symmetric: if vds < 0 the roles of drain and source swap.
        let reversed = vds < 0.0;
        let vgs_e = if reversed { vgs - vds } else { vgs };
        let vds_e = vds.abs();
        let vbs_e = if reversed { vbs - vds } else { vbs };

        let r = if self.m.level == 3 {
            self.current_level3(vgs_e, vds_e, vbs_e, ctx.vt())
        } else {
            self.current(vgs_e, vds_e, vbs_e)
        };
        self.vgs = vgs;
        self.vds = vds;
        self.vbs = vbs;
        self.op = r;
        self.reversed = reversed;
        self.id = sgn * if reversed { -r.id } else { r.id };

        // Effective terminal orientation. When vds < 0 the physical drain acts
        // as the source, so the stamp is written against swapped indices.
        let (dl, sl) = if reversed { (S, D) } else { (D, S) };
        self.stamp_core(&mut ctx.sys, dl, sl, &r);

        let ceq = r.id - r.gm * vgs_e - r.gds * vds_e - r.gmbs * vbs_e;
        let d_node = if reversed { s } else { d };
        let s_node = if reversed { d } else { s };
        ctx.rhs(d_node, -sgn * ceq);
        ctx.rhs(s_node, sgn * ceq);

        self.stamp_ohmic(&mut ctx.sys);

        // Bulk junctions use the PHYSICAL bulk-to-source and bulk-to-drain
        // voltages, not the swapped effective ones: the junctions do not
        // exchange roles when vds goes negative, the channel does.
        let vbs_p = sgn * (ctx.v(b) - ctx.v(s));
        let vbd_p = sgn * (ctx.v(b) - ctx.v(d));
        self.bulk_junctions(ctx, vbs_p, vbd_p);
        self.stamp_bulk(ctx, vbs_p, vbd_p);
        let (qbs, capbs) = self.jbs.eval(vbs_p);
        let (qbd, capbd) = self.jbd.eval(vbd_p);
        self.qbs = qbs;
        self.capbs = capbs;
        self.qbd = qbd;
        self.capbd = capbd;
        self.vbs_p = vbs_p;
        self.vbd_p = vbd_p;

        self.charges(vgs_e, vds_e, &r);
        self.vgs_e = vgs_e;
        self.vds_e = vds_e;
        self.vbs_e = vbs_e;
    }

    fn load_tran(&mut self, ctx: &mut Context) {
        self.load_dc(ctx);
        let sgn = self.sign;
        let off = self.c.state_off;

        // Meyer gate charge, integrated INCREMENTALLY:
        //
        //     q(t) = q(t-1) + Cavg * (v(t) - v(t-1))
        //
        // rather than as `q = C(v) * v`. The latter is not a charge at all —
        // whenever C moves, the product jumps, so crossing a region boundary
        // injects a current impulse out of nowhere. That is what made the
        // intrinsic Meyer capacitance unusable here: with `tox` given, a
        // switching PMOS drove the timestep to collapse, and refining the
        // timestep made it worse rather than better. Cavg is the mean of this
        // timepoint's half-capacitance and the previous one's, which is exactly
        // what ngspice's "return half, add the other half from last time"
        // convention computes. Same structure as mos1load.c.
        let vgs_t = self.vgs;
        let vgd_t = self.vgs - self.vds;
        let vgb_t = self.vgs - self.vbs;
        let first = ctx.init_transient;
        let (cgs, cgd, cgb, qgs, qgd, qgb) = if first {
            // No previous timepoint: use the full capacitance and seed the
            // charge from the operating point, as SPICE does for MODETRANOP.
            (
                self.cgs,
                self.cgd,
                self.cgb,
                self.cgs * vgs_t,
                self.cgd * vgd_t,
                self.cgb * vgb_t,
            )
        } else {
            let p = ctx.state.at(1);
            let (hgs1, hgd1, hgb1) = (p[off + 10], p[off + 11], p[off + 12]);
            let vgs1 = p[off + 13];
            let vgd1 = vgs1 - p[off + 14];
            let vgb1 = vgs1 - p[off + 15];
            let (qgs1, qgd1, qgb1) = (p[off], p[off + 2], p[off + 4]);
            let cgs = self.hgs + hgs1 + self.m.cgso * self.m.w;
            let cgd = self.hgd + hgd1 + self.m.cgdo * self.m.w;
            let cgb = self.hgb + hgb1 + self.m.cgbo * self.m.l;
            (
                cgs,
                cgd,
                cgb,
                qgs1 + cgs * (vgs_t - vgs1),
                qgd1 + cgd * (vgd_t - vgd1),
                qgb1 + cgb * (vgb_t - vgb1),
            )
        };
        {
            let s0 = ctx.state.at_mut(0);
            s0[off + 10] = self.hgs;
            s0[off + 11] = self.hgd;
            s0[off + 12] = self.hgb;
            s0[off + 13] = self.vgs;
            s0[off + 14] = self.vds;
            s0[off + 15] = self.vbs;
        }

        // Gate capacitances are already mapped onto the physical terminals by
        // `charges`, so these do not swap with `reversed`.
        let pairs = [
            (off, cgs, qgs, G, S, vgs_t),
            (off + 2, cgd, qgd, G, D, vgd_t),
            (off + 4, cgb, qgb, G, B, vgb_t),
            // The bulk junctions do NOT swap when vds goes negative — the
            // channel does — so these use the physical, un-swapped terminals.
            (off + 6, self.capbs, self.qbs, B, S, self.vbs_p),
            (off + 8, self.capbd, self.qbd, B, D, self.vbd_p),
        ];
        for (o, c, q, na, nb, vv) in pairs {
            if c == 0.0 {
                continue;
            }
            ctx.state.at_mut(0)[o] = q;
            ctx.integrate(o, c, vv);
            let (geq, ieq) = (ctx.geq, ctx.ieq);
            ctx.sys.add(self.h[na][na], geq);
            ctx.sys.add(self.h[na][nb], -geq);
            ctx.sys.add(self.h[nb][na], -geq);
            ctx.sys.add(self.h[nb][nb], geq);
            let n = self.inner_nodes();
            let (pa, pb) = (n[na], n[nb]);
            // Charges and voltages are in the sign-mirrored frame the current
            // equations use, so the equivalent CURRENT has to be mirrored back
            // before it reaches the nodes. The conductance does not — it is
            // dq/dv, and both are mirrored. Omitting this leaves a PMOS's
            // displacement current flowing the wrong way, which is the same
            // polarity error that made every PMOS threshold wrong at DC.
            ctx.rhs(pa, -sgn * ieq);
            ctx.rhs(pb, sgn * ieq);
        }
    }

    fn load_ac(&mut self, ctx: &mut Context) {
        self.stamp_ohmic_ac(&mut ctx.sys);
        // Small-signal bulk junction conductances, from the last DC load.
        let (gbs, gbd) = (self.gbs, self.gbd);
        ctx.sys.add_complex(self.h[B][B], gbs + gbd, 0.0);
        ctx.sys.add_complex(self.h[B][S], -gbs, 0.0);
        ctx.sys.add_complex(self.h[B][D], -gbd, 0.0);
        ctx.sys.add_complex(self.h[S][B], -gbs, 0.0);
        ctx.sys.add_complex(self.h[S][S], gbs, 0.0);
        ctx.sys.add_complex(self.h[D][B], -gbd, 0.0);
        ctx.sys.add_complex(self.h[D][D], gbd, 0.0);
        let r = self.op;
        let w = ctx.omega;
        let (gm, gds, gmbs) = (r.gm, r.gds, r.gmbs);
        let sys = &mut ctx.sys;
        sys.add_complex(self.h[D][D], gds, 0.0);
        sys.add_complex(self.h[D][G], gm, 0.0);
        sys.add_complex(self.h[D][S], -gm - gds - gmbs, 0.0);
        sys.add_complex(self.h[D][B], gmbs, 0.0);
        sys.add_complex(self.h[S][D], -gds, 0.0);
        sys.add_complex(self.h[S][G], -gm, 0.0);
        sys.add_complex(self.h[S][S], gm + gds + gmbs, 0.0);
        sys.add_complex(self.h[S][B], -gmbs, 0.0);

        for (na, nb, c) in [
            (G, S, self.cgs),
            (G, D, self.cgd),
            (G, B, self.cgb),
            (B, S, self.capbs),
            (B, D, self.capbd),
        ] {
            if c == 0.0 {
                continue;
            }
            let bsus = w * c;
            sys.add_complex(self.h[na][na], 0.0, bsus);
            sys.add_complex(self.h[na][nb], 0.0, -bsus);
            sys.add_complex(self.h[nb][na], 0.0, -bsus);
            sys.add_complex(self.h[nb][nb], 0.0, bsus);
        }
    }

    fn check_convergence(&mut self, ctx: &mut Context) {
        let sgn = self.sign;
        let n = self.inner_nodes();
        let (d, g, s) = (n[D], n[G], n[S]);
        let vgs = sgn * (ctx.v(g) - ctx.v(s));
        let vds = sgn * (ctx.v(d) - ctx.v(s));
        let tol = ctx.reltol * vgs.abs().max(self.vgs.abs()) + ctx.vntol;
        if (vgs - self.vgs).abs() > tol || (vds - self.vds).abs() > tol {
            ctx.device_converged = false;
        }
    }
}
