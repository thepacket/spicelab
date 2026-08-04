/**
 * `.measure` — extract a number from a run.
 *
 * The most-used directive SpiceLab lacked: 431 files in the two conformance
 * corpora carry one. Ranked by real usage there, the functions that matter are
 * DERIV, MAX, WHEN, TRIG/TARG, FIND, MIN, RMS, PP, AVG and INTEG — which is
 * what this implements.
 *
 * Like `fourier.js` this lives above the engines, on the rows both produce.
 *
 * ## Two numerical rules, and why both are load-bearing
 *
 * **Integrate over TIME, never average samples.** A transient's timestep is not
 * uniform — LTE control packs points wherever the waveform moves. The mean of
 * the sample values therefore weights the busy regions by however many points
 * the integrator happened to place there, so AVG and RMS come out dependent on
 * `reltol` rather than on the signal. Every aggregate here is a trapezoidal
 * integral divided by the span. On a slow-then-fast waveform the two disagree
 * by tens of percent, and the wrong one looks perfectly reasonable.
 *
 * **Interpolate crossings; never snap to the nearest sample.** WHEN, FIND ...
 * WHEN and TRIG/TARG all report a TIME, and a time snapped to a sample is
 * quantised by the timestep. The error is invisible — it looks like a slightly
 * different delay — and it changes when tolerances change. Linear
 * interpolation between the bracketing samples costs nothing and makes the
 * answer a property of the waveform.
 *
 * ## What is deliberately not here
 *
 * `PARAM`/`EQN` expressions over other measurements, and measurement results
 * as `.param` inputs to a later run. Both need the netlist expression
 * evaluator, which lives in Rust; wiring that across the boundary is a
 * separate piece of work, and a half-version that silently ignored an
 * unsupported expression would be worse than not having it. Unrecognised
 * functions are REPORTED as unsupported rather than returning a number.
 */

/**
 * @typedef {object} Measurement
 * @property {string} name
 * @property {string} func
 * @property {number|null} value  null when the condition never occurred
 * @property {string} [unit]
 * @property {string} [error]     set instead of `value` when it could not run
 */

/** Split a `.measure` card into tokens, keeping `key=value` pairs together. */
function tokenize(card) {
  return card
    .replace(/\s*=\s*/g, '=')          // `FROM = 1m` -> `FROM=1m`
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
}

/** SPICE engineering suffixes. Shares the micro-sign rule from the parser: the
 *  MICRO SIGN is two UTF-8 bytes, so match the CHAR. `470u` and `470µ` and
 *  `470μ` are the same number. */
export function num(tok) {
  if (tok == null) return NaN;
  const s = String(tok).trim();
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(.*)$/.exec(s);
  if (!m) return NaN;
  const mant = parseFloat(m[1]);
  const rest = m[2];
  if (!rest) return mant;
  const c = rest[0].toLowerCase();
  const scale =
    rest.slice(0, 3).toLowerCase() === 'meg' ? 1e6 :
    rest.slice(0, 3).toLowerCase() === 'mil' ? 25.4e-6 :
    c === 't' ? 1e12 : c === 'g' ? 1e9 : c === 'k' ? 1e3 :
    c === 'm' ? 1e-3 :
    c === 'u' || rest[0] === 'µ' || rest[0] === 'μ' ? 1e-6 :
    c === 'n' ? 1e-9 : c === 'p' ? 1e-12 : c === 'f' ? 1e-15 :
    c === 'a' ? 1e-18 : 1;
  return mant * scale;
}

/** `V(out)` / `I(V1)` / `out` -> the signal name a resolver understands. */
function signal(tok) {
  const m = /^[vi]\s*\(\s*([^)]+?)\s*\)$/i.exec(String(tok).trim());
  return m ? m[1] : String(tok).trim();
}

