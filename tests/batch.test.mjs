/**
 * Batch analysis: sweeps, corners and Monte Carlo.
 *
 * The property that matters is that a swept case agrees with the same circuit
 * run on its own. A sweep that quietly drifts from a single run — because an
 * override did not apply, or applied to the wrong thing — produces a smooth,
 * plausible curve of wrong numbers, which is the failure mode this whole
 * project keeps guarding against.
 */
import { createRequire } from 'node:module';
import {
  mulberry32, runCase, sampleSets, summarize, sweepValues, withOverrides,
} from '../src/worker/batch-core.js';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [pass] ${name}`); }
  else { fail++; failures.push(`${name}: ${detail}`); console.log(`  [FAIL] ${name} ${detail}`); }
}
const eqv = (name, a, b) =>
  check(name, a === b, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
const near = (name, a, b, tol) =>
  check(name, Math.abs(a - b) <= tol, `got ${a}, expected ${b} (tol ${tol})`);

const require = createRequire(import.meta.url);
const wasm = require('../src/wasm-node/spicelab_wasm.js');
const Session = wasm.Session;
const memory = () => wasm.memory;

console.log('\nOverride splicing');
{
  const n = withOverrides('t\nR1 a 0 1k\n.end', { rval: 2000 });
  check('appends the param', /\.param rval=2000/.test(n), n);
  check('keeps exactly one .end', (n.match(/^\s*\.end\s*$/gim) ?? []).length === 1, n);
  check('.end is last', /\.param rval=2000\n\.end$/.test(n), JSON.stringify(n));

  // `.ends` closes a subcircuit and must survive.
  const s = withOverrides('t\n.subckt d a b\nR1 a b 1k\n.ends\nX1 x y d\n.end', { k: 1 });
  check('.ends is not stripped', /\.ends/.test(s), s);
  eqv('only the bare .end is removed', (s.match(/^\s*\.end\s*$/gim) ?? []).length, 1);
}

console.log('\nSweep and sample generation');
{
  const lin = sweepValues({ start: 0, stop: 10, points: 5 });
  eqv('linear count', lin.length, 5);
  eqv('linear start', lin[0], 0);
  eqv('linear stop', lin[4], 10);
  near('linear midpoint', lin[2], 5, 1e-12);

  const log = sweepValues({ start: 1, stop: 1000, points: 4, scale: 'log' });
  near('log start', log[0], 1, 1e-12);
  near('log stop', log[3], 1000, 1e-9);
  near('log is geometric', log[1], 10, 1e-9);
}
{
  // Reproducibility is the point of seeding: a Monte Carlo result that cannot
  // be reproduced cannot be investigated.
  const spec = { r: { nominal: 1000, tol: 0.05 } };
  const a = sampleSets(spec, 50, 7);
  const b = sampleSets(spec, 50, 7);
  const c = sampleSets(spec, 50, 8);
  eqv('same seed reproduces exactly', JSON.stringify(a), JSON.stringify(b));
  check('different seed differs', JSON.stringify(a) !== JSON.stringify(c));

  const vals = a.map((s) => s.r);
  const mean = vals.reduce((x, y) => x + y, 0) / vals.length;
  near('gaussian mean sits near nominal', mean, 1000, 15);
  // tol is 3 sigma, so essentially everything lands inside the stated band.
  const inside = vals.filter((v) => Math.abs(v - 1000) <= 50).length;
  check('tol is read as 3 sigma', inside >= 48, `${inside}/50 inside +/-5%`);

  const u = sampleSets({ r: { nominal: 100, tol: 0.1, dist: 'uniform' } }, 200, 3);
  const uv = u.map((s) => s.r);
  check('uniform stays strictly inside the band',
        uv.every((v) => v >= 90 - 1e-9 && v <= 110 + 1e-9),
        `${Math.min(...uv)}..${Math.max(...uv)}`);
}
{
  const rnd = mulberry32(42);
  const xs = Array.from({ length: 1000 }, rnd);
  check('prng stays in [0,1)', xs.every((x) => x >= 0 && x < 1));
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  near('prng mean is about 0.5', m, 0.5, 0.05);
}

console.log('\nOne case agrees with a direct run');
{
  // A divider whose lower leg is a parameter.
  const netlist = `divider sweep
