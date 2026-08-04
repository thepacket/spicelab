/**
 * `.step` — repeat the analysis with one parameter changed.
 *
 * The most-used directive SpiceLab lacked: 436 files across the two corpora.
 * It is not a new analysis; it is the SAME analysis run many times, which is
 * exactly what `src/worker/batch*.js` already does for sweeps and Monte Carlo.
 * So this module only turns cards into a list of parameter values, and the
 * existing pool runs them.
 *
 * ## Forms understood
 *
 *   .step param <name> <start> <stop> <step>
 *   .step param <name> list <v1> <v2> ...
 *   .step param <name> lin|dec|oct <points> <start> <stop>
 *   .step <name> <start> <stop> <step>        (PARAM is optional in practice)
 *   .step <name> list <v1> <v2> ...
 *
 * ## What it deliberately refuses rather than approximates
 *
 * **`.step temp`** and **`.step <device>:<param>`** (`R1:R`, `M1:W`). Both are
 * real and common, and neither is a `.param`: the override mechanism this
 * rides on appends `.param name=value`, which reaches a parameter the netlist
 * REFERENCES by name and nothing else. Stepping `R1:R` that way would silently
 * define an unused parameter and run the same circuit N times — N identical
 * points on a plot, which looks like a flat response rather than like a
 * failure. Reported as unsupported instead.
 *
 * That refusal is the same rule the engine selector uses: saying "not
 * implemented" is safe, and silently doing something adjacent is not.
 */

import { num } from './measure.js';

/**
 * @typedef {object} StepSpec
 * @property {string} param   the `.param` name to override
 * @property {number[]} values
 * @property {string} [error] set instead, when the card cannot be run
 * @property {string} card    the original text, for messages
 */

/** Inclusive range, built by COUNT rather than by accumulating `step`.
 *
 *  Accumulating drifts: `0.1` added thirty times is not `3`, so the last point
 *  lands just outside the stop and is dropped, and a sweep quietly loses its
 *  endpoint. Deriving each value from the index keeps the ends exact. */
function range(start, stop, step) {
  if (!(Math.abs(step) > 0)) return [start];
  const n = Math.floor(Math.abs((stop - start) / step) + 1e-9) + 1;
  const sign = stop >= start ? 1 : -1;
  const mag = Math.abs(step);
  return Array.from({ length: Math.max(1, n) }, (_, i) => start + sign * i * mag);
}

/** Logarithmic points per decade/octave, as `.ac` spells it. */
function logRange(kind, points, start, stop) {
  if (!(start > 0 && stop > 0)) return [];
  const per = kind === 'oct' ? Math.LN2 : Math.LN10;
  const total = Math.ceil((Math.log(stop / start) / per) * points);
  const out = [];
  for (let i = 0; i <= total; i++) out.push(start * Math.exp((per * i) / points));
  if (out[out.length - 1] < stop) out.push(stop);
  return out;
}

/** Parse one `.step` card. */
export function parseStep(card) {
  const text = String(card).trim();
  const toks = text.replace(/^\s*\.step\s+/i, '').trim().split(/[\s,]+/).filter(Boolean);
  const bad = (error) => ({ param: '', values: [], error, card: text });
  if (!toks.length) return bad('.step names nothing to sweep');

  let i = 0;
  if (toks[i].toLowerCase() === 'param') i++;
  const name = toks[i++];
  if (!name) return bad('.step needs a parameter name');

  // Refused, loudly. See the header: an override is a `.param`, so these would
  // run the same circuit N times and draw a flat line.
  if (name.includes(':')) {
    return bad(`.step of a device parameter (${name}) is not implemented; ` +
               `use a .param in the value instead, e.g. R1 a b {rval}`);
  }
  if (/^temp(er)?$/i.test(name)) {
    return bad('.step temp is not implemented: temperature is not a .param');
  }

  const rest = toks.slice(i);
  const kind = (rest[0] ?? '').toLowerCase();

  if (kind === 'list') {
    const values = rest.slice(1).map(num).filter(Number.isFinite);
    if (!values.length) return bad('.step ... LIST has no usable values');
    return { param: name, values, card: text };
  }

  if (kind === 'lin' || kind === 'dec' || kind === 'oct') {
    const points = Math.max(1, Math.round(num(rest[1])));
    const start = num(rest[2]);
    const stop = num(rest[3]);
    if (![points, start, stop].every(Number.isFinite)) {
      return bad(`.step ${kind.toUpperCase()} needs points, start and stop`);
    }
    const values = kind === 'lin'
      ? range(start, stop, points > 1 ? (stop - start) / (points - 1) : 0)
      : logRange(kind, points, start, stop);
    if (!values.length) {
      return bad(`.step ${kind.toUpperCase()} needs positive start and stop`);
    }
    return { param: name, values, card: text };
  }

  const start = num(rest[0]);
  const stop = num(rest[1]);
  const step = num(rest[2]);
  if (![start, stop, step].every(Number.isFinite)) {
    return bad('.step needs start, stop and step (or LIST, or LIN/DEC/OCT)');
  }
  return { param: name, values: range(start, stop, step), card: text };
}

/**
 * Every `.step` card in a netlist.
 *
 * Multiple cards mean a NESTED sweep in SPICE, and that is not implemented —
 * the result is a family of families, and every consumer above here plots one
 * curve per case. Rather than run only the first and silently ignore the rest,
 * which would give a correct-looking plot of the wrong experiment, the extras
 * are returned carrying an error.
 */
export function parseSteps(netlist) {
  const cards = [...String(netlist).matchAll(/^[ \t]*\.step\b.*$/gim)].map((m) => m[0]);
  return cards.map((c, i) => {
    const s = parseStep(c);
    if (i > 0 && !s.error) {
      return { ...s, values: [],
               error: 'nested .step (more than one card) is not implemented' };
    }
    return s;
  });
}

/** Strip `.step` cards, so the per-case netlist does not re-trigger them. */
export function withoutSteps(netlist) {
  return String(netlist)
    .split('\n')
    .filter((l) => !/^\s*\.step\b/i.test(l))
    .join('\n');
}
