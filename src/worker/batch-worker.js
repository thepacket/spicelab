/**
 * Batch worker: one wasm instance, one case at a time.
 *
 * Thin, like sim-worker.js — the logic lives in batch-core.js so it can be
 * tested under Node without spawning anything.
 */
import init, { Session } from '../wasm/spicelab_wasm.js';
import { runCase } from './batch-core.js';

let memory = null;

self.onmessage = (e) => {
  const { id, spec } = e.data ?? {};
  try {
    // Failures are returned as data so one bad case cannot abort the sweep.
    self.postMessage({ id, result: runCase(Session, () => memory, spec) });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) });
  }
};

init().then((mod) => {
  memory = mod.memory;
  self.postMessage({ ready: true });
}).catch((err) => {
  self.postMessage({ error: `wasm init failed: ${String(err?.message ?? err)}` });
});
