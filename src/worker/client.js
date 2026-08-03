/**
 * Main-thread client for the simulation worker.
 *
 * Two channels, as described in protocol.js: control over postMessage, waveform
 * rows over the shared ring. The client hides the request/reply plumbing and
 * pumps the ring on animation frames so the caller sees a plain callback.
 *
 * SEQUENCING NOTE. The ring cannot be allocated until the stride is known, and
 * the stride is not known until the netlist has been compiled. So `load` is two
 * round trips: compile, then allocate and attach. Doing it the other way — a
 * fixed maximum stride — would waste memory on small circuits and break on
 * large ones.
 */
import { Cmd, Evt, RING_ROWS } from './protocol.js';
import { allocate, isShared, RingReader, STATE_DONE, STATE_ERROR } from './ring.js';

export class SimClient {
  constructor(worker) {
    this.worker = worker;
    this.reader = null;
    this.stride = 0;
    this.labels = [];
    this.numUnknowns = 0;
    this._seq = 0;
    this._pending = new Map();
    this._listeners = new Map();
    this._pumping = false;

    worker.onmessage = (e) => this._onMessage(e.data);
  }

  /**
   * Boot a worker and wait for its wasm module to instantiate.
   * @param {string|URL} [workerUrl]
   */
  static async create(workerUrl = new URL('./sim-worker.js', import.meta.url)) {
    const worker = new Worker(workerUrl, { type: 'module' });
    const client = new SimClient(worker);
    await new Promise((resolve, reject) => {
      client.on(Evt.READY, resolve);
      client.on(Evt.ERROR, (p) => reject(new Error(p.message)));
    });
    return client;
  }

  /** Subscribe to an unsolicited worker event (progress, tran-done, error). */
  on(evt, fn) {
    if (!this._listeners.has(evt)) this._listeners.set(evt, new Set());
    this._listeners.get(evt).add(fn);
    return () => this._listeners.get(evt).delete(fn);
  }

  _emit(evt, payload) {
    const set = this._listeners.get(evt);
    if (set) for (const fn of set) fn(payload);
  }

  _onMessage(msg) {
    const { id, evt, payload } = msg ?? {};
    if (id !== undefined && this._pending.has(id)) {
      const { resolve, reject } = this._pending.get(id);
      this._pending.delete(id);
      if (evt === Evt.ERROR) reject(new Error(payload.message));
      else resolve(payload);
      return;
    }
    this._emit(evt, payload);
  }

