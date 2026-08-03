/**
 * Lock-free SPSC ring buffer for streaming solution rows out of the solver.
 *
 * WHY NOT postMessage: a transient run produces thousands of timepoints. Posting
 * each one structured-clones a typed array and wakes the main thread; posting
 * them in batches adds latency and still copies. A shared ring lets the worker
 * write and the renderer read with no serialization and no per-point wakeup.
 *
 * WHY LOSSLESS RATHER THAN OVERWRITING: a scope-like view would be happy to drop
 * old rows, but the same buffer carries full analysis runs whose points all have
 * to arrive. So the producer applies back-pressure: it writes what fits, reports
 * how much it wrote, and the worker stops stepping until the consumer drains.
 * `dropped` exists only so an overwrite mode can be added later without changing
 * the header layout.
 *
 * MEMORY MODEL: one producer (the worker) and one consumer (the main thread),
 * and nothing else may touch the buffer. `write` and `read` are monotonically
 * increasing row counters, never wrapped in the header — only the data index is
 * taken modulo capacity. That removes the classic full-vs-empty ambiguity, and
 * the counters are 32-bit so they wrap at 2^31 rows, which at 64 bytes a row is
 * ~137 GB of waveform; the modulo arithmetic stays correct across that wrap as
 * long as capacity is a power of two.
 *
 * ORDERING: the producer fills the data region and only then publishes the new
 * `write` value with Atomics.store; the consumer reads `write` with Atomics.load
 * before touching the data. That store/load pair is the release/acquire edge
 * that makes the row contents visible.
 *
 * CROSS-ORIGIN ISOLATION IS REQUIRED, not an optimization. A plain ArrayBuffer
 * cannot be shared with a worker: postMessage either structured-clones it (the
 * worker then writes to its own copy, which the main thread never sees) or
 * transfers it (detaching it here). Either way the consumer silently receives
 * nothing. So `allocate` still returns an ArrayBuffer when SharedArrayBuffer is
 * unavailable — a caller may legitimately want a same-thread ring, and the
 * tests use one — but any cross-thread caller must check `isShared` and refuse
 * to proceed. `SimClient.load` does exactly that. See scripts/dev-server.mjs
 * for the headers, and CLAUDE.md for the hosting decision.
 */

/** Int32 header slots. Kept at 8 entries so the f64 region stays 8-byte aligned. */
export const HEADER_I32 = 8;
export const HDR_WRITE = 0;
export const HDR_READ = 1;
export const HDR_CAPACITY = 2;
export const HDR_STRIDE = 3;
export const HDR_STATE = 4;
export const HDR_DROPPED = 5;
export const HDR_ERRLEN = 6;

/** Producer state, published so the consumer knows when to stop polling. */
export const STATE_IDLE = 0;
export const STATE_RUNNING = 1;
export const STATE_DONE = 2;
export const STATE_ERROR = 3;

const HEADER_BYTES = HEADER_I32 * 4;

