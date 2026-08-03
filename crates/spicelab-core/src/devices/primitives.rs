//! Linear primitives: R, C, L, K, and the four controlled sources.
//! Port of `src/core/devices/primitives.js`.
//!
//! Stamp conventions everything else follows:
//!   `nodes[0]` = positive terminal, current flows in at `nodes[0]`.
//!   `branches[]` holds indices of extra unknowns owned by this device.

use crate::context::Context;
use crate::device::{bind2, reserve2, stamp2, stamp2c, Common, DeviceOps, NoiseSource};
use crate::sparse::SparseSystem;

const BOLTZMANN: f64 = 1.380649e-23;

pub struct Resistor {
    pub c: Common,
    pub r: f64,
    pub tc1: f64,
    pub tc2: f64,
    g: f64,
    h: [i32; 4],
}

impl Resistor {
    pub fn new(name: &str, p: i32, n: i32, r: f64) -> Self {
        Resistor {
            c: Common::new(name, vec![p, n]),
            r,
            tc1: 0.0,
            tc2: 0.0,
            g: 1.0 / r,
            h: [-1; 4],
        }
    }
}

impl DeviceOps for Resistor {
    fn common(&self) -> &Common {
        &self.c
    }
    fn common_mut(&mut self) -> &mut Common {
        &mut self.c
    }

    fn temperature(&mut self, ctx: &Context) {
        let dt = ctx.temp - ctx.nom_temp;
        let r_eff = self.r * (1.0 + self.tc1 * dt + self.tc2 * dt * dt);
        self.g = 1.0 / r_eff;
    }

    fn reserve(&self, sys: &mut SparseSystem) {
        reserve2(sys, self.c.nodes[0], self.c.nodes[1]);
    }
    fn bind(&mut self, sys: &SparseSystem) {
        self.h = bind2(sys, self.c.nodes[0], self.c.nodes[1]);
    }
    fn load_dc(&mut self, ctx: &mut Context) {
        stamp2(&mut ctx.sys, &self.h, self.g);
    }

    fn load_noise(&self, ctx: &Context, out: &mut Vec<NoiseSource>) {
        // Johnson noise: 4kTG A^2/Hz, injected between the terminals.
        out.push(NoiseSource {
            device: self.c.name.clone(),
            kind: "thermal",
            nodes: [self.c.nodes[0], self.c.nodes[1]],
            psd: 4.0 * BOLTZMANN * ctx.temp * self.g,
        });
    }
}

pub struct Capacitor {
    pub c: Common,
    pub cap: f64,
    /// Initial condition, applied when `uic` is set.
    pub ic: Option<f64>,
    h: [i32; 4],
}

impl Capacitor {
    pub fn new(name: &str, p: i32, n: i32, cap: f64) -> Self {
        Capacitor {
            c: Common::new(name, vec![p, n]),
            cap,
            ic: None,
            h: [-1; 4],
        }
    }
}

impl DeviceOps for Capacitor {
    fn common(&self) -> &Common {
        &self.c
    }
    fn common_mut(&mut self) -> &mut Common {
        &mut self.c
    }
    /// [charge, current]
    fn n_states(&self) -> usize {
        2
    }

    fn reserve(&self, sys: &mut SparseSystem) {
        reserve2(sys, self.c.nodes[0], self.c.nodes[1]);
    }
    fn bind(&mut self, sys: &SparseSystem) {
        self.h = bind2(sys, self.c.nodes[0], self.c.nodes[1]);
    }

    fn load_dc(&mut self, ctx: &mut Context) {
        // Open circuit at DC. gmin across the branch keeps the matrix
        // nonsingular when a capacitor is the only element on a node.
        let g = ctx.gmin;
        stamp2(&mut ctx.sys, &self.h, g);
    }

    fn load_tran(&mut self, ctx: &mut Context) {
        let (p, n) = (self.c.nodes[0], self.c.nodes[1]);
        let v = ctx.v(p) - ctx.v(n);
        let off = self.c.state_off;
        ctx.state.at_mut(0)[off] = self.cap * v;
        ctx.integrate(off, self.cap, v);
        let (geq, ieq) = (ctx.geq, ctx.ieq);
        stamp2(&mut ctx.sys, &self.h, geq);
        ctx.rhs(p, -ieq);
        ctx.rhs(n, ieq);
    }

    fn load_ac(&mut self, ctx: &mut Context) {
        let b = ctx.omega * self.cap;
        stamp2c(&mut ctx.sys, &self.h, 0.0, b);
    }
}

