/**
 * Differential test against ngspice.
 *
 * The JS oracle proves the Rust core reproduces ITSELF. It cannot prove either
 * one matches SPICE, because both were written here from the same reading of
 * the same equations — a shared misreading would agree perfectly and be wrong
 * together. ngspice is an independent implementation with a thirty-year
 * lineage back to Berkeley SPICE3, so agreeing with it is evidence of a
 * different kind.
 *
 * CLAUDE.md asks for exactly this where no closed form exists: "compare against
 * ngspice and record the reference values rather than eyeballing a plot."
 *
 * The SAME netlist text goes to both simulators. That matters — if the two were
 * fed circuits built through different code paths, a disagreement could come
 * from the netlist rather than the solver, and the test would be measuring the
 * wrong thing.
 *
 * Skips cleanly when ngspice is absent, so the suite still runs elsewhere:
 *   brew install ngspice   /   apt install ngspice
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { PARTS, modelCard } from '../src/schematic/parts.js';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [pass] ${name}`); }
  else { fail++; failures.push(`${name}: ${detail}`); console.log(`  [FAIL] ${name} ${detail}`); }
}
/** Relative comparison, with an absolute floor for values near zero. */
function close(name, a, b, rtol, atol = 1e-12) {
  const ok = Math.abs(a - b) <= Math.max(atol, rtol * Math.abs(b));
  check(name, ok, `got ${a}, ngspice ${b} (rtol ${rtol})`);
  return ok;
}

// ------------------------------------------------------------------ ngspice

