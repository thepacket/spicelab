/**
 * Message protocol between the main thread and the simulation worker.
 *
 * Control messages go over postMessage; SOLUTION DATA DOES NOT. Waveform rows
 * travel through the shared ring buffer (see ring.js) and are never serialized.
 * Everything here is small, infrequent, and JSON-shaped: load a netlist, start
 * a run, pause, report an error.
 *
 * The split matters because it is what keeps the two channels honest. If a
 * message type ever needs to carry per-timepoint data, that is a sign the ring
 * is being bypassed.
 */

/** Main thread -> worker. */
export const Cmd = Object.freeze({
  /** Compile a netlist and prepare a session. */
  LOAD: 'load',
  /** Solve the DC operating point. */
  OP: 'op',
  /** Begin a transient run and start streaming. */
  TRAN: 'tran',
  /** Run an AC sweep to completion. */
  AC: 'ac',
  /** Run a DC sweep to completion. */
  DC: 'dc',
  /** Stop producing but keep the session. */
  PAUSE: 'pause',
  /** Resume a paused transient. */
  RESUME: 'resume',
  /** Abandon the current run. */
  CANCEL: 'cancel',
});

/** Worker -> main thread. */
export const Evt = Object.freeze({
  /** Worker booted and the wasm module is instantiated. */
  READY: 'ready',
  /** Netlist compiled: carries labels, stride, and the ring buffer. */
  LOADED: 'loaded',
  /** An operating point is available in the ring. */
  OP_DONE: 'op-done',
  /** Periodic progress during a transient. */
  PROGRESS: 'progress',
  /** Transient reached tstop. */
  TRAN_DONE: 'tran-done',
  /** AC sweep finished; carries the frequency-domain rows. */
  AC_DONE: 'ac-done',
  /** DC sweep finished; carries rows in the transient shape. */
  DC_DONE: 'dc-done',
  /** Any failure, with a human-readable message. */
  ERROR: 'error',
});

/**
 * How many step attempts the solver makes per boundary crossing.
 *
 * This is the knob that trades latency against overhead. Too small and the
 * per-call cost dominates; too large and a pause or parameter change takes
 * effect visibly late. 64 keeps a boundary crossing well under a frame for the
 * circuit sizes this simulator targets.
 */
export const STEP_BATCH = 64;

/**
 * Ring capacity in rows.
 *
 * Sized so a 60 Hz consumer has real headroom: at 16k rows a frame the ring
 * sustains ~1M rows/second before back-pressure engages at all. This matters
 * more than it looks — the ring's capacity is a hard ceiling on throughput
 * whenever the consumer is scheduled at a fixed rate, so undersizing it
 * silently caps the solver rather than merely adding latency.
 */
export const RING_ROWS = 16384;
