/**
 * Schematic -> netlist text.
 *
 * The output goes through exactly the same parser as a hand-written netlist
 * (crates/spicelab-core/src/netlist/), which is the point: the editor gets no
 * private path into the solver, so anything the editor can build can also be
 * typed, saved, diffed and shared as text.
 *
 * Terminal order comes from the symbol's pin declaration order in model.js.
 * Getting that wrong reverses a diode or swaps a transistor's collector and
 * emitter — which simulates happily and gives the wrong answer, so the pin
 * order in SYMBOLS is part of the contract, not a display detail.
 */
import { SYMBOLS, isDirective, pinsOf, subcktPins } from './model.js';
import { extractNets } from './nets.js';
import { checkErc, hasBlockingErrors } from './erc.js';
import { defaultPartFor, getPart, modelCard } from './parts.js';

/** Netlist card letter and terminal count per symbol type. */
/** Symbol types whose netlist card names a `.model`. */
const NEEDS_MODEL = new Set(['diode', 'npn', 'pnp', 'nmos', 'pmos']);

/**
 * Decide the model name and card for a semiconductor instance.
 *
 * Precedence, most specific first:
 *   1. `props.modelCard` — a full card the user typed. Trusted verbatim.
 *   2. `props.model` naming an external model (from an `.include`). No card is
 *      emitted; the include is expected to define it.
 *   3. `props.part` — a library part id.
 *   4. The default part for the symbol type.
 */
function resolveModel(c) {
  if (c.props.modelCard) {
    // Take the name from the card itself so the instance line cannot disagree
    // with the definition.
    const m = /^\s*\.model\s+(\S+)/i.exec(c.props.modelCard);
    return { name: m ? m[1] : (c.props.model ?? `${c.ref}_MOD`), card: c.props.modelCard };
  }
  if (c.props.model && !c.props.part) {
    // Names something defined elsewhere (an .include). Emit no card.
    return { name: c.props.model, card: null };
  }
  const part = getPart(c.props.part) ?? defaultPartFor(c.type);
  if (!part) return { name: c.props.model ?? `${c.ref}_MOD`, card: null };
  return { name: part.id, card: modelCard(part, part.id) };
}

const CARD = {
  subckt: 'X',
  resistor: 'R',
  capacitor: 'C',
  inductor: 'L',
  diode: 'D',
  vsource: 'V',
  isource: 'I',
  npn: 'Q',
  pnp: 'Q',
  nmos: 'M',
  pmos: 'M',
};

/**
 * Build netlist text from a schematic.
 *
 * @param {import('./model.js').Schematic} sch
 * @param {{title?:string, analyses?:string[], models?:string[], skipErc?:boolean}} opts
 * @returns {{netlist:string, issues:Array, nets:Array, ok:boolean,
 *   analyses:string[]}} `analyses` lists the cards contributed by placed
 *   analysis components, so a caller can tell whether the schematic specifies
 *   its own run or needs the panel's parameters.
 */
export function toNetlist(sch, opts = {}) {
  const extracted = extractNets(sch);
  const issues = checkErc(sch, extracted);
  const ok = !hasBlockingErrors(issues);

  // Emit even when ERC fails, so the caller can show the text alongside the
  // errors — seeing the generated netlist is often how you spot the mistake.
  const lines = [];
  lines.push(opts.title ?? 'spicelab schematic');

  const netOf = (c, i) => {
    const idx = extracted.netOfPin.get(`${c.id}:${i}`);
    return idx === undefined ? '?' : extracted.nets[idx].name;
  };

  // Model cards to append, keyed by model name so two instances of the same
  // part emit one card rather than a duplicate.
  const models = new Map();

  // Analyses placed on the canvas. Collected separately because they are
  // appended after the devices, and because a disabled one must vanish from
  // the netlist entirely rather than be emitted commented out.
  const placed = [];

  for (const c of sch.components) {
    const sym = SYMBOLS[c.type];
    if (sym.ground) continue;
    // One skip for parts and analyses alike — that uniformity is the whole
    // reason `enabled` lives on the component rather than beside the analyses.
    if (c.enabled === false) continue;
    if (isDirective(c.type)) {
      placed.push(sym.card(c.props));
      continue;
    }
    const letter = CARD[c.type];
    if (!letter) continue;

    const nodes = pinsOf(c).map((_, i) => netOf(c, i));
    const ref = c.ref.toUpperCase().startsWith(letter)
      ? c.ref
      : `${letter}${c.ref}`;

    if (c.type === 'subckt') {
      // X<ref> <nodes...> <subcktname> [params]
      // Node order follows the declared pin order, which must match the
      // `.subckt` line — see the note on `subckt` in model.js.
      const extra = String(c.props.params ?? '').trim();
      lines.push(
        `${ref} ${nodes.join(' ')} ${c.props.name ?? ''}${extra ? ` ${extra}` : ''}`.trim(),
      );
      continue;
    }

    if (NEEDS_MODEL.has(c.type)) {
      // The emitted netlist MUST be self-contained. Previously this wrote a
      // reference to `<ref>_MOD` and never defined it, so every diode, BJT and
      // MOSFET placed from the palette produced a netlist that failed to build
      // with "undefined model". A dangling reference is not a default.
      const { name, card } = resolveModel(c);
      if (card && !models.has(name)) models.set(name, card);
      const extra = c.props.params ? ` ${c.props.params}` : '';
      lines.push(`${ref} ${nodes.join(' ')} ${name}${extra}`);
    } else {
      lines.push(`${ref} ${nodes.join(' ')} ${c.value}`);
    }
  }

  for (const card of models.values()) lines.push(card);
  for (const m of opts.models ?? []) lines.push(m);
  // Canvas-placed analyses first, then any the caller passed explicitly — the
  // Simulate buttons still work on a schematic with no analysis placed.
  for (const a of placed) lines.push(a);
  for (const a of opts.analyses ?? []) lines.push(a);
  lines.push('.end');

  return { netlist: lines.join('\n'), issues, nets: extracted.nets, ok, extracted,
           analyses: placed };
}
