//! Newton-Raphson limiting. Port of `src/core/limiting.js`.
//!
//! Exponential junctions overflow instantly if Newton takes a full step. These
//! clamp the iterate to a physically reachable value while preserving the step
//! direction, which is what makes nonlinear circuits converge at all. This is
//! the accumulated empirical part of SPICE, reproduced in its standard form.

use std::f64::consts::{E, SQRT_2};

/// Voltage at which the junction exponential is truncated.
pub fn junction_critical(is: f64, vt: f64) -> f64 {
    vt * (vt / (SQRT_2 * is.max(1e-30))).ln()
}

/// Limit a p-n junction voltage. Returns the limited value and whether it changed.
pub fn pnj_limit(vnew: f64, vold: f64, vt: f64, vcrit: f64) -> (f64, bool) {
    if vnew > vcrit && (vnew - vold).abs() > 2.0 * vt {
        if vold > 0.0 {
            let arg = 1.0 + (vnew - vold) / vt;
            let v = if arg > 0.0 { vold + vt * arg.ln() } else { vcrit };
            return (v, true);
        }
        let v = if vnew > 0.0 { vt * (vnew / vt).ln() } else { vnew };
        return (v, true);
    }
    (vnew, false)
}

/// Limit a FET gate-source voltage around threshold.
pub fn fet_limit(vnew: f64, vold: f64, vto: f64) -> (f64, bool) {
    let vtsthi = (2.0 * (vold - vto)).abs() + 2.0;
    let vtstlo = (vtsthi / 2.0).max(2.0);
    let vtox = vto + 3.5;
    let delv = vnew - vold;

    if vold >= vto {
        if vold >= vtox {
            if delv <= 0.0 {
                if vnew >= vtox {
                    return (vnew, false);
                }
                return if vold - vnew > vtstlo {
                    (vold - vtstlo, true)
                } else {
                    (vnew, false)
                };
            }
            return if delv > vtsthi {
                (vold + vtsthi, true)
            } else {
                (vnew, false)
            };
        }
        if delv > 0.0 {
            return if vnew <= vtox {
                if delv > vtsthi {
                    (vold + vtsthi, true)
                } else {
                    (vnew, false)
                }
            } else {
                (vtox, true)
            };
        }
        return if vold - vnew > vtstlo {
            (vold - vtstlo, true)
        } else {
            (vnew, false)
        };
    }

    if delv <= 0.0 {
        return if vold - vnew > vtstlo {
            (vold - vtstlo, true)
        } else {
            (vnew, false)
        };
    }
    let vtemp = vto + 0.5;
    if vnew <= vtemp {
        return if delv > vtsthi {
            (vold + vtsthi, true)
        } else {
            (vnew, false)
        };
    }
    (vtemp, true)
}

/// Limit a drain-source voltage to keep it from swinging wildly.
///
/// The "changed" flag must reflect whether the value was ACTUALLY clamped, not
/// whether this branch can clamp. Returning true unconditionally leaves
/// `ctx.limited` permanently set, and Newton then never reports convergence —
/// the circuit iterates to the limit and fails on a well-behaved bias.
pub fn lim_vds(vnew: f64, vold: f64) -> (f64, bool) {
    let v = if vold >= 3.5 {
        if vnew > vold {
            vnew.min(3.0 * vold + 2.0)
        } else if vnew < 3.5 {
            vnew.max(2.0)
        } else {
            vnew
        }
    } else if vnew > vold {
        vnew.min(4.0)
    } else {
        vnew.max(-0.5)
    };
    (v, v != vnew)
}

/// `E` is re-exported for device models that need the natural-log base directly
/// (the diode reverse-region expansion uses it).
pub const EULER: f64 = E;
