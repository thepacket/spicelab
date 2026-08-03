/**
 * Analytic validation suite.
 *
 * Every case here has a closed-form answer. This is the layer that catches the
 * silent numerical bugs — a sign error in a Jacobian entry produces waveforms
 * that look entirely plausible and are wrong, so plausibility is not a test.
 * Run this before trusting any new device or integration method.
 */
import { Circuit } from '../src/core/circuit.js';
import { Resistor, Capacitor, Inductor, VCVS, VCCS } from '../src/core/devices/primitives.js';
import { VoltageSource, CurrentSource } from '../src/core/devices/sources.js';
import { Diode } from '../src/core/devices/semiconductors.js';
import { BJT } from '../src/core/devices/semiconductors.js';
import { MOSFET } from '../src/core/devices/mosfet.js';
import { op, dcSweep, acSweep, bode } from '../src/core/analyses/dc.js';
import { tran, TransientRun } from '../src/core/analyses/tran.js';

let pass = 0, fail = 0;
const failures = [];

function check(name, actual, expected, tol) {
  const err = Math.abs(actual - expected);
  const rel = Math.abs(expected) > 1e-12 ? err / Math.abs(expected) : err;
  const ok = err <= tol || rel <= tol;
  if (ok) { pass++; }
  else {
    fail++;
    failures.push(`${name}: got ${actual.toPrecision(6)}, expected ${expected.toPrecision(6)}`);
  }
  const mark = ok ? 'pass' : 'FAIL';
  console.log(`  [${mark}] ${name.padEnd(46)} ${Number(actual).toPrecision(6)}  (expect ${Number(expected).toPrecision(6)})`);
}

// ---------------------------------------------------------------- divider
console.log('\nResistive divider — Kirchhoff');
{
  const c = new Circuit();
  const vin = c.node('in'), mid = c.node('mid');
  c.add(new VoltageSource('V1', vin, -1, { dc: 10 }));
  c.add(new Resistor('R1', vin, mid, 1000));
  c.add(new Resistor('R2', mid, -1, 3000));
  op(c);
  check('V(mid) = 10 * 3k/4k', c.voltage('mid'), 7.5, 1e-9);
  check('I(V1) = -2.5 mA', c.current('V1'), -2.5e-3, 1e-9);
}

// ------------------------------------------------------------ current src
console.log('\nCurrent source into resistor — Ohm');
{
  const c = new Circuit();
  const a = c.node('a');
  c.add(new CurrentSource('I1', -1, a, { dc: 1e-3 }));
  c.add(new Resistor('R1', a, -1, 2200));
  op(c);
  check('V(a) = 1mA * 2.2k', c.voltage('a'), 2.2, 1e-9);
}

// ------------------------------------------------------ controlled sources
console.log('\nControlled sources');
{
  const c = new Circuit();
  const i = c.node('in'), o = c.node('out');
  c.add(new VoltageSource('V1', i, -1, { dc: 2 }));
  c.add(new VCVS('E1', o, -1, i, -1, 5));
  c.add(new Resistor('RL', o, -1, 1000));
  op(c);
  check('VCVS gain 5', c.voltage('out'), 10, 1e-9);
}
{
  const c = new Circuit();
  const i = c.node('in'), o = c.node('out');
  c.add(new VoltageSource('V1', i, -1, { dc: 2 }));
  c.add(new VCCS('G1', o, -1, i, -1, 1e-3));
  c.add(new Resistor('RL', o, -1, 1000));
  op(c);
  check('VCCS 1mS into 1k', c.voltage('out'), -2, 1e-9);
}