.param rbot=3k
V1 in 0 DC 10
R1 in mid 1k
R2 mid 0 {rbot}
.end`;

  const r = runCase(Session, memory, {
    netlist,
    overrides: { rbot: 3000 },
    analysis: { type: 'op' },
    measures: [{ name: 'vmid', probe: 'mid' }],
  });
  check('case ran', r.ok, r.error ?? '');
  near('matches the hand-computed divider', r.values.vmid, 7.5, 1e-9);

  // The override must actually take effect, not be silently ignored.
  const r2 = runCase(Session, memory, {
    netlist,
    overrides: { rbot: 1000 },
    analysis: { type: 'op' },
    measures: [{ name: 'vmid', probe: 'mid' }],
  });
  near('override changes the answer', r2.values.vmid, 5.0, 1e-9);

  // ...and with no override the netlist default applies.
  const r3 = runCase(Session, memory, {
    netlist, analysis: { type: 'op' },
    measures: [{ name: 'vmid', probe: 'mid' }],
  });
  near('default is used when not overridden', r3.values.vmid, 7.5, 1e-9);
}

console.log('\nA sweep traces the analytic curve');
{
  const netlist = `divider sweep
.param rbot=1k
V1 in 0 DC 10
R1 in mid 1k
R2 mid 0 {rbot}
.end`;
  const values = sweepValues({ start: 100, stop: 10000, points: 12, scale: 'log' });
  let worst = 0;
  for (const rb of values) {
    const r = runCase(Session, memory, {
      netlist, overrides: { rbot: rb },
      analysis: { type: 'op' },
      measures: [{ name: 'vmid', probe: 'mid' }],
    });
    const want = 10 * rb / (1000 + rb);
    worst = Math.max(worst, Math.abs(r.values.vmid - want));
  }
  check('every swept point matches 10*Rb/(1k+Rb)', worst < 1e-9, `worst error ${worst}`);
}

console.log('\nTransient and AC measurements');
{
  const netlist = `rc
.param rval=1k
V1 in 0 DC 0 AC 1 PULSE(0 1 0 1p 1p 1 0)
R1 in out {rval}
C1 out 0 1u
.end`;

  const t = runCase(Session, memory, {
    netlist,
    analysis: { type: 'tran', tstop: 5e-3, tstep: 1e-5, tmax: 2e-5, method: 'trap' },
    measures: [
      { name: 'final', probe: 'out', measure: 'final' },
      { name: 'peak', probe: 'out', measure: 'max' },
      { name: 'at1tau', probe: 'out', measure: 'at', at: 1e-3 },
    ],
  });
  check('transient case ran', t.ok, t.error ?? '');
  // tstop is 5 tau, so the step has reached 1 - e^-5, NOT 1. Asserting 1.0
  // here would be asserting the wrong physics and would only pass on a
  // sufficiently sloppy tolerance.
  near('final value is 1-e^-5 at 5 tau', t.values.final, 1 - Math.exp(-5), 3e-3);
  near('one tau is 1-1/e', t.values.at1tau, 1 - Math.exp(-1), 3e-3);
  // A first-order step is monotonic, so the maximum is the final value and
  // there is no overshoot.
  near('peak equals the final value (monotonic)', t.values.peak, t.values.final, 1e-12);
  check('never exceeds the drive amplitude', t.values.peak <= 1.0 + 1e-9,
        `peak ${t.values.peak}`);

  const a = runCase(Session, memory, {
    netlist,
    analysis: { type: 'ac', scale: 'dec', points: 40, start: 1, stop: 1e6 },
    measures: [
      { name: 'bw', probe: 'out', measure: 'bw3db' },
      { name: 'dc', probe: 'out', measure: 'at', at: 1 },
    ],
  });
  check('ac case ran', a.ok, a.error ?? '');
  const fc = 1 / (2 * Math.PI * 1000 * 1e-6);
  near('3 dB bandwidth matches 1/(2*pi*R*C)', a.values.bw, fc, fc * 0.06);
  near('DC gain is 0 dB', a.values.dc, 0, 0.01);

  // Sweeping R must move the corner inversely.
  const bw = [];
  for (const rv of [500, 1000, 2000]) {
    const r = runCase(Session, memory, {
      netlist, overrides: { rval: rv },
      analysis: { type: 'ac', scale: 'dec', points: 40, start: 1, stop: 1e6 },
      measures: [{ name: 'bw', probe: 'out', measure: 'bw3db' }],
    });
    bw.push(r.values.bw);
  }
  check('halving R doubles the bandwidth', bw[0] > bw[1] && bw[1] > bw[2],
        JSON.stringify(bw));
  near('bandwidth scales as 1/R', bw[0] / bw[2], 4, 0.3);
}

console.log('\nMonte Carlo');
{
  const netlist = `divider mc
