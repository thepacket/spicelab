//! Simulation context and shared device state.
//!
//! Port of the `Context` / `StatePool` half of `src/core/device.js`, plus
//! `src/core/integrator.js`. The integrator is folded into `Context` here: the
//! JS version installs a closure on the context, which in Rust would mean either
//! a `Box<dyn Fn>` indirection or a lifetime knot on the hot path. A method
//! matching on a `Method` enum is the same computation with static dispatch.
//!
//! CHARGE-BASED, NOT CAPACITANCE-BASED. Devices report q(v) and dq/dv and the
//! integrator differentiates. Stamping capacitance directly does not conserve
//! charge across timestep changes and drifts in switching circuits.

use crate::sparse::SparseSystem;

pub const GND: i32 = -1;

const BOLTZMANN: f64 = 1.380649e-23;
const CHARGE: f64 = 1.602176634e-19;

/// Analysis mode a load pass is running under.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    /// DC operating point.
    Op,
    /// DC sweep (same stamps as Op).
    Dc,
    /// Transient.
    Tran,
    /// Small-signal frequency domain.
    Ac,
}

/// Numerical integration method.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Method {
    Be,
    Trap,
    Gear2,
}

impl Method {
    pub fn parse(s: &str) -> Option<Method> {
        match s {
            "be" => Some(Method::Be),
            "trap" => Some(Method::Trap),
            "gear2" => Some(Method::Gear2),
            _ => None,
        }
    }
}

/// Per-instance device state as flat arrays with a history ring.
///
/// Depth 3 covers Gear2 and trapezoidal; the 4th slot absorbs a rejected step.
/// Layout convention (SPICE3): slot `k` is a charge, slot `k+1` is the
/// corresponding branch current. LTE estimation relies on this pairing.
pub struct StatePool {
    pub size: usize,
    depth: usize,
    rings: Vec<Vec<f64>>,
    head: usize,
}

impl StatePool {
    pub fn new(size: usize) -> Self {
        let depth = 4;
        StatePool {
            size,
            depth,
            rings: vec![vec![0.0; size]; depth],
            head: 0,
        }
    }

    #[inline]
    fn idx(&self, k: usize) -> usize {
        (self.head + k) % self.depth
    }

    /// State vector `k` timepoints back from now (0 = current).
    #[inline]
    pub fn at(&self, k: usize) -> &[f64] {
        &self.rings[self.idx(k)]
    }

    #[inline]
    pub fn at_mut(&mut self, k: usize) -> &mut [f64] {
        let i = self.idx(k);
        &mut self.rings[i]
    }

    /// Advance to a new timepoint, carrying current values forward as the guess.
    pub fn advance(&mut self) {
        self.head = (self.head + self.depth - 1) % self.depth;
        let dst = self.head;
        let src = (self.head + 1) % self.depth;
        // Allocation-free copy between two rows of the ring.
        if dst < src {
            let (a, b) = self.rings.split_at_mut(src);
            a[dst].copy_from_slice(&b[0]);
        } else {
            let (a, b) = self.rings.split_at_mut(dst);
            b[0].copy_from_slice(&a[src]);
        }
    }

    /// Undo an advance (used when a timestep is rejected).
    pub fn rollback(&mut self) {
        self.head = (self.head + 1) % self.depth;
    }

    pub fn reset(&mut self) {
        for r in self.rings.iter_mut() {
            r.iter_mut().for_each(|v| *v = 0.0);
        }
        self.head = 0;
    }
}

/// Everything a device needs during a load pass. One per circuit; the analyses
/// mutate its fields rather than allocating, so a load pass never allocates.
pub struct Context {
    pub sys: SparseSystem,
    pub n: usize,

    /// Current Newton iterate.
    pub x: Vec<f64>,
    /// Previous Newton iterate.
    pub x_prev: Vec<f64>,
    /// Solution at the last accepted timepoint.
    pub x_old: Vec<f64>,
    pub rhs_re: Vec<f64>,
    pub rhs_im: Vec<f64>,

