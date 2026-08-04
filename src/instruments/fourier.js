/**
 * `.four` — Fourier analysis of a transient waveform.
 *
 * ## Why this lives in JS, above the engines
 *
 * It is pure post-processing on samples both engines already produce in the
 * same `[x, v0, v1, ...]` row shape. Implementing it in the Rust core would
 * make it available on the interactive engine only, and a design routed to
 * ngspice for its devices would silently lose the analysis. Here it works for
 * both, and it needs no wasm boundary.
 *
 * ## The two things that make it correct rather than plausible
 *
 * **Resample onto a uniform grid.** A SPICE transient does not have a uniform
 * timestep — LTE control shortens it wherever the waveform is moving, which is
 * exactly where the harmonics are. Running a DFT straight over the raw samples
 * weights those regions by however many points the integrator happened to
 * place there, so the answer depends on solver tolerances rather than on the
 * signal. The result looks entirely reasonable and changes when you tighten
 * `reltol`. Linear interpolation onto a uniform grid is what ngspice does.
 *
 * **Use a whole number of periods, taken from the END of the run.** A DFT
 * assumes the window is periodic; a partial period at the edge is a
 * discontinuity, and it leaks energy across every bin — inventing harmonics
 * that are not in the signal and inflating THD. Taking the window from the end
 * also skips the start-up transient, which is not part of the steady-state
 * spectrum and is the other way to get a large, believable, wrong THD.
 *
 * No window function is applied, deliberately: windowing trades leakage for
 * resolution and is the right tool when the period is unknown. Here the period
 * is given, so an exact whole number of periods has no leakage to suppress,
 * and a window would attenuate the very harmonics being measured.
 */

/**
 * @typedef {object} Harmonic
 * @property {number} n      harmonic number; 0 is DC, 1 the fundamental
 * @property {number} freq   Hz
 * @property {number} mag    amplitude in the signal's own units
 * @property {number} norm   amplitude relative to the fundamental
 * @property {number} phase  degrees
 * @property {number} phaseNorm  degrees, relative to the fundamental
 */

/**
 * @param {ArrayLike<number>} times   sample times, ascending
 * @param {ArrayLike<number>} values  the signal, same length as `times`
 * @param {number} freq               fundamental, Hz
 * @param {{harmonics?: number, samples?: number, periods?: number}} [opts]
 * @returns {{dc: number, thd: number, harmonics: Harmonic[],
 *            window: {t0: number, t1: number, periods: number}}}
 */
export function fourier(times, values, freq, opts = {}) {
  const nHarm = Math.max(1, opts.harmonics ?? 9);
  const periods = Math.max(1, Math.floor(opts.periods ?? 1));
  // A power of two is not required — this is a direct DFT of a handful of
  // bins, not an FFT — but it must be comfortably above the highest harmonic
  // to keep the interpolation from aliasing into it.
  const n = Math.max(opts.samples ?? 1024, 8 * nHarm);

  if (!(freq > 0)) throw new Error('.four needs a positive fundamental frequency');
  const len = Math.min(times.length, values.length);
  if (len < 2) throw new Error('.four needs a transient with at least two points');

  const span = periods / freq;
  const t1 = times[len - 1];
  const t0 = t1 - span;
  if (t0 < times[0]) {
    throw new Error(
      `.four needs at least ${periods} period(s) of ${eng(freq)}Hz ` +
      `(${eng(span)}s) of transient, but the run covers only ` +
      `${eng(t1 - times[0])}s. Extend tstop.`);
  }

  // Resample. `times` is ascending, so the read cursor only moves forward and
  // the whole resample is O(len + n) rather than a binary search per point.
  const x = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + (span * i) / n;   // [t0, t1), so the endpoint is not doubled
    while (j < len - 2 && times[j + 1] < t) j++;
    const ta = times[j], tb = times[j + 1];
    const dt = tb - ta;
    // A zero-width step can occur at a breakpoint, where the solver places two
    // samples at the same instant to represent a discontinuity. Interpolating
    // across it divides by zero; take the left value, which is the one before
    // the edge.
    x[i] = dt > 0 ? values[j] + ((values[j + 1] - values[j]) * (t - ta)) / dt
                  : values[j];
  }

  const harmonics = [];
  let sumSq = 0;
  let fundMag = 0;
  let fundPhase = 0;
  for (let k = 0; k <= nHarm; k++) {
    // The k-th harmonic of the FUNDAMENTAL is bin k*periods of a window that
    // is `periods` periods long. Using bin k would read the wrong frequency
    // whenever periods > 1 — and would still return a smooth, plausible
    // spectrum.
    const bin = k * periods;
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) {
      const th = (-2 * Math.PI * bin * i) / n;
      re += x[i] * Math.cos(th);
      im += x[i] * Math.sin(th);
    }
    // DC is an average; every other bin carries half the amplitude in each of
    // its positive and negative frequency images, hence the 2.
    const scale = k === 0 ? 1 / n : 2 / n;
    const mag = Math.hypot(re, im) * scale;
    const phase = (Math.atan2(im, re) * 180) / Math.PI;
    if (k === 1) { fundMag = mag; fundPhase = phase; }
    if (k >= 2) sumSq += mag * mag;
    harmonics.push({ n: k, freq: k * freq, mag, phase, norm: 0, phaseNorm: 0 });
  }

  for (const h of harmonics) {
    h.norm = fundMag > 0 ? h.mag / fundMag : 0;
    h.phaseNorm = h.phase - fundPhase;
  }

  return {
    dc: harmonics[0].mag,
    // Percent, and relative to the FUNDAMENTAL rather than to the total — the
    // IEEE definition SPICE reports. The other convention (relative to RMS of
    // everything) gives a different number for the same signal.
    thd: fundMag > 0 ? (Math.sqrt(sumSq) / fundMag) * 100 : 0,
    harmonics,
    window: { t0, t1, periods },
  };
}

/** Compact engineering notation, for error messages only. */
function eng(v) {
  const a = Math.abs(v);
  if (a === 0) return '0';
  for (const [mag, suf] of [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''],
                            [1e-3, 'm'], [1e-6, 'u'], [1e-9, 'n'], [1e-12, 'p']]) {
    if (a >= mag) return `${(v / mag).toPrecision(4)} ${suf}`;
  }
  return v.toExponential(2);
}