/** Linear interpolation of `v` at time `t`, given bracketing index `i`. */
function lerp(t, ta, tb, va, vb) {
  const dt = tb - ta;
  return dt > 0 ? va + ((vb - va) * (t - ta)) / dt : va;
}

/**
 * Index range covering [from, to], clamped to the data.
 * Returns null when the window contains fewer than two points.
 */
function windowOf(t, from, to) {
  const n = t.length;
  const lo = Number.isFinite(from) ? from : t[0];
  const hi = Number.isFinite(to) ? to : t[n - 1];
  if (!(hi > lo)) return null;
  let a = 0; while (a < n - 1 && t[a + 1] <= lo) a++;
  let b = n - 1; while (b > 0 && t[b - 1] >= hi) b--;
  return b > a ? { a, b, lo: Math.max(lo, t[0]), hi: Math.min(hi, t[n - 1]) } : null;
}

/**
 * Trapezoidal integral of `v` over [lo, hi], with the partial end intervals
 * interpolated rather than dropped.
 *
 * Dropping them is the subtle version of the averaging bug: with a FROM/TO
 * that does not land on samples, the window silently shrinks to the nearest
 * enclosed samples and the answer shifts by up to one timestep at each end.
 */
function integrate(t, v, w, f = (x) => x) {
  let sum = 0;
  for (let i = w.a; i < w.b; i++) {
    let ta = t[i], tb = t[i + 1], va = v[i], vb = v[i + 1];
    if (tb <= w.lo || ta >= w.hi) continue;
    if (ta < w.lo) { va = lerp(w.lo, ta, tb, va, vb); ta = w.lo; }
    if (tb > w.hi) { vb = lerp(w.hi, t[i], t[i + 1], v[i], v[i + 1]); tb = w.hi; }
    sum += ((f(va) + f(vb)) / 2) * (tb - ta);
  }
  return sum;
}

/**
 * Times at which `v` crosses `level`, interpolated.
 *
 * `edge` is 'rise' | 'fall' | 'cross'. A sample sitting exactly ON the level is
 * counted once, from the interval that arrives at it, so a waveform that
 * touches and retreats does not register two crossings.
 */
function crossings(t, v, level, edge = 'cross', w) {
  const out = [];
  for (let i = w.a; i < w.b; i++) {
    const a = v[i] - level, b = v[i + 1] - level;
    if (a === 0 && b === 0) continue;
    const rising = a < 0 && b >= 0;
    const falling = a > 0 && b <= 0;
    if (!rising && !falling) continue;
    if (edge === 'rise' && !rising) continue;
    if (edge === 'fall' && !falling) continue;
    const dt = t[i + 1] - t[i];
    const x = b === a ? t[i] : t[i] - (a * dt) / (b - a);
    if (x >= w.lo - 1e-15 && x <= w.hi + 1e-15) out.push(x);
  }
  return out;
}

/** Central-difference derivative of `v` at time `x`. */
function derivAt(t, v, x) {
  const n = t.length;
  let i = 0; while (i < n - 2 && t[i + 1] < x) i++;
  const dt = t[i + 1] - t[i];
  return dt > 0 ? (v[i + 1] - v[i]) / dt : 0;
}

const AGGREGATES = new Set(['max', 'min', 'pp', 'avg', 'rms', 'integ', 'deriv']);

/**
 * Run one `.measure` card.
 *
 * @param {string} card  the directive text, with or without the leading dot
 * @param {{t: ArrayLike<number>, get: (name: string) => ArrayLike<number>|null}} data
 * @returns {Measurement}
 */
