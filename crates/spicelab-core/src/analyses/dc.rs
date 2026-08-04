//! DC operating point, DC sweep, and AC small-signal sweep.
//! Port of `src/core/analyses/dc.js`.

use crate::circuit::Circuit;
use crate::context::Mode;
use crate::device::DeviceKind;
use crate::newton::{newton, solve_dc, NewtonResult};
use crate::SimError;

pub struct OpResult {
    pub result: NewtonResult,
    pub solution: Vec<f64>,
    pub labels: Vec<String>,
}

/// Compute and return the DC operating point.
pub fn op(circuit: &mut Circuit) -> Result<OpResult, SimError> {
    circuit.ensure_built()?;
    let r = solve_dc(circuit, None)?;
    circuit.ctx.x_old.copy_from_slice(&circuit.ctx.x);
    let x = circuit.ctx.x.clone();
    Ok(OpResult {
        result: r,
        solution: x,
        labels: circuit.labels.clone(),
    })
}

/// `.tf` — small-signal DC transfer function about the operating point.
#[derive(Debug, Clone, Copy)]
pub struct TfResult {
    /// d(output)/d(input), dimensionless for a voltage-in voltage-out pair.
    pub gain: f64,
    /// Resistance seen looking into the input source's terminals.
    pub r_in: f64,
    /// Resistance seen looking back into the output node.
    pub r_out: f64,
}

/// Small-signal transfer function: gain, input resistance, output resistance.
///
/// This is not new numerics. Every piece already existed: `op` finds the bias
/// point, `load(Mode::Ac)` linearises about it, and `factor`/`solve` are the
/// same sparse routines every other analysis uses. What `.tf` adds is three
/// right-hand sides against ONE factorisation.
///
/// `omega = 0` is what makes the linearised matrix the DC small-signal one: a
/// capacitor's `jwC` vanishes to an open and an inductor's `jwL` to a short,
/// which is exactly the DC limit. So this reuses the AC assembly rather than
/// needing a separate DC-linearisation path.
///
/// The three solves, all against the same factored `J`:
///
///   - **gain**: excite the input source's own MNA row with 1. For a voltage
///     source that row states `v+ - v- = E`, so a unit there is a unit volt,
///     and `x[out]` is dV(out)/dE.
///   - **r_in**: the same solve already carries `x[branch]` = dI/dE, and the
///     branch current is defined flowing INTO node 0 of the source — out of
///     its positive terminal into the circuit is therefore `-x[branch]`. Hence
///     the negation; without it a plain divider reports a negative resistance,
///     which is how the sign was pinned down.
///   - **r_out**: inject a unit current into the output node with the input
///     excitation absent. The Jacobian holds no source VALUES — those live in
///     the right-hand side — so simply changing the RHS is what "zero the
///     independent sources" means here, and no source has to be modified and
///     restored.
pub fn transfer_function(
    circuit: &mut Circuit,
    output: &str,
    input_source: &str,
) -> Result<TfResult, SimError> {
    circuit.ensure_built()?;
    op(circuit)?;

    let out = circuit.index_of(output)?;
    if out < 0 {
        return Err(SimError::Build(format!(
            "{output} is ground; a transfer function to ground is always zero"
        )));
    }
    let out = out as usize;

    let dev = circuit
        .device_index(input_source)
        .ok_or_else(|| SimError::Build(format!("no such source: {input_source}")))?;
    let branch = *circuit.devices[dev].branches().first().ok_or_else(|| {
        SimError::Build(format!(
            "{input_source} has no branch current, so it cannot be a `.tf` input. \
             Use an independent VOLTAGE source."
        ))
    })?;

    let n = circuit.num_unknowns;
    circuit.ctx.omega = 0.0;
    circuit.load(Mode::Ac);
    let bad = circuit.ctx.sys.factor(1e-30);
    if bad >= 0 {
        return Err(SimError::Convergence {
            message: "singular matrix linearising for .tf".to_string(),
            time: None,
        });
    }

    // One factorisation, two right-hand sides.
    let mut b = vec![0.0; n];
    b[branch] = 1.0;
    circuit.ctx.sys.solve(&mut b, None);
    let gain = b[out];
    let d_i = -b[branch];

    let mut c = vec![0.0; n];
    c[out] = 1.0;
    circuit.ctx.sys.solve(&mut c, None);

    Ok(TfResult {
        gain,
        // An ideal source into an open circuit draws no current: report an
        // infinite resistance rather than dividing by zero and returning inf
        // by accident, which reads the same but for the wrong reason.
        r_in: if d_i == 0.0 { f64::INFINITY } else { 1.0 / d_i },
        r_out: c[out],
    })
}

