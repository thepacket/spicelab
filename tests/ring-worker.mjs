/** Producer side of the cross-thread ring test. */
import { workerData } from 'node:worker_threads';
import { RingWriter, STATE_DONE, STATE_RUNNING } from '../src/worker/ring.js';

const { buf, stride, rows } = workerData;
const w = new RingWriter(buf);
w.setState(STATE_RUNNING);

let produced = 0;
while (produced < rows) {
  const chunk = Math.min(9, rows - produced);
  const src = new Float64Array(chunk * stride);
  for (let i = 0; i < chunk; i++) {
    const v = produced + i;
    src[i * stride] = v;
    for (let k = 1; k < stride; k++) src[i * stride + k] = v * 10 + k;
  }
  const n = w.write(src, chunk);
  produced += n;
  if (n < chunk) {
    // Ring is full: the consumer is behind. Spin briefly rather than blocking,
    // so this stays a plain busy-wait the test can bound.
    Atomics.wait(w.hdr, 1, Atomics.load(w.hdr, 1), 1);
  }
}
w.setState(STATE_DONE);