.param rtop=1k
.param rbot=1k
V1 in 0 DC 10
R1 in mid {rtop}
R2 mid 0 {rbot}
.end`;
  const sets = sampleSets({
    rtop: { nominal: 1000, tol: 0.05 },
    rbot: { nominal: 1000, tol: 0.05 },
  }, 200, 12345);

  const results = sets.map((s) => runCase(Session, memory, {
    netlist, overrides: s,
    analysis: { type: 'op' },
    measures: [{ name: 'vmid', probe: 'mid' }],
  }));

  check('every trial converged', results.every((r) => r.ok),
        results.find((r) => !r.ok)?.error ?? '');

  const st = summarize(results, ['vmid']).vmid;
  eqv('summary counts every trial', st.n, 200);
  near('mean sits at the nominal 5 V', st.mean, 5.0, 0.05);
  check('spread is non-zero', st.sd > 0.001, `sd=${st.sd}`);
  // Two independent 5% (3 sigma) parts on a 2:1 divider give roughly 1.2% 3-sigma
  // on the midpoint, so the whole population stays well inside +/-5%.
  check('all trials inside a sane band',
        st.min > 4.5 && st.max < 5.5, `${st.min}..${st.max}`);
  check('percentiles are ordered', st.p1 <= st.p50 && st.p50 <= st.p99,
        `${st.p1} ${st.p50} ${st.p99}`);
}

console.log('\nFailures are reported, not thrown');
{
  const bad = runCase(Session, memory, {
    netlist: 'broken\nR1 a b\n.end',
    analysis: { type: 'op' },
    measures: [{ name: 'x', probe: 'a' }],
  });
  check('a malformed netlist returns ok:false', !bad.ok, JSON.stringify(bad));
  check('with a message', typeof bad.error === 'string' && bad.error.length > 0);

  const floating = runCase(Session, memory, {
    netlist: 'no ground\nV1 a b DC 1\nR1 a b 1k\n.end',
    analysis: { type: 'op' },
    measures: [{ name: 'x', probe: 'a' }],
  });
  check('an unsolvable circuit is reported too', !floating.ok, JSON.stringify(floating));

  // A summary over mixed results must ignore the failures rather than poison
  // the statistics with NaN.
  const st = summarize([
    { ok: true, values: { v: 1 } },
    { ok: false },
    { ok: true, values: { v: 3 } },
    { ok: true, values: { v: NaN } },
  ], ['v']).v;
  eqv('summary skips failed and non-finite cases', st.n, 2);
  near('and averages the rest', st.mean, 2, 1e-12);
}

console.log(`\n${'-'.repeat(72)}`);
console.log(`${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  ' + f);
  process.exit(1);
}
