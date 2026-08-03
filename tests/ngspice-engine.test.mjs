/**
 * The ngspice engine, behind the same contract as the Rust core.
 *
 * Two things are being proved here, and only one of them is obvious.
 *
 * The obvious one: ngspice-in-wasm produces correct results in the same ring
 * row format, so nothing downstream can tell which engine ran.
 *
 * The other: **back-pressure reaches ngspice's solver.** Its per-timepoint
 * callback has no way to say "wait", which is why subprocess-based frontends
 * either buffer a whole run or stream without flow control. But the callback is
 * synchronous, so blocking inside it blocks the solver. The ring here is
 * deliberately far smaller than the run, so if flow control did NOT work the
 * run would either overwrite data or fail — it cannot silently pass.
 *
 * Skips cleanly when the wasm module has not been built.
 */
import { existsSync } from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { allocate, RingReader, STATE_DONE, STATE_ERROR } from '../src/worker/ring.js';

const MODULE = new URL('../src/ngspice/ngspice.mjs', import.meta.url);

// --------------------------------------------------------------- worker side
//
// The engine must run on a worker: `Atomics.wait` throws on the main thread,
// and blocking the main thread is what back-pressure would do.
if (!isMainThread) {
  const { NgspiceEngine } = await import('../src/worker/ngspice-engine.js');
  const { ring, netlist, tstop, tstep } = workerData;
  try {
    const engine = await NgspiceEngine.create();
    const info = engine.load(netlist);
    parentPort.postMessage({ evt: 'loaded', info });
    engine.attachRing(ring);
    await engine.tran({ tstop, tstep });
    parentPort.postMessage({ evt: 'done' });
  } catch (e) {
    parentPort.postMessage({ evt: 'error', message: String(e?.message ?? e) });
  }
  process.exit(0);
}