// ------------------------------------------------------------ RC transient
console.log('\nRC step response — V(t) = V(1 - e^-t/RC)');
{
  const R = 1000, C = 1e-6, tau = R * C;
  for (const method of ['be', 'trap', 'gear2']) {
    const c = new Circuit();
    c.options.method = method;
    const vin = c.node('in'), out = c.node('out');
    c.add(new VoltageSource('V1', vin, -1, {
      dc: 0, tran: { type: 'pulse', v1: 0, v2: 1, td: 0, tr: 1e-12, pw: 1, per: 0 },
    }));
    c.add(new Resistor('R1', vin, out, R));
    c.add(new Capacitor('C1', out, -1, C));
    const r = tran(c, { tstop: 5 * tau, tstep: tau / 100, tmax: tau / 50 });
    const oi = c.indexOf('out');
    // Sample at t = tau and t = 3 tau.
    for (const k of [1, 3]) {
      const target = k * tau;
      let best = 0;
      for (let j = 0; j < r.time.length; j++) {
        if (Math.abs(r.time[j] - target) < Math.abs(r.time[best] - target)) best = j;
      }
      check(`${method}: V(out) at ${k}tau`, r.data[best][oi], 1 - Math.exp(-k), 3e-3);
    }
  }
}

// ----------------------------------------------------------- RLC transient
console.log('\nUnderdamped RLC — ringing frequency and envelope');
{
  const R = 20, L = 1e-3, C = 1e-6;
  const w0 = 1 / Math.sqrt(L * C);
  const alpha = R / (2 * L);
  const wd = Math.sqrt(w0 * w0 - alpha * alpha);
  const c = new Circuit();
  c.options.method = 'trap';
  const vin = c.node('in'), out = c.node('out');
  c.add(new VoltageSource('V1', vin, -1, {
    tran: { type: 'pulse', v1: 0, v2: 1, td: 0, tr: 1e-12, pw: 1, per: 0 },
  }));
  c.add(new Resistor('R1', vin, out, R));
  c.add(new Inductor('L1', out, c.node('m'), L));
  c.add(new Capacitor('C1', c.node('m'), -1, C));
  const period = (2 * Math.PI) / wd;
  const r = tran(c, { tstop: 3 * period, tstep: period / 400, tmax: period / 200 });
  const mi = c.indexOf('m');

  // Locate the first peak; analytically it occurs near t = pi/wd.
  let peakIdx = 0;
  for (let j = 1; j < r.data.length; j++) {
    if (r.data[j][mi] > r.data[peakIdx][mi]) peakIdx = j;
  }
  const tPeak = r.time[peakIdx];
  check('first peak time = pi/wd', tPeak, Math.PI / wd, 0.02);
  const overshoot = 1 + Math.exp((-alpha * Math.PI) / wd);
  check('first peak value', r.data[peakIdx][mi], overshoot, 0.02);
}

// -------------------------------------------------- LC energy conservation
console.log('\nLossless LC tank — energy conservation over 20 cycles');
{
  const L = 1e-3, C = 1e-6;
  const w0 = 1 / Math.sqrt(L * C);
  const period = (2 * Math.PI) / w0;
  const c = new Circuit();
  c.options.method = 'trap';
  const a = c.node('a');
  const cap = new Capacitor('C1', a, -1, C);
  cap.ic = 1;
  c.add(cap);
  c.add(new Inductor('L1', a, -1, L));
  c.add(new Resistor('Rleak', a, -1, 1e12));
  const run = new TransientRun(c, {
    tstop: 20 * period, tstep: period / 200, tmax: period / 100, uic: true, method: 'trap',
  });
  run.begin();
  run.runToCompletion();
  const ai = c.indexOf('a');
  const bi = c.devices.find((d) => d.name === 'L1').branches[0];
  const energy = (k) => 0.5 * C * run.data[k][ai] ** 2 + 0.5 * L * run.data[k][bi] ** 2;
  const e0 = 0.5 * C * 1;
  const eEnd = energy(run.data.length - 1);
  check('energy after 20 cycles / initial', eEnd / e0, 1, 0.02);
}

