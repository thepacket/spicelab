/**
 * Instruments: things that display probe data.
 *
 * Every instrument takes the SAME shape of input — a probe set, a run's labels,
 * and rows of solver output — and knows nothing about the schematic, the
 * solver, or the other instruments. Routing lives in the ProbeSet, so adding an
 * instrument means adding a class here and nothing else.
 *
 * Autoscaling deserves a note. A scope that rescales on every frame makes a
 * settling waveform look like it is not settling, because the axis shrinks with
 * the signal. These instruments latch the range across a run and only ever
 * widen it, so the picture stays comparable frame to frame.
 */
import { COLORS } from '../schematic/render.js';
import { probeColor } from './probe.js';

/** Format a value with an engineering suffix, for readouts and axes. */
export function eng(v, unit = '', digits = 4) {
  if (!Number.isFinite(v)) return `${v}`;
  const a = Math.abs(v);
  if (a === 0) return `0 ${unit}`.trim();
  const table = [
    [1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''],
    [1e-3, 'm'], [1e-6, 'u'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f'],
  ];
  for (const [mag, suf] of table) {
    if (a >= mag) return `${(v / mag).toPrecision(digits)} ${suf}${unit}`.trim();
  }
  return `${v.toExponential(2)} ${unit}`.trim();
}

class BaseInstrument {
  constructor(id, canvas) {
    this.id = id;
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
  }

  /**
   * Read live from `COLORS` rather than copied in the constructor: instruments
   * are built once at startup and a theme change must reach them without
   * rebuilding, exactly like the schematic renderer.
   */
  get theme() {
    return {
      bg: COLORS.plotBg,
      axis: COLORS.plotAxis,
      text: COLORS.plotText,
      strong: COLORS.text,
      grid: COLORS.plotGrid,
    };
  }

  _fit() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.dpr = dpr;
    return { w, h };
  }

  _blank(msg) {
    const { w, h } = this._fit();
    const g = this.g;
    g.fillStyle = this.theme.bg;
    g.fillRect(0, 0, w, h);
    g.fillStyle = this.theme.text;
    g.font = `${12 * this.dpr}px ui-monospace, Menlo, monospace`;
    g.textAlign = 'center';
    g.fillText(msg, w / 2, h / 2);
    g.textAlign = 'left';
  }
}

/**
 * Time-domain scope.
 *
 * Fed incrementally: `push` accepts each batch of rows as the worker produces
 * them, so a long run draws progressively instead of appearing at the end.
 */
export class Oscilloscope extends BaseInstrument {
  constructor(canvas, id = 'scope') {
    super(id, canvas);
    this.reset();
  }

  reset() {
    this.times = [];
    this.series = [];
    this.bound = [];
    this.lo = Infinity;
    this.hi = -Infinity;
    this.unit = 'V';
  }

  /** Bind probes to a run's column layout. Call once per run. */
  begin(probeSet, labels) {
    this.reset();
    this.bound = probeSet.routedTo(this.id).map((p, i) => {
      const r = p.resolve(labels);
      return {
        probe: p,
        color: probeColor(p, i),
        ...r,
      };
    });
    this.series = this.bound.map(() => []);
    const withUnit = this.bound.find((b) => b.ok);
    if (withUnit) this.unit = withUnit.unit;
    return this.bound.filter((b) => !b.ok);
  }

  /** Append a batch of solver rows. `stride` includes the leading time column. */
  push(view, count, stride) {
    for (let r = 0; r < count; r++) {
      const base = r * stride;
      this.times.push(view[base]);
      for (let k = 0; k < this.bound.length; k++) {
        const b = this.bound[k];
        // +1 skips the time column; probes index into the unknown vector.
        const v = b.ok ? b.read(view, base + 1) : NaN;
        this.series[k].push(v);
        if (Number.isFinite(v)) {
          if (v < this.lo) this.lo = v;
          if (v > this.hi) this.hi = v;
        }
      }
    }
  }

