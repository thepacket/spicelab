/**
 * Transport-agnostic simulation engine.
 *
 * Owns the wasm session and the ring producer, and knows nothing about how
 * messages arrive. The browser worker (sim-worker.js) and the Node test harness
 * both drive this same class, which is the only reason the streaming path can
 * be tested without a browser.
 *
 * The producer loop is the interesting part. It must:
 *
 *   - never outrun the consumer (ask the ring how much space there is and pass
 *     that to the solver as a row budget, rather than producing and discarding),
 *   - never block the worker's message loop, or pause and cancel would not be
 *     delivered until the run finished,
 *   - re-derive its view of wasm memory after every call, because a growing
 *     wasm heap detaches every existing ArrayBuffer view.
 *
 * That last one is the quiet failure: a cached Float64Array over wasm memory
 * keeps working right up until an allocation triggers growth, then silently
 * reads zeroes or throws.
 */
import { RingWriter, STATE_DONE, STATE_ERROR, STATE_RUNNING } from './ring.js';
import { STEP_BATCH } from './protocol.js';
import { rustCanRun } from './engines.js';

/** Yield to the event loop so pending messages get processed. */
const yieldToLoop = () =>
  new Promise((resolve) => setTimeout(resolve, 0));

export class SimEngine {
  /** @see {import('./engines.js').Engine} — this is that contract. */
  id = 'rust';
  label = 'SpiceLab core';
  /**
   * Interactive: the symbolic/numeric split means a value change re-stamps an
   * already-analysed matrix, and `_produce` passes the ring's free space to the
   * solver so back-pressure reaches it. Both are required to claim this.
   */
  interactive = true;

  /**
   * @param {object} opts
   * @param {Function} opts.Session wasm-bindgen `Session` class
   * @param {() => WebAssembly.Memory} opts.memory returns the module's memory
   * @param {(evt: string, payload?: object) => void} opts.emit control-channel send
   */
  constructor({ Session, memory, emit }) {
    this.Session = Session;
    this.canRun = rustCanRun(Session);
    this.getMemory = memory;
    this.emit = emit;
    this.session = null;
    this.writer = null;
    this.running = false;
    this.paused = false;
    this.cancelled = false;
  }

  /**
   * A Float64Array over the session's staged rows.
   *
   * Rebuilt on every call on purpose — see the note about detached buffers in
   * the file header. Never cache the result across a wasm call.
   */
  _stagedView(rows) {
    const stride = this.session.stride;
    return new Float64Array(
      this.getMemory().buffer,
      this.session.stagingPtr,
      rows * stride,
    );
  }

  /**
   * Compile a netlist and attach a ring buffer.
   * @param {string} netlist
   * @param {SharedArrayBuffer|ArrayBuffer} ring pre-allocated by the caller,
   *   which needs `stride` to size it — so the caller compiles once to learn
   *   the stride, or over-allocates. See client.js for how this is sequenced.
   */
  load(netlist) {
    this.cancel();
    this.session = this.Session.fromNetlist(netlist);
    return {
      stride: this.session.stride,
      numUnknowns: this.session.numUnknowns,
      labels: this.session.labels().split('\n'),
    };
  }

  attachRing(buf) {
    this.writer = new RingWriter(buf);
    if (this.writer.stride !== this.session.stride) {
      throw new Error(
        `ring stride ${this.writer.stride} does not match session stride ` +
        `${this.session.stride}`,
      );
    }
  }

  /** Solve the operating point and publish it as a single ring row. */
  op() {
    this.session.solveOp();
    const rows = 1;
    this.writer.write(this._stagedView(rows), rows);
    this.writer.setState(STATE_DONE);
    return { numUnknowns: this.session.numUnknowns };
  }

  /**
   * Run a transient, streaming rows into the ring until tstop.
   *
   * Returns when the run finishes, is cancelled, or pauses.
   */
  async tran({ tstop, tstep, tmax = 0, uic = false, method = '' }) {
    this.session.beginTran(tstop, tstep, tmax, uic, method);
    this.cancelled = false;
    this.paused = false;
    this.running = true;
    this.writer.setState(STATE_RUNNING);
    await this._produce();
  }

