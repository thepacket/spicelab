/**
 * Numerical integration methods.
 *
 * Each method converts a charge state q(v) plus its derivative dq/dv into an
 * equivalent conductance geq and current source ieq such that the branch current
 * is i = geq*v + ieq. Devices never see the method; they only report charge.
 *
 * State layout convention (matches SPICE3): slot qOff holds the charge, slot
 * qOff+1 holds the resulting branch current. Both are kept in the history ring
 * so higher-order methods and LTE estimation can look backwards.
 */

export const Method = Object.freeze({
  BE: 'be',
  TRAP: 'trap',
  GEAR2: 'gear2',
});

/**
 * Install an integrator on a context.
 * @param {import('./device.js').Context} ctx
 * @param {string} method
 * @param {number} order effective order for this step (1 on the first step)
 */
export function setIntegrator(ctx, method, order = 2) {
  const st = ctx.state;

  if (ctx.initTransient) {
    // First timepoint: charges are known but there is no history to
    // differentiate against. Contribute nothing but keep dq/dv so the DC
    // operating point of the capacitor (an open circuit) is correct.
    ctx.integrator = (qOff, dqdv, v) => {
      st.at(0)[qOff + 1] = 0;
      ctx.geq = 0;
      ctx.ieq = 0;
    };
    return;
  }

  if (method === Method.BE || order === 1) {
    ctx.integrator = (qOff, dqdv, v) => {
      const dt = ctx.dt[0];
      const cur = st.at(0);
      const prev = st.at(1);
      const g = dqdv / dt;
      const i = (cur[qOff] - prev[qOff]) / dt;
      cur[qOff + 1] = i;
      ctx.geq = g;
      ctx.ieq = i - g * v;
    };
    return;
  }

  if (method === Method.TRAP) {
    ctx.integrator = (qOff, dqdv, v) => {
      const dt = ctx.dt[0];
      const cur = st.at(0);
      const prev = st.at(1);
      const g = (2 * dqdv) / dt;
      const i = (2 / dt) * (cur[qOff] - prev[qOff]) - prev[qOff + 1];
      cur[qOff + 1] = i;
      ctx.geq = g;
      ctx.ieq = i - g * v;
    };
    return;
  }

  if (method === Method.GEAR2) {
    ctx.integrator = (qOff, dqdv, v) => {
      const h0 = ctx.dt[0];
      const h1 = ctx.dt[1] || h0;
      // Variable-step BDF2 coefficients.
      const r = h0 / h1;
      const a0 = (1 + 2 * r) / (h0 * (1 + r));
      const a1 = -((1 + r) * (1 + r)) / (h0 * (1 + r));
      const a2 = (r * r) / (h0 * (1 + r));
      const cur = st.at(0);
      const p1 = st.at(1);
      const p2 = st.at(2);
      const g = a0 * dqdv;
      const i = a0 * cur[qOff] + a1 * p1[qOff] + a2 * p2[qOff];
      cur[qOff + 1] = i;
      ctx.geq = g;
      ctx.ieq = i - g * v;
    };
    return;
  }

  throw new Error(`unknown integration method: ${method}`);
}

/**
 * Local truncation error estimate for a charge state, returning the largest
 * timestep that would keep the error inside tolerance.
 *
 * Uses divided differences of the stored charge history, which is the standard
 * SPICE approach and works with variable steps.
 */
export function lteTimestep(ctx, qOff, method, trtol = 7) {
  const st = ctx.state;
  const q0 = st.at(0)[qOff];
  const q1 = st.at(1)[qOff];
  const q2 = st.at(2)[qOff];
  const h0 = ctx.dt[0];
  const h1 = ctx.dt[1] || h0;
  if (h0 <= 0 || h1 <= 0) return Infinity;

  // Second divided difference approximates q''/2.
  const d1 = (q0 - q1) / h0;
  const d2 = (q1 - q2) / h1;
  const dd = (d1 - d2) / (h0 + h1);

  const tol = Math.max(ctx.chgtol, ctx.reltol * Math.max(Math.abs(q0), Math.abs(q1)));
  const err = Math.abs(dd);
  if (err < 1e-300) return Infinity;

  // BE is first order (error ~ h^2 * q''), TRAP/GEAR2 second order.
  const factor = method === Method.BE ? 0.5 : 1 / 12;
  const allowed = Math.sqrt(Math.abs((trtol * tol) / (factor * err * 2)));
  return allowed;
}
