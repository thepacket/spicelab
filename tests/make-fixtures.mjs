/**
 * Golden fixture generator.
 *
 * Emits declarative circuit specs plus the reference results produced by the
 * verified JS oracle. The Rust core builds the same circuits from the same JSON
 * and must reproduce the numbers inside the stated tolerance.
 *
 * Regenerate only when the oracle changes AND the analytic suite is green.
 * A fixture regenerated from a broken oracle silently blesses the breakage.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { Circuit } from '../src/core/circuit.js';
import { Resistor, Capacitor, Inductor } from '../src/core/devices/primitives.js';
import { VoltageSource } from '../src/core/devices/sources.js';
import { Diode, BJT } from '../src/core/devices/semiconductors.js';
import { MOSFET } from '../src/core/devices/mosfet.js';
import { op, acSweep } from '../src/core/analyses/dc.js';
import { tran } from '../src/core/analyses/tran.js';

const fixtures = [];

/** Build a circuit from a declarative spec. Mirrors what the Rust side must do. */
function build(spec) {
  const c = new Circuit(spec.name);
  if (spec.options) Object.assign(c.options, spec.options);
  const N = (s) => c.node(s);
  for (const d of spec.devices) {
    switch (d.kind) {
      case 'R': c.add(new Resistor(d.name, N(d.nodes[0]), N(d.nodes[1]), d.value)); break;
      case 'C': {
        const cap = new Capacitor(d.name, N(d.nodes[0]), N(d.nodes[1]), d.value);
        if (d.ic != null) cap.ic = d.ic;
        c.add(cap); break;
      }
      case 'L': c.add(new Inductor(d.name, N(d.nodes[0]), N(d.nodes[1]), d.value)); break;
      case 'V': c.add(new VoltageSource(d.name, N(d.nodes[0]), N(d.nodes[1]), d.spec)); break;
      case 'D': c.add(new Diode(d.name, N(d.nodes[0]), N(d.nodes[1]), d.model)); break;
      case 'Q': c.add(new BJT(d.name, N(d.nodes[0]), N(d.nodes[1]), N(d.nodes[2]),
                              d.nodes[3] ? N(d.nodes[3]) : -1, d.model)); break;
      case 'M': c.add(new MOSFET(d.name, N(d.nodes[0]), N(d.nodes[1]), N(d.nodes[2]),
                                 N(d.nodes[3]), d.model, d.inst)); break;
      default: throw new Error(`unknown device kind ${d.kind}`);
    }
  }
  return c;
}

function addOp(name, spec, probes, tol = 1e-9) {
  const c = build(spec);
  op(c);
  fixtures.push({
    name, analysis: 'op', tolerance: tol, circuit: spec,
    expect: Object.fromEntries(probes.map((p) => [p, c.voltage(p)])),
  });
}

function addTran(name, spec, run, probes, samples, tol = 1e-4) {
  const c = build(spec);
  const r = tran(c, run);
  const idx = probes.map((p) => c.indexOf(p));
  const points = [];
  for (const t of samples) {
    let best = 0;
    for (let j = 0; j < r.time.length; j++) {
      if (Math.abs(r.time[j] - t) < Math.abs(r.time[best] - t)) best = j;
    }
    points.push({
      t: r.time[best],
      v: Object.fromEntries(probes.map((p, k) => [p, r.data[best][idx[k]]])),
    });
  }
  fixtures.push({ name, analysis: 'tran', tolerance: tol, circuit: spec, run, expect: points });
}

function addAc(name, spec, sweep, probe, tol = 1e-6) {
  const c = build(spec);
  const r = acSweep(c, sweep);
  const i = c.indexOf(probe);
  const pts = [];
  for (let k = 0; k < r.freq.length; k += Math.ceil(r.freq.length / 12)) {
    pts.push({ f: r.freq[k], re: r.re[k][i], im: r.im[k][i] });
  }
  fixtures.push({ name, analysis: 'ac', tolerance: tol, circuit: spec, sweep, probe, expect: pts });
}

// ---------------------------------------------------------------- cases
addOp('divider', {
  name: 'divider',
  devices: [
    { kind: 'V', name: 'V1', nodes: ['in', '0'], spec: { dc: 10 } },
    { kind: 'R', name: 'R1', nodes: ['in', 'mid'], value: 1000 },
    { kind: 'R', name: 'R2', nodes: ['mid', '0'], value: 3000 },
  ],
}, ['mid']);

addOp('diode_series', {
  name: 'diode_series',
  devices: [
    { kind: 'V', name: 'V1', nodes: ['in', '0'], spec: { dc: 5 } },
    { kind: 'R', name: 'R1', nodes: ['in', 'a'], value: 1000 },
    { kind: 'D', name: 'D1', nodes: ['a', '0'], model: { is: 1e-14, n: 1 } },
  ],
}, ['a'], 1e-7);

