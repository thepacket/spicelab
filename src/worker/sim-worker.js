/**
 * Browser worker adapter.
 *
 * Thin by design: all of the interesting behaviour lives in SimEngine, which is
 * transport-agnostic and covered by tests/stream.test.mjs running under Node
 * worker_threads. This file only translates postMessage into engine calls.
 */
import init, { Session } from '../wasm/spicelab_wasm.js';
import { SimEngine } from './engine.js';
import { select } from './engines.js';
import { Cmd, Evt } from './protocol.js';

/** The interactive engine. Always present; always tried first. */
let rust = null;
/**
 * The coverage engine. Created on FIRST NEED and never before — it is ~4.9 MB
 * of wasm against the Rust core's 415 KB, and most designs never route to it.
 */
let ngspice = null;
/** Whichever engine the current design was routed to. */
let engine = null;
let wasmMemory = null;

async function engineList() {
  return ngspice ? [rust, ngspice] : [rust];
}

/**
 * Choose an engine for `netlist`, loading the coverage engine if needed.
 *
 * The two-pass shape exists because `select()` is synchronous — engines answer
 * `canRun` without I/O — while creating the ngspice engine is an async import.
 * So: ask with what is loaded; if nothing can run it and the reason is
 * `unsupported`, load the fallback and ask again. A verdict of `invalid` is
 * never retried, because the netlist is broken and a second engine must not get
 * a chance to disagree. See the rule in engines.js.
 */
async function route(netlist) {
  let r = select(await engineList(), netlist);
  if (!r.engine && r.verdict.kind === 'unsupported' && !ngspice) {
    emit('engine-loading', { id: 'ngspice' });
    const { NgspiceEngine } = await import('./ngspice-engine.js');
    ngspice = await NgspiceEngine.create(emit);
    r = select(await engineList(), netlist);
  }
  if (!r.engine) throw new Error(r.reason);
  return r;
}

const emit = (evt, payload) => self.postMessage({ evt, payload });

/** Reply to a specific request, echoing its id so the client can match it. */
const reply = (id, evt, payload) => self.postMessage({ id, evt, payload });

self.onmessage = async (e) => {
  const { id, cmd, args } = e.data ?? {};
  try {
    switch (cmd) {
      case Cmd.LOAD: {
        const r = await route(args.netlist);
        engine = r.engine;
        const info = engine.load(args.netlist);
        // Which engine ran is REPORTED, not hidden: the two differ in ways the
        // user can feel, so the UI needs to be able to say so and to withhold
        // live controls when the engine is not interactive.
        reply(id, Evt.LOADED, {
          ...info,
          engine: { id: engine.id, label: engine.label, interactive: engine.interactive },
          engineReason: r.reason,
        });
        break;
      }
      case 'attach-ring': {
        engine.attachRing(args.ring);
        reply(id, 'ring-attached', {});
        break;
      }
      case Cmd.OP: {
        const info = engine.op();
        reply(id, Evt.OP_DONE, info);
        break;
      }
      case Cmd.TRAN: {
        reply(id, 'tran-started', {});
        await engine.tran(args);
        break;
      }
      case Cmd.AC: {
        const res = engine.ac(args);
        // The AC result is a one-shot block, not a stream, so it is transferred
        // rather than pushed through the ring. Transferring avoids a copy.
        self.postMessage(
          { id, evt: Evt.AC_DONE, payload: res },
          [res.data.buffer],
        );
        break;
      }
      case Cmd.PAUSE:
        engine.pause();
        reply(id, 'paused', {});
        break;
      case Cmd.RESUME:
        reply(id, 'resumed', {});
        await engine.resume();
        break;
      case Cmd.CANCEL:
        engine.cancel();
        reply(id, 'cancelled', {});
        break;
      default:
        reply(id, Evt.ERROR, { message: `unknown command: ${cmd}` });
    }
  } catch (err) {
    reply(id, Evt.ERROR, { message: String(err?.message ?? err) });
  }
};

// Instantiate the module, then announce readiness. Commands sent before this
// are queued by the client, which waits for READY.
init().then((mod) => {
  wasmMemory = mod.memory;
  rust = new SimEngine({
    Session,
    memory: () => wasmMemory,
    emit,
  });
  engine = rust;
  emit(Evt.READY, {});
}).catch((err) => {
  emit(Evt.ERROR, { message: `wasm init failed: ${String(err?.message ?? err)}` });
});