/** Round up to a power of two, so the modulo can be a mask. */
function pow2(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * Allocate a buffer sized for `rows` rows of `stride` f64 values.
 * Uses SharedArrayBuffer when the page is cross-origin isolated, else falls
 * back to ArrayBuffer (single-threaded / postMessage transfer).
 * @param {number} rows requested capacity in rows; rounded up to a power of two
 * @param {number} stride values per row (time + one per unknown)
 */
export function allocate(rows, stride) {
  const capacity = pow2(Math.max(2, rows));
  const bytes = HEADER_BYTES + capacity * stride * 8;
  const shared =
    typeof SharedArrayBuffer !== 'undefined' &&
    (typeof globalThis.crossOriginIsolated === 'undefined' || globalThis.crossOriginIsolated);
  const buf = shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
  const hdr = new Int32Array(buf, 0, HEADER_I32);
  hdr[HDR_CAPACITY] = capacity;
  hdr[HDR_STRIDE] = stride;
  hdr[HDR_STATE] = STATE_IDLE;
  return buf;
}

/** True if this buffer supports genuine cross-thread sharing. */
export function isShared(buf) {
  return typeof SharedArrayBuffer !== 'undefined' && buf instanceof SharedArrayBuffer;
}

class RingBase {
  constructor(buf) {
    this.buf = buf;
    this.hdr = new Int32Array(buf, 0, HEADER_I32);
    this.capacity = this.hdr[HDR_CAPACITY];
    this.stride = this.hdr[HDR_STRIDE];
    this.mask = this.capacity - 1;
    this.data = new Float64Array(buf, HEADER_BYTES, this.capacity * this.stride);
  }

  get state() {
    return Atomics.load(this.hdr, HDR_STATE);
  }

  /** Rows written but not yet read. */
  get available() {
    return Atomics.load(this.hdr, HDR_WRITE) - Atomics.load(this.hdr, HDR_READ);
  }
}

/**
 * Producer side. Only the worker may construct one of these.
 */
export class RingWriter extends RingBase {
  /** Rows that can be written before the consumer must drain. */
  get free() {
    return this.capacity - this.available;
  }

  /**
   * Copy rows out of a flat source array.
   *
   * @param {Float64Array} src packed rows, `count * stride` values
   * @param {number} count number of rows available in `src`
   * @returns {number} rows actually written; less than `count` means the
   *   consumer is behind and the caller should stop producing and retry.
   */
  write(src, count) {
    const free = this.free;
    const n = Math.min(count, free);
    if (n <= 0) return 0;

    const write = Atomics.load(this.hdr, HDR_WRITE);
    const start = (write & this.mask) * this.stride;
    const firstRows = Math.min(n, this.capacity - (write & this.mask));

    this.data.set(src.subarray(0, firstRows * this.stride), start);
    if (firstRows < n) {
      // Wrapped: the tail goes back at the start of the data region.
      this.data.set(
        src.subarray(firstRows * this.stride, n * this.stride),
        0,
      );
    }
    // Publish only after the payload is in place.
    Atomics.store(this.hdr, HDR_WRITE, write + n);
    Atomics.notify(this.hdr, HDR_WRITE);
    return n;
  }

  setState(state) {
    Atomics.store(this.hdr, HDR_STATE, state);
    Atomics.notify(this.hdr, HDR_STATE);
  }

  /**
   * BLOCK until at least one row can be written.
   *
   * The mirror of `RingReader.waitForData`, and it exists for one caller: a
   * producer that cannot be asked how many rows to make. The Rust core takes a
   * row budget, so it never overproduces and never needs this. ngspice does
   * not — its per-timepoint callback is invoked from inside the solver loop and
   * has no return value meaning "wait".
   *
   * But that callback runs SYNCHRONOUSLY on the worker thread, so blocking
   * inside it blocks ngspice's solver, which is precisely back-pressure. The
   * consumer notifies HDR_READ every time it drains. This is the piece that
   * lets the second engine stream instead of buffering a whole run in memory,
   * and it is only possible because the engine is linked in rather than run as
   * a subprocess.
   *
   * Worker threads only — `Atomics.wait` throws on the main thread.
   *
   * @param {number} timeoutMs per-wait timeout; the loop re-checks `state` on
   *   each expiry so a cancelled or errored run cannot wedge the producer.
   * @returns {boolean} whether space is now available
   */
  waitForSpace(timeoutMs = 50) {
    while (true) {
      if (this.free > 0) return true;
      if (this.state === STATE_ERROR) return false;
      const read = Atomics.load(this.hdr, HDR_READ);
      Atomics.wait(this.hdr, HDR_READ, read, timeoutMs);
    }
  }
}

/**
 * Consumer side, used on the main thread by the renderer.
 */
export class RingReader extends RingBase {
  /**
   * Read up to `max` rows into `dst`.
   * @param {Float64Array} dst at least `max * stride` long
   * @param {number} max
   * @returns {number} rows read
   */
  read(dst, max) {
    // Acquire: everything the producer wrote before publishing is visible.
    const write = Atomics.load(this.hdr, HDR_WRITE);
    const read = Atomics.load(this.hdr, HDR_READ);
    const n = Math.min(write - read, max);
    if (n <= 0) return 0;

    const start = (read & this.mask) * this.stride;
    const firstRows = Math.min(n, this.capacity - (read & this.mask));
    dst.set(this.data.subarray(start, start + firstRows * this.stride), 0);
    if (firstRows < n) {
      dst.set(
        this.data.subarray(0, (n - firstRows) * this.stride),
        firstRows * this.stride,
      );
    }
    Atomics.store(this.hdr, HDR_READ, read + n);
    Atomics.notify(this.hdr, HDR_READ);
    return n;
  }

  /**
   * Iterate rows without copying. The callback receives a subarray view valid
   * only for the duration of the call. Returns the number of rows consumed.
   *
   * Only safe on a non-wrapping span, so this may return fewer rows than are
   * available; call it again to pick up the remainder.
   */
  peek(fn, max = Infinity) {
    const write = Atomics.load(this.hdr, HDR_WRITE);
    const read = Atomics.load(this.hdr, HDR_READ);
    const avail = Math.min(write - read, max);
    if (avail <= 0) return 0;
    const idx = read & this.mask;
    const n = Math.min(avail, this.capacity - idx);
    const start = idx * this.stride;
    fn(this.data.subarray(start, start + n * this.stride), n, this.stride);
    Atomics.store(this.hdr, HDR_READ, read + n);
    Atomics.notify(this.hdr, HDR_READ);
    return n;
  }

  /**
   * Block until at least one row is available or the producer finishes.
   * Only usable on a worker thread with a SharedArrayBuffer — the main thread
   * may not block, and Atomics.wait throws there.
   * @returns {boolean} whether rows are available
   */
  waitForData(timeoutMs = 100) {
    while (true) {
      if (this.available > 0) return true;
      const state = this.state;
      if (state === STATE_DONE || state === STATE_ERROR) {
        return this.available > 0;
      }
      const write = Atomics.load(this.hdr, HDR_WRITE);
      const r = Atomics.wait(this.hdr, HDR_WRITE, write, timeoutMs);
      if (r === 'timed-out' && this.available === 0) {
        if (this.state !== STATE_RUNNING) return this.available > 0;
      }
    }
  }
}
