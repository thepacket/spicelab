//! Independent voltage and current sources. Port of `src/core/devices/sources.js`.
//!
//! A source carries three independent values: a DC level (operating point and DC
//! sweep), a transient waveform, and an AC magnitude/phase. They are separate on
//! purpose — that is what lets one netlist serve `.op`, `.dc`, `.ac` and `.tran`
//! without editing.
//!
//! Fields whose SPICE default depends on the run (`tstep`, `tstop`) are stored
//! as `Option` and resolved at evaluation time, matching the JS oracle's
//! parameter-default behaviour rather than freezing a default at construction.

use crate::context::{Context, Mode};
use crate::device::{Common, DeviceOps};
use crate::sparse::SparseSystem;
use std::f64::consts::PI;

#[derive(Clone, Debug)]
pub struct AcSpec {
    pub mag: f64,
    pub phase: f64,
}

#[derive(Clone, Debug)]
pub enum Waveform {
    Dc {
        v0: f64,
    },
    Sin {
        vo: f64,
        va: f64,
        /// Defaults to `1 / tstop`.
        freq: Option<f64>,
        td: f64,
        theta: f64,
        phase: f64,
    },
    Pulse {
        v1: f64,
        v2: f64,
        td: f64,
        /// Defaults to `tstep`.
        tr: Option<f64>,
        /// Defaults to `tstep`.
        tf: Option<f64>,
        /// Defaults to `tstop`.
        pw: Option<f64>,
        /// Defaults to `tstop`.
        per: Option<f64>,
    },
    Pwl {
        points: Vec<(f64, f64)>,
        repeat: bool,
        period: f64,
    },
    Exp {
        v1: f64,
        v2: f64,
        td1: f64,
        /// Defaults to `tstep`.
        tau1: Option<f64>,
        /// Defaults to `tstop`.
        td2: Option<f64>,
        /// Defaults to `tstep`.
        tau2: Option<f64>,
    },
    Sffm {
        vo: f64,
        va: f64,
        /// Defaults to `1 / tstop`.
        fc: Option<f64>,
        mdi: f64,
        /// Defaults to `1 / tstop`.
        fs: Option<f64>,
    },
    Am {
        va: f64,
        vo: f64,
        mf: f64,
        /// Defaults to `1 / tstop`.
        fc: Option<f64>,
        td: f64,
    },
}

impl Waveform {
    /// Evaluate the waveform at time `t`.
    pub fn eval(&self, t: f64, tstep: f64, tstop: f64) -> f64 {
        match self {
            Waveform::Dc { v0 } => *v0,

            Waveform::Sin {
                vo,
                va,
                freq,
                td,
                theta,
                phase,
            } => {
                let freq = freq.unwrap_or(1.0 / tstop);
                if t < *td {
                    return vo + va * ((PI / 180.0) * phase).sin();
                }
                let dt = t - td;
                vo + va
                    * (-dt * theta).exp()
                    * (2.0 * PI * freq * dt + (PI / 180.0) * phase).sin()
            }

            Waveform::Pulse {
                v1,
                v2,
                td,
                tr,
                tf,
                pw,
                per,
            } => {
                let tr = tr.unwrap_or(tstep);
                let tf = tf.unwrap_or(tstep);
                let pw = pw.unwrap_or(tstop);
                let per = per.unwrap_or(tstop);
                if t < *td {
                    return *v1;
                }
                let mut x = t - td;
                if per > 0.0 && x >= per {
                    x -= (x / per).floor() * per;
                }
                if x < tr {
                    return v1 + ((v2 - v1) * x) / if tr != 0.0 { tr } else { 1e-300 };
                }
                if x < tr + pw {
                    return *v2;
                }
                if x < tr + pw + tf {
                    return v2
                        + ((v1 - v2) * (x - tr - pw)) / if tf != 0.0 { tf } else { 1e-300 };
                }
                *v1
            }

            Waveform::Pwl {
                points,
                repeat,
                period,
            } => {
                if points.is_empty() {
                    return 0.0;
                }
                let mut x = t;
                if *repeat && *period > 0.0 && x > *period {
                    x -= (x / period).floor() * period;
                }
                if x <= points[0].0 {
                    return points[0].1;
                }
                for i in 1..points.len() {
                    if x <= points[i].0 {
                        let (t0, v0) = points[i - 1];
                        let (t1, v1) = points[i];
                        return if t1 == t0 {
                            v1
                        } else {
                            v0 + ((v1 - v0) * (x - t0)) / (t1 - t0)
                        };
                    }
                }
                points[points.len() - 1].1
            }

            Waveform::Exp {
                v1,
                v2,
                td1,
                tau1,
                td2,
                tau2,
            } => {
                let tau1 = tau1.unwrap_or(tstep);
                let td2 = td2.unwrap_or(tstop);
                let tau2 = tau2.unwrap_or(tstep);
                let mut v = *v1;
                if t > *td1 {
                    v += (v2 - v1) * (1.0 - (-(t - td1) / tau1).exp());
                }
                if t > td2 {
                    v += (v1 - v2) * (1.0 - (-(t - td2) / tau2).exp());
                }
                v
            }

            Waveform::Sffm {
                vo,
                va,
                fc,
                mdi,
                fs,
            } => {
                let fc = fc.unwrap_or(1.0 / tstop);
                let fs = fs.unwrap_or(1.0 / tstop);
                vo + va * (2.0 * PI * fc * t + mdi * (2.0 * PI * fs * t).sin()).sin()
            }

            Waveform::Am {
                va,
                vo,
                mf,
                fc,
                td,
            } => {
                let fc = fc.unwrap_or(1.0 / tstop);
                if t < *td {
                    return 0.0;
                }
                let dt = t - td;
                va * (vo + (2.0 * PI * mf * dt).sin()) * (2.0 * PI * fc * dt).sin()
            }
        }
    }