// ------------------------------------------------------------------- AC
console.log('\nRC low-pass — AC magnitude and phase');
{
  const R = 1000, C = 1e-7;
  const fc = 1 / (2 * Math.PI * R * C);
  const c = new Circuit();
  const vin = c.node('in'), out = c.node('out');
  c.add(new VoltageSource('V1', vin, -1, { dc: 0, ac: { mag: 1, phase: 0 } }));
  c.add(new Resistor('R1', vin, out, R));
  c.add(new Capacitor('C1', out, -1, C));
  const r = acSweep(c, { type: 'dec', points: 50, start: fc / 100, stop: fc * 100 });
  const b = bode(r, c.indexOf('out'));
  let k = 0;
  for (let j = 0; j < b.freq.length; j++) {
    if (Math.abs(Math.log(b.freq[j] / fc)) < Math.abs(Math.log(b.freq[k] / fc))) k = j;
  }
  check('magnitude at fc = -3.01 dB', b.mag[k], -3.0103, 0.05);
  check('phase at fc = -45 deg', b.phase[k], -45, 0.5);
  check('magnitude a decade up = -20 dB', b.mag[k + 50], -20.04, 0.3);
}

// -------------------------------------------------------- inductor AC
console.log('\nSeries RL — AC corner');
{
  const R = 100, L = 1e-3;
  const fc = R / (2 * Math.PI * L);
  const c = new Circuit();
  const vin = c.node('in'), out = c.node('out');
  c.add(new VoltageSource('V1', vin, -1, { ac: { mag: 1, phase: 0 } }));
  c.add(new Inductor('L1', vin, out, L));
  c.add(new Resistor('R1', out, -1, R));
  const r = acSweep(c, { type: 'dec', points: 40, start: fc / 100, stop: fc * 100 });
  const b = bode(r, c.indexOf('out'));
  let k = 0;
  for (let j = 0; j < b.freq.length; j++) {
    if (Math.abs(Math.log(b.freq[j] / fc)) < Math.abs(Math.log(b.freq[k] / fc))) k = j;
  }
  check('RL magnitude at fc', b.mag[k], -3.0103, 0.05);
}

// ------------------------------------------------------------------ diode
console.log('\nDiode — Shockley equation at a known bias');
{
  const IS = 1e-14, N = 1;
  const c = new Circuit();
  const a = c.node('a');
  c.add(new VoltageSource('V1', a, -1, { dc: 0.6 }));
  c.add(new Diode('D1', a, -1, { is: IS, n: N, rs: 0 }));
  op(c);
  const vt = c.ctx.vt;
  const expected = IS * (Math.exp(0.6 / (N * vt)) - 1);
  check('I(D1) at 0.6 V', -c.current('V1'), expected, 1e-3);
}
{
  // Series resistor sets the operating point; check consistency both ways.
  const c = new Circuit();
  const vin = c.node('in'), a = c.node('a');
  c.add(new VoltageSource('V1', vin, -1, { dc: 5 }));
  c.add(new Resistor('R1', vin, a, 1000));
  c.add(new Diode('D1', a, -1, { is: 1e-14, n: 1 }));
  op(c);
  const vd = c.voltage('a');
  const id = (5 - vd) / 1000;
  const vt = c.ctx.vt;
  check('diode KCL consistency', 1e-14 * (Math.exp(vd / vt) - 1), id, 1e-3);
  // vd = Vt * ln(Id/Is) for Id well above Is.
  check('forward drop = Vt*ln(Id/Is)', vd, vt * Math.log(id / 1e-14), 2e-3);
}

