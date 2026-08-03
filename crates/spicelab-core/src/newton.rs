//! Newton-Raphson driver and the convergence aid ladder.
//! Port of `src/core/newton.js`.
//!
//! When plain Newton fails, SPICE does not give up: it re-tries the same problem
//! with a modified circuit that is easier to solve, then walks the modification
//! back to zero, using each solution as the start of the next. Two ladders:
//!
//!   gmin stepping   — add a large conductance to ground on every node, making
//!                     the circuit trivially solvable, then shrink it.
//!   source stepping — scale all independent sources to zero (where the answer
//!                     is all-zeros) and ramp them back up.
//!
//! Almost every real circuit that "won't converge" is solved by one of these.

use crate::circuit::Circuit;
use crate::context::Mode;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FailReason {
    SingularMatrix,
    NonFiniteSolution,
    IterationLimit,
}

impl std::fmt::Display for FailReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FailReason::SingularMatrix => write!(f, "singular matrix"),
            FailReason::NonFiniteSolution => write!(f, "non-finite solution"),
            FailReason::IterationLimit => write!(f, "iteration limit"),
        }
    }
}

#[derive(Clone, Debug)]
pub struct NewtonResult {
    pub converged: bool,
    pub iterations: usize,
    pub reason: Option<FailReason>,
    pub method: &'static str,
}

/// One Newton loop at fixed gmin and source factor.
pub fn newton(circuit: &mut Circuit, mode: Mode, max_iter: usize) -> NewtonResult {
    let n = circuit.num_unknowns;
    let nonlinear = circuit.devices.iter().any(|d| d.is_nonlinear());
    let pivot_tol = 1e-30;

    for iter in 0..max_iter {
        {
            let ctx = &mut circuit.ctx;
            let (x, xp) = (&ctx.x, &mut ctx.x_prev);
            xp.copy_from_slice(x);
            ctx.init_junction = nonlinear && iter == 0 && ctx.force_init;
            ctx.limited = false;
            ctx.device_converged = true;
        }

        circuit.load(mode);

        let bad = circuit.ctx.sys.factor(pivot_tol);
        if bad >= 0 {
            return NewtonResult {
                converged: false,
                iterations: iter,
                reason: Some(FailReason::SingularMatrix),
                method: "direct",
            };
        }

        {
            // Solve in place: x <- A^-1 * rhs. Disjoint field borrows.
            let ctx = &mut circuit.ctx;
            ctx.x.copy_from_slice(&ctx.rhs_re);
            ctx.sys.solve(&mut ctx.x, None);
        }

        if circuit.ctx.x[..n].iter().any(|v| !v.is_finite()) {
            return NewtonResult {
                converged: false,
                iterations: iter,
                reason: Some(FailReason::NonFiniteSolution),
                method: "direct",
            };
        }

        if !nonlinear {
            return NewtonResult {
                converged: true,
                iterations: iter + 1,
                reason: None,
                method: "direct",
            };
        }

        // Apply device limiting to the freshly computed iterate.
        {
            let Circuit { devices, ctx, .. } = circuit;
            for d in devices.iter_mut() {
                if d.is_nonlinear() {
                    d.limit(ctx);
                }
            }
        }

        // Convergence test: every unknown must satisfy reltol/abstol, no device
        // may object, and no limiting may have been applied this iteration.
        let mut ok = iter > 0 && !circuit.ctx.limited;
        if ok {
            let ctx = &circuit.ctx;
            for i in 0..n {
                let a = ctx.x[i];
                let b = ctx.x_prev[i];
                let tol = ctx.reltol * a.abs().max(b.abs()) + ctx.vntol;
                if (a - b).abs() > tol {
                    ok = false;
                    break;
                }
            }
        }
        if ok {
            let Circuit { devices, ctx, .. } = circuit;
            for d in devices.iter_mut() {
                if d.is_nonlinear() {
                    d.check_convergence(ctx);
                }
            }
            if circuit.ctx.device_converged {
                return NewtonResult {
                    converged: true,
                    iterations: iter + 1,
                    reason: None,
                    method: "direct",
                };
            }
        }
    }

    NewtonResult {
        converged: false,
        iterations: max_iter,
        reason: Some(FailReason::IterationLimit),
        method: "direct",
    }
}

/// Solve with the full convergence ladder. Used for the operating point and for
/// the first point of a DC sweep or transient run.
pub fn solve_dc(circuit: &mut Circuit, max_iter: Option<usize>) -> Result<NewtonResult, crate::SimError> {
    let max_iter = max_iter.unwrap_or(circuit.options.itl1);
    let base_gmin = circuit.options.gmin;

    circuit.ctx.source_factor = 1.0;
    circuit.ctx.gmin = base_gmin;
    circuit.ctx.force_init = true;
    circuit.ctx.x.iter_mut().for_each(|v| *v = 0.0);

    let mut r = newton(circuit, Mode::Op, max_iter);
    if r.converged {
        return Ok(NewtonResult {
            method: "direct",
            ..r
        });
    }

    // --- gmin stepping ---
    circuit.ctx.force_init = true;
    circuit.ctx.x.iter_mut().for_each(|v| *v = 0.0);
    let mut gmin = 1e-3;
    while gmin >= base_gmin {
        circuit.ctx.gmin = gmin;
        r = newton(circuit, Mode::Op, max_iter);
        circuit.ctx.force_init = false;
        if !r.converged {
            break;
        }
        if gmin <= base_gmin {
            return Ok(NewtonResult {
                method: "gmin stepping",
                ..r
            });
        }
        gmin /= 10.0;
    }

    // --- source stepping ---
    circuit.ctx.gmin = base_gmin;
    circuit.ctx.force_init = true;
    circuit.ctx.x.iter_mut().for_each(|v| *v = 0.0);
    let mut converged = false;
    for f in [
        0.0, 0.01, 0.05, 0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9, 0.95, 1.0,
    ] {
        circuit.ctx.source_factor = f;
        r = newton(circuit, Mode::Op, max_iter);
        circuit.ctx.force_init = false;
        if !r.converged {
            converged = false;
            break;
        }
        converged = f == 1.0;
    }
    circuit.ctx.source_factor = 1.0;
    if converged {
        return Ok(NewtonResult {
            method: "source stepping",
            ..r
        });
    }

    Err(crate::SimError::Convergence {
        message: format!(
            "operating point did not converge ({})",
            r.reason
                .as_ref()
                .map(|x| x.to_string())
                .unwrap_or_else(|| "unknown".into())
        ),
        time: None,
    })
}