/// Which scalar property of a device a sweep drives.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SweepProperty {
    /// The DC level of an independent source.
    Dc,
    /// Resistance of a resistor (recomputes conductance, no re-analysis).
    Resistance,
}

#[derive(Clone, Debug)]
pub struct SweepSpec {
    pub device: String,
    pub property: SweepProperty,
    pub start: f64,
    pub stop: f64,
    pub step: f64,
}

impl SweepSpec {
    fn values(&self) -> Vec<f64> {
        let n = (((self.stop - self.start) / self.step).abs().round() as i64 + 1).max(1);
        (0..n).map(|i| self.start + i as f64 * self.step).collect()
    }
}

pub struct SweepTrace {
    pub outer: Option<f64>,
    pub x: Vec<f64>,
    pub solutions: Vec<Vec<f64>>,
}

pub struct SweepResult {
    pub sweeps: Vec<SweepTrace>,
    pub labels: Vec<String>,
}

fn get_property(c: &Circuit, dev: usize, p: SweepProperty) -> Result<f64, SimError> {
    Ok(match (&c.devices[dev], p) {
        (DeviceKind::VoltageSource(v), SweepProperty::Dc) => v.dc,
        (DeviceKind::CurrentSource(i), SweepProperty::Dc) => i.dc,
        (DeviceKind::Resistor(r), SweepProperty::Resistance) => r.r,
        _ => {
            return Err(SimError::Build(format!(
                "{}: property not sweepable on this device",
                c.devices[dev].name()
            )))
        }
    })
}

fn set_property(c: &mut Circuit, dev: usize, p: SweepProperty, val: f64) {
    // A value change must never dirty the topology — that is what keeps a
    // sweep (and a slider drag) off the symbolic path.
    match (&mut c.devices[dev], p) {
        (DeviceKind::VoltageSource(v), SweepProperty::Dc) => v.dc = val,
        (DeviceKind::CurrentSource(i), SweepProperty::Dc) => i.dc = val,
        (DeviceKind::Resistor(r), SweepProperty::Resistance) => r.r = val,
        _ => {}
    }
    if p == SweepProperty::Resistance {
        // Recompute the temperature-adjusted conductance from the new value.
        // This is a numeric-phase update only; the pattern is untouched.
        let Circuit { devices, ctx, .. } = c;
        devices[dev].temperature(ctx);
    }
}