/// A mutual-inductance coupling, resolved to a concrete branch index during
/// topology build. `K<name> L1 L2 <coefficient>` creates one of these on each
/// of the two inductors.
#[derive(Clone)]
pub struct Couple {
    /// Index of the coupled inductor in `Circuit::devices`.
    pub other_dev: usize,
    /// Mutual inductance, `k * sqrt(l1 * l2)`.
    pub m: f64,
    /// Branch index of the coupled inductor. Filled in by `build_topology`.
    pub other_branch: usize,
}

pub struct Inductor {
    pub c: Common,
    pub l: f64,
    pub ic: Option<f64>,
    pub couples: Vec<Couple>,
    h_pb: i32,
    h_nb: i32,
    h_bp: i32,
    h_bn: i32,
    h_bb: i32,
    h_mut: Vec<i32>,
}

impl Inductor {
    pub fn new(name: &str, p: i32, n: i32, l: f64) -> Self {
        Inductor {
            c: Common::new(name, vec![p, n]),
            l,
            ic: None,
            couples: Vec::new(),
            h_pb: -1,
            h_nb: -1,
            h_bp: -1,
            h_bn: -1,
            h_bb: -1,
            h_mut: Vec::new(),
        }
    }

    fn stamp_topology(&self, sys: &mut SparseSystem) {
        sys.add(self.h_pb, 1.0);
        sys.add(self.h_nb, -1.0);
        sys.add(self.h_bp, 1.0);
        sys.add(self.h_bn, -1.0);
    }
}

impl DeviceOps for Inductor {
    fn common(&self) -> &Common {
        &self.c
    }
    fn common_mut(&mut self) -> &mut Common {
        &mut self.c
    }
    fn n_branches(&self) -> usize {
        1
    }
    /// [flux, voltage]
    fn n_states(&self) -> usize {
        2
    }

    fn reserve(&self, sys: &mut SparseSystem) {
        let (p, n) = (self.c.nodes[0], self.c.nodes[1]);
        let b = self.c.branches[0] as i32;
        sys.reserve(p, b);
        sys.reserve(n, b);
        sys.reserve(b, p);
        sys.reserve(b, n);
        sys.reserve(b, b);
        for c in &self.couples {
            sys.reserve(b, c.other_branch as i32);
        }
    }

    fn bind(&mut self, sys: &SparseSystem) {
        let (p, n) = (self.c.nodes[0], self.c.nodes[1]);
        let b = self.c.branches[0] as i32;
        self.h_pb = sys.handle(p, b);
        self.h_nb = sys.handle(n, b);
        self.h_bp = sys.handle(b, p);
        self.h_bn = sys.handle(b, n);
        self.h_bb = sys.handle(b, b);
        self.h_mut = self
            .couples
            .iter()
            .map(|c| sys.handle(b, c.other_branch as i32))
            .collect();
    }

    fn load_dc(&mut self, ctx: &mut Context) {
        // A short at DC: V(p) - V(n) = 0.
        self.stamp_topology(&mut ctx.sys);
    }

    fn load_tran(&mut self, ctx: &mut Context) {
        let b = self.c.branches[0];
        let i = ctx.x[b];
        let mut flux = self.l * i;
        for c in &self.couples {
            flux += c.m * ctx.x[c.other_branch];
        }
        let off = self.c.state_off;
        ctx.state.at_mut(0)[off] = flux;
        ctx.integrate(off, self.l, i);

        self.stamp_topology(&mut ctx.sys);
        let (geq, mut ieq) = (ctx.geq, ctx.ieq);
        ctx.sys.add(self.h_bb, -geq);

        // ctx.ieq already folds in the mutual flux through the charge state, so
        // the linear mutual term is subtracted out of the RHS as it is added to
        // the matrix. `scale` converts dq/dv = L into the method's coefficient
        // (L/dt for BE).
        let scale = geq / self.l;
        for (k, c) in self.couples.iter().enumerate() {
            let gm = scale * c.m;
            ctx.sys.add(self.h_mut[k], -gm);
            ieq -= gm * ctx.x[c.other_branch];
        }
        ctx.rhs(b as i32, ieq);
    }

    fn load_ac(&mut self, ctx: &mut Context) {
        self.stamp_topology(&mut ctx.sys);
        let w = ctx.omega;
        ctx.sys.add_complex(self.h_bb, 0.0, -w * self.l);
        for (k, c) in self.couples.iter().enumerate() {
            ctx.sys.add_complex(self.h_mut[k], 0.0, -w * c.m);
        }
    }
}

