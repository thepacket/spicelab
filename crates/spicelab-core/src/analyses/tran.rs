//! Transient analysis. Port of `src/core/analyses/tran.js`.
//!
//! Written as a resumable stepper rather than a run-to-completion loop. The
//! interactive UI needs to advance the simulation for a slice of wall-clock
//! time, hand control back so the browser can paint, and resume where it left
//! off. A blocking loop would have to be rewritten to support that; this does
//! not. `advance_steps` is the wasm-friendly form of the JS `advanceFor(ms)` —
//! the host decides the budget, since `Instant::now` is not available on
//! `wasm32-unknown-unknown`.

use crate::circuit::Circuit;
use crate::context::{lte_timestep, Method, Mode};
use crate::device::DeviceKind;
use crate::newton::newton;
use crate::newton::solve_dc;
use crate::SimError;

#[derive(Clone, Debug)]
pub struct TranOptions {
    pub tstop: f64,
    pub tstep: f64,
    pub tstart: f64,
    pub tmax: Option<f64>,
    pub uic: bool,
    pub method: Option<Method>,
}

impl TranOptions {
    pub fn new(tstop: f64, tstep: f64) -> Self {
        TranOptions {
            tstop,
            tstep,
            tstart: 0.0,
            tmax: None,
            uic: false,
            method: None,
        }
    }
}

pub struct TranStats {
    pub accepted: usize,
    pub rejected: usize,
    pub iterations: usize,
}

pub struct TranResult {
    pub time: Vec<f64>,
    pub data: Vec<Vec<f64>>,
    pub labels: Vec<String>,
    pub stats: TranStats,
}

pub struct TransientRun {
    tstop: f64,
    tstep: f64,
    tstart: f64,
    tmax: f64,
    uic: bool,
    method: Method,

    pub time: f64,
    dt: f64,
    pub done: bool,
    order: usize,
    pub accepted: usize,
    pub rejected: usize,
    pub iterations: usize,

    pub times: Vec<f64>,
    pub data: Vec<Vec<f64>>,

    breakpoints: Vec<f64>,
    bp_index: usize,
    /// The step just accepted ended on a source discontinuity, so the next one
    /// must start at order 1. See `step`.
    bp_restart: bool,
}

impl TransientRun {
    pub fn new(circuit: &Circuit, opts: &TranOptions) -> Self {
        let tmax = opts
            .tmax
            .unwrap_or_else(|| opts.tstep.min((opts.tstop - opts.tstart) / 50.0));
        TransientRun {
            tstop: opts.tstop,
            tstep: opts.tstep,
            tstart: opts.tstart,
            tmax,
            uic: opts.uic,
            method: opts.method.unwrap_or(circuit.options.method),
            time: 0.0,
            dt: 0.0,
            done: false,
            order: 1,
            accepted: 0,
            rejected: 0,
            iterations: 0,
            times: Vec::new(),
            data: Vec::new(),
            breakpoints: Vec::new(),
            bp_index: 0,
            bp_restart: false,
        }
    }

    pub fn begin(&mut self, c: &mut Circuit) -> Result<(), SimError> {
        c.ensure_built()?;
        c.ctx.tstep = self.tstep;
        c.ctx.tstop = self.tstop;
        c.ctx.method = self.method;

        // Collect waveform breakpoints so no source edge is stepped over.
        let mut bp: Vec<f64> = vec![0.0, self.tstop];
        for d in c.devices.iter() {
            if let Some(w) = d.tran_waveform() {
                bp.extend(w.breakpoints(self.tstop));
            }
        }
        bp.sort_by(|a, b| a.partial_cmp(b).unwrap());
        bp.dedup();
        self.breakpoints = bp;
        self.bp_index = 0;

        c.ctx.state.reset();
        if self.uic {
            c.ctx.x.iter_mut().for_each(|v| *v = 0.0);
            self.apply_initial_conditions(c);
        } else {
            // Sources take their t=0 waveform value here, not their DC value.
            c.ctx.time = 0.0;
            c.ctx.tran_op = true;
            let r = solve_dc(c, None);
            c.ctx.tran_op = false;
            r?;
        }
        c.ctx.x_old.copy_from_slice(&c.ctx.x);

        // First timepoint: charges are seeded from the operating point.
        c.ctx.mode = Mode::Tran;
        c.ctx.time = 0.0;
        c.ctx.init_transient = true;
        c.ctx.order = 1;
        c.load(Mode::Tran);
        c.ctx.init_transient = false;

        self.time = 0.0;
        self.dt = self.tmax.min(self.tstep) / 10.0;
        self.order = 1;
        self.record(c, 0.0);
        Ok(())
    }