addOp('bjt_bias', {
  name: 'bjt_bias',
  devices: [
    { kind: 'V', name: 'VCC', nodes: ['vcc', '0'], spec: { dc: 12 } },
    { kind: 'R', name: 'RB', nodes: ['vcc', 'b'], value: 470000 },
    { kind: 'R', name: 'RC', nodes: ['vcc', 'c'], value: 2200 },
    { kind: 'Q', name: 'Q1', nodes: ['c', 'b', '0'], model: { is: 1e-16, bf: 150, vaf: 80 } },
  ],
}, ['b', 'c'], 1e-6);

addOp('mos_bias', {
  name: 'mos_bias',
  devices: [
    { kind: 'V', name: 'VDD', nodes: ['vdd', '0'], spec: { dc: 5 } },
    { kind: 'V', name: 'VG', nodes: ['g', '0'], spec: { dc: 2.5 } },
    { kind: 'R', name: 'RD', nodes: ['vdd', 'd'], value: 5000 },
    { kind: 'M', name: 'M1', nodes: ['d', 'g', '0', '0'],
      model: { type: 'nmos', vto: 1, kp: 2e-5, lambda: 0.02 }, inst: { w: 20e-6, l: 1e-6 } },
  ],
}, ['d'], 1e-7);

for (const method of ['be', 'trap', 'gear2']) {
  addTran(`rc_step_${method}`, {
    name: 'rc_step',
    options: { method },
    devices: [
      { kind: 'V', name: 'V1', nodes: ['in', '0'],
        spec: { dc: 0, tran: { type: 'pulse', v1: 0, v2: 1, td: 0, tr: 1e-12, pw: 1, per: 0 } } },
      { kind: 'R', name: 'R1', nodes: ['in', 'out'], value: 1000 },
      { kind: 'C', name: 'C1', nodes: ['out', '0'], value: 1e-6 },
    ],
  }, { tstop: 5e-3, tstep: 1e-5, tmax: 2e-5, method },
     ['out'], [1e-3, 2e-3, 3e-3, 4e-3], 3e-3);
}

addTran('rlc_ring', {
  name: 'rlc_ring',
  options: { method: 'trap' },
  devices: [
    { kind: 'V', name: 'V1', nodes: ['in', '0'],
      spec: { tran: { type: 'pulse', v1: 0, v2: 1, td: 0, tr: 1e-12, pw: 1, per: 0 } } },
    { kind: 'R', name: 'R1', nodes: ['in', 'out'], value: 20 },
    { kind: 'L', name: 'L1', nodes: ['out', 'm'], value: 1e-3 },
    { kind: 'C', name: 'C1', nodes: ['m', '0'], value: 1e-6 },
  ],
}, { tstop: 6e-4, tstep: 5e-7, tmax: 1e-6, method: 'trap' },
   ['m'], [5e-5, 1e-4, 2e-4, 4e-4], 5e-3);

addTran('lc_tank_energy', {
  name: 'lc_tank',
  options: { method: 'trap' },
  devices: [
    { kind: 'C', name: 'C1', nodes: ['a', '0'], value: 1e-6, ic: 1 },
    { kind: 'L', name: 'L1', nodes: ['a', '0'], value: 1e-3 },
    { kind: 'R', name: 'Rleak', nodes: ['a', '0'], value: 1e12 },
  ],
}, { tstop: 1.2566e-3, tstep: 3e-7, tmax: 6e-7, uic: true, method: 'trap' },
   ['a'], [2e-4, 6e-4, 1e-3], 5e-3);

addAc('rc_lowpass_ac', {
  name: 'rc_lowpass',
  devices: [
    { kind: 'V', name: 'V1', nodes: ['in', '0'], spec: { dc: 0, ac: { mag: 1, phase: 0 } } },
    { kind: 'R', name: 'R1', nodes: ['in', 'out'], value: 1000 },
    { kind: 'C', name: 'C1', nodes: ['out', '0'], value: 1e-7 },
  ],
}, { type: 'dec', points: 20, start: 16, stop: 160000 }, 'out');

addAc('rlc_bandpass_ac', {
  name: 'rlc_bandpass',
  devices: [
    { kind: 'V', name: 'V1', nodes: ['in', '0'], spec: { ac: { mag: 1, phase: 0 } } },
    { kind: 'R', name: 'R1', nodes: ['in', 'out'], value: 50 },
    { kind: 'L', name: 'L1', nodes: ['out', 'm'], value: 1e-3 },
    { kind: 'C', name: 'C1', nodes: ['m', '0'], value: 1e-9 },
  ],
}, { type: 'dec', points: 30, start: 1e4, stop: 1e7 }, 'm');

mkdirSync(new URL('./fixtures/', import.meta.url), { recursive: true });
const path = new URL('./fixtures/golden.json', import.meta.url);
writeFileSync(path, JSON.stringify({
  generator: 'spicelab js oracle',
  generated: new Date().toISOString().slice(0, 10),
  note: 'Reference values from the JS oracle, verified against tests/analytic.test.mjs. ' +
        'The Rust core must reproduce these within each fixture tolerance.',
  fixtures,
}, null, 2));
console.log(`wrote ${fixtures.length} fixtures to tests/fixtures/golden.json`);
for (const f of fixtures) console.log(`  ${f.analysis.padEnd(5)} ${f.name}`);