pub struct Vcvs {
    pub c: Common,
    pub gain: f64,
    h: [i32; 6],
}

impl Vcvs {
    pub fn new(name: &str, p: i32, n: i32, cp: i32, cn: i32, gain: f64) -> Self {
        Vcvs {
            c: Common::new(name, vec![p, n, cp, cn]),
            gain,
            h: [-1; 6],
        }
    }
}

impl DeviceOps for Vcvs {
    fn common(&self) -> &Common {
        &self.c
    }
    fn common_mut(&mut self) -> &mut Common {
        &mut self.c
    }
    fn n_branches(&self) -> usize {
        1
    }

    fn reserve(&self, sys: &mut SparseSystem) {
        let (p, n, cp, cn) = (
            self.c.nodes[0],
            self.c.nodes[1],
            self.c.nodes[2],
            self.c.nodes[3],
        );
        let b = self.c.branches[0] as i32;
        sys.reserve(p, b);
        sys.reserve(n, b);
        sys.reserve(b, p);
        sys.reserve(b, n);
        sys.reserve(b, cp);
        sys.reserve(b, cn);
    }

    fn bind(&mut self, sys: &SparseSystem) {
        let (p, n, cp, cn) = (
            self.c.nodes[0],
            self.c.nodes[1],
            self.c.nodes[2],
            self.c.nodes[3],
        );
        let b = self.c.branches[0] as i32;
        self.h = [
            sys.handle(p, b),
            sys.handle(n, b),
            sys.handle(b, p),
            sys.handle(b, n),
            sys.handle(b, cp),
            sys.handle(b, cn),
        ];
    }

    fn load_dc(&mut self, ctx: &mut Context) {
        let s = &mut ctx.sys;
        s.add(self.h[0], 1.0);
        s.add(self.h[1], -1.0);
        s.add(self.h[2], 1.0);
        s.add(self.h[3], -1.0);
        s.add(self.h[4], -self.gain);
        s.add(self.h[5], self.gain);
    }
}

pub struct Vccs {
    pub c: Common,
    pub gm: f64,
    h: [i32; 4],
}

impl Vccs {
    pub fn new(name: &str, p: i32, n: i32, cp: i32, cn: i32, gm: f64) -> Self {
        Vccs {
            c: Common::new(name, vec![p, n, cp, cn]),
            gm,
            h: [-1; 4],
        }
    }
}

impl DeviceOps for Vccs {
    fn common(&self) -> &Common {
        &self.c
    }
    fn common_mut(&mut self) -> &mut Common {
        &mut self.c
    }

    fn reserve(&self, sys: &mut SparseSystem) {
        let (p, n, cp, cn) = (
            self.c.nodes[0],
            self.c.nodes[1],
            self.c.nodes[2],
            self.c.nodes[3],
        );
        sys.reserve(p, cp);
        sys.reserve(p, cn);
        sys.reserve(n, cp);
        sys.reserve(n, cn);
    }

    fn bind(&mut self, sys: &SparseSystem) {
        let (p, n, cp, cn) = (
            self.c.nodes[0],
            self.c.nodes[1],
            self.c.nodes[2],
            self.c.nodes[3],
        );
        self.h = [
            sys.handle(p, cp),
            sys.handle(p, cn),
            sys.handle(n, cp),
            sys.handle(n, cn),
        ];
    }

    fn load_dc(&mut self, ctx: &mut Context) {
        let s = &mut ctx.sys;
        s.add(self.h[0], self.gm);
        s.add(self.h[1], -self.gm);
        s.add(self.h[2], -self.gm);
        s.add(self.h[3], self.gm);
    }
}

/// Current-controlled current source. Control is the branch of a voltage source.
pub struct Cccs {
    pub c: Common,
    pub gain: f64,
    /// Index of the controlling device in `Circuit::devices`.
    pub ctrl_dev: usize,
    /// Branch index of the controlling device, resolved by `build_topology`.
    pub ctrl_branch: usize,
    h: [i32; 2],
}

impl Cccs {
    pub fn new(name: &str, p: i32, n: i32, ctrl_dev: usize, gain: f64) -> Self {
        Cccs {
            c: Common::new(name, vec![p, n]),
            gain,
            ctrl_dev,
            ctrl_branch: 0,
            h: [-1; 2],
        }
    }
}

impl DeviceOps for Cccs {
    fn common(&self) -> &Common {
        &self.c
    }
    fn common_mut(&mut self) -> &mut Common {
        &mut self.c
    }

