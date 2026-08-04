/**
 * WebGPU waveform renderer.
 *
 * WHY: Canvas2D redraws every point on the CPU every frame. At a few thousand
 * points that is free; at a million it is a slideshow, and a transient run
 * routinely produces a million points. Here the samples live in GPU storage
 * buffers and each frame is one draw call — pan and zoom become a 64-byte
 * uniform write, independent of how much data is on screen.
 *
 * HOW: one instanced quad per line segment. The vertex shader reads the two
 * endpoints from storage, maps them to pixels, and offsets by the line's
 * half-width along the segment normal. No vertex buffer, no per-frame CPU work,
 * and thick lines without the geometry expansion Canvas2D does internally.
 *
 * PRECISION. Samples upload as f32, with x stored as `t - t0` so the exponent
 * range is spent on the run's span rather than on absolute epoch. f32 carries
 * ~7 significant digits, which is far more than a pixel needs for any
 * reasonable overview, but it does bound how deep a zoom stays exact: a 1 s run
 * resolves to about 100 ns. The f64 samples are kept on the CPU regardless
 * (cursors and measurements must not be limited by display precision), so
 * re-uploading a re-normalized window is the fix if deep zoom is ever needed.
 *
 * Axes and labels are NOT drawn here. They go on a Canvas2D overlay sharing the
 * same rect — text is the one thing Canvas2D does better, and the plot geometry
 * is identical in both because the padding lives in the shared uniform.
 */
import { COLORS } from '../schematic/render.js';
import { probeColor } from './probe.js';

const SHADER = `
struct View {
  // x0, x1, y0, y1 — the visible data window
  range : vec4<f32>,
  // viewport width px, viewport height px, half line width px, unused
  size  : vec4<f32>,
  // padding left, right, top, bottom, in px
  pad   : vec4<f32>,
  color : vec4<f32>,
};

@group(0) @binding(0) var<uniform> view : View;
@group(0) @binding(1) var<storage, read> xs : array<f32>;
@group(0) @binding(2) var<storage, read> ys : array<f32>;

fn toPx(x : f32, y : f32) -> vec2<f32> {
  let u = (x - view.range.x) / max(view.range.y - view.range.x, 1e-30);
  let v = (y - view.range.z) / max(view.range.w - view.range.z, 1e-30);
  let w = view.size.x - view.pad.x - view.pad.y;
  let h = view.size.y - view.pad.z - view.pad.w;
  return vec2<f32>(view.pad.x + u * w, view.size.y - view.pad.w - v * h);
}

@vertex
fn vs(@builtin(vertex_index) vi : u32,
      @builtin(instance_index) ii : u32) -> @builtin(position) vec4<f32> {
  let p0 = toPx(xs[ii], ys[ii]);
  let p1 = toPx(xs[ii + 1u], ys[ii + 1u]);

  var d = p1 - p0;
  let len = length(d);
  // A zero-length segment has no direction; pick one so the quad degenerates
  // predictably instead of producing NaNs.
  if (len < 1e-6) { d = vec2<f32>(1.0, 0.0); } else { d = d / len; }
  let n = vec2<f32>(-d.y, d.x) * view.size.z;
  // Extend along the segment by the half-width so consecutive quads overlap at
  // the joint; without it every corner shows a notch.
  let e = d * view.size.z;

  var p : vec2<f32>;
  switch vi {
    case 0u: { p = p0 + n - e; }
    case 1u: { p = p0 - n - e; }
    case 2u: { p = p1 + n + e; }
    case 3u: { p = p1 + n + e; }
    case 4u: { p = p0 - n - e; }
    default: { p = p1 - n + e; }
  }

  // Pixels -> clip space.
  return vec4<f32>(
    (p.x / view.size.x) * 2.0 - 1.0,
    1.0 - (p.y / view.size.y) * 2.0,
    0.0, 1.0);
}

@fragment
fn fs() -> @location(0) vec4<f32> {
  return view.color;
}
`;

const UNIFORM_BYTES = 64; // 4 x vec4<f32>

function hexToRgba(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
}

export class GpuScope {
  static isSupported() {
    return typeof navigator !== 'undefined' && !!navigator.gpu;
  }