    /// Times the stepper must land on so an edge is never stepped over.
    pub fn breakpoints(&self, tstop: f64) -> Vec<f64> {
        let mut bp: Vec<f64> = Vec::new();
        match self {
            Waveform::Pulse {
                td, tr, tf, pw, per, ..
            } => {
                let (tr, tf, pw, per) = (
                    tr.unwrap_or(0.0),
                    tf.unwrap_or(0.0),
                    pw.unwrap_or(0.0),
                    per.unwrap_or(0.0),
                );
                if per > 0.0 {
                    let mut t = *td;
                    while t < tstop {
                        bp.extend_from_slice(&[t, t + tr, t + tr + pw, t + tr + pw + tf]);
                        t += per;
                    }
                } else {
                    bp.extend_from_slice(&[*td, td + tr, td + tr + pw, td + tr + pw + tf]);
                }
            }
            Waveform::Pwl {
                points,
                repeat,
                period,
            } => {
                for (t, _) in points {
                    bp.push(*t);
                }
                if *repeat && *period > 0.0 {
                    let mut k = 1.0;
                    while k * period < tstop {
                        for (t, _) in points {
                            bp.push(t + k * period);
                        }
                        k += 1.0;
                    }
                }
            }
            Waveform::Exp { td1, td2, .. } => {
                bp.push(*td1);
                bp.push(td2.unwrap_or(0.0));
            }
            Waveform::Sin { td, .. } => bp.push(*td),
            _ => {}
        }
        bp.retain(|&t| t >= 0.0 && t <= tstop);
        bp.sort_by(|a, b| a.partial_cmp(b).unwrap());
        bp
    }
}

pub struct VoltageSource {
    pub c: Common,
    pub dc: f64,
    pub ac: Option<AcSpec>,
    pub tran: Option<Waveform>,
    h: [i32; 4],
}

impl VoltageSource {
    pub fn new(name: &str, p: i32, n: i32, dc: f64) -> Self {
        VoltageSource {
            c: Common::new(name, vec![p, n]),
            dc,
            ac: None,
            tran: None,
            h: [-1; 4],
        }
    }

    pub fn with_ac(mut self, mag: f64, phase: f64) -> Self {
        self.ac = Some(AcSpec { mag, phase });
        self
    }

    pub fn with_tran(mut self, w: Waveform) -> Self {
        self.tran = Some(w);
        self
    }

    fn topology(&self, sys: &mut SparseSystem) {
        sys.add(self.h[0], 1.0);
        sys.add(self.h[1], -1.0);
        sys.add(self.h[2], 1.0);
        sys.add(self.h[3], -1.0);
    }