// -------------------------------------------------------------------- BJT
console.log('\nBJT — forward beta and Early effect');
{
  const c = new Circuit();
  const b = c.node('b'), col = c.node('c');
  c.add(new CurrentSource('IB', -1, b, { dc: 10e-6 }));
  c.add(new VoltageSource('VC', col, -1, { dc: 5 }));
  c.add(new BJT('Q1', col, b, -1, -1, { is: 1e-16, bf: 100, vaf: Infinity }));
  op(c);
  check('Ic = beta * Ib', -c.current('VC'), 100 * 10e-6, 0.02);
}
{
  // Common-emitter gain: gm * Rc, with gm = Ic/Vt.
  const c = new Circuit();
  const vcc = c.node('vcc'), b = c.node('b'), col = c.node('c'), inp = c.node('in');
  c.add(new VoltageSource('VCC', vcc, -1, { dc: 10 }));
  c.add(new VoltageSource('VIN', inp, -1, { dc: 0, ac: { mag: 1, phase: 0 } }));
  c.add(new Capacitor('Cin', inp, b, 1e-3));
  c.add(new CurrentSource('IB', -1, b, { dc: 20e-6 }));
  c.add(new Resistor('RC', vcc, col, 2000));
  c.add(new BJT('Q1', col, b, -1, -1, { is: 1e-16, bf: 100, vaf: 100 }));
  const r = acSweep(c, { type: 'dec', points: 10, start: 1e3, stop: 1e5 });
  const bd = bode(r, c.indexOf('c'));
  const q = c.devices.find((d) => d.name === 'Q1');
  const gm = Math.abs(q.op.gmf);
  const ro = 100 / Math.abs(q.ic);
  const rout = 1 / (1 / 2000 + 1 / ro);
  const expectedDb = 20 * Math.log10(gm * rout);
  check('CE voltage gain (dB)', bd.mag[5], expectedDb, 0.5);
}

// ---------------------------------------------------------------- MOSFET
console.log('\nMOSFET Level 1 — saturation current');
{
  const KP = 2e-5, W = 10e-6, L = 1e-6, VTO = 1;
  const c = new Circuit();
  const g = c.node('g'), d = c.node('d');
  c.add(new VoltageSource('VG', g, -1, { dc: 3 }));
  c.add(new VoltageSource('VD', d, -1, { dc: 5 }));
  c.add(new MOSFET('M1', d, g, -1, -1, { type: 'nmos', vto: VTO, kp: KP, lambda: 0 }, { w: W, l: L }));
  op(c);
  const beta = KP * (W / L);
  const expected = (beta / 2) * (3 - VTO) ** 2;
  check('Id in saturation', -c.current('VD'), expected, 1e-6);
}
{
  // Linear region, and the symmetric-swap path (negative Vds).
  const KP = 2e-5, W = 10e-6, L = 1e-6, VTO = 1;
  const c = new Circuit();
  const g = c.node('g'), d = c.node('d');
  c.add(new VoltageSource('VG', g, -1, { dc: 5 }));
  c.add(new VoltageSource('VD', d, -1, { dc: 0.5 }));
  c.add(new MOSFET('M1', d, g, -1, -1, { type: 'nmos', vto: VTO, kp: KP }, { w: W, l: L }));
  op(c);
  const beta = KP * (W / L);
  const expected = beta * ((5 - VTO) - 0.5 / 2) * 0.5;
  check('Id in linear region', -c.current('VD'), expected, 1e-6);
}

// ------------------------------------------------------------- DC sweep
console.log('\nDC sweep — diode I-V monotonicity and endpoint');
{
  const c = new Circuit();
  const a = c.node('a');
  c.add(new VoltageSource('V1', a, -1, { dc: 0 }));
  c.add(new Resistor('Rs', a, c.node('k'), 10));
  c.add(new Diode('D1', c.node('k'), -1, { is: 1e-14, n: 1 }));
  const r = dcSweep(c, { device: 'V1', start: 0, stop: 1, step: 0.01 });
  const bi = c.devices.find((d) => d.name === 'V1').branches[0];
  const sols = r.sweeps[0].solutions;
  let monotone = true;
  for (let i = 1; i < sols.length; i++) if (-sols[i][bi] < -sols[i - 1][bi] - 1e-12) monotone = false;
  check('sweep is monotonic', monotone ? 1 : 0, 1, 0);
  check('sweep starts at zero current', -sols[0][bi], 0, 1e-9);
}

// ------------------------------------------------------------------ report
console.log(`\n${'-'.repeat(72)}`);
console.log(`${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  ' + f);
}
process.exit(fail ? 1 : 0);