    fn apply_initial_conditions(&self, c: &mut Circuit) {
        // Collected first so the borrow on `devices` ends before `ctx` is
        // mutated. Same semantics as the JS loop.
        let ics: Vec<(i32, i32, f64)> = c
            .devices
            .iter()
            .filter_map(|d| {
                let ic = match d {
                    DeviceKind::Capacitor(x) => x.ic,
                    DeviceKind::Inductor(x) => x.ic,
                    _ => None,
                }?;
                let n = d.nodes();
                if n.len() >= 2 {
                    Some((n[0], n[1], ic))
                } else {
                    None
                }
            })
            .collect();
        for (p, n, ic) in ics {
            if p >= 0 {
                let base = if n >= 0 { c.ctx.x[n as usize] } else { 0.0 };
                c.ctx.x[p as usize] = ic + base;
            }
        }
    }

    fn record(&mut self, c: &Circuit, t: f64) {
        self.times.push(t);
        self.data.push(c.ctx.x.clone());
    }

    /// Largest step allowed by breakpoints, tmax, and the remaining span.
    fn limit_step(&mut self, dt: f64) -> f64 {
        let mut lim = dt.min(self.tmax).min(self.tstop - self.time);
        while self.bp_index < self.breakpoints.len()
            && self.breakpoints[self.bp_index] <= self.time + 1e-15
        {
            self.bp_index += 1;
        }
        if self.bp_index < self.breakpoints.len() {
            let to_bp = self.breakpoints[self.bp_index] - self.time;
            if to_bp > 0.0 && to_bp < lim {
                lim = to_bp;
            } else if to_bp > 0.0 && to_bp < 1.5 * lim {
                // Do not leave a sliver of a step just before a breakpoint.
                lim = to_bp / 2.0;
            }
        }
        lim.max(1e-18)
    }

