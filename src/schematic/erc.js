/**
 * Electrical rule checks.
 *
 * These exist so that the common mistakes surface as a message pointing at the
 * offending part of the schematic, BEFORE simulate, rather than as a
 * "structurally singular matrix" from deep inside the solver. The sparse
 * ordering can tell you a pivot was unavailable; it cannot tell you that R3's
 * lower pin is one grid square away from the wire it looks connected to.
 *
 * Severity matters: `error` blocks simulation because the solver would fail or
 * silently solve something else; `warning` is suspicious but legal.
 */
import { SYMBOLS, isDirective, pinsOf, subcktPins } from './model.js';
import { defaultPartFor, getPart } from './parts.js';

/** Symbols whose behaviour comes from a `.model`, not from a value field. */
const MODEL_BASED = new Set([
  'diode', 'npn', 'pnp', 'nmos', 'pmos',
  'njf', 'pjf', 'nvdmos', 'pvdmos', 'sw',
]);

/** Components that inject energy and cannot be shorted or paralleled. */
const IDEAL_VOLTAGE = new Set(['vsource']);

/**
 * @param {import('./model.js').Schematic} sch
 * @param {ReturnType<import('./nets.js').extractNets>} extracted
 * @returns {Array<{severity:'error'|'warning', code:string, message:string, at?:object}>}
 */