/// Sweep a source (or a resistor value) and record the solution at each step.
pub fn dc_sweep(
    circuit: &mut Circuit,
    sweep: &SweepSpec,
    sweep2: Option<&SweepSpec>,
) -> Result<SweepResult, SimError> {
    circuit.ensure_built()?;

    let find = |c: &Circuit, name: &str| -> Result<usize, SimError> {
        c.device_index(name)
            .ok_or_else(|| SimError::Build(format!("sweep source not found: {name}")))
    };
    let d1 = find(circuit, &sweep.device)?;
    let d2 = match sweep2 {
        Some(s) => Some(find(circuit, &s.device)?),
        None => None,
    };

    let outer: Vec<Option<f64>> = match sweep2 {
        Some(s) => s.values().into_iter().map(Some).collect(),
        None => vec![None],
    };
    let inner = sweep.values();

    let saved1 = get_property(circuit, d1, sweep.property)?;
    let saved2 = match (d2, sweep2) {
        (Some(d), Some(s)) => Some(get_property(circuit, d, s.property)?),
        _ => None,
    };

    let mut sweeps = Vec::new();
    let mut first = true;
    for v2 in outer {
        if let (Some(d), Some(s), Some(val)) = (d2, sweep2, v2) {
            set_property(circuit, d, s.property, val);
        }
        let mut trace = SweepTrace {
            outer: v2,
            x: Vec::new(),
            solutions: Vec::new(),
        };
        for &v1 in &inner {
            set_property(circuit, d1, sweep.property, v1);
            if first {
                solve_dc(circuit, None)?;
                first = false;
            } else {
                circuit.ctx.force_init = false;
                let itl2 = circuit.options.itl2;
                let r = newton(circuit, Mode::Dc, itl2);
                if !r.converged {
                    solve_dc(circuit, None)?;
                }
            }
            trace.x.push(v1);
            trace.solutions.push(circuit.ctx.x.clone());
        }
        sweeps.push(trace);
    }

    set_property(circuit, d1, sweep.property, saved1);
    if let (Some(d), Some(s), Some(v)) = (d2, sweep2, saved2) {
        set_property(circuit, d, s.property, v);
    }

    Ok(SweepResult {
        sweeps,
        labels: circuit.labels.clone(),
    })
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AcScale {
    Dec,
    Oct,
    Lin,
}

#[derive(Clone, Debug)]
pub struct AcSpec {
    pub scale: AcScale,
    pub points: usize,
    pub start: f64,
    pub stop: f64,
}

pub struct AcResult {
    pub freq: Vec<f64>,
    pub re: Vec<Vec<f64>>,
    pub im: Vec<Vec<f64>>,
    pub labels: Vec<String>,
}

/// AC small-signal sweep. Requires a converged operating point first, since the
/// linearization is taken about it.
pub fn ac_sweep(circuit: &mut Circuit, spec: &AcSpec) -> Result<AcResult, SimError> {
    circuit.ensure_built()?;
    op(circuit)?;

    let mut freqs: Vec<f64> = Vec::new();
    if spec.scale == AcScale::Lin {
        let n = spec.points.max(2);
        for i in 0..n {
            freqs.push(spec.start + ((spec.stop - spec.start) * i as f64) / (n - 1) as f64);
        }
    } else {
        let per = if spec.scale == AcScale::Dec {
            10f64.ln()
        } else {
            2f64.ln()
        };
        let total = (((spec.stop / spec.start).ln() / per) * spec.points as f64).ceil() as usize;
        for i in 0..=total {
            freqs.push(spec.start * ((per * i as f64) / spec.points as f64).exp());
        }
        if *freqs.last().unwrap() < spec.stop {
            freqs.push(spec.stop);
        }
    }

    let n = circuit.num_unknowns;
    let mut re = vec![0.0; n];
    let mut im = vec![0.0; n];
    let mut out_re = Vec::with_capacity(freqs.len());
    let mut out_im = Vec::with_capacity(freqs.len());

    for &f in &freqs {
        circuit.ctx.omega = 2.0 * std::f64::consts::PI * f;
        circuit.load(Mode::Ac);
        let bad = circuit.ctx.sys.factor(1e-30);
        if bad >= 0 {
            return Err(SimError::Convergence {
                message: format!("singular AC matrix at {f} Hz"),
                time: None,
            });
        }
        re.copy_from_slice(&circuit.ctx.rhs_re);
        im.copy_from_slice(&circuit.ctx.rhs_im);
        circuit.ctx.sys.solve(&mut re, Some(&mut im));
        out_re.push(re.clone());
        out_im.push(im.clone());
    }

    Ok(AcResult {
        freq: freqs,
        re: out_re,
        im: out_im,
        labels: circuit.labels.clone(),
    })
}

/// Magnitude in dB and phase in degrees for one unknown index.
pub fn bode(ac: &AcResult, index: usize) -> (Vec<f64>, Vec<f64>) {
    let mut mag = Vec::with_capacity(ac.freq.len());
    let mut phase = Vec::with_capacity(ac.freq.len());
    for k in 0..ac.freq.len() {
        let r = ac.re[k][index];
        let i = ac.im[k][index];
        mag.push(20.0 * r.hypot(i).log10());
        phase.push((180.0 / std::f64::consts::PI) * i.atan2(r));
    }
    (mag, phase)
}