    pub state: StatePool,

    pub mode: Mode,
    pub time: f64,
    /// `dt[0]` = current step, `dt[1]` = previous step.
    pub dt: [f64; 2],
    pub omega: f64,

    pub gmin: f64,
    /// Instance temperature, K.
    pub temp: f64,
    /// Model extraction temperature, K.
    pub nom_temp: f64,
    /// Source ramping factor for convergence aid.
    pub source_factor: f64,
    /// First timepoint: use DC values, no integration.
    pub init_transient: bool,
    /// Solving the operating point that a transient run STARTS from.
    ///
    /// The mode is still `Dc` — it is a DC solve — but independent sources must
    /// take their waveform value at t=0 rather than their `DC` value, because
    /// that is the state the run actually begins in. A source written
    /// `DC 0 PULSE(5 0 ...)` sits at 5 V when transient time starts, and
    /// starting the run from the 0 V operating point instead makes every device
    /// jump discontinuously at the first step. That is what SPICE has always
    /// done (`MODETRANOP` evaluates the function; only `.op` uses the DC value).
    pub tran_op: bool,
    /// First Newton iteration: use nominal junction guesses.
    pub init_junction: bool,
    pub force_init: bool,

    pub reltol: f64,
    pub vntol: f64,
    pub abstol: f64,
    pub chgtol: f64,

    /// Cleared by a device when its own convergence test fails.
    pub device_converged: bool,
    /// Set by a device when limiting altered the iterate.
    pub limited: bool,

    // --- integrator configuration and output ---
    pub method: Method,
    /// Effective order for this step (1 on the first steps).
    pub order: usize,
    pub geq: f64,
    pub ieq: f64,

    pub tstep: f64,
    pub tstop: f64,
}

impl Context {
    pub fn new(sys: SparseSystem, num_unknowns: usize, state_size: usize) -> Self {
        Context {
            sys,
            n: num_unknowns,
            x: vec![0.0; num_unknowns],
            x_prev: vec![0.0; num_unknowns],
            x_old: vec![0.0; num_unknowns],
            rhs_re: vec![0.0; num_unknowns],
            rhs_im: vec![0.0; num_unknowns],
            state: StatePool::new(state_size.max(1)),
            mode: Mode::Op,
            time: 0.0,
            dt: [1e-9, 1e-9],
            omega: 0.0,
            gmin: 1e-12,
            temp: 300.15,
            nom_temp: 300.15,
            source_factor: 1.0,
            init_transient: false,
            tran_op: false,
            init_junction: false,
            force_init: false,
            reltol: 1e-3,
            vntol: 1e-6,
            abstol: 1e-12,
            chgtol: 1e-14,
            device_converged: true,
            limited: false,
            method: Method::Trap,
            order: 2,
            geq: 0.0,
            ieq: 0.0,
            tstep: 1e-9,
            tstop: 1.0,
        }
    }

    /// Node voltage, honouring the ground index.
    #[inline]
    pub fn v(&self, node: i32) -> f64 {
        if node < 0 {
            0.0
        } else {
            self.x[node as usize]
        }
    }

    #[inline]
    pub fn v_old(&self, node: i32) -> f64 {
        if node < 0 {
            0.0
        } else {
            self.x_old[node as usize]
        }
    }

    /// Add to the real RHS at a node (ignored for ground).
    #[inline]
    pub fn rhs(&mut self, node: i32, val: f64) {
        if node >= 0 {
            self.rhs_re[node as usize] += val;
        }
    }

    #[inline]
    pub fn rhs_c(&mut self, node: i32, val_re: f64, val_im: f64) {
        if node >= 0 {
            self.rhs_re[node as usize] += val_re;
            self.rhs_im[node as usize] += val_im;
        }
    }

    /// Thermal voltage kT/q at the instance temperature.
    #[inline]
    pub fn vt(&self) -> f64 {
        BOLTZMANN * self.temp / CHARGE
    }

