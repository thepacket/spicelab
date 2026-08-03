/**
 * Ring buffer tests.
 *
 * The interesting cases are the ones that only show up under load: wrapping the
 * data region, filling exactly to capacity, and a consumer that lags. A ring
 * that is wrong at the wrap point still works for short runs and then silently
 * corrupts long ones, which is the same failure shape as the numerical bugs the
 * analytic suite exists to catch.
 */
import {
  allocate,
  isShared,
  RingReader,
  RingWriter,
  STATE_DONE,
  STATE_RUNNING,
  HDR_CAPACITY,
} from '../src/worker/ring.js';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  [pass] ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ': ' + detail : ''}`);
    console.log(`  [FAIL] ${name} ${detail}`);
  }
}

function eq(name, a, b) {
  check(name, a === b, `got ${a}, expected ${b}`);
}

/** Build `n` rows where row i is [i, i*10, i*10+1, ...]. */
function makeRows(n, stride, base = 0) {
  const src = new Float64Array(n * stride);
  for (let i = 0; i < n; i++) {
    src[i * stride] = base + i;
    for (let k = 1; k < stride; k++) src[i * stride + k] = (base + i) * 10 + k;
  }
  return src;
}

function verifyRows(dst, n, stride, base = 0) {
  for (let i = 0; i < n; i++) {
    if (dst[i * stride] !== base + i) return `row ${i} time ${dst[i * stride]}`;
    for (let k = 1; k < stride; k++) {
      if (dst[i * stride + k] !== (base + i) * 10 + k) {
        return `row ${i} col ${k} = ${dst[i * stride + k]}`;
      }
    }
  }
  return null;
}

console.log('\nAllocation and header');
{
  const buf = allocate(10, 4);
  const w = new RingWriter(buf);
  eq('capacity rounds up to a power of two', w.capacity, 16);
  eq('stride is recorded', w.stride, 4);
  check('backed by SharedArrayBuffer in Node', isShared(buf));
  const hdr = new Int32Array(buf, 0, 8);
  eq('header capacity slot', hdr[HDR_CAPACITY], 16);
  eq('starts empty', w.available, 0);
  eq('starts fully free', w.free, 16);
}

console.log('\nRound trip');
{
  const stride = 4;
  const buf = allocate(16, stride);
  const w = new RingWriter(buf);
  const r = new RingReader(buf);

  eq('write 5 rows', w.write(makeRows(5, stride), 5), 5);
  eq('5 available', r.available, 5);
  const dst = new Float64Array(16 * stride);
  eq('read 5 rows', r.read(dst, 16), 5);
  check('contents survive the round trip', verifyRows(dst, 5, stride) === null,
        verifyRows(dst, 5, stride) ?? '');
  eq('empty again', r.available, 0);
  eq('reading an empty ring returns 0', r.read(dst, 16), 0);
}

console.log('\nBack-pressure at capacity');
{
  const stride = 2;
  const buf = allocate(8, stride);
  const w = new RingWriter(buf);
  const r = new RingReader(buf);

  eq('fills exactly to capacity', w.write(makeRows(8, stride), 8), 8);
  eq('no free space', w.free, 0);
  eq('further writes are refused', w.write(makeRows(3, stride), 3), 0);

  const dst = new Float64Array(8 * stride);
  eq('drain 3', r.read(dst, 3), 3);
  eq('partial write takes what fits', w.write(makeRows(5, stride, 100), 5), 3);
  eq('full again', w.free, 0);
}

console.log('\nWrapping the data region');
{
  // Capacity 8: write/read 6, then write 6 more so the span crosses the end.
  const stride = 3;
  const buf = allocate(8, stride);
  const w = new RingWriter(buf);
  const r = new RingReader(buf);
  const dst = new Float64Array(8 * stride);

  w.write(makeRows(6, stride), 6);
  r.read(dst, 6);

  eq('write across the wrap', w.write(makeRows(6, stride, 50), 6), 6);
  eq('read across the wrap', r.read(dst, 8), 6);
  const bad = verifyRows(dst, 6, stride, 50);
  check('wrapped contents are intact', bad === null, bad ?? '');
}

console.log('\nSustained streaming with a lagging consumer');
{
  // Producer wants to push far more than capacity; consumer drains in odd-sized
  // chunks so the wrap point lands mid-chunk repeatedly.
  const stride = 5;
  const total = 5000;
  const buf = allocate(64, stride);
  const w = new RingWriter(buf);
  const r = new RingReader(buf);

  let produced = 0;
  let consumed = 0;
  let bad = null;
  const dst = new Float64Array(64 * stride);
  let guard = 0;

  while (consumed < total && guard++ < 1e6) {
    if (produced < total) {
      const chunk = Math.min(7, total - produced);
      const src = makeRows(chunk, stride, produced);
      produced += w.write(src, chunk);
    }
    const got = r.read(dst, 5);
    if (got > 0) {
      const e = verifyRows(dst, got, stride, consumed);
      if (e && !bad) bad = e;
      consumed += got;
    }
  }
  eq('everything produced', produced, total);
  eq('everything consumed', consumed, total);
  check('no row was corrupted or reordered', bad === null, bad ?? '');
}

console.log('\nZero-copy peek');
{
  const stride = 2;
  const buf = allocate(8, stride);
  const w = new RingWriter(buf);
  const r = new RingReader(buf);
  w.write(makeRows(4, stride), 4);

  let seen = 0;
  const times = [];
  r.peek((view, n, s) => {
    seen = n;
    for (let i = 0; i < n; i++) times.push(view[i * s]);
  });
  eq('peek saw all 4 rows', seen, 4);
  eq('peek advanced the read cursor', r.available, 0);
  check('peek returned the right times', times.join(',') === '0,1,2,3', times.join(','));
}

console.log('\nState signalling');
{
  const buf = allocate(4, 2);
  const w = new RingWriter(buf);
  const r = new RingReader(buf);
  w.setState(STATE_RUNNING);
  eq('reader observes running', r.state, STATE_RUNNING);
  w.setState(STATE_DONE);
  eq('reader observes done', r.state, STATE_DONE);
}

console.log('\nA paused consumer stalls, then recovers');
{
  // Back-pressure means a consumer that stops draining stops the producer.
  // That is correct — but it makes the consumer's scheduling load-bearing, and
  // is exactly why SimClient must not pump on requestAnimationFrame alone
  // (rAF does not fire in a hidden tab, so the run would hang at zero points
  // forever without ever reporting an error).
  const stride = 2;
  const buf = allocate(8, stride);
  const w = new RingWriter(buf);
  const r = new RingReader(buf);

  let produced = 0;
  const pump = () => {
    while (produced < 100) {
      const n = w.write(makeRows(1, stride, produced), 1);
      if (n === 0) break;      // full: producer must wait for the consumer
      produced += n;
    }
  };

  pump();
  eq('producer fills the ring then stops', produced, 8);
  const before = produced;
  pump();
  eq('a stalled consumer blocks all further progress', produced, before);

  // Consumer wakes up.
  const dst = new Float64Array(8 * stride);
  let consumed = 0;
  let bad = null;
  let guard = 0;
  while (consumed < 100 && guard++ < 1000) {
    const got = r.read(dst, 8);
    if (got) {
      const e = verifyRows(dst, got, stride, consumed);
      if (e && !bad) bad = e;
      consumed += got;
    }
    pump();
  }
  eq('everything arrives once draining resumes', consumed, 100);
  check('and nothing was corrupted by the stall', bad === null, bad ?? '');
}

console.log('\nCross-thread transfer via a real Worker');
{
  // The genuine test of sharing: a second thread writes, this one reads, with
  // no postMessage carrying the payload.
  const { Worker } = await import('node:worker_threads');
  const stride = 3;
  const rows = 500;
  const buf = allocate(32, stride);

  const src = new URL('./ring-worker.mjs', import.meta.url);
  const worker = new Worker(src, { workerData: { buf, stride, rows } });

  const r = new RingReader(buf);
  const dst = new Float64Array(32 * stride);
  let consumed = 0;
  let bad = null;
  const deadline = Date.now() + 5000;

  while (consumed < rows && Date.now() < deadline) {
    const got = r.read(dst, 32);
    if (got > 0) {
      const e = verifyRows(dst, got, stride, consumed);
      if (e && !bad) bad = e;
      consumed += got;
    } else if (r.state === 3) {
      break;
    }
  }
  await worker.terminate();

  eq('received every row written by the worker thread', consumed, rows);
  check('worker-written data is intact', bad === null, bad ?? '');
}

console.log(`\n${'-'.repeat(72)}`);
console.log(`${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  ' + f);
  process.exit(1);
}