export function measureOne(card, data) {
  const toks = tokenize(card.replace(/^\s*\.meas(ure)?\s+/i, ''));
  // `.measure <tran|ac|dc> <name> <func> ...`; the analysis word is optional in
  // practice and carries no information here, since the caller supplies data
  // from whichever run it just made.
  let i = 0;
  if (/^(tran|ac|dc|op|noise|tf)$/i.test(toks[0] ?? '')) i++;
  const name = toks[i++] ?? '';
  const func = (toks[i++] ?? '').toLowerCase();
  const rest = toks.slice(i);

  const fail = (error) => ({ name, func, value: null, error });
  if (!name || !func) return fail('malformed .measure card');

  // Named options, wherever they appear.
  const opt = {};
  for (const tk of rest) {
    const m = /^([a-z_]+)=(.*)$/i.exec(tk);
    if (m) opt[m[1].toLowerCase()] = m[2];
  }
  const from = num(opt.from ?? opt.td ?? NaN);
  const to = num(opt.to ?? NaN);
  const edge = opt.rise ? 'rise' : opt.fall ? 'fall' : 'cross';
  const nth = Math.max(1, parseInt(opt.rise ?? opt.fall ?? opt.cross ?? '1', 10) || 1);

  const t = data.t;
  if (!t || t.length < 2) return fail('a .measure needs at least two points');

  const series = (tok) => {
    const v = data.get(signal(tok));
    return v && v.length ? v : null;
  };

  // --- TRIG ... TARG: the delay between two crossings ----------------------
  if (func === 'trig' || rest.some((x) => x.toLowerCase() === 'targ')) {
    const all = [func, ...rest];
    const ti = all.findIndex((x) => x.toLowerCase() === 'trig');
    const gi = all.findIndex((x) => x.toLowerCase() === 'targ');
    if (ti < 0 || gi < 0) return fail('TRIG needs a matching TARG');
    const part = (lo, hi) => {
      const seg = all.slice(lo + 1, hi);
      const o = {};
      for (const tk of seg) {
        const m = /^([a-z_]+)=(.*)$/i.exec(tk);
        if (m) o[m[1].toLowerCase()] = m[2];
      }
      return { sig: seg[0], o };
    };
    const A = part(ti, gi), B = part(gi, all.length);
    const va = series(A.sig), vb = series(B.sig);
    if (!va) return fail(`unknown signal: ${A.sig}`);
    if (!vb) return fail(`unknown signal: ${B.sig}`);
    const w = windowOf(t, from, to);
    if (!w) return fail('the FROM/TO window contains no data');
    const pick = (o, v) => {
      const e = o.rise ? 'rise' : o.fall ? 'fall' : 'cross';
      const k = Math.max(1, parseInt(o.rise ?? o.fall ?? o.cross ?? '1', 10) || 1);
      const xs = crossings(t, v, num(o.val ?? o.value ?? '0'), e, w);
      return xs[k - 1] ?? null;
    };
    const x0 = pick(A.o, va), x1 = pick(B.o, vb);
    if (x0 == null) return fail('TRIG condition never occurred');
    if (x1 == null) return fail('TARG condition never occurred');
    return { name, func: 'trig', value: x1 - x0, unit: 's' };
  }

  // --- WHEN / FIND ---------------------------------------------------------
  if (func === 'when' || func === 'find') {
    const all = rest.slice();
    const wi = all.findIndex((x) => x.toLowerCase() === 'when');
    const w = windowOf(t, from, to);
    if (!w) return fail('the FROM/TO window contains no data');

    if (func === 'find' && opt.at !== undefined) {
      const v = series(all[0]);
      if (!v) return fail(`unknown signal: ${all[0]}`);
      const x = num(opt.at);
      let k = 0; while (k < t.length - 2 && t[k + 1] < x) k++;
      return { name, func, value: lerp(x, t[k], t[k + 1], v[k], v[k + 1]) };
    }

    // `WHEN a=b` may compare a signal to a constant OR to another signal.
    const expr = func === 'find' ? all.slice(wi + 1) : all;
    const lhsTok = expr[0];
    let level = NaN, lhs = lhsTok, rhs = null;
    const eq = /^(.+?)=(.+)$/.exec(lhsTok ?? '');
    if (eq) { lhs = eq[1]; rhs = eq[2]; }
    else if (expr[1] === '=' ) { rhs = expr[2]; }
    else if (expr[1]) { rhs = expr[1]; }
    if (rhs == null) return fail('WHEN needs a target value');

    const va = series(lhs);
    if (!va) return fail(`unknown signal: ${lhs}`);
    const vb = series(rhs);
    let xs;
    if (vb) {
      // Signal-to-signal: cross the DIFFERENCE through zero. Comparing each to
      // a level separately would find the wrong instant entirely.
      const d = Array.from({ length: t.length }, (_, k) => va[k] - vb[k]);
      xs = crossings(t, d, 0, edge, w);
    } else {
      level = num(rhs);
      if (!Number.isFinite(level)) return fail(`cannot read a value from "${rhs}"`);
      xs = crossings(t, va, level, edge, w);
    }
    const x = xs[nth - 1];
    if (x == null) {
      return fail(func === 'when'
        ? 'the condition never occurred in the measured window'
        : 'the WHEN condition never occurred in the measured window');
    }
    if (func === 'when') return { name, func, value: x, unit: 's' };

    const target = series(all[0]);
    if (!target) return fail(`unknown signal: ${all[0]}`);
    let k = 0; while (k < t.length - 2 && t[k + 1] < x) k++;
    return { name, func, value: lerp(x, t[k], t[k + 1], target[k], target[k + 1]) };
  }

  // --- aggregates over a window -------------------------------------------
  if (!AGGREGATES.has(func)) {
    return fail(`.measure ${func.toUpperCase()} is not implemented`);
  }
  const v = series(rest[0]);
  if (!v) return fail(`unknown signal: ${rest[0] ?? '(none)'}`);
  const w = windowOf(t, from, to);
  if (!w) return fail('the FROM/TO window contains no data');

  if (func === 'deriv') {
    const x = Number.isFinite(num(opt.at ?? NaN)) ? num(opt.at) : w.hi;
    return { name, func, value: derivAt(t, v, x) };
  }

  if (func === 'max' || func === 'min' || func === 'pp') {
    let lo = Infinity, hi = -Infinity;
    for (let k = w.a; k <= w.b; k++) {
      if (t[k] < w.lo || t[k] > w.hi) continue;
      if (v[k] < lo) lo = v[k];
      if (v[k] > hi) hi = v[k];
    }
    if (!Number.isFinite(lo)) return fail('the FROM/TO window contains no data');
    return { name, func, value: func === 'max' ? hi : func === 'min' ? lo : hi - lo };
  }

  const span = w.hi - w.lo;
  if (func === 'integ') return { name, func, value: integrate(t, v, w) };
  if (func === 'avg') return { name, func, value: integrate(t, v, w) / span };
  // rms
  return { name, func, value: Math.sqrt(integrate(t, v, w, (x) => x * x) / span) };
}

/** Run every `.measure` card found in a netlist. */
export function measureAll(netlist, data) {
  const out = [];
  for (const m of String(netlist).matchAll(/^[ \t]*\.meas(?:ure)?\b.*$/gim)) {
    out.push(measureOne(m[0], data));
  }
  return out;
}

/**
 * Signal names referenced by the `.measure` cards in a netlist.
 *
 * The editor uses this to capture only the columns a measurement needs while
 * the transient streams. Capturing every unknown would be simpler and is what
 * a 200k-point run makes expensive — the rows are the whole solution vector,
 * and holding all of it defeats the point of streaming through a ring.
 */
export function signalsIn(netlist) {
  const out = new Set();
  for (const m of String(netlist).matchAll(/^[ \t]*\.meas(?:ure)?\b.*$/gim)) {
    for (const s of m[0].matchAll(/\b[vi]\s*\(\s*([^)]+?)\s*\)/gi)) {
      out.add(s[1].trim().toLowerCase());
    }
  }
  return [...out];
}