export function checkErc(sch, extracted) {
  const issues = [];
  const { nets } = extracted;

  const err = (code, message, at) => issues.push({ severity: 'error', code, message, at });
  const warn = (code, message, at) => issues.push({ severity: 'warning', code, message, at });

  // --- no ground reference -------------------------------------------------
  // Every MNA formulation needs a datum node. Without one the matrix is
  // singular and the solver's message will not mention ground.
  if (sch.components.length > 0 && !nets.some((n) => n.isGround)) {
    err(
      'no-ground',
      'No ground reference. Every circuit needs at least one ground symbol; ' +
      'node voltages are measured relative to it.',
    );
  }

  // --- unconnected pins ----------------------------------------------------
  // A pin on a net by itself drives nothing and is driven by nothing. For a
  // two-terminal part that leaves a floating node, which is singular.
  for (const net of nets) {
    if (net.pins.length === 1 && !net.labelled) {
      const p = net.pins[0];
      err(
        'unconnected-pin',
        `${p.component.ref} pin ${p.name} is not connected to anything.`,
        { component: p.component, x: p.x, y: p.y },
      );
    }
  }

  // --- floating nets -------------------------------------------------------
  // A net of pure wire with no pins is harmless but almost always a leftover.
  for (const net of nets) {
    if (net.pins.length === 0) {
      warn(
        'empty-net',
        `Net ${net.name} has wires but no component pins.`,
        { net: net.name },
      );
    }
  }

  // --- shorted and paralleled voltage sources -----------------------------
  // Two ideal sources across the same pair of nets is an inconsistent system:
  // either the values disagree (no solution) or they agree (infinitely many
  // current splits). Both come out of the solver as a singular matrix.
  const pairKey = (a, b) => [a, b].sort().join('\x00');
  const sourcePairs = new Map();
  for (const c of sch.components) {
    if (!IDEAL_VOLTAGE.has(c.type)) continue;
    const a = netIndexOf(extracted, c, 0);
    const b = netIndexOf(extracted, c, 1);
    if (a === undefined || b === undefined) continue;
    if (a === b) {
      err(
        'shorted-source',
        `${c.ref} has both terminals on the same net (${nets[a].name}); ` +
        'an ideal voltage source cannot be shorted.',
        { component: c },
      );
      continue;
    }
    const k = pairKey(a, b);
    if (!sourcePairs.has(k)) sourcePairs.set(k, []);
    sourcePairs.get(k).push(c);
  }
  for (const group of sourcePairs.values()) {
    if (group.length > 1) {
      err(
        'parallel-sources',
        `${group.map((c) => c.ref).join(' and ')} are ideal voltage sources in ` +
        'parallel across the same two nets.',
        { components: group },
      );
    }
  }

  // --- missing values ------------------------------------------------------
  // Semiconductors are excluded on purpose: their behaviour comes from a
  // `.model` card, not from a value field, so demanding a value made every
  // diode and transistor a hard ERC error. Analyses are excluded for the same
  // reason one step further out — they carry named parameters in `props` and
  // have no value field at all, so the identical mistake would make every
  // placed `.tran` a hard error.
  for (const c of sch.components) {
    if (SYMBOLS[c.type].ground) continue;
    if (isDirective(c.type)) continue;
    // A subcircuit's behaviour comes from its macromodel, like a semiconductor's
    // comes from a .model — it has no value field either.
    if (c.type === 'subckt') continue;
    if (MODEL_BASED.has(c.type)) continue;
    if (!String(c.value ?? '').trim()) {
      err('missing-value', `${c.ref} has no value.`, { component: c });
    }
  }

  // --- subcircuits ---------------------------------------------------------
  // An X card naming nothing, or with no pins, builds a netlist the parser
  // rejects with a message about generated text rather than about the block on
  // screen — the same reason every other check here exists.
  for (const c of sch.components) {
    if (c.type !== 'subckt' || c.enabled === false) continue;
    if (!String(c.props.name ?? '').trim()) {
      err('subckt-name', `${c.ref} does not name a subcircuit.`, { component: c });
    }
    if (!subcktPins(c.props.pins).length) {
      err('subckt-pins', `${c.ref} has no pins; list them in .subckt order.`,
          { component: c });
    }
  }

  // --- analyses ------------------------------------------------------------
  // A blank parameter would emit a malformed card that the parser rejects with
  // a message about the generated text rather than about the block on screen.
  for (const c of sch.components) {
    if (!isDirective(c.type) || c.enabled === false) continue;
    for (const d of SYMBOLS[c.type].params ?? []) {
      if (d.def === '') continue;           // genuinely optional
      if (!String(c.props[d.key] ?? '').trim()) {
        err('analysis-param', `${c.ref} has no ${d.key}.`, { component: c });
      }
    }
  }
  // Two enabled analyses of the same kind is ambiguous: the netlist would carry
  // two cards and whichever the parser honours is arbitrary. A warning rather
  // than an error, because disabling one is the obvious fix and the run still
  // produces something.
  const byKind = new Map();
  for (const c of sch.components) {
    if (!isDirective(c.type) || c.enabled === false) continue;
    if (!byKind.has(c.type)) byKind.set(c.type, []);
    byKind.get(c.type).push(c);
  }
  for (const [type, group] of byKind) {
    if (group.length > 1) {
      warn(
        'duplicate-analysis',
        `${group.map((c) => c.ref).join(' and ')} are both enabled ${type} ` +
        'analyses; disable one, or the netlist carries two cards.',
        { components: group },
      );
    }
  }

  // --- unresolvable part selections ---------------------------------------
  // A part id that no longer exists must be reported rather than silently
  // falling back, or the schematic would quietly simulate a different device
  // than the one named in the saved file.
  for (const c of sch.components) {
    if (!MODEL_BASED.has(c.type)) continue;
    if (c.props.modelCard || (c.props.model && !c.props.part)) continue;
    if (c.props.part && !getPart(c.props.part)) {
      err(
        'unknown-part',
        `${c.ref} names part "${c.props.part}", which is not in the library.`,
        { component: c },
      );
    } else if (!c.props.part && !defaultPartFor(c.type)) {
      err('no-default-part', `${c.ref} has no part selected.`, { component: c });
    }
  }

  // --- a named model must actually be defined somewhere ---------------------
  // `props.model` points at a `.model` card in a pasted SPICE text block —
  // there is no filesystem, so `.include` cannot fetch one. A typo there
  // builds a netlist the parser rejects with "undefined model", which names
  // the GENERATED text rather than the component on screen. That is the exact
  // gap every other check in this file exists to close.
  //
  // A WARNING, not an error. The check can only see text blocks on this
  // canvas, and being wrong in the blocking direction would stop a design that
  // simulates fine.
  const defined = new Set();
  for (const c of sch.components) {
    if (c.type !== 'spice' || c.enabled === false) continue;
    for (const m of String(c.props.text ?? '')
      .matchAll(/^\s*\.(?:model|subckt)\s+(\S+)/gim)) {
      defined.add(m[1].toLowerCase());
    }
  }
  for (const c of sch.components) {
    if (!MODEL_BASED.has(c.type) || c.enabled === false) continue;
    const name = String(c.props.model ?? '').trim();
    if (!name || c.props.part) continue;
    if (!defined.has(name.toLowerCase())) {
      warn(
        'undefined-model',
        `${c.ref} names model "${name}", which no SPICE text block on this ` +
        `sheet defines.`,
        { component: c },
      );
    }
  }

  // --- duplicate references ------------------------------------------------
  const seen = new Map();
  for (const c of sch.components) {
    if (SYMBOLS[c.type].ground) continue;
    const r = c.ref.toLowerCase();
    if (seen.has(r)) {
      err(
        'duplicate-ref',
        `Reference ${c.ref} is used more than once.`,
        { components: [seen.get(r), c] },
      );
    } else {
      seen.set(r, c);
    }
  }

  // --- conflicting net labels ---------------------------------------------
  for (const c of extracted.conflicts) {
    warn(
      'label-conflict',
      `One net carries conflicting labels: ${c.names.join(', ')}. ` +
      `Using "${c.names[0]}".`,
    );
  }

  return issues;
}

function netIndexOf(extracted, component, pinIndex) {
  return extracted.netOfPin.get(`${component.id}:${pinIndex}`);
}

/** True if any issue would prevent a meaningful simulation. */
export function hasBlockingErrors(issues) {
  return issues.some((i) => i.severity === 'error');
}
