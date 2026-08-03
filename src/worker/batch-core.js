/**
 * Batch analysis: parameter sweeps, corners and Monte Carlo.
 *
 * SCOPE NOTE, because CLAUDE.md is emphatic about it. "Batch on the GPU" means
 * hundreds of INDEPENDENT circuits factored in parallel — not one matrix split
 * across threads. A single circuit's sparse LU is a sequential dependency chain
 * and belongs on the CPU. This module keeps that boundary: every case here is a
 * whole, independent solve, and the parallelism is across cases.
 *
 * The current executor is a CPU worker pool (see batch.js). That is the right
 * first implementation: it reuses the Rust core exactly as validated, so a
 * sweep cannot disagree with a single run. A WGSL batch factoriser would mean
 * reimplementing the numerics in a language where they cannot be diffed against
 * the JS oracle — a large piece of work that should not start until the CPU
 * pool is measurably the bottleneck.
 *
 * This file is deliberately free of workers and of wasm-bindgen specifics: it
 * takes a `Session` constructor and a memory accessor, so the same code runs
 * inside a browser worker and directly under Node in the tests.
 */
import { Probe, ProbeKind } from '../instruments/probe.js';

/**
 * Splice parameter overrides into a netlist.
 *
 * Overrides are appended rather than substituted textually because the parser
 * evaluates `.param` in declaration order with later definitions winning — so
 * appending is exact, while regex-replacing a value would also hit comments,
 * model cards and any net that happened to share the name.
 */
export function withOverrides(netlist, overrides = {}) {
  const keys = Object.keys(overrides);
  // Strip a terminating `.end` (but never `.ends`, which closes a subcircuit).
  const body = netlist
    .split('\n')
    .filter((l) => !/^\s*\.end\s*$/i.test(l))
    .join('\n');
  if (!keys.length) return `${body}\n.end`;
  const params = keys.map((k) => `.param ${k}=${overrides[k]}`).join('\n');
  return `${body}\n${params}\n.end`;
}

/** Deterministic PRNG, so a Monte Carlo run reproduces exactly. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, using the supplied uniform source. */
function gauss(rnd) {
  let u = 0;
  while (u === 0) u = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

/**
 * Generate parameter sets for a Monte Carlo run.
 *
 * `tol` is a fraction. A gaussian spec treats `tol` as 3 sigma, which is the
 * usual reading of a component tolerance — sampling it as 1 sigma would put a
 * third of the population outside the stated tolerance.
 *
 * @param {Record<string, {nominal:number, tol:number, dist?:'gauss'|'uniform'}>} spec
 */
export function sampleSets(spec, trials, seed = 1) {
  const rnd = mulberry32(seed);
  const names = Object.keys(spec);
  const out = [];
  for (let i = 0; i < trials; i++) {
    const set = {};
    for (const n of names) {
      const { nominal, tol = 0, dist = 'gauss' } = spec[n];
      if (dist === 'uniform') {
        set[n] = nominal * (1 + tol * (rnd() * 2 - 1));
      } else {
        set[n] = nominal * (1 + (tol / 3) * gauss(rnd));
      }
    }
    out.push(set);
  }
  return out;
}

/** Linear or logarithmic sweep values. */
export function sweepValues({ start, stop, points = 10, scale = 'lin' }) {
  const out = [];
  const n = Math.max(2, points);
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    out.push(scale === 'log'
      ? start * (stop / start) ** f
      : start + (stop - start) * f);
  }
  return out;
}

function resolveProbe(target, labels, kind = ProbeKind.VOLTAGE) {
  return new Probe({ kind, target }).resolve(labels);
}

/**
 * Reduce one analysis result to the requested scalars.
 *
 * Measurements run HERE, inside the worker, so a thousand-case sweep transfers
 * a thousand numbers rather than a thousand waveforms.
 */
function measureTran(measures, labels, times, rows, stride) {
  const out = {};
  for (const m of measures) {
    const r = resolveProbe(m.probe, labels, m.kind === 'current'
      ? ProbeKind.CURRENT : ProbeKind.VOLTAGE);
    if (!r.ok) { out[m.name] = NaN; continue; }
    let lo = Infinity, hi = -Infinity, last = NaN, atVal = NaN;
    let bestDt = Infinity;
    for (let i = 0; i < times.length; i++) {
      const v = r.read(rows, i * stride + 1);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      last = v;
      if (m.at !== undefined) {
        const d = Math.abs(times[i] - m.at);
        if (d < bestDt) { bestDt = d; atVal = v; }
      }
    }
    switch (m.measure) {
      case 'max': out[m.name] = hi; break;
      case 'min': out[m.name] = lo; break;
      case 'peak2peak': out[m.name] = hi - lo; break;
      case 'at': out[m.name] = atVal; break;
      default: out[m.name] = last; break;   // 'final'
    }
  }
  return out;
}

