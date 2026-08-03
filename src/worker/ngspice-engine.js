/**
 * The ngspice engine: coverage, not interactivity.
 *
 * Implements the same contract as the Rust core (`src/worker/engines.js`) and
 * produces the same ring row format — `[t, v0, v1, ...]` — so the consumer, the
 * probe system and the renderer never learn which engine ran.
 *
 * ## What is different from the Rust engine, and why
 *
 * **It is loaded lazily.** 4.86 MB of wasm (1.56 MB gzipped) against the Rust
 * core's 415 KB. Importing it eagerly would make every page load pay for a
 * capability most designs never need, so `create()` is async and the module is
 * only fetched when `select()` actually routes a design here.
 *
 * **`load()` has to run something.** The Rust core knows its unknowns from the
 * topology build, before any analysis. ngspice only announces its vectors when
 * an analysis starts, so there is no way to learn the stride without running
 * one. `load()` therefore issues an `op` purely to discover the vector list.
 * That is a real cost and a real failure mode — a circuit whose operating point
 * does not converge cannot report its labels — so it is reported honestly
 * rather than hidden.
 *
 * **Back-pressure works, and that was not obvious.** ngspice's per-timepoint
 * callback has no return value meaning "wait", which is why every
 * subprocess-based frontend (Qucs-S included) buffers a whole run or streams
 * without flow control. But the callback is invoked SYNCHRONOUSLY from inside
 * the solver loop, and this engine runs on a worker thread, so blocking in the
 * callback blocks ngspice itself. `RingWriter.waitForSpace` does exactly that.
 * The solver stalls when the consumer falls behind, which is the same guarantee
 * the Rust engine gets from its row budget, reached by a different route.
 *
 * `bg_run` is never called. It is the only ngspice path that needs threads, and
 * this build has none. See `docs/ngspice-wasm-build.md`.
 */
import { RingWriter, STATE_DONE, STATE_ERROR, STATE_RUNNING } from './ring.js';
import { YES } from './engines.js';

/**
 * Rewrite an ngspice vector name into SpiceLab's label convention.
 *
 * The two engines name the same quantity differently, and the probe system
 * resolves by NAME, so without this a probe on `I(V1)` reports "no branch
 * current for V1" the moment a design is routed to ngspice — a correct-looking
 * error about a signal that is right there.
 *
 * Only the FORM is normalised, not the case: SPICE identifiers are
 * case-insensitive and `Probe.resolve` compares that way, so reconstructing the
 * netlist's original capitalisation here would be guesswork with nothing to
 * gain. ngspice lowercases everything it reports.
 *
 *   v1#branch  ->  I(v1)      branch current
 *   x1.m       ->  x1.m       hierarchical node, already compatible
 */
export function normalizeVectorName(name) {
  const branch = /^(.*)#branch$/.exec(name);
  return branch ? `I(${branch[1]})` : name;
}

export class NgspiceEngine {
  id = 'ngspice';
  label = 'ngspice 46';
  /**
   * NOT interactive, and this is a capability claim the UI acts on.
   *
   * Back-pressure works (see above), but the other half of interactivity does
   * not: there is no symbolic/numeric split to exploit, so a changed value
   * means re-sending the deck and re-running from scratch. Live controls must
   * not be offered for a design that lands here.
   */
  interactive = false;

  constructor(mod, emit) {
    this.mod = mod;
    this.emit = emit ?? (() => {});
    this.writer = null;
    this.labels = [];
    this.stride = 0;
    this.complex = false;
    this.cancelled = false;
    this.paused = false;
    this.running = false;
    this._rowSink = null;
    this._log = [];

    mod.onVectors = (s, complex) => {
      this.labels = s.split('\n').filter(Boolean).map(normalizeVectorName);
      // A complex plot carries re/im pairs, so the row is 1 + 2n wide. The
      // caller needs this BEFORE the first row in order to size a ring.
      this.complex = !!complex;
      this.stride = complex ? 1 + 2 * this.labels.length : 1 + this.labels.length;
    };
    mod.onRow = (idx, n) => this._row(idx, n);
    mod.onLog = (line, isErr) => {
      // ngspice prefixes with "stdout "/"stderr ". Keep only complaints; the
      // rest is banner noise on every single run.
      const text = line.replace(/^std(out|err)\s*/, '').trim();
      if (!text) return;
      if (isErr || /error|warning/i.test(text)) this._log.push(text);
    };
  }

  /**
   * Fetch and instantiate the wasm module. Async and lazy on purpose.
   * @param {(evt: string, payload?: object) => void} [emit]
   */
  static async create(emit) {
    const { default: factory } = await import('../ngspice/ngspice.mjs');
    const mod = await factory({});
    const engine = new NgspiceEngine(mod, emit);
    if (engine._call('ngw_init') !== 0) throw new Error('ngSpice_Init failed');
    return engine;
  }

  _call(fn, ...args) {
    return this.mod.ccall(fn, 'number', args.map(() => 'string'), args);
  }