  _send(cmd, args = {}, transfer = []) {
    const id = ++this._seq;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, cmd, args }, transfer);
    });
  }

  /**
   * Compile a netlist and attach a ring sized for it.
   * @returns {Promise<{stride:number, labels:string[], numUnknowns:number}>}
   */
  async load(netlist) {
    const info = await this._send(Cmd.LOAD, { netlist });
    this.stride = info.stride;
    this.labels = info.labels;
    this.numUnknowns = info.numUnknowns;
    /**
     * Which engine ran this design, and whether it supports live interaction.
     * Surfaced rather than hidden — see the two-engine note in CLAUDE.md.
     * @type {{id:string,label:string,interactive:boolean}|null}
     */
    this.engine = info.engine ?? null;
    this.engineReason = info.engineReason ?? '';

    const ring = allocate(RING_ROWS, this.stride);
    if (!isShared(ring)) {
      // Fail loudly. A plain ArrayBuffer sent to a worker is copied or
      // detached, so the worker would stream into memory this thread cannot
      // see and every run would silently produce no waveform. A clear error
      // beats an empty plot with no explanation.
      throw new Error(
        'SharedArrayBuffer is unavailable: this page is not cross-origin ' +
        'isolated. Serve it with "Cross-Origin-Opener-Policy: same-origin" and ' +
        '"Cross-Origin-Embedder-Policy: require-corp" (see scripts/dev-server.mjs).',
      );
    }
    this.reader = new RingReader(ring);
    this.shared = true;
    await this._send('attach-ring', { ring });
    return info;
  }

  /** Solve the operating point. Resolves to the solution vector. */
  async op() {
    await this._send(Cmd.OP);
    const dst = new Float64Array(this.stride);
    this.reader.read(dst, 1);
    // Column 0 is time (0 for an operating point); the rest are the unknowns.
    return dst.subarray(1);
  }

  /**
   * Run a transient, delivering batches of rows as they are produced.
   *
   * @param {object} opts tstop, tstep, tmax, uic, method
   * @param {(rows: Float64Array, count: number, stride: number) => void} onRows
   *   called with a view valid only for the duration of the call
   * @returns {Promise<object>} resolves with the run statistics at tstop
   */
  async tran(opts, onRows) {
    const finished = new Promise((resolve, reject) => {
      const offDone = this.on(Evt.TRAN_DONE, (p) => {
        offDone(); offErr();
        // Drain whatever is still buffered before reporting completion.
        this._drain(onRows);
        resolve(p);
      });
      const offErr = this.on(Evt.ERROR, (p) => {
        offDone(); offErr();
        reject(new Error(p.message));
      });
    });

    await this._send(Cmd.TRAN, opts);
    this._pump(onRows);
    return finished;
  }

  /** Drain everything currently available, without waiting. */
  _drain(onRows) {
    if (!this.reader || !onRows) return 0;
    let total = 0;
    let n;
    // peek() stops at the wrap point, so loop until it yields nothing.
    while ((n = this.reader.peek(onRows)) > 0) total += n;
    return total;
  }

  /**
   * Pump the ring until the run ends.
   *
   * Frame-paced while the page is visible: the consumer only needs to keep up
   * with the display, and draining more often just burns main-thread time the
   * renderer wants.
   *
   * BUT IT MUST NOT DEPEND ON requestAnimationFrame ALONE. rAF does not fire in
   * a hidden or backgrounded tab, and the ring applies back-pressure — so a
   * consumer that stops draining stops the WORKER too. The symptom is not a
   * slow run, it is a run that hangs at zero points forever and never reports
   * an error, because nothing has failed: the producer is patiently waiting for
   * space that will never appear. Switching tabs mid-simulation is enough to
   * trigger it.
   *
   * So: rAF when visible, a timer when hidden, re-checked every tick.
   */
  _pump(onRows) {
    if (this._pumping) return;
    this._pumping = true;

    const hidden = () =>
      typeof document !== 'undefined' && document.visibilityState === 'hidden';

    // Background scheduling must NOT use setTimeout. Browsers clamp timers to
    // 1 Hz in a hidden tab, and because the ring applies back-pressure that
    // clamp becomes the simulation's speed limit: the consumer drains at most
    // one ring-full per second, so a 200k point run took ~49 s (4096 rows of
    // ring / 200k rows = 49 ticks) instead of well under a second. The solver
    // was idle the entire time waiting for space.
    //
    // A MessageChannel task is a macrotask that is NOT subject to that clamp,
    // so it keeps draining at full speed while still yielding to the event
    // loop between iterations.
    const chan = typeof MessageChannel === 'function' ? new MessageChannel() : null;
    if (chan) chan.port1.onmessage = () => tick();

    const schedule = (fn) => {
      if (typeof requestAnimationFrame === 'function' && !hidden()) {
        requestAnimationFrame(fn);
      } else if (chan) {
        chan.port2.postMessage(0);
      } else {
        setTimeout(fn, 0);
      }
    };

    const tick = () => {
      this._drain(onRows);
      const state = this.reader.state;
      if (state === STATE_DONE || state === STATE_ERROR) {
        this._drain(onRows);
        this._pumping = false;
        return;
      }
      schedule(tick);
    };
    schedule(tick);
  }

  /**
   * Run an AC sweep. Resolves with `{points, stride, data}` where each row is
   * `[freq, re0, im0, re1, im1, ...]`.
   */
  ac(opts) {
    return this._send(Cmd.AC, opts);
  }

  pause() {
    return this._send(Cmd.PAUSE);
  }

  resume() {
    return this._send(Cmd.RESUME);
  }

  cancel() {
    return this._send(Cmd.CANCEL);
  }

  terminate() {
    this.worker.terminate();
  }
}

/**
 * Whether this page can use SharedArrayBuffer.
 *
 * False means the COOP/COEP headers are missing; everything still runs, but the
 * ring falls back to a non-shared ArrayBuffer and the worker's writes are not
 * visible here. See scripts/dev-server.mjs and the hosting note in CLAUDE.md.
 */
export function crossOriginIsolated() {
  return typeof globalThis.crossOriginIsolated === 'boolean'
    ? globalThis.crossOriginIsolated
    : false;
}