function measureAc(measures, labels, points, stride, data) {
  const out = {};
  for (const m of measures) {
    const r = resolveProbe(m.probe, labels);
    if (!r.ok) { out[m.name] = NaN; continue; }
    const mag = [];
    const freq = [];
    for (let k = 0; k < points; k++) {
      const base = k * stride + 1;
      const re = r.read(data, base, 2, 0);
      const im = r.read(data, base, 2, 1);
      freq.push(data[k * stride]);
      mag.push(20 * Math.log10(Math.hypot(re, im) || 1e-300));
    }
    if (m.measure === 'bw3db') {
      // First crossing below (peak - 3 dB), scanning up from DC.
      const peak = Math.max(...mag);
      let bw = freq[freq.length - 1];
      for (let k = 0; k < mag.length; k++) {
        if (mag[k] <= peak - 3.0103) { bw = freq[k]; break; }
      }
      out[m.name] = bw;
    } else if (m.measure === 'peak_db') {
      out[m.name] = Math.max(...mag);
    } else if (m.measure === 'at') {
      let best = 0;
      for (let k = 0; k < freq.length; k++) {
        if (Math.abs(Math.log(freq[k] / m.at)) < Math.abs(Math.log(freq[best] / m.at))) best = k;
      }
      out[m.name] = mag[best];
    } else {
      out[m.name] = mag[0];
    }
  }
  return out;
}

/**
 * Run one case to completion and return only its measurements.
 *
 * @param {Function} Session wasm-bindgen Session class
 * @param {() => WebAssembly.Memory} memory
 * @param {object} spec { netlist, overrides, analysis, measures }
 */
export function runCase(Session, memory, spec) {
  const { netlist, overrides = {}, analysis, measures = [] } = spec;
  const src = withOverrides(netlist, overrides);
  let session;
  try {
    session = Session.fromNetlist(src);
  } catch (e) {
    return { ok: false, error: `parse/build: ${String(e?.message ?? e)}`, overrides };
  }

  try {
    const labels = session.labels().split('\n');

    if (analysis.type === 'op') {
      session.solveOp();
      const row = new Float64Array(memory().buffer, session.stagingPtr, session.stagingLen);
      const values = {};
      for (const m of measures) {
        const r = resolveProbe(m.probe, labels, m.kind === 'current'
          ? ProbeKind.CURRENT : ProbeKind.VOLTAGE);
        values[m.name] = r.ok ? r.read(row, 1) : NaN;
      }
      return { ok: true, values, overrides };
    }

    if (analysis.type === 'ac') {
      const { scale = 'dec', points = 20, start = 1, stop = 1e6 } = analysis;
      const n = session.runAc(scale, points, start, stop);
      const stride = 1 + 2 * session.numUnknowns;
      const data = new Float64Array(memory().buffer, session.stagingPtr, n * stride);
      return { ok: true, values: measureAc(measures, labels, n, stride, data), overrides };
    }

    // Transient. Accumulate into plain arrays; the caller only gets scalars.
    const { tstop, tstep, tmax = 0, uic = false, method = '' } = analysis;
    session.beginTran(tstop, tstep, tmax, uic, method);
    const stride = session.stride;
    const times = [];
    const rows = [];
    // A cap keeps a pathological case from exhausting memory in a batch of
    // hundreds; it is generous relative to any sane sweep point count.
    const MAX_ROWS = 2_000_000;
    while (!session.done) {
      const got = session.advance(256, 4096);
      if (!got) break;
      const view = new Float64Array(memory().buffer, session.stagingPtr, got * stride);
      for (let i = 0; i < got * stride; i++) rows.push(view[i]);
      for (let r = 0; r < got; r++) times.push(view[r * stride]);
      if (times.length > MAX_ROWS) break;
    }
    const flat = Float64Array.from(rows);
    return {
      ok: true,
      values: measureTran(measures, labels, times, flat, stride),
      points: times.length,
      overrides,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e), overrides };
  }
}

/** Descriptive statistics over a set of case results, per measurement. */
export function summarize(results, measureNames) {
  const out = {};
  for (const name of measureNames) {
    const xs = results
      .filter((r) => r.ok && Number.isFinite(r.values?.[name]))
      .map((r) => r.values[name])
      .sort((a, b) => a - b);
    if (!xs.length) { out[name] = null; continue; }
    const n = xs.length;
    const mean = xs.reduce((a, b) => a + b, 0) / n;
    const varr = n > 1
      ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)
      : 0;
    const pct = (p) => xs[Math.min(n - 1, Math.max(0, Math.round((p / 100) * (n - 1))))];
    out[name] = {
      n, mean, sd: Math.sqrt(varr),
      min: xs[0], max: xs[n - 1],
      p1: pct(1), p50: pct(50), p99: pct(99),
    };
  }
  return out;
}