    /// Attempt one timestep. Returns whether it was accepted.
    pub fn step(&mut self, c: &mut Circuit) -> Result<bool, SimError> {
        let dt = self.limit_step(self.dt);

        c.ctx.state.advance();
        c.ctx.dt[1] = c.ctx.dt[0];
        c.ctx.dt[0] = dt;
        c.ctx.time = self.time + dt;
        c.ctx.x_old.copy_from_slice(&c.ctx.x);

        c.ctx.method = self.method;
        // Order restarts at 1 for the first steps of the run AND for the first
        // step after every source discontinuity.
        //
        // Trapezoidal integration carries the previous step's branch current
        // forward (`i = (2/dt)*(q0-q1) - i1`). Across a breakpoint that history
        // belongs to the OTHER side of the edge, so the first post-edge step is
        // seeded with a derivative that no longer exists, and in a branch with
        // no resistance to damp it the error alternates in sign and never
        // decays: a gate overlap capacitance driven by a PULSE rings at twice
        // the correct current forever. The mean stays right, which is why this
        // looks like a plausible waveform rather than an error — and driving
        // that ringing into a load resistor flips the MOSFET's drain/source
        // roles every step, which is what finally showed up, as a timestep
        // collapse on a p-channel switch. One backward-Euler step at the edge
        // discards the stale history, which is what SPICE has always done.
        c.ctx.order = if self.accepted < 2 || self.bp_restart {
            1
        } else {
            self.order.min(c.options.maxord)
        };

        c.ctx.force_init = false;
        let itl4 = c.options.itl4;
        let r = newton(c, Mode::Tran, itl4);
        self.iterations += r.iterations;

        if !r.converged {
            c.ctx.state.rollback();
            c.ctx.x.copy_from_slice(&c.ctx.x_old);
            c.ctx.dt[0] = c.ctx.dt[1];
            self.rejected += 1;
            self.dt = dt / 8.0;
            if self.dt < 1e-18 {
                return Err(SimError::Convergence {
                    message: format!(
                        "transient failed to converge at t={:.4e} s (timestep collapsed to {:.2e} s)",
                        self.time, self.dt
                    ),
                    time: Some(self.time),
                });
            }
            return Ok(false);
        }

        // Commit charges at the CONVERGED solution.
        //
        // Devices compute q(v) during load(), which runs before the solve. For a
        // nonlinear circuit Newton iterates until v stops moving, so the stored
        // charge ends up consistent. For a LINEAR circuit Newton exits after one
        // iteration and the stored charge is left one timepoint stale, which
        // silently corrupts every subsequent integration and LTE estimate. This
        // one extra stamp pass at the converged solution fixes both cases.
        // Do not remove it: nothing in the suite fails loudly if you do.
        c.load(Mode::Tran);

        // Local truncation error check across every charge-storing device.
        let mut allowed = f64::INFINITY;
        let trtol = c.options.trtol;
        for d in c.devices.iter() {
            let ns = d.n_lte_states();
            if ns >= 2 {
                let off = d.state_off();
                for k in (0..ns).step_by(2) {
                    let lim = lte_timestep(&c.ctx, off + k, self.method, trtol);
                    if lim < allowed {
                        allowed = lim;
                    }
                }
            }
        }

        if self.accepted >= 2 && allowed < 0.9 * dt {
            c.ctx.state.rollback();
            c.ctx.x.copy_from_slice(&c.ctx.x_old);
            c.ctx.dt[0] = c.ctx.dt[1];
            self.rejected += 1;
            self.dt = allowed.max(dt / 8.0);
            return Ok(false);
        }

        self.time += dt;
        self.accepted += 1;
        self.order = 2;
        self.bp_restart = self.bp_index < self.breakpoints.len()
            && (self.breakpoints[self.bp_index] - self.time).abs() <= 1e-15;
        if self.time >= self.tstart {
            let t = self.time;
            self.record(c, t);
        }

        // Grow the step, but never by more than 2x, and never past LTE.
        let mut next = (2.0 * dt).min(allowed);
        if r.iterations as f64 > c.options.itl4 as f64 * 0.7 {
            next = next.min(dt);
        }
        self.dt = next;

        if self.time >= self.tstop - 1e-15 {
            self.done = true;
        }
        Ok(true)
    }

    /// Run at most `max_steps` step attempts, then yield. The resumable form:
    /// the caller owns the wall-clock budget.
    pub fn advance_steps(&mut self, c: &mut Circuit, max_steps: usize) -> Result<bool, SimError> {
        for _ in 0..max_steps {
            if self.done {
                break;
            }
            self.step(c)?;
        }
        Ok(self.done)
    }

    /// Run to the end and copy out the trajectory. The run stays intact and
    /// inspectable — `times`/`data` remain readable afterwards, which is what
    /// callers that keep the `TransientRun` around expect.
    pub fn run_to_completion(&mut self, c: &mut Circuit) -> Result<TranResult, SimError> {
        while !self.done {
            self.step(c)?;
        }
        Ok(self.result(c))
    }

    /// Run to the end and take ownership of the trajectory, leaving the run
    /// drained. `data` holds one `Vec` per accepted timepoint, so this avoids
    /// duplicating the whole run's allocations when the caller is finished with
    /// the stepper anyway. Used by [`tran`].
    pub fn into_result(mut self, c: &mut Circuit) -> Result<TranResult, SimError> {
        while !self.done {
            self.step(c)?;
        }
        Ok(TranResult {
            time: std::mem::take(&mut self.times),
            data: std::mem::take(&mut self.data),
            labels: c.labels.clone(),
            stats: TranStats {
                accepted: self.accepted,
                rejected: self.rejected,
                iterations: self.iterations,
            },
        })
    }

    pub fn result(&self, c: &Circuit) -> TranResult {
        TranResult {
            time: self.times.clone(),
            data: self.data.clone(),
            labels: c.labels.clone(),
            stats: TranStats {
                accepted: self.accepted,
                rejected: self.rejected,
                iterations: self.iterations,
            },
        }
    }
}

/// Convenience wrapper for a blocking transient run.
pub fn tran(c: &mut Circuit, opts: &TranOptions) -> Result<TranResult, SimError> {
    let mut run = TransientRun::new(c, opts);
    run.begin(c)?;
    run.into_result(c)
}