    fn reserve(&self, sys: &mut SparseSystem) {
        let cb = self.ctrl_branch as i32;
        sys.reserve(self.c.nodes[0], cb);
        sys.reserve(self.c.nodes[1], cb);
    }

    fn bind(&mut self, sys: &SparseSystem) {
        let cb = self.ctrl_branch as i32;
        self.h = [sys.handle(self.c.nodes[0], cb), sys.handle(self.c.nodes[1], cb)];
    }

    fn load_dc(&mut self, ctx: &mut Context) {
        ctx.sys.add(self.h[0], self.gain);
        ctx.sys.add(self.h[1], -self.gain);
    }
}

/// Current-controlled voltage source.
pub struct Ccvs {
    pub c: Common,
    pub gain: f64,
    pub ctrl_dev: usize,
    pub ctrl_branch: usize,
    h: [i32; 5],
}

impl Ccvs {
    pub fn new(name: &str, p: i32, n: i32, ctrl_dev: usize, gain: f64) -> Self {
        Ccvs {
            c: Common::new(name, vec![p, n]),
            gain,
            ctrl_dev,
            ctrl_branch: 0,
            h: [-1; 5],
        }
    }
}

impl DeviceOps for Ccvs {
    fn common(&self) -> &Common {
        &self.c
    }
    fn common_mut(&mut self) -> &mut Common {
        &mut self.c
    }
    fn n_branches(&self) -> usize {
        1
    }

    fn reserve(&self, sys: &mut SparseSystem) {
        let (p, n) = (self.c.nodes[0], self.c.nodes[1]);
        let b = self.c.branches[0] as i32;
        let cb = self.ctrl_branch as i32;
        sys.reserve(p, b);
        sys.reserve(n, b);
        sys.reserve(b, p);
        sys.reserve(b, n);
        sys.reserve(b, cb);
    }

    fn bind(&mut self, sys: &SparseSystem) {
        let (p, n) = (self.c.nodes[0], self.c.nodes[1]);
        let b = self.c.branches[0] as i32;
        self.h = [
            sys.handle(p, b),
            sys.handle(n, b),
            sys.handle(b, p),
            sys.handle(b, n),
            sys.handle(b, self.ctrl_branch as i32),
        ];
    }

    fn load_dc(&mut self, ctx: &mut Context) {
        let s = &mut ctx.sys;
        s.add(self.h[0], 1.0);
        s.add(self.h[1], -1.0);
        s.add(self.h[2], 1.0);
        s.add(self.h[3], -1.0);
        s.add(self.h[4], -self.gain);
    }
}

#[derive(Clone, Debug)]
pub struct SwitchModel {
    pub vt: f64,
    pub vh: f64,
    pub ron: f64,
    pub roff: f64,
}

impl Default for SwitchModel {
    fn default() -> Self {
        SwitchModel {
            vt: 0.0,
            vh: 0.0,
            ron: 1.0,
            roff: 1e12,
        }
    }
}

/// Voltage-controlled switch with hysteresis.
///
/// Both switch states stamp the same two-terminal pattern, so the reserved
/// pattern is already the union and a state flip never forces re-analysis.
pub struct VSwitch {
    pub c: Common,
    pub m: SwitchModel,
    pub on: bool,
    h: [i32; 4],
}

impl VSwitch {
    pub fn new(name: &str, p: i32, n: i32, cp: i32, cn: i32, m: SwitchModel) -> Self {
        VSwitch {
            c: Common::new(name, vec![p, n, cp, cn]),
            m,
            on: false,
            h: [-1; 4],
        }
    }
}

impl DeviceOps for VSwitch {
    fn common(&self) -> &Common {
        &self.c
    }
    fn common_mut(&mut self) -> &mut Common {
        &mut self.c
    }
    fn is_nonlinear(&self) -> bool {
        true
    }

    fn reserve(&self, sys: &mut SparseSystem) {
        reserve2(sys, self.c.nodes[0], self.c.nodes[1]);
    }
    fn bind(&mut self, sys: &SparseSystem) {
        self.h = bind2(sys, self.c.nodes[0], self.c.nodes[1]);
    }

    fn load_dc(&mut self, ctx: &mut Context) {
        let vc = ctx.v(self.c.nodes[2]) - ctx.v(self.c.nodes[3]);
        if vc > self.m.vt + self.m.vh {
            self.on = true;
        } else if vc < self.m.vt - self.m.vh {
            self.on = false;
        }
        let g = 1.0 / if self.on { self.m.ron } else { self.m.roff };
        stamp2(&mut ctx.sys, &self.h, g);
    }
}