  /**
   * Returns a ready GpuScope, or null if WebGPU is unavailable or the device
   * could not be created. Callers fall back to the Canvas2D Oscilloscope.
   */
  static async create(canvas, id = 'scope') {
    if (!GpuScope.isSupported()) return null;
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return null;
      const device = await adapter.requestDevice();
      return new GpuScope(canvas, device, id);
    } catch {
      return null;
    }
  }

  constructor(canvas, device, id) {
    this.canvas = canvas;
    this.device = device;
    this.id = id;
    this.pad = { l: 56, r: 8, t: 8, b: 22 };
    this.lineWidth = 1.5;

    this.ctx = canvas.getContext('webgpu');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.ctx.configure({
      device,
      format: this.format,
      alphaMode: 'premultiplied',
    });

    const module = device.createShaderModule({ code: SHADER });
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.reset();
  }

  reset() {
    for (const t of this.traces ?? []) {
      t.xbuf?.destroy();
      t.ybuf?.destroy();
      t.uniform?.destroy();
    }
    this.traces = [];
    this.times = [];      // f64, kept for cursors and measurement
    this.count = 0;
    this.t0 = null;
    this.lo = Infinity;
    this.hi = -Infinity;
    this.unit = 'V';
    this.xUnit ??= 's';
    this.capacity = 0;
    this.xbuf?.destroy();
    this.xbuf = null;
  }

  /**
   * Bind probes to a run. Returns any that failed to resolve.
   *
   * `xUnit` is the unit of the independent variable, and it is a PARAMETER
   * because this scope now serves two analyses. A transient's x is seconds; a
   * DC sweep's x is the swept source's value, in volts or amps. The axis was
   * hardcoded to seconds, so a sweep from 0 to 5 V was labelled "0 s .. 5 s" —
   * a correct curve under a wrong axis, which is this project's characteristic
   * failure and is worse than no axis at all.
   */
  begin(probeSet, labels, xUnit = 's') {
    this.reset();
    this.xUnit = xUnit;
    const routed = probeSet.routedTo(this.id);
    this.traces = routed.map((p, i) => {
      const r = p.resolve(labels);
      const color = probeColor(p, i);
      return {
        probe: p, color, rgba: hexToRgba(color), values: [],
        ybuf: null, uniform: this.device.createBuffer({
          size: UNIFORM_BYTES,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
        bind: null,
        ...r,
      };
    });
    const withUnit = this.traces.find((t) => t.ok);
    if (withUnit) this.unit = withUnit.unit;
    this._grow(1 << 16);
    return this.traces.filter((t) => !t.ok);
  }

  /** Allocate (or reallocate) GPU storage for `n` samples, preserving data. */
  _grow(n) {
    if (n <= this.capacity) return;
    let cap = Math.max(n, this.capacity ? this.capacity * 2 : 1 << 16);
    const dev = this.device;
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const bytes = cap * 4;

    const newX = dev.createBuffer({ size: bytes, usage });
    const enc = dev.createCommandEncoder();
    if (this.xbuf && this.count) {
      enc.copyBufferToBuffer(this.xbuf, 0, newX, 0, this.count * 4);
    }
    // Collect the old buffers; do NOT destroy them yet. A buffer referenced by
    // an encoder that has not been finished and submitted is still needed —
    // destroying it here drops the copy silently, and the waveform then shows a
    // straight ramp from zero across everything recorded before the last grow.
    // No error, no warning, just a plausible-looking wrong picture.
    const retire = [];
    for (const t of this.traces) {
      const newY = dev.createBuffer({ size: bytes, usage });
      if (t.ybuf && this.count) {
        enc.copyBufferToBuffer(t.ybuf, 0, newY, 0, this.count * 4);
      }
      if (t.ybuf) retire.push(t.ybuf);
      t.ybuf = newY;
    }
    if (this.xbuf) retire.push(this.xbuf);

    dev.queue.submit([enc.finish()]);
    for (const b of retire) b.destroy();

    this.xbuf = newX;
    this.capacity = cap;

    // Bind groups reference the buffers, so they must be rebuilt after a grow.
    for (const t of this.traces) {
      t.bind = dev.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: t.uniform } },
          { binding: 1, resource: { buffer: this.xbuf } },
          { binding: 2, resource: { buffer: t.ybuf } },
        ],
      });
    }
  }

  /**
   * Append a batch of solver rows, uploading only the new span.
   *
   * Incremental upload is the point: re-sending the whole waveform each batch
   * would make streaming O(n^2) in bytes transferred.
   */
  push(view, count, stride) {
    if (!count || !this.traces.length) return;
    this._grow(this.count + count);

    if (this.t0 === null) this.t0 = view[0];
    const xs = new Float32Array(count);
    const ys = this.traces.map(() => new Float32Array(count));

    for (let r = 0; r < count; r++) {
      const base = r * stride;
      const t = view[base];
      this.times.push(t);
      xs[r] = t - this.t0;
      for (let k = 0; k < this.traces.length; k++) {
        const tr = this.traces[k];
        const v = tr.ok ? tr.read(view, base + 1) : NaN;
        tr.values.push(v);
        ys[k][r] = v;
        if (Number.isFinite(v)) {
          if (v < this.lo) this.lo = v;
          if (v > this.hi) this.hi = v;
        }
      }
    }

    const off = this.count * 4;
    this.device.queue.writeBuffer(this.xbuf, off, xs);
    for (let k = 0; k < this.traces.length; k++) {
      this.device.queue.writeBuffer(this.traces[k].ybuf, off, ys[k]);
    }
    this.count += count;
  }

  /** The data window currently displayed, in real units. */
  window() {
    const t0 = this.times[0] ?? 0;
    const t1 = this.times[this.times.length - 1] ?? 1;
    let { lo, hi } = this;
    if (!(hi > lo)) { hi = lo + 1; lo -= 1; }
    const p = (hi - lo) * 0.08;
    return { t0, t1, lo: lo - p, hi: hi + p };
  }

  fit() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.dpr = dpr;
    return { w, h, dpr };
  }

  draw() {
    const { w, h, dpr } = this.fit();
    const dev = this.device;
    const enc = dev.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: this.ctx.getCurrentTexture().createView(),
        // WebGPU wants normalised components, so the themed hex has to be
        // converted every frame — there is nowhere to cache it that a theme
        // change would invalidate.
        clearValue: rgbaOf(COLORS.plotBg),
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });

    if (this.count >= 2) {
      const win = this.window();
      const u = new Float32Array(16);
      u[0] = 0;                       // x0, relative to t0
      u[1] = win.t1 - win.t0;         // x1
      u[2] = win.lo;
      u[3] = win.hi;
      u[4] = w;
      u[5] = h;
      u[6] = (this.lineWidth * dpr) / 2;
      u[7] = 0;
      u[8] = this.pad.l * dpr;
      u[9] = this.pad.r * dpr;
      u[10] = this.pad.t * dpr;
      u[11] = this.pad.b * dpr;

      pass.setPipeline(this.pipeline);
      for (const t of this.traces) {
        if (!t.ok) continue;
        u[12] = t.rgba[0]; u[13] = t.rgba[1]; u[14] = t.rgba[2]; u[15] = t.rgba[3];
        dev.queue.writeBuffer(t.uniform, 0, u);
        pass.setBindGroup(0, t.bind);
        // 6 vertices per segment, one instance per segment.
        pass.draw(6, this.count - 1, 0, 0);
      }
    }

    pass.end();
    dev.queue.submit([enc.finish()]);
  }

  /** Same interface as the Canvas2D scope, for cursor readouts. */
  sampleAt(t) {
    if (!this.times.length) return [];
    let best = 0;
    for (let i = 0; i < this.times.length; i++) {
      if (Math.abs(this.times[i] - t) < Math.abs(this.times[best] - t)) best = i;
    }
    return this.traces.map((tr) => ({
      label: tr.probe.label,
      color: tr.color,
      value: tr.values[best],
      unit: tr.ok ? tr.unit : '',
    }));
  }
}

