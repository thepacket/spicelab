/**
 * `.measure`, against waveforms whose answers are known exactly.
 *
 * The two cases that matter most are the ones a plausible implementation gets
 * wrong:
 *
 *   - NON-UNIFORM sampling. A transient packs points where the waveform moves,
 *     so AVG and RMS computed as the mean of samples are weighted by the
 *     solver's timestep choices rather than by the signal. Every waveform here
 *     is sampled non-uniformly on purpose, and the expected values are the
 *     time integrals.
 *   - CROSSING times between samples. A time snapped to the nearest sample is
 *     quantised by the timestep, which looks like a slightly different delay
 *     and moves when tolerances change. The ramps here cross deliberately
 *     BETWEEN samples.
 */
import { measureOne, measureAll, num } from '../src/instruments/measure.js';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [pass] ${name}`); }
  else { fail++; failures.push(`${name}: ${detail}`); console.log(`  [FAIL] ${name} ${detail}`); }
}
const near = (name, a, b, tol) =>
  check(name, a != null && Math.abs(a - b) <= tol, `got ${a}, expected ${b} (tol ${tol})`);

/** A signal sampled at deliberately uneven times. */
function build(f, tmax, n = 500) {
  const t = [], v = [];
  for (let i = 0; i <= n; i++) {
    // Quadratic spacing: dense at the start, sparse at the end. The mean of
    // samples and the time average differ substantially here.
    const x = (i / n) ** 2 * tmax;
    t.push(x); v.push(f(x));
  }
  return { t, v };
}

const data = (sigs) => ({
  t: sigs.t,
  get: (n) => sigs[n.toLowerCase()] ?? null,
});

console.log('\nSuffixes');
{
  near('plain number', num('2.5'), 2.5, 0);
  near('milli', num('5m'), 5e-3, 0);
  near('meg beats milli', num('2meg'), 2e6, 0);
  near('micro, ASCII', num('470u'), 470e-6, 0);
  // The MICRO SIGN is two UTF-8 bytes; matching the byte gives 470 farads.
  near('micro, U+00B5', num('470µ'), 470e-6, 0);
  near('micro, U+03BC', num('470μ'), 470e-6, 0);
  near('a trailing unit is ignored', num('1.5kOhm'), 1500, 0);
}

console.log('\nAggregates are time integrals, not sample means');
{
  // v = t over [0, 1]. Time average is exactly 0.5; RMS is 1/sqrt(3).
  // The MEAN OF SAMPLES with quadratic spacing is about 0.375 — a 25% error
  // that looks entirely reasonable.
  const s = build((x) => x, 1);
  const d = data({ t: s.t, out: s.v });
  near('AVG is the time average', measureOne('.measure tran a AVG V(out)', d).value, 0.5, 1e-4);
  near('RMS is the time RMS', measureOne('.measure tran r RMS V(out)', d).value,
       1 / Math.sqrt(3), 1e-4);
  near('INTEG is the area', measureOne('.measure tran i INTEG V(out)', d).value, 0.5, 1e-4);
  near('MAX', measureOne('.measure tran m MAX V(out)', d).value, 1, 1e-9);
  near('MIN', measureOne('.measure tran m MIN V(out)', d).value, 0, 1e-9);
  near('PP', measureOne('.measure tran p PP V(out)', d).value, 1, 1e-9);

  // A sample mean would give ~0.375 here; assert we are not that.
  const mean = s.v.reduce((a, b) => a + b, 0) / s.v.length;
  check('the sample mean really is different, so the test has teeth',
        Math.abs(mean - 0.5) > 0.05, `sample mean ${mean}`);
}

console.log('\nFROM/TO windows include partial end intervals');
{
  const s = build((x) => x, 1, 37);   // coarse, so the window edges miss samples
  const d = data({ t: s.t, out: s.v });
  // Average of v = t over [0.3, 0.7] is exactly 0.5.
  near('AVG over a window', measureOne('.measure tran a AVG V(out) FROM=0.3 TO=0.7', d).value,
       0.5, 2e-3);
  // Area over [0.25, 0.75] is (0.75^2 - 0.25^2)/2 = 0.25.
  near('INTEG over a window',
       measureOne('.measure tran i INTEG V(out) FROM=0.25 TO=0.75', d).value, 0.25, 2e-3);
  check('a window with no data is reported, not silently zero',
        measureOne('.measure tran a AVG V(out) FROM=5 TO=6', d).error != null);
}

console.log('\nCrossings are interpolated, not snapped');
{
  // v = t over [0, 1], sampled every 0.1 — so v = 0.55 falls exactly halfway
  // between two samples. Snapping would give 0.5 or 0.6.
  const t = [], v = [];
  for (let i = 0; i <= 10; i++) { t.push(i / 10); v.push(i / 10); }
  const d = data({ t, out: v, ref: v.map(() => 0.55) });
  near('WHEN interpolates between samples',
       measureOne('.measure tran w WHEN V(out)=0.55', d).value, 0.55, 1e-12);
  near('FIND ... WHEN reads the other signal at that instant',
       measureOne('.measure tran f FIND V(out) WHEN V(out)=0.55', d).value, 0.55, 1e-12);
  near('FIND ... AT interpolates too',
       measureOne('.measure tran f FIND V(out) AT=0.35', d).value, 0.35, 1e-12);
  // Signal-to-signal comparison crosses the DIFFERENCE through zero.
  near('WHEN compares two signals',
       measureOne('.measure tran w WHEN V(out)=V(ref)', d).value, 0.55, 1e-12);
}

console.log('\nEdges and the nth crossing');
{
  // A triangle: up 0->1 over [0,1], down 1->0 over [1,2], up again over [2,3].
  const t = [], v = [];
  for (let i = 0; i <= 300; i++) {
    const x = (i / 300) * 3;
    t.push(x);
    v.push(x < 1 ? x : x < 2 ? 2 - x : x - 2);
  }
  const d = data({ t, out: v });
  near('RISE=1 finds the first rising crossing',
       measureOne('.measure tran w WHEN V(out)=0.5 RISE=1', d).value, 0.5, 5e-3);
  near('FALL=1 finds the falling one',
       measureOne('.measure tran w WHEN V(out)=0.5 FALL=1', d).value, 1.5, 5e-3);
  near('RISE=2 finds the second rising crossing',
       measureOne('.measure tran w WHEN V(out)=0.5 RISE=2', d).value, 2.5, 5e-3);
  check('a crossing that never happens is reported, not returned as 0',
        measureOne('.measure tran w WHEN V(out)=99', d).error != null);
}

console.log('\nTRIG ... TARG measures a delay');
{
  // a crosses 0.5 at t=0.5; b is a delayed by 0.25, crossing at t=0.75.
  const t = [], a = [], b = [];
  for (let i = 0; i <= 1000; i++) {
    const x = i / 1000;
    t.push(x); a.push(x); b.push(Math.max(0, x - 0.25));
  }
  const d = data({ t, a, b });
  const r = measureOne('.measure tran td TRIG V(a) VAL=0.5 RISE=1 TARG V(b) VAL=0.5 RISE=1', d);
  near('the delay is the difference of two interpolated crossings', r.value, 0.25, 2e-3);
  check('the result is a time', r.unit === 's', JSON.stringify(r));
  check('a TARG that never fires is reported',
        measureOne('.measure tran td TRIG V(a) VAL=0.5 TARG V(b) VAL=99', d).error != null);
}

console.log('\nDERIV');
{
  // v = 3t, so dv/dt = 3 everywhere.
  const t = [], v = [];
  for (let i = 0; i <= 200; i++) { t.push(i / 200); v.push(3 * (i / 200)); }
  const d = data({ t, out: v });
  near('slope of a ramp', measureOne('.measure tran s DERIV V(out) AT=0.5', d).value, 3, 1e-6);
}

console.log('\nRefusals name the problem');
{
  const d = data({ t: [0, 1], out: [0, 1] });
  const r = measureOne('.measure tran x FOURIER V(out)', d);
  check('an unimplemented function is reported as such',
        /not implemented/i.test(r.error ?? ''), JSON.stringify(r));
  check('and does NOT return a number', r.value === null, JSON.stringify(r));
  const u = measureOne('.measure tran x MAX V(nope)', d);
  check('an unknown signal is named', /nope/.test(u.error ?? ''), JSON.stringify(u));
}

console.log('\nEvery card in a netlist is run');
{
  const t = [], v = [];
  for (let i = 0; i <= 100; i++) { t.push(i / 100); v.push(i / 100); }
  const d = data({ t, out: v });
  const netlist = [
    'title', 'V1 out 0 1',
    '.measure tran vmax MAX V(out)',
    '.MEAS TRAN vavg AVG V(out)',
    '* .measure tran ignored MAX V(out)',
    '.end',
  ].join('\n');
  const rs = measureAll(netlist, d);
  check('both cards run, and the comment is not one', rs.length === 2,
        JSON.stringify(rs.map((r) => r.name)));
  near('first', rs[0].value, 1, 1e-9);
  near('second', rs[1].value, 0.5, 1e-3);
}

console.log(`\n${'-'.repeat(72)}\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  ' + f);
  process.exit(1);
}
