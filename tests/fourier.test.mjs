/**
 * `.four` against signals whose spectra are known exactly.
 *
 * A DFT that is subtly wrong still returns a smooth, plausible spectrum, so
 * "it produced numbers" proves nothing. Every case here has a closed form:
 *
 *   - a pure sine       exactly one harmonic, THD exactly 0
 *   - a square wave     odd harmonics only, amplitude 4A/(pi*n) — the classic
 *                       1, 1/3, 1/5 ratios and THD 48.34%
 *   - a known 2nd       a deliberate second harmonic at a chosen ratio
 *
 * The square wave is the load-bearing one: it pins the scaling, the harmonic
 * INDEXING and the THD convention all at once, and it is the case a windowing
 * or off-by-one-bin mistake fails.
 */
import { fourier } from '../src/instruments/fourier.js';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [pass] ${name}`); }
  else { fail++; failures.push(`${name}: ${detail}`); console.log(`  [FAIL] ${name} ${detail}`); }
}
const near = (name, a, b, tol) =>
  check(name, Math.abs(a - b) <= tol, `got ${a}, expected ${b} (tol ${tol})`);

/** Sample `f` over `cycles` periods of `freq`, deliberately NON-uniformly. */
function sample(f, freq, cycles = 3, n = 4000, jitter = 0) {
  const t = [], v = [];
  const span = cycles / freq;
  for (let i = 0; i <= n; i++) {
    // A real transient's timestep varies; a fixed grid would let a resampling
    // bug pass unnoticed, which is the whole reason resampling exists.
    const u = i / n + (jitter ? jitter * Math.sin(17 * i) / n : 0);
    const tt = Math.min(span, Math.max(0, u * span));
    t.push(tt);
    v.push(f(tt));
  }
  return [t, v];
}

const F = 1000;

console.log('\nA pure sine has one harmonic and no distortion');
{
  const A = 2.5;
  const [t, v] = sample((x) => A * Math.sin(2 * Math.PI * F * x), F);
  const r = fourier(t, v, F);
  near('fundamental amplitude', r.harmonics[1].mag, A, 1e-3);
  near('THD is zero', r.thd, 0, 1e-3);
  near('DC is zero', r.dc, 0, 1e-3);
  check('harmonics above the first are negligible',
        r.harmonics.slice(2).every((h) => h.mag < 1e-3 * A),
        JSON.stringify(r.harmonics.slice(2).map((h) => h.mag)));
  near('the fundamental is reported at the right frequency', r.harmonics[1].freq, F, 0);
}

console.log('\nA DC offset lands in bin 0, not in the fundamental');
{
  const [t, v] = sample((x) => 1.25 + Math.sin(2 * Math.PI * F * x), F);
  const r = fourier(t, v, F);
  near('DC term', r.dc, 1.25, 1e-3);
  near('fundamental is unaffected by the offset', r.harmonics[1].mag, 1, 1e-3);
}

console.log('\nA square wave has the textbook odd-harmonic series');
{
  // 4A/pi * (sin w t + sin3/3 + sin5/5 + ...)
  const A = 1;
  const [t, v] = sample((x) => (Math.sin(2 * Math.PI * F * x) >= 0 ? A : -A), F, 3, 20000);
  const r = fourier(t, v, F);
  const fund = (4 * A) / Math.PI;
  near('fundamental is 4A/pi', r.harmonics[1].mag, fund, 0.02);
  // The ratios are what a scaling or indexing error breaks.
  near('3rd harmonic is 1/3', r.harmonics[3].norm, 1 / 3, 0.02);
  near('5th harmonic is 1/5', r.harmonics[5].norm, 1 / 5, 0.02);
  near('7th harmonic is 1/7', r.harmonics[7].norm, 1 / 7, 0.02);
  check('even harmonics are absent',
        [2, 4, 6, 8].every((k) => r.harmonics[k].norm < 0.02),
        JSON.stringify([2, 4, 6, 8].map((k) => r.harmonics[k].norm)));
  // THD of a square wave over harmonics 2..9 is sqrt(1/9+1/25+1/49+1/81).
  const expect = Math.hypot(1 / 3, 1 / 5, 1 / 7, 1 / 9) * 100;
  near('THD matches the closed form', r.thd, expect, 1.0);
}

console.log('\nA known second harmonic is measured, not invented');
{
  const [t, v] = sample(
    (x) => Math.sin(2 * Math.PI * F * x) + 0.2 * Math.sin(2 * Math.PI * 2 * F * x), F);
  const r = fourier(t, v, F);
  near('2nd harmonic ratio', r.harmonics[2].norm, 0.2, 2e-3);
  near('THD is that one harmonic', r.thd, 20, 0.2);
}

console.log('\nThe window is a whole number of periods, taken from the end');
{
  // A start-up transient that has decayed by the end. Including it would
  // inflate THD; the window must exclude it.
  const [t, v] = sample(
    (x) => Math.sin(2 * Math.PI * F * x) + 3 * Math.exp(-x * 4000), F, 6, 8000);
  const r = fourier(t, v, F, { periods: 1 });
  near('the window is exactly one period', r.window.t1 - r.window.t0, 1 / F, 1e-12);
  check('the window ends at the last sample', Math.abs(r.window.t1 - t[t.length - 1]) < 1e-12);
  check('start-up distortion is excluded', r.thd < 2, `THD ${r.thd}`);

  // Multiple periods must select the SAME harmonics, not bins shifted by the
  // period count — a bug that still yields a smooth spectrum.
  const one = fourier(t, v, F, { periods: 1 });
  const three = fourier(t, v, F, { periods: 3 });
  near('periods:3 finds the same fundamental',
       three.harmonics[1].mag, one.harmonics[1].mag, 5e-3);
  near('periods:3 reports the same frequency', three.harmonics[3].freq, 3 * F, 0);
}

console.log('\nRefusals are specific');
{
  const [t, v] = sample((x) => Math.sin(2 * Math.PI * F * x), F, 3);
  let msg = '';
  try { fourier(t, v, 10); } catch (e) { msg = e.message; }
  check('too short a run is refused, and says to extend tstop',
        /extend tstop/i.test(msg), msg);
  msg = '';
  try { fourier(t, v, 0); } catch (e) { msg = e.message; }
  check('a zero fundamental is refused', /positive/i.test(msg), msg);
  msg = '';
  try { fourier([0], [0], F); } catch (e) { msg = e.message; }
  check('a one-point run is refused', /two points/i.test(msg), msg);
}

console.log(`\n${'-'.repeat(72)}\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  ' + f);
  process.exit(1);
}
