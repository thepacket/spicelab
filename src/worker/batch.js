/**
 * Batch runner: a pool of workers, one independent circuit per task.
 *
 * The parallelism is ACROSS cases, never inside one. A single circuit's sparse
 * LU is a sequential dependency chain, so splitting it would cost more in
 * synchronisation than it saves; a thousand-point sweep, by contrast, is a
 * thousand problems that never talk to each other. See batch-core.js for why
 * this is a CPU pool rather than a WGSL kernel.
 *
 * Each worker instantiates its own wasm module and therefore its own linear
 * memory, so cases cannot interfere. That is also why the pool size defaults to
 * hardwareConcurrency rather than something larger: every worker costs a full
 * wasm instance, and past the core count they only contend.
 */
import { sampleSets, summarize, sweepValues } from './batch-core.js';

export class BatchRunner {
  /**
   * @param {object} opts
   * @param {number} [opts.workers] pool size; defaults to hardwareConcurrency
   * @param {string|URL} [opts.workerUrl]
   */
  static async create(opts = {}) {
    const n = Math.max(1, opts.workers
      ?? Math.min(8, navigator.hardwareConcurrency || 4));
    const url = opts.workerUrl ?? new URL('./batch-worker.js', import.meta.url);
    const runner = new BatchRunner();
    runner.workers = await Promise.all(
      Array.from({ length: n }, () => spawn(url)),
    );
    return runner;
  }

  constructor() {
    this.workers = [];
    this.cancelled = false;
  }

  /**
   * Run every case, `workers` at a time.
   *
   * Results come back in INPUT order regardless of completion order — a sweep
   * plotted in completion order would look like noise.
   *
   * @param {Array<object>} cases specs for batch-core `runCase`
   * @param {(done:number,total:number)=>void} [onProgress]
   */
  async run(cases, onProgress) {
    this.cancelled = false;
    const results = new Array(cases.length);
    let next = 0;
    let done = 0;

    const pump = async (w) => {
      while (!this.cancelled) {
        const i = next++;
        if (i >= cases.length) return;
        results[i] = await call(w, cases[i]);
        done++;
        onProgress?.(done, cases.length);
      }
    };

    await Promise.all(this.workers.map(pump));
    return results;
  }

  /** Sweep one parameter and measure each point. */
  async sweep({ netlist, param, values, scale, start, stop, points, analysis, measures },
              onProgress) {
    const vals = values ?? sweepValues({ start, stop, points, scale });
    const cases = vals.map((v) => ({
      netlist, overrides: { [param]: v }, analysis, measures,
    }));
    const results = await this.run(cases, onProgress);
    return { values: vals, results };
  }

  /** Monte Carlo over component tolerances. */
  async monteCarlo({ netlist, params, trials = 100, seed = 1, analysis, measures },
                   onProgress) {
    const sets = sampleSets(params, trials, seed);
    const cases = sets.map((overrides) => ({
      netlist, overrides, analysis, measures,
    }));
    const results = await this.run(cases, onProgress);
    return {
      sets,
      results,
      stats: summarize(results, measures.map((m) => m.name)),
    };
  }

  cancel() {
    this.cancelled = true;
  }

  terminate() {
    for (const w of this.workers) w.worker.terminate();
    this.workers = [];
  }
}

function spawn(url) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(url, { type: 'module' });
    const handle = { worker, seq: 0, pending: new Map() };
    worker.onmessage = (e) => {
      const { id, ready, error, result } = e.data ?? {};
      if (ready) { resolve(handle); return; }
      if (error && id === undefined) { reject(new Error(error)); return; }
      const p = handle.pending.get(id);
      if (!p) return;
      handle.pending.delete(id);
      // A worker-side failure is data, not an exception: one bad corner must
      // not abort the other 999 cases.
      p.resolve(result ?? { ok: false, error: error ?? 'unknown worker error' });
    };
    worker.onerror = (e) => reject(new Error(e.message ?? 'worker failed to start'));
  });
}

function call(handle, spec) {
  const id = ++handle.seq;
  return new Promise((resolve) => {
    handle.pending.set(id, { resolve });
    handle.worker.postMessage({ id, spec });
  });
}

export { sampleSets, summarize, sweepValues };
