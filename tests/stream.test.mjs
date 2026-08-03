/**
 * End-to-end streaming test.
 *
 * Netlist text -> wasm solver on a worker thread -> shared ring buffer -> main
 * thread, checked against the closed-form RC step response. This is the only
 * test that exercises the whole item-4 path at once; the pieces have their own
 * tests but the seams between them do not.
 *
 * The ring is deliberately far smaller than the run, so back-pressure and
 * wrapping are exercised rather than incidentally avoided.
 */
import { Worker } from 'node:worker_threads';
import { allocate, RingReader, STATE_DONE, STATE_ERROR } from '../src/worker/ring.js';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [pass] ${name}`); }
  else { fail++; failures.push(`${name}: ${detail}`); console.log(`  [FAIL] ${name} ${detail}`); }
}
function near(name, a, b, tol) {
  check(name, Math.abs(a - b) <= tol, `got ${a}, expected ${b} (tol ${tol})`);
}

const R = 1000, C = 1e-6, tau = R * C;
const netlist = `RC step
V1 in 0 DC 0 PULSE(0 1 0 1p 1p 1 0)
R1 in out ${R}
C1 out 0 ${C}
.end`;

console.log('\nStreaming an RC transient through the ring');

// Stride is 1 (time) + unknowns. The circuit has in, out and I(V1) = 3.
const STRIDE = 4;
// 64 rows for a run that produces hundreds: forces wrapping and back-pressure.
const ring = allocate(64, STRIDE);
const reader = new RingReader(ring);

const worker = new Worker(new URL('./stream-worker.mjs', import.meta.url), {
  workerData: {
    ring,
    netlist,
    run: { tstop: 5 * tau, tstep: tau / 100, tmax: tau / 50, method: 'trap' },
  },
});

let loaded = null;
let doneEvt = null;
let errored = null;
worker.on('message', (m) => {
  if (m.evt === 'loaded') loaded = m.payload;
  else if (m.evt === 'tran-done') doneEvt = m.payload;
  else if (m.evt === 'error') errored = m.payload;
});

// Consume concurrently with production.
const rows = [];
const dst = new Float64Array(64 * STRIDE);
const deadline = Date.now() + 20000;
while (Date.now() < deadline) {
  const n = reader.read(dst, 64);
  for (let i = 0; i < n; i++) {
    rows.push(dst.slice(i * STRIDE, (i + 1) * STRIDE));
  }
  if (n === 0) {
    const s = reader.state;
    if (s === STATE_DONE && reader.available === 0) break;
    if (s === STATE_ERROR) break;
    await new Promise((r) => setTimeout(r, 1));
  }
}
await worker.terminate();

check('no error from the worker', errored === null, errored?.message ?? '');
check('worker reported the compiled circuit', loaded !== null);
if (loaded) {
  check('stride matches', loaded.stride === STRIDE, `got ${loaded.stride}`);
  check('labels came through', JSON.stringify(loaded.labels) === '["in","out","I(V1)"]',
        JSON.stringify(loaded.labels));
}
check('received a substantial number of rows', rows.length > 100, `got ${rows.length}`);
check('run reported done', doneEvt !== null);

// Time must be monotonically non-decreasing and reach tstop.
let monotone = true;
for (let i = 1; i < rows.length; i++) {
  if (rows[i][0] < rows[i - 1][0] - 1e-18) monotone = false;
}
check('times are monotonic across the whole stream', monotone);
near('final time reaches tstop', rows[rows.length - 1][0], 5 * tau, tau / 20);

// The physics: V(out) = 1 - e^(-t/tau). Column 2 is `out`.
const at = (t) => {
  let best = 0;
  for (let i = 0; i < rows.length; i++) {
    if (Math.abs(rows[i][0] - t) < Math.abs(rows[best][0] - t)) best = i;
  }
  return rows[best];
};
for (const k of [1, 2, 3]) {
  near(`V(out) at ${k}tau survives the round trip`, at(k * tau)[2], 1 - Math.exp(-k), 3e-3);
}

// Rows must be intact, not just plausible: V(in) is a 1 V step throughout.
let vinOk = true;
for (let i = 1; i < rows.length; i++) {
  if (Math.abs(rows[i][1] - 1) > 1e-9) { vinOk = false; break; }
}
check('V(in) is exactly the 1 V step in every row (no torn rows)', vinOk);

console.log(`\n${'-'.repeat(72)}`);
console.log(`${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  ' + f);
  process.exit(1);
}