// ----------------------------------------------------------------- main side

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [pass] ${name}`); }
  else { fail++; failures.push(`${name}: ${detail}`); console.log(`  [FAIL] ${name} ${detail}`); }
}
const near = (name, a, b, tol) =>
  check(name, Math.abs(a - b) <= tol, `got ${a}, expected ${b} (tol ${tol})`);

if (!existsSync(fileURLToPath(MODULE))) {
  console.log('\nngspice wasm module not built — skipping.');
  console.log('Build it with: npm run build:ngspice');
  console.log('\n0 passed, 0 failed (skipped)');
  process.exit(0);
}

const R = 1000, C = 1e-6, tau = R * C;
const netlist = `rc step
V1 in 0 DC 0 PULSE(0 1 0 1n 1n 1 2)
R1 in out ${R}
C1 out 0 ${C}
.end`;

console.log('\nngspice engine, streaming through the ring');

// Two rows of capacity. A 5 ms / 10 us run is ~500 rows, so the consumer is
// forced to drain hundreds of times and the producer must block hundreds of
// times. Nothing here can pass by accident.
const CAPACITY = 2;
const STRIDE = 4;                       // [t, v1#branch, out, in]
const ring = allocate(CAPACITY, STRIDE);
const reader = new RingReader(ring);

const rows = [];
let loaded = null;
let workerError = null;

const worker = new Worker(new URL(import.meta.url), {
  workerData: { ring, netlist, tstop: 5e-3, tstep: 1e-5 },
});
worker.on('message', (m) => {
  if (m.evt === 'loaded') loaded = m.info;
  if (m.evt === 'error') workerError = m.message;
});

// Drain until the producer reports done. Deliberately unhurried: a slow
// consumer is the case back-pressure exists for.
const buf = new Float64Array(CAPACITY * STRIDE);
// A deadline, not just a completion check. If the producer dies before setting
// a terminal state — which is exactly what an `attachRing` stride mismatch
// does — this loop would otherwise spin forever and the test would hang
// instead of failing. A hanging test reports nothing; a failing one names the
// problem.
let timedOut = false;
const deadline = Date.now() + 30_000;
await new Promise((resolve) => {
  const pump = () => {
    const n = reader.read(buf, CAPACITY);
    for (let i = 0; i < n; i++) rows.push(Array.from(buf.subarray(i * STRIDE, (i + 1) * STRIDE)));
    const s = reader.state;
    if ((s === STATE_DONE || s === STATE_ERROR) && reader.available === 0) resolve();
    else if (Date.now() > deadline) { timedOut = true; resolve(); }
    else setTimeout(pump, 0);
  };
  pump();
});
check('the run reached a terminal state', !timedOut,
      'producer never finished — it probably threw before setting ring state');
await new Promise((r) => worker.on('exit', r));

check('the worker reported no error', workerError === null, workerError ?? '');
check('load() discovered the vector list', !!loaded, 'no loaded message');
if (loaded) {
  check('labels look like nodes', loaded.labels.includes('out'), JSON.stringify(loaded.labels));
  check('stride is labels + 1 for the x axis', loaded.stride === loaded.labels.length + 1,
        `${loaded.stride} vs ${loaded.labels.length}`);
}

check('rows streamed through a 2-row ring', rows.length > 100, `${rows.length} rows`);

if (rows.length && loaded) {
  const oi = loaded.labels.indexOf('out') + 1;
  const at = (t) => rows.reduce((b, r) => (Math.abs(r[0] - t) < Math.abs(b[0] - t) ? r : b), rows[0]);

  // Monotonic time proves nothing was dropped or reordered under wrapping.
  let mono = true;
  for (let i = 1; i < rows.length; i++) if (rows[i][0] < rows[i - 1][0]) mono = false;
  check('time is monotonic — no rows lost or reordered', mono);

  for (const k of [1, 2, 3]) {
    near(`RC step at ${k}tau`, at(k * tau)[oi], 1 - Math.exp(-k), 5e-3);
  }
  near('starts at zero', rows[0][oi], 0, 1e-9);
}

// ------------------------------------------------------------------- op
//
// Covered separately from `tran` because it takes a different path through the
// engine, and the first version of this file tested only `tran` and `ac`. The
// gap hid a real bug: `load()` latches `cancelled` and only `tran()` cleared
// it, so every operating point produced an all-zero row — with no error, a
// DONE ring state, and a probe that resolved happily and read 0 V.

console.log('\nngspice operating point');
{
  const { NgspiceEngine } = await import('../src/worker/ngspice-engine.js');
  const { allocate: alloc, RingReader: Reader } = await import('../src/worker/ring.js');
  const ng = await NgspiceEngine.create();
  const info = ng.load('div\nV1 in 0 DC 5\nR1 in out 1k\nR2 out 0 3k\n.end');
  const r = alloc(4, info.stride);
  ng.attachRing(r);
  ng.op();
  const rd = new Reader(r);
  const row = new Float64Array(info.stride);
  const n = rd.read(row, 1);
  check('op produced exactly one row', n === 1, `got ${n}`);
  const oi = info.labels.indexOf('out');
  near('V(out) is the divider result', row[1 + oi], 3.75, 1e-9);
  const ii = info.labels.indexOf('I(v1)');
  check('the branch current label was normalised', ii >= 0, JSON.stringify(info.labels));
  if (ii >= 0) near('I(V1) is -V/(R1+R2)', row[1 + ii], -5 / 4000, 1e-12);
}

// ------------------------------------------------------------------- AC
//
// Checked against a closed form because an AC bug is the quiet kind: dropping
// the imaginary part leaves the real part, which still rolls off and still
// looks like a filter response. It is wrong everywhere except DC.

console.log('\nngspice AC returns complex data in the shared row shape');
{
  const { NgspiceEngine } = await import('../src/worker/ngspice-engine.js');
  const ng = await NgspiceEngine.create();
  ng.load(`rc ac\nV1 in 0 DC 0 AC 1\nR1 in out 1k\nC1 out 0 1u\n.end`);
  const res = ng.ac({ scale: 'dec', points: 4, start: 10, stop: 1e4 });
  const oi = ng.labels.indexOf('out');
  check('AC produced points', res.points > 5, String(res.points));
  check('rows are 1 + 2n wide, i.e. re/im pairs',
        res.stride === 1 + 2 * ng.labels.length, `${res.stride} for ${ng.labels.length} vectors`);

  let worst = 0;
  for (let k = 0; k < res.points; k++) {
    const b = k * res.stride;
    const f = res.data[b];
    const re = res.data[b + 1 + 2 * oi], im = res.data[b + 2 + 2 * oi];
    const mag = Math.hypot(re, im);
    const want = 1 / Math.sqrt(1 + (2 * Math.PI * f * 1e3 * 1e-6) ** 2);
    worst = Math.max(worst, Math.abs(mag - want));
  }
  check('|H| matches the RC closed form', worst < 1e-12, `worst ${worst.toExponential(2)}`);

  // The imaginary part must be genuinely populated, not left at zero — that is
  // exactly the bug this section exists to catch.
  let anyIm = false;
  for (let k = 0; k < res.points; k++) {
    if (Math.abs(res.data[k * res.stride + 2 + 2 * oi]) > 1e-9) anyIm = true;
  }
  check('the imaginary part is populated', anyIm, 'all im were zero');

  // And the x axis lands in slot 0 rather than trailing as an ordinary column,
  // which is what happened when the scale was found by matching the name
  // "time" — `frequency` is not called that.
  check('frequency is in slot 0', res.data[0] >= 10 && res.data[0] < 20,
        String(res.data[0]));
  check('frequency is not also a label', !ng.labels.includes('frequency'),
        JSON.stringify(ng.labels));
}

console.log(`\n${'-'.repeat(72)}\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