    /// Integrate a charge state into an equivalent conductance and current.
    ///
    /// Reads `state[q_off]`, writes `state[q_off + 1]` (the branch current), and
    /// leaves the companion model in `self.geq` / `self.ieq` such that the
    /// branch current is `i = geq * v + ieq`.
    pub fn integrate(&mut self, q_off: usize, dqdv: f64, v: f64) {
        if self.init_transient {
            // First timepoint: charges are known but there is no history to
            // differentiate against. Contribute nothing, but the device still
            // reports dq/dv so the DC behaviour (a capacitor as an open
            // circuit) stays correct.
            self.state.at_mut(0)[q_off + 1] = 0.0;
            self.geq = 0.0;
            self.ieq = 0.0;
            return;
        }

        let (geq, i) = match self.method {
            Method::Be => self.int_be(q_off, dqdv),
            _ if self.order == 1 => self.int_be(q_off, dqdv),
            Method::Trap => {
                let dt = self.dt[0];
                let q0 = self.state.at(0)[q_off];
                let prev = self.state.at(1);
                let q1 = prev[q_off];
                let i1 = prev[q_off + 1];
                let g = 2.0 * dqdv / dt;
                let i = (2.0 / dt) * (q0 - q1) - i1;
                (g, i)
            }
            Method::Gear2 => {
                let h0 = self.dt[0];
                let h1 = if self.dt[1] != 0.0 { self.dt[1] } else { h0 };
                // Variable-step BDF2 coefficients.
                let r = h0 / h1;
                let a0 = (1.0 + 2.0 * r) / (h0 * (1.0 + r));
                let a1 = -((1.0 + r) * (1.0 + r)) / (h0 * (1.0 + r));
                let a2 = (r * r) / (h0 * (1.0 + r));
                let q0 = self.state.at(0)[q_off];
                let q1 = self.state.at(1)[q_off];
                let q2 = self.state.at(2)[q_off];
                (a0 * dqdv, a0 * q0 + a1 * q1 + a2 * q2)
            }
        };

        self.state.at_mut(0)[q_off + 1] = i;
        self.geq = geq;
        self.ieq = i - geq * v;
    }

    #[inline]
    fn int_be(&self, q_off: usize, dqdv: f64) -> (f64, f64) {
        let dt = self.dt[0];
        let q0 = self.state.at(0)[q_off];
        let q1 = self.state.at(1)[q_off];
        (dqdv / dt, (q0 - q1) / dt)
    }
}

/// Local truncation error estimate for a charge state, returning the largest
/// timestep that would keep the error inside tolerance.
///
/// Uses divided differences of the stored charge history — the standard SPICE
/// approach, which works with variable steps.
pub fn lte_timestep(ctx: &Context, q_off: usize, method: Method, trtol: f64) -> f64 {
    let q0 = ctx.state.at(0)[q_off];
    let q1 = ctx.state.at(1)[q_off];
    let q2 = ctx.state.at(2)[q_off];
    let h0 = ctx.dt[0];
    let h1 = if ctx.dt[1] != 0.0 { ctx.dt[1] } else { h0 };
    if h0 <= 0.0 || h1 <= 0.0 {
        return f64::INFINITY;
    }

    // Second divided difference approximates q''/2.
    let d1 = (q0 - q1) / h0;
    let d2 = (q1 - q2) / h1;
    let dd = (d1 - d2) / (h0 + h1);

    let tol = ctx.chgtol.max(ctx.reltol * q0.abs().max(q1.abs()));
    let err = dd.abs();
    if err < 1e-300 {
        return f64::INFINITY;
    }

    // BE is first order (error ~ h^2 q''), TRAP/GEAR2 second order.
    let factor = if method == Method::Be { 0.5 } else { 1.0 / 12.0 };
    ((trtol * tol) / (factor * err * 2.0)).abs().sqrt()
}