  /**
   * The coverage engine accepts anything.
   *
   * It does NOT pre-validate. Under the selection rule in `engines.js` a
   * malformed netlist is stopped by the preferred engine before it ever reaches
   * here, and a second opinion on validity is exactly what that rule exists to
   * prevent. Genuine failures surface from `load()` with ngspice's own message.
   */
  canRun() {
    return YES;
  }

  /**
   * Compile the deck and discover the vector list.
   *
   * The `op` is a probe, not a result — see the note in the file header.
   */
  load(netlist) {
    this.cancel();
    this.labels = [];
    this.stride = 0;
    this._log = [];
    // Analysis cards in the deck would run on `run`; the engine issues its own
    // nutmeg commands instead, so the API call is what decides the analysis.
    if (this._call('ngw_load', netlist) !== 0) {
      throw new Error(this._why('ngspice rejected the netlist'));
    }
    this._rowSink = () => {};        // discard the probe's rows
    this._call('ngw_command', 'op');
    this._rowSink = null;
    if (!this.labels.length) {
      throw new Error(this._why('ngspice produced no vectors'));
    }
    return { stride: this.stride, numUnknowns: this.labels.length, labels: this.labels };
  }

  _why(prefix) {
    return this._log.length ? `${prefix}: ${this._log.join('; ')}` : prefix;
  }

  attachRing(buf) {
    this.writer = new RingWriter(buf);
    if (this.writer.stride !== this.stride) {
      throw new Error(
        `ring stride ${this.writer.stride} does not match ngspice stride ${this.stride}`,
      );
    }
  }

  /** Called synchronously from inside ngspice's solver loop. */
  _row(idx, n) {
    if (this._rowSink) { this._rowSink(idx, n); return; }
    if (!this.writer || this.cancelled) return;
    const src = this.mod.HEAPF64.subarray(idx, idx + this.stride);
    // Block until the consumer makes room. This is the back-pressure: ngspice
    // is stalled inside its own timestep loop, so nothing is computed that has
    // nowhere to go.
    if (!this.writer.waitForSpace()) { this.cancelled = true; return; }
    this.writer.write(src, 1);
    this._produced++;
  }

  op() {
    this._produced = 0;
    // `load()` calls `cancel()`, which latches `cancelled` — and `_row` drops
    // every row while it is set. `tran()` clears it; this did not, so operating
    // points silently produced an all-zero row. Nothing errored: the ring state
    // reached DONE, the probe resolved, and it read 0 V off a divider.
    this.cancelled = false;
    this.writer.setState(STATE_RUNNING);
    this._call('ngw_command', 'op');
    this.writer.setState(STATE_DONE);
    return { numUnknowns: this.labels.length };
  }

  /**
   * Run a transient to completion, streaming rows as they are produced.
   *
   * Returns only when ngspice returns: unlike the Rust engine there is no
   * resumable stepper, so `pause` and `resume` cannot be honoured mid-run.
   */
  async tran({ tstop, tstep }) {
    this._produced = 0;
    this.cancelled = false;
    this.running = true;
    this.writer.setState(STATE_RUNNING);
    try {
      const rc = this._call('ngw_command', `tran ${tstep} ${tstop}`);
      if (rc !== 0 && this._log.length) throw new Error(this._why('transient failed'));
      this.writer.setState(STATE_DONE);
      this.emit('tran-done', { rows: this._produced });
    } catch (e) {
      this.writer.setState(STATE_ERROR);
      this.emit('error', { message: String(e?.message ?? e) });
    } finally {
      this.running = false;
    }
  }

  /**
   * AC sweep, returned as a block rather than streamed.
   *
   * Rows are `[f, re0, im0, re1, im1, ...]` — the same shape the Rust engine
   * returns, so `Probe.resolve`'s stride/offset arithmetic works unchanged.
   * The shim supplies `cimag`; an earlier version did not, and the real part
   * alone still rolls off like a filter response while being wrong everywhere
   * except DC.
   */
  ac({ scale = 'dec', points = 10, start = 1, stop = 1e6 }) {
    const rows = [];
    this._rowSink = (idx, n) => rows.push(this.mod.HEAPF64.slice(idx, idx + n));
    this._call('ngw_command', `ac ${scale} ${points} ${start} ${stop}`);
    this._rowSink = null;
    if (!this.complex && rows.length) {
      throw new Error('ngspice returned real data for an AC sweep');
    }
    const stride = this.stride;
    const data = new Float64Array(rows.length * stride);
    rows.forEach((r, i) => data.set(r.subarray(0, stride), i * stride));
    return { points: rows.length, stride, data };
  }

  /**
   * Not supported: ngspice has no resumable stepper. Reported rather than
   * silently ignored, because a UI that offers pause and gets nothing is worse
   * than one that knows it cannot.
   */
  pause() { this.paused = false; }
  async resume() { /* nothing to resume */ }

  cancel() {
    this.cancelled = true;
    this.running = false;
    if (this.mod && this._call('ngw_running')) this._call('ngw_command', 'bg_halt');
  }
}