  draw() {
    if (!this.times.length || !this.bound.length) {
      this._blank(this.bound.length ? 'no data' : 'route a probe to the scope');
      return;
    }
    const { w, h } = this._fit();
    const g = this.g;
    const d = this.dpr;
    const padL = 56 * d, padB = 22 * d, padT = 8 * d, padR = 8 * d;

    g.fillStyle = this.theme.bg;
    g.fillRect(0, 0, w, h);

    let { lo, hi } = this;
    if (!(hi > lo)) { hi = lo + 1; lo -= 1; }
    const pad = (hi - lo) * 0.08;
    lo -= pad; hi += pad;

    const t0 = this.times[0];
    const t1 = this.times[this.times.length - 1];
    const X = (t) => padL + ((t - t0) / (t1 - t0 || 1)) * (w - padL - padR);
    const Y = (v) => h - padB - ((v - lo) / (hi - lo)) * (h - padB - padT);

    // Gridlines, five horizontal divisions.
    g.strokeStyle = this.theme.grid;
    g.lineWidth = 1 * d;
    g.beginPath();
    for (let i = 0; i <= 4; i++) {
      const y = padT + (i * (h - padB - padT)) / 4;
      g.moveTo(padL, y); g.lineTo(w - padR, y);
    }
    g.stroke();

    g.strokeStyle = this.theme.axis;
    g.beginPath();
    g.moveTo(padL, padT); g.lineTo(padL, h - padB); g.lineTo(w - padR, h - padB);
    g.stroke();

    g.fillStyle = this.theme.text;
    g.font = `${10 * d}px ui-monospace, Menlo, monospace`;
    for (let i = 0; i <= 4; i++) {
      const v = hi - (i * (hi - lo)) / 4;
      const y = padT + (i * (h - padB - padT)) / 4;
      g.textAlign = 'right';
      g.fillText(eng(v, this.unit, 3), padL - 5 * d, y + 3.5 * d);
    }
    g.textAlign = 'left';
    g.fillText(eng(t0, 's', 3), padL, h - 6 * d);
    g.textAlign = 'right';
    g.fillText(eng(t1, 's', 3), w - padR, h - 6 * d);
    g.textAlign = 'left';

    for (let k = 0; k < this.bound.length; k++) {
      const b = this.bound[k];
      if (!b.ok) continue;
      const s = this.series[k];
      g.strokeStyle = b.color;
      g.lineWidth = 1.6 * d;
      g.beginPath();
      let started = false;
      for (let i = 0; i < s.length; i++) {
        if (!Number.isFinite(s[i])) { started = false; continue; }
        const x = X(this.times[i]), y = Y(s[i]);
        if (started) g.lineTo(x, y);
        else { g.moveTo(x, y); started = true; }
      }
      g.stroke();
    }
  }

  /** Value of each bound probe at the sample nearest `t`, for a cursor readout. */
  sampleAt(t) {
    if (!this.times.length) return [];
    let best = 0;
    for (let i = 0; i < this.times.length; i++) {
      if (Math.abs(this.times[i] - t) < Math.abs(this.times[best] - t)) best = i;
    }
    return this.bound.map((b, k) => ({
      label: b.probe.label,
      color: b.color,
      value: this.series[k][best],
      unit: b.ok ? b.unit : '',
    }));
  }
}

/** Frequency-domain magnitude/phase display for an AC sweep. */
export class BodePlotter extends BaseInstrument {
  constructor(canvas, id = 'bode') {
    super(id, canvas);
    this.freq = [];
    this.traces = [];
  }

  /**
   * @param {{points:number, stride:number, data:Float64Array}} ac rows of
   *   `[freq, re0, im0, re1, im1, ...]` as produced by SimClient.ac
   */
  load(probeSet, labels, ac) {
    this.freq = [];
    this.traces = [];
    const bound = probeSet.routedTo(this.id).map((p, i) => ({
      probe: p,
      color: probeColor(p, i),
      ...p.resolve(labels),
    }));

    for (let k = 0; k < ac.points; k++) this.freq.push(ac.data[k * ac.stride]);

    for (const b of bound) {
      if (!b.ok) { this.traces.push({ ...b, mag: [], phase: [] }); continue; }
      const mag = [], phase = [];
      for (let k = 0; k < ac.points; k++) {
        // AC rows interleave re/im per unknown, so unknown i sits at
        // base + 2i (real) and base + 2i + 1 (imaginary).
        const base = k * ac.stride + 1;
        const re = b.read(ac.data, base, 2, 0);
        const im = b.read(ac.data, base, 2, 1);
        mag.push(20 * Math.log10(Math.hypot(re, im) || 1e-300));
        phase.push((180 / Math.PI) * Math.atan2(im, re));
      }
      this.traces.push({ ...b, mag, phase });
    }
    return bound.filter((b) => !b.ok);
  }

