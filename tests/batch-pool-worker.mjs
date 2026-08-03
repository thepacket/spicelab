/** Node analogue of src/worker/batch-worker.js. */
import { parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { runCase } from '../src/worker/batch-core.js';

const require = createRequire(import.meta.url);
const wasm = require('../src/wasm-node/spicelab_wasm.js');

parentPort.postMessage({ ready: true });
parentPort.on('message', ({ id, spec }) => {
  try {
    parentPort.postMessage({ id, result: runCase(wasm.Session, () => wasm.memory, spec) });
  } catch (err) {
    parentPort.postMessage({ id, error: String(err?.message ?? err) });
  }
});
