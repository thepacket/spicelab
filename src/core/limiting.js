/**
 * Newton-Raphson limiting.
 *
 * Exponential junctions overflow instantly if Newton is allowed to take a full
 * step. These functions clamp the iterate to a physically reachable value while
 * preserving the direction of the step, which is what makes nonlinear circuits
 * converge at all. They are the accumulated empirical part of SPICE and are
 * reproduced here in their standard form.
 */

/** Voltage at which the junction exponential is truncated. */
export function junctionCritical(is, vt) {
  return vt * Math.log(vt / (Math.SQRT2 * Math.max(is, 1e-30)));
}

/**
 * Limit a p-n junction voltage.
 * @returns {[number, boolean]} limited value and whether it changed
 */
export function pnjLimit(vnew, vold, vt, vcrit) {
  if (vnew > vcrit && Math.abs(vnew - vold) > 2 * vt) {
    if (vold > 0) {
      const arg = 1 + (vnew - vold) / vt;
      const v = arg > 0 ? vold + vt * Math.log(arg) : vcrit;
      return [v, true];
    }
    const v = vnew > 0 ? vt * Math.log(vnew / vt) : vnew;
    return [v, true];
  }
  return [vnew, false];
}

/** Limit a FET gate-source voltage around threshold. */
export function fetLimit(vnew, vold, vto) {
  const vtsthi = Math.abs(2 * (vold - vto)) + 2;
  const vtstlo = Math.max(vtsthi / 2, 2);
  const vtox = vto + 3.5;
  const delv = vnew - vold;
  if (vold >= vto) {
    if (vold >= vtox) {
      if (delv <= 0) {
        if (vnew >= vtox) return [vnew, false];
        return vold - vnew > vtstlo ? [vold - vtstlo, true] : [vnew, false];
      }
      return delv > vtsthi ? [vold + vtsthi, true] : [vnew, false];
    }
    if (delv > 0) {
      return vnew <= vtox ? (delv > vtsthi ? [vold + vtsthi, true] : [vnew, false])
                          : [vtox, true];
    }
    return vold - vnew > vtstlo ? [vold - vtstlo, true] : [vnew, false];
  }
  if (delv <= 0) {
    return vold - vnew > vtstlo ? [vold - vtstlo, true] : [vnew, false];
  }
  const vtemp = vto + 0.5;
  if (vnew <= vtemp) return delv > vtsthi ? [vold + vtsthi, true] : [vnew, false];
  return [vtemp, true];
}

/**
 * Limit a drain-source voltage to keep it from swinging wildly.
 *
 * The "changed" flag must reflect whether the value was ACTUALLY clamped, not
 * whether this branch can clamp. Returning true unconditionally makes
 * ctx.limited permanently set, and Newton then never reports convergence — the
 * circuit iterates to the limit and fails on a perfectly well-behaved bias.
 */
export function limVds(vnew, vold) {
  let v = vnew;
  if (vold >= 3.5) {
    if (vnew > vold) v = Math.min(vnew, 3 * vold + 2);
    else if (vnew < 3.5) v = Math.max(vnew, 2);
  } else if (vnew > vold) {
    v = Math.min(vnew, 4);
  } else {
    v = Math.max(vnew, -0.5);
  }
  return [v, v !== vnew];
}
