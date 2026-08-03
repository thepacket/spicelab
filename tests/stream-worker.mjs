/**
 * Worker side of the end-to-end streaming test: the Node analogue of
 * src/worker/sim-worker.js. Drives the same SimEngine, so the streaming path
 * under test is the real one, not a mock.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { SimEngine } from '../src/worker/engine.js';

const require = createRequire(import.meta.url);
const wasm = require('../src/wasm-node/spicelab_wasm.js');

const { ring, netlist, run } = workerData;

const engine = new SimEngine({
  Session: wasm.Session,
  memory: () => wasm.memory,
  emit: (evt, payload) => parentPort.postMessage({ evt, payload }),
});

try {
  const info = engine.load(netlist);
  engine.attachRing(ring);
  parentPort.postMessage({ evt: 'loaded', payload: info });
  await engine.tran(run);
} catch (e) {
  parentPort.postMessage({ evt: 'error', payload: { message: String(e?.message ?? e) } });
}