function haveNgspice() {
  try {
    execFileSync('ngspice', ['--version'], { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

if (!haveNgspice()) {
  console.log('\nngspice not found — skipping the differential suite.');
  console.log('Install it to enable these checks:  brew install ngspice');
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'spicelab-ng-'));
const version = execFileSync('ngspice', ['--version'], { encoding: 'utf8' })
  .split('\n').find((l) => /ngspice-\d/.test(l))?.trim() ?? 'unknown';
console.log(`\nReference simulator: ${version}`);

/**
 * Run a netlist under ngspice and return the columns `wrdata` wrote.
 *
 * One vector per call: `wrdata` emits (x, y) pairs for real vectors and
 * (x, re, im) triples for complex ones, so requesting several at once makes the
 * column layout depend on the analysis. One at a time is unambiguous.
 */
function ngspice(netlistBody, control, vector) {
  const outFile = join(dir, 'out.txt');
  const src = [
    netlistBody.trim(),
    '.control',
    control,
    `wrdata ${outFile} ${vector}`,
    '.endc',
    '.end',
    '',
  ].join('\n');
  const cir = join(dir, 'case.cir');
  writeFileSync(cir, src);
  try {
    execFileSync('ngspice', ['-b', cir], { stdio: 'pipe', timeout: 60000 });
  } catch (e) {
    throw new Error(`ngspice failed: ${String(e.stderr ?? e.message).slice(0, 200)}`);
  }
  return readFileSync(outFile, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => l.trim().split(/\s+/).map(Number));
}

const ngOp = (body, vec) => ngspice(body, 'op', vec)[0][1];
const ngTran = (body, tstep, tstop, vec) =>
  ngspice(body, `tran ${tstep} ${tstop}`, vec).map((r) => [r[0], r[1]]);
const ngAc = (body, scale, pts, f0, f1, vec) =>
  ngspice(body, `ac ${scale} ${pts} ${f0} ${f1}`, vec).map((r) => [r[0], r[1], r[2]]);

// --------------------------------------------------------------- our solver

const require = createRequire(import.meta.url);
const wasm = require('../src/wasm-node/spicelab_wasm.js');

function ourOp(body, node) {
  const s = wasm.Session.fromNetlist(`${body}\n.op\n.end`);
  s.solveOp();
  const row = new Float64Array(wasm.memory.buffer, s.stagingPtr, s.stagingLen);
  const L = s.labels().split('\n');
  const i = L.indexOf(node);
  if (i < 0) throw new Error(`no such node "${node}" in [${L}]`);
  return row[1 + i];
}

function ourTran(body, tstop, tstep, tmax, node) {
  const s = wasm.Session.fromNetlist(`${body}\n.end`);
  const L = s.labels().split('\n');
  const idx = L.indexOf(node);
  s.beginTran(tstop, tstep, tmax, false, 'trap');
  const stride = s.stride;
  const out = [];
  while (!s.done) {
    const n = s.advance(512, 8192);
    if (!n) break;
    const v = new Float64Array(wasm.memory.buffer, s.stagingPtr, n * stride);
    for (let r = 0; r < n; r++) out.push([v[r * stride], v[r * stride + 1 + idx]]);
  }
  return out;
}

function ourAc(body, scale, pts, f0, f1, node) {
  const s = wasm.Session.fromNetlist(`${body}\n.end`);
  const L = s.labels().split('\n');
  const idx = L.indexOf(node);
  const n = s.runAc(scale, pts, f0, f1);
  const stride = 1 + 2 * s.numUnknowns;
  const d = new Float64Array(wasm.memory.buffer, s.stagingPtr, n * stride);
  const out = [];
  for (let k = 0; k < n; k++) {
    const base = k * stride;
    out.push([d[base], d[base + 1 + 2 * idx], d[base + 2 + 2 * idx]]);
  }
  return out;
}

/** Value of a sampled series at the point nearest `x`. */
const at = (series, x) =>
  series.reduce((b, r) => (Math.abs(r[0] - x) < Math.abs(b[0] - x) ? r : b), series[0]);

// ------------------------------------------------------------------- cases

console.log('\nDC operating point');
{
  const body = `divider
V1 in 0 DC 10
R1 in mid 1k
R2 mid 0 3k`;
  close('resistive divider V(mid)', ourOp(body, 'mid'), ngOp(body, 'v(mid)'), 1e-9);
}
{
  // Nonlinear: exercises Newton, limiting and the Shockley equation.
  const body = `diode bias
V1 in 0 DC 5
R1 in a 1k
D1 a 0 DM
.model DM D (is=1e-14 n=1 rs=0)`;
  close('diode bias V(a)', ourOp(body, 'a'), ngOp(body, 'v(a)'), 1e-5);
}
{
  // Gummel-Poon with Early effect and the high-injection knee.
  const body = `bjt bias
VCC vcc 0 DC 12
RB vcc b 470k
RC vcc c 2.2k
Q1 c b 0 QM
.model QM NPN (is=1e-16 bf=150 vaf=80 ikf=0.1 ise=1e-15 ne=1.5 br=4 nr=1)`;
  close('BJT V(b)', ourOp(body, 'b'), ngOp(body, 'v(b)'), 1e-5);
  close('BJT V(c)', ourOp(body, 'c'), ngOp(body, 'v(c)'), 1e-4);
}
{
  // MOSFET Level 1, including the body effect and channel-length modulation.
  const body = `mos bias
VDD vdd 0 DC 5
VG g 0 DC 2.5
RD vdd d 5k
M1 d g 0 0 MM w=20u l=1u
.model MM NMOS (level=1 vto=1 kp=2e-5 lambda=0.02 gamma=0.5 phi=0.6)`;
  close('MOSFET V(d)', ourOp(body, 'd'), ngOp(body, 'v(d)'), 1e-5);
}

console.log('\nMOSFET Level 3, across a bias grid');
{
  // Level 3 is a stack of multiplicative corrections on the square law, so a
  // single bias point proves very little — an error in the short-channel term
  // or in velocity saturation only shows up in part of the plane. Sweep it.
  const MODEL = 'LEVEL=3 KP=45.3E-6 VTO=0.72 TOX=51.5E-9 NSUB=2.8E15 GAMMA=0.94 '
    + 'PHI=0.65 VMAX=150E3 XJ=0.11E-6 LD=0.52E-6 THETA=0.054 ETA=0.025 '
    + 'KAPPA=0.5 DELTA=0.315';
  const cir = (vg, vd, vb) => `l3
VG g 0 DC ${vg}
VD d 0 DC ${vd}
VB b 0 DC ${vb}
M1 d g 0 b MM w=20u l=2u
.model MM NMOS (${MODEL})`;

  let worst = 0, worstAt = '';
  let n = 0;
  for (const vb of [0, -1, -2]) {
    for (const vg of [1, 2, 3, 5]) {
      for (const vd of [0.1, 0.5, 1, 3, 5]) {
        const ours = -ourOp(cir(vg, vd, vb), 'I(VD)');
        const ref = -ngOp(cir(vg, vd, vb), 'i(vd)');
        // Below a nanoamp the comparison is meaningless: ngspice reports its
        // gmin leakage there and we report an exact zero.
        if (Math.abs(ref) < 1e-9) continue;
        n++;
        const rel = Math.abs(ours - ref) / Math.abs(ref);
        if (rel > worst) { worst = rel; worstAt = `vg=${vg} vd=${vd} vb=${vb}`; }
      }
    }
  }
  // 1e-3 rather than 1e-6: the worst point sits within a few tens of mV of
  // threshold with the body effect raising vth, where the current is tiny and
  // relative error is amplified by the division. Away from threshold the
  // agreement is ~1e-6.
  check(`Level 3 NMOS over ${n} bias points`, worst < 1e-3,
        `worst relative error ${worst.toExponential(2)} at ${worstAt}`);
  console.log(`     NMOS worst relative error ${worst.toExponential(2)} over ${n} points`);
}
{
  // P-channel, both levels. A PMOS states vto NEGATIVE while the current
  // equation works in a mirrored frame, and getting that wrong turned every
  // p-channel device on far too early. Nothing here tested one until ngspice
  // was available, so both levels are swept now.
  const CARDS = {
    'level 1': 'level=1 vto=-1 kp=2e-5 gamma=0.5 phi=0.6 lambda=0.02',
    'level 3': 'LEVEL=3 KP=22.1E-6 VTO=-0.71 TOX=51.5E-9 NSUB=3.3E16 GAMMA=0.92 '
             + 'PHI=0.65 VMAX=970E3 XJ=0.63E-6 LD=0.23E-6 THETA=0.108 ETA=0.322 '
             + 'KAPPA=0.5 DELTA=2.24',
  };
  for (const [label, card] of Object.entries(CARDS)) {
    const cir = (vg, vd, vb) => `pmos
VG g 0 DC ${vg}
VD d 0 DC ${vd}
VB b 0 DC ${vb}
M1 d g 0 b MM w=20u l=2u
.model MM PMOS (${card})`;
    let worst = 0, worstAt = '', n = 0;
    for (const vb of [0, 1]) {
      for (const vg of [-1, -2, -3, -5]) {
        for (const vd of [-0.1, -0.5, -1, -3, -5]) {
          const ours = ourOp(cir(vg, vd, vb), 'I(VD)');
          const ref = ngOp(cir(vg, vd, vb), 'i(vd)');
          if (Math.abs(ref) < 1e-9) continue;
          n++;
          const rel = Math.abs(ours - ref) / Math.abs(ref);
          if (rel > worst) { worst = rel; worstAt = `vg=${vg} vd=${vd} vb=${vb}`; }
        }
      }
    }
    check(`PMOS ${label} over ${n} bias points`, worst < 1e-3,
          `worst relative error ${worst.toExponential(2)} at ${worstAt}`);
  }
}

console.log('\nMOSFET bulk junctions');
{
  // The bulk-source and bulk-drain junctions were absent entirely: with the
  // gate off and the bulk forward biased, ngspice conducted milliamps and this
  // device conducted exactly zero. Only visible when the bulk is not tied to
  // the source — the normal case on-chip, and the mechanism behind a power
  // FET's body diode.
  const body = (vb) => `bulk
VB b 0 DC ${vb}
VG g 0 DC 0
VD d 0 DC 0
M1 d g 0 b MM w=20u l=2u
.model MM NMOS (level=1 vto=1 kp=2e-5 is=1e-14)`;
  for (const vb of [-1, 0.4, 0.6, 0.7]) {
    close(`bulk current at Vb=${vb}V`,
          ourOp(body(vb), 'I(VB)'), ngOp(body(vb), 'i(vb)'), 1e-4, 1e-13);
  }
  // And with the bulk tied to the source it must contribute nothing, so the
  // ordinary common-source result is unchanged.
  const tied = `bulk tied
VDD vdd 0 DC 5
VG g 0 DC 3
RD vdd d 5k
M1 d g 0 0 MM w=20u l=2u
.model MM NMOS (level=1 vto=1 kp=2e-5)`;
  close('bulk tied to source changes nothing', ourOp(tied, 'd'), ngOp(tied, 'v(d)'), 1e-6);
}

console.log('\nMOSFET bulk junction CAPACITANCE');
{
  // The junction currents were added first and matched immediately; the
  // junction CHARGE stayed missing, so DC was right and every transient and AC
  // answer was short by the bulk capacitance. Measured as the admittance an AC
  // source sees looking into the bulk, with everything else grounded.
  //
  // `tox` is stated deliberately. ngspice gives a Level 1 card NO intrinsic
  // gate capacitance unless TOX is present (Level 3 defaults it to 1e-7), and
  // this core defaulted it to 1e-7 for both — a silent extra cox*W*L on every
  // gate, 13.8 fF here, which is how this discrepancy first showed up.
  const body = (vb) => `bulkcap
VB b 0 DC ${vb} AC 1
VG g 0 DC 0
VD d 0 DC 0
M1 d g 0 b MM w=20u l=2u ad=100p as=100p pd=60u ps=60u
.model MM NMOS (level=1 vto=1 kp=2e-5 is=1e-14 tox=1e-7
+ cj=2e-4 cjsw=1e-9 mj=0.5 mjsw=0.33 pb=0.8 fc=0.5)`;
  const mag = (r) => Math.hypot(r[1], r[2]);
  for (const vb of [-3, -1, 0, 0.5, 0.7]) {
    // Reverse bias uses the depletion formula, forward bias the linearisation
    // above fc*pb = 0.4 V. They are different code paths.
    const ours = mag(ourAc(body(vb), 'lin', 2, 1e6, 1e6, 'I(VB)')[0]);
    const ref = mag(ngAc(body(vb), 'lin', 1, 1e6, 1e6, 'i(vb)')[0]);
    close(`bulk admittance at Vb=${vb}V`, ours, ref, 1e-4);
  }
  // Without TOX, ngspice leaves the intrinsic gate capacitance out entirely.
  const noTox = body(0).replace(' tox=1e-7', '');
  close('no TOX means no intrinsic gate capacitance',
        mag(ourAc(noTox, 'lin', 2, 1e6, 1e6, 'I(VB)')[0]),
        mag(ngAc(noTox, 'lin', 1, 1e6, 1e6, 'i(vb)')[0]), 1e-6);
}

console.log('\nMOSFET gate charge, both polarities');
{
  // Drain pinned by a source, so the only current into it is the gate-drain
  // displacement current — which reads the SIGN of the charge stamp directly.
  //
  // The equivalent current is computed from sign-mirrored voltages and was not
  // mirrored back, so a PMOS's displacement current flowed the wrong way. It
  // did not merely invert the answer: the wrong-signed companion model is
  // unstable, and the run diverged to 24x before failing.
  for (const [kind, vto, pulse, rail] of [
    ['NMOS', '1', 'PULSE(0 5 1n 1n 1n 20n 100n)', '0'],
    ['PMOS', '-1', 'PULSE(5 0 1n 1n 1n 20n 100n)', '5'],
  ]) {
    const body = `${kind} gate charge
VS s 0 DC ${rail}
VD d 0 DC ${rail}
VG g 0 DC 0 ${pulse}
M1 d g s s MM w=20u l=2u
.model MM ${kind} (level=1 vto=${vto} kp=2e-5 cgdo=5e-10)`;
    const ours = ourTran(body, 40e-9, 4e-11, 8e-11, 'I(VD)');
    const ref = ngTran(body, '0.04n', '40n', 'i(vd)');
    // Mid-ramp on each edge: a constant dV/dt through a constant capacitance,
    // so the current is a known plateau of C*dV/dt = 5e-5 A, signed.
    // 1n delay + 1n rise, 20n high, then the 1n fall at 22-23n.
    for (const [t, want] of [[1.5e-9, 5e-5], [22.5e-9, -5e-5]]) {
      const sign = kind === 'PMOS' ? -1 : 1;
      close(`${kind} gate-drain current at ${t * 1e9}ns`,
            at(ours, t)[1], sign * want, 1e-3, 1e-12);
      close(`${kind} matches ngspice at ${t * 1e9}ns`,
            at(ours, t)[1], at(ref, t)[1], 1e-3, 1e-12);
    }
  }
}

console.log('\nMOSFET switching with the intrinsic Meyer model');
{
  // Two things had to be right for this to run at all.
  //
  // The gate charge was computed as q = C(v)*v, which is not a charge: when C
  // moves the product jumps, so crossing a Meyer region boundary injects a
  // current impulse from nowhere. Refining the timestep made it WORSE. It is
  // now integrated incrementally against an averaged capacitance, as SPICE
  // does.
  //
  // And `lim_vds` refuses to let vds fall below -0.5 V, which is right for a
  // forward-biased device and makes reverse conduction unreachable — the drain
  // of a switch being turned off, a body diode, either half of a transmission
  // gate. Applied unconditionally it turned an ordinary circuit into a hard
  // convergence failure.
  const body = `pmos sw
VDD vdd 0 DC 5
VG g 0 DC 0 PULSE(5 0 1n 1n 1n 50n 100n)
RD d 0 100k
M1 d g vdd vdd MP w=20u l=2u
.model MP PMOS (level=1 vto=-1 kp=2e-5 cgso=5e-10 cgdo=5e-10 cgbo=2e-10 tox=1e-7)`;
  const ours = ourTran(body, 60e-9, 1e-11, 2e-11, 'd');
  const ref = ngTran(body, '0.01n', '60n', 'v(d)');
  const peak = (s) => s.filter((r) => r[0] > 52e-9 && r[0] < 54e-9)
                       .reduce((a, b) => (b[1] > a[1] ? b : a));
  // The turn-off spike drives the drain ABOVE the source rail, which is the
  // reverse-conduction case, and its height is what both fixes decide.
  close('turn-off spike peak', peak(ours)[1], peak(ref)[1], 2e-3);
  for (const t of [30e-9, 55e-9]) {
    close(`PMOS switch v(d) at ${t * 1e9}ns`, at(ours, t)[1], at(ref, t)[1], 5e-2, 5e-3);
  }

  // Same edge on an n-channel device, where the drain is driven BELOW ground.
  const nbody = `nmos sw
VG g 0 DC 0 PULSE(0 5 1n 1n 1n 50n 100n)
RD d 0 100k
M1 d g 0 0 MN w=20u l=2u
.model MN NMOS (level=1 vto=1 kp=2e-5 cgdo=5e-10)`;
  const nours = ourTran(nbody, 60e-9, 1e-11, 2e-11, 'd');
  const nref = ngTran(nbody, '0.01n', '60n', 'v(d)');
  const trough = (s) => s.filter((r) => r[0] > 52e-9 && r[0] < 54e-9)
                         .reduce((a, b) => (b[1] < a[1] ? b : a));
  close('reverse conduction trough', trough(nours)[1], trough(nref)[1], 2e-2);
}

console.log('\nTransient');
{
  const body = `rc step
V1 in 0 DC 0 PULSE(0 1 0 1p 1p 1 0)
R1 in out 1k
C1 out 0 1u`;
  const ours = ourTran(body, 5e-3, 1e-5, 2e-5, 'out');
  const ref = ngTran(body, '10u', '5m', 'v(out)');
  for (const k of [1, 2, 3, 4]) {
    const t = k * 1e-3;
    close(`RC step at ${k}tau`, at(ours, t)[1], at(ref, t)[1], 3e-3);
  }
}
{
  // Underdamped ring: the integrator and timestep control get a real workout,
  // and a phase error shows up immediately as a value mismatch at a peak.
  const body = `rlc ring
V1 in 0 DC 0 PULSE(0 1 0 1p 1p 1 0)
R1 in out 20
L1 out m 1m
C1 m 0 1u`;
  const ours = ourTran(body, 6e-4, 5e-7, 1e-6, 'm');
  const ref = ngTran(body, '0.5u', '600u', 'v(m)');
  for (const t of [5e-5, 1e-4, 2e-4, 4e-4]) {
    close(`RLC V(m) at t=${t.toExponential(0)}`, at(ours, t)[1], at(ref, t)[1], 2e-2, 5e-3);
  }
}

console.log('\nAC sweep');
{
  const body = `rc lowpass
V1 in 0 DC 0 AC 1
R1 in out 1k
C1 out 0 0.1u`;
  const ours = ourAc(body, 'dec', 10, 10, 1e5, 'out');
  const ref = ngAc(body, 'dec', 10, 10, 1e5, 'v(out)');
  for (const f of [100, 1000, 1591, 10000]) {
    const a = at(ours, f), b = at(ref, f);
    close(`AC re at ${f} Hz`, a[1], b[1], 1e-4, 1e-9);
    close(`AC im at ${f} Hz`, a[2], b[2], 1e-4, 1e-9);
  }
}

console.log('\nEvery library part, against ngspice');
{
  let worstD = 0, worstQ = 0, bad = null;
  for (const p of PARTS) {
    try {
      if (p.kind === 'diode') {
        const body = `part ${p.id}
V1 in 0 DC 5
R1 in a 1k
D1 a 0 PM
${modelCard(p, 'PM')}`;
        const ours = ourOp(body, 'a');
        const ref = ngOp(body, 'v(a)');
        worstD = Math.max(worstD, Math.abs(ours - ref) / Math.max(Math.abs(ref), 1e-6));
        if (Math.abs(ours - ref) > 2e-4 * Math.max(Math.abs(ref), 1) && !bad) {
          bad = `${p.id}: ours ${ours}, ngspice ${ref}`;
        }
      } else if (p.kind === 'nmos' || p.kind === 'pmos') {
        const sgn = p.kind === 'nmos' ? 1 : -1;
        const type = p.kind === 'nmos' ? 'NMOS' : 'PMOS';
        const body = `part ${p.id}
VDD vdd 0 DC ${5 * sgn}
VG g 0 DC ${3 * sgn}
RD vdd d 5k
M1 d g 0 0 PM w=20u l=2u
.model PM ${type} (${p.params})`;
        const ours = ourOp(body, 'd');
        const ref = ngOp(body, 'v(d)');
        worstQ = Math.max(worstQ, Math.abs(ours - ref) / Math.max(Math.abs(ref), 1e-6));
        if (Math.abs(ours - ref) > 2e-3 * Math.max(Math.abs(ref), 1) && !bad) {
          bad = `${p.id} V(d): ours ${ours}, ngspice ${ref}`;
        }
      } else {
        const sgn = p.kind === 'npn' ? 1 : -1;
        const type = p.kind === 'npn' ? 'NPN' : 'PNP';
        const body = `part ${p.id}
VCC vcc 0 DC ${12 * sgn}
RB vcc b 470k
RC vcc c 2.2k
Q1 c b 0 PM
.model PM ${type} (${p.params})`;
        for (const node of ['b', 'c']) {
          const ours = ourOp(body, node);
          const ref = ngOp(body, `v(${node})`);
          worstQ = Math.max(worstQ, Math.abs(ours - ref) / Math.max(Math.abs(ref), 1e-6));
          if (Math.abs(ours - ref) > 2e-3 * Math.max(Math.abs(ref), 1) && !bad) {
            bad = `${p.id} V(${node}): ours ${ours}, ngspice ${ref}`;
          }
        }
      }
    } catch (e) {
      if (!bad) bad = `${p.id}: ${e.message.slice(0, 120)}`;
    }
  }
  check('every library diode matches ngspice', worstD < 2e-4,
        `worst relative error ${worstD.toExponential(2)}`);
  check('every library transistor matches ngspice', worstQ < 2e-3,
        `worst relative error ${worstQ.toExponential(2)}`);
  check('no part failed to run', bad === null, bad ?? '');
  console.log(`     worst diode error ${worstD.toExponential(2)}, ` +
              `worst BJT error ${worstQ.toExponential(2)}`);
}

rmSync(dir, { recursive: true, force: true });

console.log(`\n${'-'.repeat(72)}`);
console.log(`${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  ' + f);
  process.exit(1);
}