/**
 * Canvas2D axis overlay for the GPU scope.
 *
 * Shares the plot rect with the GPU canvas by using the same padding, so the
 * gridlines line up with the traces exactly. Kept separate because text
 * rendering is the one thing Canvas2D genuinely does better than a shader.
 */
/** '#rrggbb' -> a WebGPU clearValue. */
function rgbaOf(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 };
}

export class ScopeAxes {
  constructor(canvas) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
  }

  /** Live, so a theme change reaches an already-constructed instrument. */
  get theme() {
    return { axis: COLORS.plotAxis, text: COLORS.plotText, grid: COLORS.plotGrid };
  }

  /**
   * @param {{l:number,r:number,t:number,b:number}} pad matching the GPU scope
   * @param {{t0:number,t1:number,lo:number,hi:number}} win
   * @param {(v:number,unit:string,digits?:number)=>string} fmt
   * @param {?string} empty
   * @param {string} xUnit unit of the independent variable — 's' for a
   *   transient, but a DC sweep's x is the swept source's value. Hardcoding
   *   seconds put a volts axis under a seconds label.
   */
  draw(pad, win, unit, fmt, empty = null, xUnit = 's') {
    const r = this.canvas.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    const g = this.g;
    g.clearRect(0, 0, w, h);
    g.font = `${10 * dpr}px ui-monospace, Menlo, monospace`;

    if (empty) {
      g.fillStyle = this.theme.text;
      g.textAlign = 'center';
      g.fillText(empty, w / 2, h / 2);
      g.textAlign = 'left';
      return;
    }

    const L = pad.l * dpr, R = pad.r * dpr, T = pad.t * dpr, B = pad.b * dpr;

    g.strokeStyle = this.theme.grid;
    g.lineWidth = dpr;
    g.beginPath();
    for (let i = 0; i <= 4; i++) {
      const y = T + (i * (h - B - T)) / 4;
      g.moveTo(L, y); g.lineTo(w - R, y);
    }
    for (let i = 1; i < 4; i++) {
      const x = L + (i * (w - L - R)) / 4;
      g.moveTo(x, T); g.lineTo(x, h - B);
    }
    g.stroke();

    g.strokeStyle = this.theme.axis;
    g.beginPath();
    g.moveTo(L, T); g.lineTo(L, h - B); g.lineTo(w - R, h - B);
    g.stroke();

    g.fillStyle = this.theme.text;
    for (let i = 0; i <= 4; i++) {
      const v = win.hi - (i * (win.hi - win.lo)) / 4;
      const y = T + (i * (h - B - T)) / 4;
      g.textAlign = 'right';
      g.fillText(fmt(v, unit, 3), L - 5 * dpr, y + 3.5 * dpr);
    }
    g.textAlign = 'left';
    g.fillText(fmt(win.t0, xUnit, 3), L, h - 6 * dpr);
    g.textAlign = 'right';
    g.fillText(fmt(win.t1, xUnit, 3), w - R, h - 6 * dpr);
    g.textAlign = 'left';
  }
}