    fn value(&self, ctx: &Context) -> f64 {
        if ctx.mode == Mode::Tran || ctx.tran_op {
            if let Some(w) = &self.tran {
                return w.eval(ctx.time, ctx.tstep, ctx.tstop);
            }
        }
        self.dc
    }

    /// Current through the source, positive flowing p to n internally.
    pub fn current(&self, ctx: &Context) -> f64 {
        ctx.x[self.c.branches[0]]
    }
}

impl DeviceOps for VoltageSource {
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
        sys.reserve(p, b);
        sys.reserve(n, b);
        sys.reserve(b, p);
        sys.reserve(b, n);
    }

    fn bind(&mut self, sys: &SparseSystem) {
        let (p, n) = (self.c.nodes[0], self.c.nodes[1]);
        let b = self.c.branches[0] as i32;
        self.h = [
            sys.handle(p, b),
            sys.handle(n, b),
            sys.handle(b, p),
            sys.handle(b, n),
        ];
    }

    fn load_dc(&mut self, ctx: &mut Context) {
        self.topology(&mut ctx.sys);
        let v = self.value(ctx) * ctx.source_factor;
        ctx.rhs(self.c.branches[0] as i32, v);
    }

    fn load_tran(&mut self, ctx: &mut Context) {
        self.topology(&mut ctx.sys);
        let v = self.value(ctx);
        ctx.rhs(self.c.branches[0] as i32, v);
    }

    fn load_ac(&mut self, ctx: &mut Context) {
        self.topology(&mut ctx.sys);
        if let Some(ac) = &self.ac {
            let ph = (PI / 180.0) * ac.phase;
            let (re, im) = (ac.mag * ph.cos(), ac.mag * ph.sin());
            ctx.rhs_c(self.c.branches[0] as i32, re, im);
        }
    }

    fn tran_waveform(&self) -> Option<&Waveform> {
        self.tran.as_ref()
    }
}

pub struct CurrentSource {
    pub c: Common,
    pub dc: f64,
    pub ac: Option<AcSpec>,
    pub tran: Option<Waveform>,
}

impl CurrentSource {
    pub fn new(name: &str, p: i32, n: i32, dc: f64) -> Self {
        CurrentSource {
            c: Common::new(name, vec![p, n]),
            dc,
            ac: None,
            tran: None,
        }
    }

    pub fn with_ac(mut self, mag: f64, phase: f64) -> Self {
        self.ac = Some(AcSpec { mag, phase });
        self
    }

    pub fn with_tran(mut self, w: Waveform) -> Self {
        self.tran = Some(w);
        self
    }

    fn value(&self, ctx: &Context) -> f64 {
        if ctx.mode == Mode::Tran || ctx.tran_op {
            if let Some(w) = &self.tran {
                return w.eval(ctx.time, ctx.tstep, ctx.tstop);
            }
        }
        self.dc
    }
}

impl DeviceOps for CurrentSource {
    fn common(&self) -> &Common {
        &self.c
    }
    fn common_mut(&mut self) -> &mut Common {
        &mut self.c
    }

    fn reserve(&self, _sys: &mut SparseSystem) {}
    fn bind(&mut self, _sys: &SparseSystem) {}

    fn load_dc(&mut self, ctx: &mut Context) {
        let i = self.value(ctx) * ctx.source_factor;
        let (p, n) = (self.c.nodes[0], self.c.nodes[1]);
        ctx.rhs(p, -i);
        ctx.rhs(n, i);
    }

    fn load_tran(&mut self, ctx: &mut Context) {
        let i = self.value(ctx);
        let (p, n) = (self.c.nodes[0], self.c.nodes[1]);
        ctx.rhs(p, -i);
        ctx.rhs(n, i);
    }

    fn load_ac(&mut self, ctx: &mut Context) {
        if let Some(ac) = &self.ac {
            let ph = (PI / 180.0) * ac.phase;
            let (re, im) = (ac.mag * ph.cos(), ac.mag * ph.sin());
            let (p, n) = (self.c.nodes[0], self.c.nodes[1]);
            ctx.rhs_c(p, -re, -im);
            ctx.rhs_c(n, re, im);
        }
    }

    fn tran_waveform(&self) -> Option<&Waveform> {
        self.tran.as_ref()
    }
}
