/**
 * DC operating point, DC sweep, and AC small-signal sweep.
 */
import { Mode } from '../device.js';
import { solveDC, newton, ConvergenceError } from '../newton.js';

/** Compute and return the DC operating point. */
export function op(circuit) {
  circuit.ensureBuilt();
  const r = solveDC(circuit);
  circuit.ctx.xOld.set(circuit.ctx.x);
  return { ...r, solution: Float64Array.from(circuit.ctx.x), labels: circuit.labels.slice() };
}

/**
 * Sweep a source (or any device property) and record the solution at each step.
 * @param {object} circuit
 * @param {{device:string, property?:string, start:number, stop:number, step:number}} sweep
 * @param {{device:string, property?:string, start:number, stop:number, step:number}} [sweep2]
 */
export function dcSweep(circuit, sweep, sweep2 = null) {
  circuit.ensureBuilt();
  const ctx = circuit.ctx;
  const find = (name) => {
    const d = circuit.devices.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!d) throw new Error(`sweep source not found: ${name}`);
    return d;
  };
  const d1 = find(sweep.device);
  const p1 = sweep.property ?? 'dc';
  const d2 = sweep2 ? find(sweep2.device) : null;
  const p2 = sweep2 ? (sweep2.property ?? 'dc') : null;

  const values = (s) => {
    const out = [];
    const n = Math.max(1, Math.round(Math.abs((s.stop - s.start) / s.step)) + 1);
    for (let i = 0; i < n; i++) out.push(s.start + i * s.step);
    return out;
  };

  const outer = d2 ? values(sweep2) : [null];
  const inner = values(sweep);
  const sweepData = [];

  const saved1 = d1[p1];
  const saved2 = d2 ? d2[p2] : null;

  let first = true;
  for (const v2 of outer) {
    if (d2) d2[p2] = v2;
    const trace = { outer: v2, x: [], solutions: [] };
    for (const v1 of inner) {
      d1[p1] = v1;
      let r;
      if (first) {
        r = solveDC(circuit);
        first = false;
      } else {
        ctx.forceInit = false;
        r = newton(circuit, Mode.DC, circuit.options.itl2);
        if (!r.converged) r = solveDC(circuit);
      }
      trace.x.push(v1);
      trace.solutions.push(Float64Array.from(ctx.x));
    }
    sweepData.push(trace);
  }

  d1[p1] = saved1;
  if (d2) d2[p2] = saved2;
  return { sweeps: sweepData, labels: circuit.labels.slice() };
}

/**
 * AC small-signal sweep. Requires a converged operating point first, since the
 * linearization is taken about it.
 * @param {{type:'dec'|'oct'|'lin', points:number, start:number, stop:number}} spec
 */
export function acSweep(circuit, spec) {
  circuit.ensureBuilt();
  op(circuit);

  const freqs = [];
  if (spec.type === 'lin') {
    const n = Math.max(2, spec.points);
    for (let i = 0; i < n; i++) {
      freqs.push(spec.start + ((spec.stop - spec.start) * i) / (n - 1));
    }
  } else {
    const per = spec.type === 'dec' ? Math.log(10) : Math.log(2);
    const total = Math.ceil((Math.log(spec.stop / spec.start) / per) * spec.points);
    for (let i = 0; i <= total; i++) {
      freqs.push(spec.start * Math.exp((per * i) / spec.points));
    }
    if (freqs[freqs.length - 1] < spec.stop) freqs.push(spec.stop);
  }

  const ctx = circuit.ctx;
  const sys = circuit.sys;
  const n = circuit.numUnknowns;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const out = { freq: freqs, re: [], im: [], labels: circuit.labels.slice() };

  for (const f of freqs) {
    ctx.omega = 2 * Math.PI * f;
    circuit.load(Mode.AC);
    const bad = sys.factor();
    if (bad >= 0) throw new ConvergenceError(`singular AC matrix at ${f} Hz`);
    re.set(ctx.rhsRe);
    im.set(ctx.rhsIm);
    sys.solve(re, im);
    out.re.push(Float64Array.from(re));
    out.im.push(Float64Array.from(im));
  }
  return out;
}

/** Convenience: magnitude in dB and phase in degrees for one unknown index. */
export function bode(acResult, index) {
  const mag = [];
  const phase = [];
  for (let k = 0; k < acResult.freq.length; k++) {
    const r = acResult.re[k][index];
    const i = acResult.im[k][index];
    mag.push(20 * Math.log10(Math.hypot(r, i)));
    phase.push((180 / Math.PI) * Math.atan2(i, r));
  }
  return { freq: acResult.freq, mag, phase };
}