  draw(which = 'mag') {
    if (!this.freq.length || !this.traces.length) {
      this._blank('route a probe and run an AC sweep');
      return;
    }
    const { w, h } = this._fit();
    const g = this.g, d = this.dpr;
    const padL = 56 * d, padB = 22 * d, padT = 8 * d, padR = 8 * d;
    g.fillStyle = this.theme.bg;
    g.fillRect(0, 0, w, h);

    const vals = this.traces.flatMap((t) => (which === 'mag' ? t.mag : t.phase));
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (!(hi > lo)) { hi = lo + 1; lo -= 1; }
    const p = (hi - lo) * 0.08; lo -= p; hi += p;

    const f0 = Math.log10(this.freq[0]);
    const f1 = Math.log10(this.freq[this.freq.length - 1]);
    const X = (f) => padL + ((Math.log10(f) - f0) / (f1 - f0 || 1)) * (w - padL - padR);
    const Y = (v) => h - padB - ((v - lo) / (hi - lo)) * (h - padB - padT);

    g.strokeStyle = this.theme.grid;
    g.lineWidth = d;
    g.beginPath();
    for (let dec = Math.ceil(f0); dec <= Math.floor(f1); dec++) {
      const x = X(10 ** dec);
      g.moveTo(x, padT); g.lineTo(x, h - padB);
    }
    for (let i = 0; i <= 4; i++) {
      const y = padT + (i * (h - padB - padT)) / 4;
      g.moveTo(padL, y); g.lineTo(w - padR, y);
    }
    g.stroke();

    g.strokeStyle = this.theme.axis;
    g.beginPath();
    g.moveTo(padL, padT); g.lineTo(padL, h - padB); g.lineTo(w - padR, h - padB);
    g.stroke();

    g.fillStyle = this.theme.text;
    g.font = `${10 * d}px ui-monospace, Menlo, monospace`;
    const unit = which === 'mag' ? 'dB' : 'deg';
    for (let i = 0; i <= 4; i++) {
      const v = hi - (i * (hi - lo)) / 4;
      const y = padT + (i * (h - padB - padT)) / 4;
      g.textAlign = 'right';
      g.fillText(`${v.toFixed(1)} ${unit}`, padL - 5 * d, y + 3.5 * d);
    }
    g.textAlign = 'left';
    g.fillText(eng(this.freq[0], 'Hz', 3), padL, h - 6 * d);
    g.textAlign = 'right';
    g.fillText(eng(this.freq[this.freq.length - 1], 'Hz', 3), w - padR, h - 6 * d);
    g.textAlign = 'left';

    for (const t of this.traces) {
      if (!t.ok) continue;
      const s = which === 'mag' ? t.mag : t.phase;
      g.strokeStyle = t.color;
      g.lineWidth = 1.6 * d;
      g.beginPath();
      for (let i = 0; i < s.length; i++) {
        const x = X(this.freq[i]), y = Y(s[i]);
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
    }
  }
}

/** DC operating point readout. */
export class Meter {
  constructor(el, id = 'meter') {
    this.el = el;
    this.id = id;
  }

  show(probeSet, labels, solution) {
    const bound = probeSet.routedTo(this.id).map((p, i) => ({
      probe: p,
      color: probeColor(p, i),
      ...p.resolve(labels),
    }));
    if (!bound.length) {
      this.el.innerHTML = '<small class="muted">route a probe to the meter</small>';
      return;
    }
    this.el.innerHTML = bound
      .map((b) => {
        if (!b.ok) {
          return `<div class="reading bad"><span>${b.probe.label}</span>
                  <span>${b.reason}</span></div>`;
        }
        const v = b.read(solution, 0);
        return `<div class="reading"><span style="color:${b.color}">${b.probe.label}</span>
                <b>${eng(v, b.unit)}</b></div>`;
      })
      .join('');
  }
}
