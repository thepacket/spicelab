/**
 * Newton-Raphson driver and the convergence aid ladder.
 *
 * When plain Newton fails, SPICE does not give up: it re-tries the same problem
 * with a modified circuit that is easier to solve, then walks the modification
 * back to zero, using each solution as the starting point for the next. Two
 * ladders are implemented here:
 *
 *   gmin stepping   — add a large conductance to ground on every node, making
 *                     the circuit trivially solvable, then shrink it.
 *   source stepping — scale all independent sources to zero (where the answer
 *                     is all-zeros) and ramp them back up.
 *
 * Almost every real circuit that "won't converge" is solved by one of these.
 */
import { Mode } from './device.js';

export class ConvergenceError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'ConvergenceError';
    this.detail = detail;
  }
}

/**
 * One Newton loop at fixed gmin and source factor.
 * @returns {{converged: boolean, iterations: number, reason?: string}}
 */
export function newton(circuit, mode, maxIter) {
  const ctx = circuit.ctx;
  const sys = circuit.sys;
  const n = circuit.numUnknowns;
  const nonlinear = circuit.devices.some((d) => d.nonlinear);

  for (let iter = 0; iter < maxIter; iter++) {
    ctx.xPrev.set(ctx.x);
    ctx.initJunction = nonlinear && iter === 0 && ctx.forceInit;
    ctx.limited = false;
    ctx.deviceConverged = true;

    circuit.load(mode);

    const bad = sys.factor();
    if (bad >= 0) {
      return { converged: false, iterations: iter, reason: 'singular matrix' };
    }
    ctx.x.set(ctx.rhsRe);
    sys.solve(ctx.x);

    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(ctx.x[i])) {
        return { converged: false, iterations: iter, reason: 'non-finite solution' };
      }
    }

    if (!nonlinear) return { converged: true, iterations: iter + 1 };

    // Apply device limiting to the freshly computed iterate.
    for (const d of circuit.devices) if (d.nonlinear) d.limit(ctx);

    // Convergence test: every unknown must satisfy reltol/abstol, no device may
    // object, and no limiting may have been applied on this iteration.
    let ok = iter > 0 && !ctx.limited;
    if (ok) {
      for (let i = 0; i < n; i++) {
        const a = ctx.x[i];
        const b = ctx.xPrev[i];
        const tol = ctx.reltol * Math.max(Math.abs(a), Math.abs(b)) + ctx.vntol;
        if (Math.abs(a - b) > tol) { ok = false; break; }
      }
    }
    if (ok) {
      for (const d of circuit.devices) if (d.nonlinear) d.checkConvergence(ctx);
      if (ctx.deviceConverged) return { converged: true, iterations: iter + 1 };
    }
  }
  return { converged: false, iterations: maxIter, reason: 'iteration limit' };
}

/**
 * Solve with the full convergence ladder. Used for the operating point and for
 * the first point of a DC sweep or transient run.
 */
export function solveDC(circuit, opts = {}) {
  const ctx = circuit.ctx;
  const maxIter = opts.maxIter ?? circuit.options.itl1;
  const baseGmin = circuit.options.gmin;

  ctx.sourceFactor = 1;
  ctx.gmin = baseGmin;
  ctx.forceInit = true;
  ctx.x.fill(0);

  let r = newton(circuit, Mode.OP, maxIter);
  if (r.converged) return { ...r, method: 'direct' };

  // --- gmin stepping ---
  ctx.forceInit = true;
  ctx.x.fill(0);
  for (let gmin = 1e-3; gmin >= baseGmin; gmin /= 10) {
    ctx.gmin = gmin;
    r = newton(circuit, Mode.OP, maxIter);
    ctx.forceInit = false;
    if (!r.converged) break;
    if (gmin <= baseGmin) return { ...r, method: 'gmin stepping' };
  }

  // --- source stepping ---
  ctx.gmin = baseGmin;
  ctx.forceInit = true;
  ctx.x.fill(0);
  let converged = false;
  for (const f of [0, 0.01, 0.05, 0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9, 0.95, 1]) {
    ctx.sourceFactor = f;
    r = newton(circuit, Mode.OP, maxIter);
    ctx.forceInit = false;
    if (!r.converged) { converged = false; break; }
    converged = f === 1;
  }
  ctx.sourceFactor = 1;
  if (converged) return { ...r, method: 'source stepping' };

  throw new ConvergenceError(
    `operating point did not converge (${r.reason ?? 'unknown'})`,
    { iterations: r.iterations, reason: r.reason }
  );
}