  async resume() {
    if (!this.session || this.session.done) return;
    this.paused = false;
    this.running = true;
    this.writer.setState(STATE_RUNNING);
    await this._produce();
  }

  pause() {
    this.paused = true;
  }

  cancel() {
    this.cancelled = true;
    this.running = false;
  }

  async _produce() {
    let lastReport = 0;
    // Yielding is how pause and cancel get delivered, so it has to happen —
    // but NOT once per batch. `setTimeout(0)` clamps to ~4 ms once nested,
    // which caps the loop at roughly 250 batches/second no matter how fast the
    // solver is. At 64 steps a batch that is ~16k points/second, so a 200k
    // point run spends ~45 s asleep and about half a second solving. Yield on a
    // time budget instead: message latency stays at a frame, and throughput is
    // bounded by the solver again.
    const YIELD_MS = 8;
    let lastYield = Date.now();
    try {
      while (this.running && !this.paused && !this.cancelled) {
        if (this.session.done) break;

        // Back-pressure: the solver is told how many rows may be produced, so
        // it never computes points that have nowhere to go. A full ring means
        // the consumer is behind; yield and re-check rather than dropping.
        const free = this.writer.free;
        if (free === 0) {
          await yieldToLoop();
          lastYield = Date.now();
          continue;
        }

        const rows = this.session.advance(STEP_BATCH, free);
        if (rows > 0) {
          const written = this.writer.write(this._stagedView(rows), rows);
          // `free` was read before advancing and the consumer only ever creates
          // space, so a short write is impossible. Assert rather than lose data
          // silently if that reasoning ever stops holding.
          if (written !== rows) {
            throw new Error(
              `ring accepted ${written} of ${rows} rows despite ${free} free`,
            );
          }
        }

        const now = Date.now();
        if (now - lastReport > 100) {
          lastReport = now;
          this.emit('progress', {
            time: this.session.simTime,
            accepted: this.session.accepted,
            rejected: this.session.rejected,
          });
        }
        if (now - lastYield >= YIELD_MS) {
          await yieldToLoop();
          lastYield = Date.now();
        }
      }

      if (this.session.done) {
        this.writer.setState(STATE_DONE);
        this.running = false;
        this.emit('tran-done', {
          time: this.session.simTime,
          accepted: this.session.accepted,
          rejected: this.session.rejected,
        });
      }
    } catch (e) {
      this.running = false;
      this.writer.setState(STATE_ERROR);
      this.emit('error', { message: String(e?.message ?? e) });
    }
  }

  /**
   * Run an AC sweep to completion.
   * Rows are `[freq, re0, im0, re1, im1, ...]`, a different shape from the
   * transient stream, so they are returned rather than pushed through the ring.
   */
  ac({ scale = 'dec', points = 10, start = 1, stop = 1e6 }) {
    const n = this.session.runAc(scale, points, start, stop);
    const stride = 1 + 2 * this.session.numUnknowns;
    const view = new Float64Array(
      this.getMemory().buffer,
      this.session.stagingPtr,
      n * stride,
    );
    // Copied out of wasm memory: the caller keeps this past the next wasm call.
    return { points: n, stride, data: view.slice() };
  }

  /**
   * DC sweep. Rows are `[x, v0, v1, ...]` — the transient shape, not AC's
   * interleaved re/im, because a sweep is a real analysis.
   *
   * That is the whole reason this needs no work in the probe system or the
   * renderer: `Probe.resolve` returns a reader parameterised by stride and
   * offset precisely so one resolution path serves every analysis.
   */
  dc({ source, start = 0, stop = 5, step = 0.1 }) {
    if (!source) throw new Error('a DC sweep needs a source to sweep');
    const n = this.session.runDc(source, start, stop, step);
    const stride = 1 + this.session.numUnknowns;
    const view = new Float64Array(
      this.getMemory().buffer,
      this.session.stagingPtr,
      n * stride,
    );
    return { points: n, stride, data: view.slice() };
  }
}
