/**
 * The simulation-engine contract, and the rule for choosing between engines.
 *
 * SpiceLab has one engine today — the Rust core — and is gaining a second,
 * ngspice compiled to wasm, which covers the devices and analyses the Rust core
 * does not implement (BSIM, JFET, VDMOS, transmission lines, `.noise`, `.tf`,
 * `.sens`). The two are not interchangeable and are not meant to be:
 *
 *   - The Rust core is the INTERACTIVE engine. Its symbolic/numeric split means
 *     a value change re-stamps an already-analysed matrix, and it streams rows
 *     with back-pressure reaching the solver. Dragging a slider stays at one
 *     frame.
 *   - ngspice is the COVERAGE engine. It runs analyses to completion and its
 *     per-timepoint callback cannot be told to wait, so back-pressure does not
 *     reach its solver.
 *
 * That difference is user-visible, so which engine ran a design is reportable
 * rather than hidden. `select()` returns the reason for its choice.
 *
 * ## The contract
 *
 * An engine is any object with these members. `SimEngine` in `engine.js` is the
 * reference implementation; it predates this file and is what the shape was
 * derived from, rather than the other way round.
 *
 * @typedef {object} Engine
 * @property {string} id             stable short name, e.g. `'rust'`
 * @property {string} label          human-readable, for the UI
 * @property {boolean} interactive   true if a value change can re-solve within
 *   a frame, and if back-pressure reaches the solver. Governs whether live
 *   controls are offered, so it is a capability claim, not a description.
 * @property {(netlist: string) => Verdict} canRun
 * @property {(netlist: string) => {stride: number, numUnknowns: number,
 *   labels: string[]}} load
 * @property {(ring: SharedArrayBuffer) => void} attachRing
 * @property {() => {numUnknowns: number}} op
 * @property {(opts: object) => Promise<void>} tran
 * @property {(opts: object) => {points: number, stride: number,
 *   data: Float64Array}} ac
 * @property {() => Promise<void>} resume
 * @property {() => void} pause
 * @property {() => void} cancel
 *
 * A verdict is deliberately three-valued, not a boolean:
 *
 * @typedef {object} Verdict
 * @property {'yes'|'unsupported'|'invalid'|'unresolved'} kind
 * @property {string} [message]
 * @property {number} [line]
 */

/** @type {Verdict} */
export const YES = { kind: 'yes' };

/**
 * Ask each engine in turn and return the first that can run the netlist.
 *
 * The order of `engines` is the preference order: put the interactive engine
 * first. The rule that matters is what happens on a NO.
 *
 * **`invalid` and `unresolved` stop the search. `unsupported` continues it.**
 *
 * This is the whole reason `canRun` returns three values instead of a boolean.
 * A netlist the preferred engine calls *invalid* is broken, and passing it to a
 * second engine is wrong in both directions:
 *
 *   - the second engine may reject it too, but with a worse message, so a
 *     precise "R1 needs 2 nodes, found 1" degrades into whatever the fallback
 *     says about the same line;
 *   - or the second engine may ACCEPT it, because two parsers never agree
 *     exactly, and then a typo silently simulates a different circuit. That is
 *     this project's characteristic failure and it is worth an explicit rule.
 *
 * `unresolved` — the netlist references a file we could not fetch — stops for a
 * different reason: the netlist is FINE, and no other engine can help, because
 * there is no filesystem in a browser and a second simulator would fail the
 * same way. Falling through would just swap a precise "supply this file" for a
 * vaguer failure further on.
 *
 * Only `unsupported` — valid SPICE this engine does not implement — justifies
 * falling through.
 *
 * @param {Engine[]} engines in preference order
 * @param {string} netlist
 * @returns {{engine: Engine|null, reason: string, verdict: Verdict,
 *   rejected: Array<{id: string, verdict: Verdict}>}}
 */
export function select(engines, netlist) {
  const rejected = [];
  for (const engine of engines) {
    const verdict = engine.canRun(netlist);
    if (verdict.kind === 'yes') {
      return {
        engine,
        verdict,
        rejected,
        reason: rejected.length === 0
          ? `${engine.label} (preferred)`
          : `${engine.label}; ${rejected[0].id} cannot: ${rejected[0].verdict.message}`,
      };
    }
    rejected.push({ id: engine.id, verdict });
    if (verdict.kind === 'invalid') {
      // Broken netlist. Report THIS engine's diagnosis and stop — see above.
      return {
        engine: null,
        verdict,
        rejected,
        reason: `netlist is not valid: ${verdict.message}`,
      };
    }
    if (verdict.kind === 'unresolved') {
      return {
        engine: null,
        verdict,
        rejected,
        reason: `${verdict.message}. Paste the file's contents into a SPICE ` +
                'text block — a browser has no filesystem to read it from.',
      };
    }
  }
  // Everything said `unsupported`. The first verdict is the most useful one,
  // because it comes from the engine the design was most likely written for.
  const first = rejected[0]?.verdict;
  return {
    engine: null,
    verdict: first ?? { kind: 'unsupported', message: 'no engines registered' },
    rejected,
    reason: first
      ? `no available engine supports this design: ${first.message}`
      : 'no engines registered',
  };
}

/**
 * Wrap the Rust core's `Session.checkNetlist` as a `canRun`.
 *
 * Delegating to the parser rather than scanning the netlist here is the point.
 * A capability list maintained in JS is a second opinion about what the Rust
 * parser accepts, and it drifts — silently, in both directions. The parser is
 * the only thing that knows, so it is what gets asked. See the note on
 * `check_netlist` in `crates/spicelab-wasm/src/lib.rs`.
 *
 * @param {{checkNetlist: (src: string) => string}} Session wasm-bindgen class
 */
export function rustCanRun(Session) {
  return (netlist) => {
    let r;
    try {
      r = JSON.parse(Session.checkNetlist(netlist));
    } catch (e) {
      // checkNetlist should never throw or emit non-JSON. If it does, treat the
      // netlist as unsupported rather than invalid: refusing to run is
      // recoverable, and wrongly calling a good netlist broken is not.
      return { kind: 'unsupported', message: `check failed: ${String(e?.message ?? e)}` };
    }
    if (r.ok) return YES;
    return { kind: r.kind, message: r.message, line: r.line };
  };
}
