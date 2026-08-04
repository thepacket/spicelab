/**
 * Canvas rendering for the schematic.
 *
 * Symbols are drawn in their LOCAL frame and the canvas transform applies the
 * instance's rotation and mirroring — the same transform `model.pinPositions`
 * uses. Drawing pins at hand-placed screen coordinates instead would let the
 * picture drift from the netlist, which is the worst possible bug class here:
 * the schematic would show one circuit and simulate another.
 *
 * Junction dots are DERIVED, not stored. A dot is drawn wherever three or more
 * wire ends meet, or a wire ends on another wire's interior — the places where
 * connection is implicit. Explicit `junctions` (which is how a crossing is
 * deliberately joined) are drawn too. Deriving them means the dot you see
 * always reflects what the extractor actually did.
 */
import { SYMBOLS, isDirective, pinsOf } from './model.js';
import { onSegmentInterior } from './nets.js';

/**
 * Palettes. Dark is the default and the one the product ships; a light variant
 * exists so the same renderer can serve print/export later, but nothing selects
 * it by default.
 *
 * Canvas colours cannot inherit from CSS, so they are declared here and must be
 * chosen for a dark surface directly — a palette designed on white and dropped
 * onto a dark background gives muddy, low-contrast symbols.
 */
export const THEMES = {
  dark: {
    bg: '#0f1115',
    grid: '#1a1f27',
    gridAxis: '#242b35',
    wire: '#58a6ff',
    symbol: '#d6dae0',
    pin: '#f85149',
    selected: '#ffa657',
    label: '#56d364',
    error: '#f85149',
    warning: '#d29922',
    text: '#d6dae0',
    probe: '#bc8cff',
    // Waveform/sweep plot surface. Canvas cannot inherit CSS custom
    // properties, so the plot palette lives here with the schematic one.
    plotBg: '#0f1115',
    plotGrid: '#1a1f27',
    plotAxis: '#39414d',
    plotText: '#8b949e',
  },
  light: {
    bg: '#ffffff',
    grid: '#e8e8e8',
    gridAxis: '#d0d0d0',
    wire: '#1a5fb4',
    symbol: '#111111',
    pin: '#c01c28',
    selected: '#e66100',
    label: '#1a7f37',
    error: '#c01c28',
    warning: '#bf8700',
    text: '#111111',
    probe: '#9141ac',
    plotBg: '#ffffff',
    plotGrid: '#ececec',
    plotAxis: '#b8b8b8',
    plotText: '#5c5c5c',
  },
};

/**
 * Trace colours, per theme.
 *
 * Not shared between themes: the dark set is chosen to glow against a near
 * black surface, and the same values on white are washed out and, for the
 * yellow and green, close to illegible. Darker, more saturated variants are a
 * different palette rather than the same one dimmed.
 */
export const SERIES_THEMES = {
  dark: ['#58a6ff', '#f85149', '#56d364', '#bc8cff', '#d29922', '#39c5cf', '#ff7b72'],
  light: ['#0969da', '#cf222e', '#1a7f37', '#8250df', '#9a6700', '#1b7c83', '#bc4c00'],
};

/** Live palette. Mutated in place so every draw call picks up a theme change. */
export const COLORS = { ...THEMES.dark };

/**
 * Live trace colours. Mutated IN PLACE for the same reason as `COLORS`:
 * instruments capture `SERIES` at import time, and a probe stores the colour it
 * was given when created. Rebinding the export would leave every existing
 * instrument holding the old array.
 */
export const SERIES = [...SERIES_THEMES.dark];

/** Current theme name, so callers can round-trip it without tracking it. */
export let themeName = 'dark';

export function setTheme(name) {
  const key = THEMES[name] ? name : 'dark';
  themeName = key;
  Object.assign(COLORS, THEMES[key]);
  SERIES.length = 0;
  SERIES.push(...SERIES_THEMES[key]);
  return key;
}

/** Points where a junction dot should be drawn. */
export function impliedJunctions(sch) {
  const count = new Map();
  const bump = (x, y) => {
    const k = `${x},${y}`;
    count.set(k, (count.get(k) ?? 0) + 1);
  };
  for (const w of sch.wires) {
    bump(w.x1, w.y1);
    bump(w.x2, w.y2);
  }

  const dots = new Set();
  // Three or more wire ends at one point: a genuine branch.
  for (const [k, n] of count) if (n >= 3) dots.add(k);
  // A wire ending on another wire's interior: a T.
  for (const w of sch.wires) {
    for (const other of sch.wires) {
      if (other === w) continue;
      for (const [x, y] of [[w.x1, w.y1], [w.x2, w.y2]]) {
        if (onSegmentInterior(x, y, other)) dots.add(`${x},${y}`);
      }
    }
  }
  // Explicit dots always show.
  for (const j of sch.junctions) dots.add(`${j.x},${j.y}`);

  return [...dots].map((k) => {
    const [x, y] = k.split(',').map(Number);
    return { x, y };
  });
}

/** Local-frame symbol art. Pins live at the coordinates declared in SYMBOLS. */
export const ART = {
  resistor(g) {
    g.beginPath();
    g.moveTo(0, -20); g.lineTo(0, -12);
    // Zigzag body.
    const n = 6, h = 24 / n;
    for (let i = 0; i < n; i++) {
      g.lineTo(i % 2 === 0 ? 7 : -7, -12 + h * (i + 0.5));
    }
    g.lineTo(0, 12); g.lineTo(0, 20);
    g.stroke();
  },
  capacitor(g) {
    g.beginPath();
    g.moveTo(0, -20); g.lineTo(0, -4);
    g.moveTo(-11, -4); g.lineTo(11, -4);
    g.moveTo(-11, 4); g.lineTo(11, 4);
    g.moveTo(0, 4); g.lineTo(0, 20);
    g.stroke();
  },
  inductor(g) {
    g.beginPath();
    g.moveTo(0, -20); g.lineTo(0, -12);
    for (let i = 0; i < 4; i++) {
      g.arc(0, -9 + i * 6, 3, -Math.PI / 2, Math.PI / 2);
    }
    g.moveTo(0, 12); g.lineTo(0, 20);
    g.stroke();
  },
  diode(g) {
    g.beginPath();
    g.moveTo(0, -20); g.lineTo(0, -7);
    g.moveTo(-9, -7); g.lineTo(9, -7); g.lineTo(0, 7); g.closePath();
    g.stroke();
    g.beginPath();
    g.moveTo(-9, 7); g.lineTo(9, 7);
    g.moveTo(0, 7); g.lineTo(0, 20);
    g.stroke();
  },
  vsource(g) {
    g.beginPath();
    g.moveTo(0, -20); g.lineTo(0, -13);
    g.moveTo(0, 13); g.lineTo(0, 20);
    g.stroke();
    g.beginPath(); g.arc(0, 0, 13, 0, Math.PI * 2); g.stroke();
    g.beginPath();
    g.moveTo(-4, -6); g.lineTo(4, -6);   // +
    g.moveTo(0, -10); g.lineTo(0, -2);
    g.moveTo(-4, 6); g.lineTo(4, 6);     // -
    g.stroke();
  },
  isource(g) {
    g.beginPath();
    g.moveTo(0, -20); g.lineTo(0, -13);
    g.moveTo(0, 13); g.lineTo(0, 20);
    g.stroke();
    g.beginPath(); g.arc(0, 0, 13, 0, Math.PI * 2); g.stroke();
    // Arrow points from + toward -, i.e. the direction of conventional current.
    g.beginPath();
    g.moveTo(0, -7); g.lineTo(0, 7);
    g.moveTo(-3, 2); g.lineTo(0, 7); g.lineTo(3, 2);
    g.stroke();
  },
  npn(g) { bjt(g, false); },
  pnp(g) { bjt(g, true); },
  nmos(g) { mos(g, false); },
  pmos(g) { mos(g, true); },
  njf(g) { jfet(g, false); },
  pjf(g) { jfet(g, true); },
  nvdmos(g) { vdmos(g, false); },
  pvdmos(g) { vdmos(g, true); },
  sw(g) {
    g.beginPath();
    g.moveTo(-20, -20); g.lineTo(-8, -20);    // N+ lead
    g.moveTo(20, -20); g.lineTo(8, -20);      // N- lead
    g.moveTo(-8, -20); g.lineTo(8, -27);      // the blade, drawn open
    g.stroke();
    g.beginPath(); g.arc(-8, -20, 1.8, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(8, -20, 1.8, 0, Math.PI * 2); g.stroke();
    // Control pair. It is a differential input — the switch responds to the
    // voltage BETWEEN nc+ and nc- — so the two leads are drawn symmetrically
    // and are NOT joined to each other; joining them would read as a short.
    // The sense line to the blade is dashed because it carries no current, and
    // drawing it solid reads as a fourth conducting terminal.
    g.beginPath();
    g.moveTo(-20, 20); g.lineTo(-6, 20);
    g.moveTo(20, 20); g.lineTo(6, 20);
    g.stroke();
    g.save();
    g.setLineDash([3, 3]);
    g.beginPath();
    g.moveTo(-6, 20); g.lineTo(-6, 12); g.lineTo(6, 12); g.lineTo(6, 20);
    g.moveTo(0, 12); g.lineTo(0, -24);
    g.stroke();
    g.restore();
  },
  ground(g) {
    g.beginPath();
    g.moveTo(0, 0); g.lineTo(0, 8);
    g.moveTo(-10, 8); g.lineTo(10, 8);
    g.moveTo(-6, 13); g.lineTo(6, 13);
    g.moveTo(-2, 18); g.lineTo(2, 18);
    g.stroke();
  },
};

function bjt(g, isPnp) {
  g.beginPath();
  g.moveTo(-20, 0); g.lineTo(-6, 0);        // base lead
  g.moveTo(-6, -12); g.lineTo(-6, 12);      // base bar
  g.moveTo(-6, -6); g.lineTo(20, -20);      // collector
  g.moveTo(-6, 6); g.lineTo(20, 20);        // emitter
  g.moveTo(20, -20); g.lineTo(20, -20);
  g.stroke();
  // Emitter arrow: out of the device for NPN, into it for PNP.
  const ex = 8, ey = 8.5;
  g.beginPath();
  if (isPnp) {
    g.moveTo(ex - 5, ey - 1.5); g.lineTo(ex, ey + 1.5); g.lineTo(ex - 1.5, ey + 5.5);
  } else {
    g.moveTo(ex + 5, ey + 4); g.lineTo(ex + 1, ey + 1); g.lineTo(ex + 5.5, ey - 1);
  }
  g.closePath();
  g.fill();
}

function mos(g, isPmos) {
  g.beginPath();
  g.moveTo(-20, 0); g.lineTo(-8, 0);        // gate lead
  g.moveTo(-8, -13); g.lineTo(-8, 13);      // gate plate
  g.moveTo(-3, -13); g.lineTo(-3, 13);      // channel
  g.moveTo(-3, -12); g.lineTo(20, -12); g.lineTo(20, -20);   // drain
  g.moveTo(-3, 12); g.lineTo(20, 12); g.lineTo(20, 20);      // source
  g.moveTo(-3, 0); g.lineTo(20, 0);                          // bulk
  g.stroke();
  g.beginPath();
  if (isPmos) {
    g.moveTo(10, -4); g.lineTo(5, 0); g.lineTo(10, 4);
  } else {
    g.moveTo(5, -4); g.lineTo(10, 0); g.lineTo(5, 4);
  }
  g.closePath();
  g.fill();
}

/** Drawn for a symbol type that has no art: a crossed box, so it reads as
 *  "missing" rather than as some other component. See `drawComponent`. */
function unknownSymbol(g) {
  g.beginPath();
  g.rect(-14, -14, 28, 28);
  g.moveTo(-14, -14); g.lineTo(14, 14);
  g.moveTo(14, -14); g.lineTo(-14, 14);
  g.stroke();
}

/**
 * JFET. Three terminals, and the gate touches the channel directly — there is
 * no insulating gap, which is the whole difference from the MOSFET beside it.
 * The arrow on the gate lead gives the junction's polarity: into the channel
 * for an n-channel device, out of it for p-channel.
 */
function jfet(g, isP) {
  g.beginPath();
  g.moveTo(-20, 0); g.lineTo(-3, 0);                       // gate lead
  g.moveTo(-3, -13); g.lineTo(-3, 13);                     // channel
  g.moveTo(-3, -12); g.lineTo(20, -12); g.lineTo(20, -20); // drain
  g.moveTo(-3, 12); g.lineTo(20, 12); g.lineTo(20, 20);    // source
  g.stroke();
  g.beginPath();
  if (isP) {
    g.moveTo(-8, -4); g.lineTo(-13, 0); g.lineTo(-8, 4);
  } else {
    g.moveTo(-13, -4); g.lineTo(-8, 0); g.lineTo(-13, 4);
  }
  g.closePath();
  g.fill();
}

/**
 * Power MOSFET. Drawn with its BODY DIODE, because that is the feature that
 * distinguishes it in use: it is the reason a VDMOS conducts in reverse, and
 * the reason it survives inductive switching. It is also three-terminal — the
 * substrate is tied internally, so unlike the level 1/3 symbol there is no
 * bulk pin to draw.
 */
function vdmos(g, isP) {
  g.beginPath();
  g.moveTo(-20, 0); g.lineTo(-8, 0);        // gate lead
  g.moveTo(-8, -13); g.lineTo(-8, 13);      // gate plate
  g.moveTo(-3, -13); g.lineTo(-3, 13);      // channel
  g.moveTo(-3, -12); g.lineTo(12, -12); g.lineTo(12, -20); g.lineTo(20, -20);
  g.moveTo(-3, 12); g.lineTo(12, 12); g.lineTo(12, 20); g.lineTo(20, 20);
  g.moveTo(-3, 0); g.lineTo(12, 0);         // internal bulk tie
  g.stroke();
  // Channel-direction arrow, as on the level 1/3 symbol.
  g.beginPath();
  if (isP) {
    g.moveTo(9, -4); g.lineTo(4, 0); g.lineTo(9, 4);
  } else {
    g.moveTo(4, -4); g.lineTo(9, 0); g.lineTo(4, 4);
  }
  g.closePath();
  g.fill();
  // Body diode, on the drain-source path. Its cathode faces the drain on an
  // n-channel part and the source on a p-channel one, which is exactly the
  // polarity that makes it conduct only in reverse.
  const dy = isP ? -1 : 1;
  g.beginPath();
  g.moveTo(20, -20); g.lineTo(20, 20);
  g.stroke();
  g.beginPath();
  g.moveTo(16, 4 * dy); g.lineTo(24, 4 * dy); g.lineTo(20, -4 * dy);
  g.closePath();
  g.fill();
  g.beginPath();
  g.moveTo(16, -4 * dy); g.lineTo(24, -4 * dy);
  g.stroke();
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.scale = 1;
    this.ox = 0;
    this.oy = 0;
  }

  /** Document coords -> screen coords. */
  toScreen(x, y) {
    return { x: x * this.scale + this.ox, y: y * this.scale + this.oy };
  }

  /** Screen coords -> document coords. */
  toDoc(sx, sy) {
    return { x: (sx - this.ox) / this.scale, y: (sy - this.oy) / this.scale };
  }

  clear() {
    const { g, canvas } = this;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = COLORS.bg;
    g.fillRect(0, 0, canvas.width, canvas.height);
  }

  drawGrid(step = 10) {
    const { g, canvas } = this;
    const s = step * this.scale;
    if (s < 4) return; // too dense to be useful
    g.save();
    g.strokeStyle = COLORS.grid;
    g.lineWidth = 1;
    g.beginPath();
    const x0 = this.ox % s;
    const y0 = this.oy % s;
    for (let x = x0; x < canvas.width; x += s) {
      g.moveTo(Math.round(x) + 0.5, 0); g.lineTo(Math.round(x) + 0.5, canvas.height);
    }
    for (let y = y0; y < canvas.height; y += s) {
      g.moveTo(0, Math.round(y) + 0.5); g.lineTo(canvas.width, Math.round(y) + 0.5);
    }
    g.stroke();
    g.restore();
  }

  _applyDoc() {
    const { g } = this;
    g.setTransform(this.scale, 0, 0, this.scale, this.ox, this.oy);
  }

  drawWires(sch, selected = new Set()) {
    const { g } = this;
    this._applyDoc();
    g.lineCap = 'round';
    for (const w of sch.wires) {
      g.strokeStyle = selected.has(w.id) ? COLORS.selected : COLORS.wire;
      g.lineWidth = selected.has(w.id) ? 3 : 2;
      g.beginPath();
      g.moveTo(w.x1, w.y1);
      g.lineTo(w.x2, w.y2);
      g.stroke();
    }
  }

  drawJunctions(sch) {
    const { g } = this;
    this._applyDoc();
    g.fillStyle = COLORS.wire;
    for (const j of impliedJunctions(sch)) {
      g.beginPath();
      g.arc(j.x, j.y, 3.2, 0, Math.PI * 2);
      g.fill();
    }
  }

  drawComponent(sch, c, isSelected = false) {
    const { g } = this;
    this._applyDoc();
    // An analysis is drawn as a labelled block rather than a symbol: it has no
    // pins and nothing to orient, and drawing it like a part would invite the
    // reader to look for terminals that do not exist.
    if (isDirective(c.type)) { this._drawDirective(c, isSelected); return; }
    if (c.type === 'subckt') { this._drawSubckt(sch, c, isSelected); return; }
    g.save();
    g.translate(c.x, c.y);
    g.rotate((c.rot * Math.PI) / 180);
    if (c.mirror) g.scale(-1, 1);
    g.strokeStyle = isSelected ? COLORS.selected : COLORS.symbol;
    g.fillStyle = isSelected ? COLORS.selected : COLORS.symbol;
    g.lineWidth = 1.6;
    g.lineJoin = 'round';
    // A symbol type with no art must LOOK wrong. This used to fall back to
    // `ART.resistor`, so adding a device to SYMBOLS and forgetting its drawing
    // gave you a schematic showing a resistor where a transistor is — the
    // picture disagreeing with the netlist, silently, which is the one thing
    // the shared-transform rule above exists to prevent.
    (ART[c.type] ?? unknownSymbol)(g);
    g.restore();

    // Pin markers, drawn unrotated so they stay circular.
    g.fillStyle = COLORS.pin;
    for (const p of sch.pinPositions(c)) {
      g.beginPath();
      g.arc(p.x, p.y, 1.8, 0, Math.PI * 2);
      g.fill();
    }

    // Reference and value, upright regardless of symbol rotation so they stay
    // readable — rotating text with the part is a common and annoying choice.
    if (!SYMBOLS[c.type].ground) {
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      const s = this.toScreen(c.x, c.y);
      g.fillStyle = isSelected ? COLORS.selected : COLORS.text;
      g.font = `${Math.max(9, 11 * this.scale)}px ui-monospace, Menlo, monospace`;
      g.textAlign = 'left';
      const dx = 18 * this.scale;
      g.fillText(c.ref, s.x + dx, s.y - 2);
      if (c.value) g.fillText(String(c.value), s.x + dx, s.y + 11);
      g.restore();
    }
  }

  /**
   * A placed analysis: a rounded box carrying its card text.
   *
   * Disabled blocks are drawn dimmed and struck through rather than hidden.
   * Hiding them would make "why is nothing running?" unanswerable from the
   * canvas, which is the exact failure the tri-state enable is supposed to
   * make visible.
   */
  _drawDirective(c, isSelected) {
    const { g } = this;
    const sym = SYMBOLS[c.type];
    const off = c.enabled === false;
    let text;
    try { text = sym.card(c.props); } catch { text = `.${c.type} ?`; }
    // A pasted macromodel is hundreds of characters wide; drawing it whole runs
    // off the sheet. Summarise to its first token and a line count, which is
    // what identifies the block at a glance.
    if (text.includes('\n')) {
      const lines = text.split('\n');
      const head = (lines.find((l) => l.trim()) ?? '').trim().slice(0, 28);
      text = `${head}${head.length >= 28 ? '…' : ''}  (${lines.length} lines)`;
    } else if (text.length > 40) {
      text = `${text.slice(0, 39)}…`;
    } else if (!text) {
      text = `(empty ${c.type})`;
    }

    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    const s = this.toScreen(c.x, c.y);
    const fs = Math.max(9, 11 * this.scale);
    g.font = `${fs}px ui-monospace, Menlo, monospace`;
    const padX = 6 * this.scale;
    const w = g.measureText(text).width + padX * 2;
    const h = fs * 2.2;
    const x = s.x - w / 2, y = s.y - h / 2;

    g.globalAlpha = off ? 0.45 : 1;
    g.fillStyle = COLORS.bg;
    g.strokeStyle = isSelected ? COLORS.selected : COLORS.probe;
    g.lineWidth = 1.4;
    if (off) g.setLineDash([4, 3]);
    const r = 4 * this.scale;
    g.beginPath();
    g.roundRect ? g.roundRect(x, y, w, h, r) : g.rect(x, y, w, h);
    g.fill();
    g.stroke();
    g.setLineDash([]);

    g.fillStyle = isSelected ? COLORS.selected : COLORS.probe;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, s.x, s.y);
    if (off) {
      g.beginPath();
      g.moveTo(x + padX / 2, s.y);
      g.lineTo(x + w - padX / 2, s.y);
      g.stroke();
    }
    g.textBaseline = 'alphabetic';
    g.globalAlpha = 1;
    g.restore();
  }

  /**
   * A subcircuit: a box with a stub per pin, and the pin NAMES drawn inside.
   *
   * The names are shown because pin order is the netlist contract for a
   * macromodel, and an unlabelled box gives the reader no way to check it
   * against the `.subckt` line.
   */
  _drawSubckt(sch, c, isSelected) {
    const { g } = this;
    const pins = pinsOf(c);
    const off = c.enabled === false;
    const half = pins.length ? Math.max(20, ((Math.ceil(pins.length / 2) - 1) * 20) / 2 + 14) : 20;

    g.save();
    g.translate(c.x, c.y);
    g.rotate((c.rot * Math.PI) / 180);
    if (c.mirror) g.scale(-1, 1);
    g.globalAlpha = off ? 0.45 : 1;
    g.strokeStyle = isSelected ? COLORS.selected : COLORS.symbol;
    g.lineWidth = 1.6;
    if (off) g.setLineDash([4, 3]);
    g.beginPath();
    g.rect(-20, -half, 40, half * 2);
    g.stroke();
    g.setLineDash([]);
    // Stubs out to the declared pin coordinates.
    g.beginPath();
    for (const p of pins) {
      g.moveTo(Math.sign(p.x) * 20, p.y);
      g.lineTo(p.x, p.y);
    }
    g.stroke();
    // Pin names, inside the box, small.
    g.fillStyle = isSelected ? COLORS.selected : COLORS.text;
    g.font = '7px ui-monospace, Menlo, monospace';
    g.textBaseline = 'middle';
    for (const p of pins) {
      g.textAlign = p.x < 0 ? 'left' : 'right';
      g.fillText(p.name, p.x < 0 ? -17 : 17, p.y);
    }
    g.textBaseline = 'alphabetic';
    g.globalAlpha = 1;
    g.restore();

    g.fillStyle = COLORS.pin;
    for (const p of sch.pinPositions(c)) {
      g.beginPath();
      g.arc(p.x, p.y, 1.8, 0, Math.PI * 2);
      g.fill();
    }

    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    const s = this.toScreen(c.x, c.y);
    g.fillStyle = isSelected ? COLORS.selected : COLORS.text;
    g.font = `${Math.max(9, 11 * this.scale)}px ui-monospace, Menlo, monospace`;
    g.textAlign = 'left';
    const dx = 34 * this.scale;
    g.fillText(c.ref, s.x + dx, s.y - 2);
    if (c.props?.name) g.fillText(String(c.props.name), s.x + dx, s.y + 11);
    g.restore();
  }

  drawLabels(sch) {
    const { g } = this;
    this._applyDoc();
    for (const l of sch.labels) {
      g.fillStyle = COLORS.label;
      g.beginPath();
      g.arc(l.x, l.y, 2.5, 0, Math.PI * 2);
      g.fill();
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      const s = this.toScreen(l.x, l.y);
      g.fillStyle = COLORS.label;
      g.font = `${Math.max(9, 11 * this.scale)}px ui-monospace, Menlo, monospace`;
      g.fillText(l.name, s.x + 6, s.y - 5);
      g.restore();
    }
  }

  /** ERC markers at the offending geometry, so a message maps to a place. */
  drawIssues(sch, issues) {
    const { g } = this;
    g.setTransform(1, 0, 0, 1, 0, 0);
    for (const issue of issues) {
      const at = issue.at;
      if (!at) continue;
      const pts = [];
      if (at.x !== undefined) pts.push({ x: at.x, y: at.y });
      if (at.component) pts.push({ x: at.component.x, y: at.component.y });
      for (const c of at.components ?? []) pts.push({ x: c.x, y: c.y });
      for (const p of pts) {
        const s = this.toScreen(p.x, p.y);
        g.strokeStyle = issue.severity === 'error' ? COLORS.error : COLORS.warning;
        g.lineWidth = 2;
        g.beginPath();
        g.arc(s.x, s.y, 13, 0, Math.PI * 2);
        g.stroke();
      }
    }
  }

  /**
   * Probe markers. Drawn from the probe's stored `at` point, with its own
   * colour, so the schematic shows what each instrument is measuring.
   */
  drawProbes(probes) {
    const { g } = this;
    for (const p of probes) {
      if (!p.at) continue;
      const s = this.toScreen(p.at.x, p.at.y);
      g.setTransform(1, 0, 0, 1, 0, 0);
      const col = p.color ?? COLORS.probe;
      g.strokeStyle = col;
      g.fillStyle = col;
      g.lineWidth = 2;
      g.globalAlpha = p.enabled ? 1 : 0.35;
      // A small ring with a tail, so it reads as an attached instrument lead
      // rather than as another junction dot.
      g.beginPath();
      g.arc(s.x, s.y, 5, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.moveTo(s.x + 3.5, s.y - 3.5);
      g.lineTo(s.x + 11, s.y - 11);
      g.stroke();
      g.font = '10px ui-monospace, Menlo, monospace';
      g.fillText(p.label, s.x + 13, s.y - 12);
      g.globalAlpha = 1;
    }
  }

  /** Rubber-band preview for a wire being drawn. */
  drawPending(segments) {
    const { g } = this;
    this._applyDoc();
    g.strokeStyle = COLORS.selected;
    g.lineWidth = 2;
    g.setLineDash([5, 4]);
    g.beginPath();
    for (const s of segments) {
      g.moveTo(s.x1, s.y1);
      g.lineTo(s.x2, s.y2);
    }
    g.stroke();
    g.setLineDash([]);
  }

  render(sch, {
    selected = new Set(), issues = [], pending = null, probes = [],
  } = {}) {
    this.clear();
    this.drawGrid();
    this.drawWires(sch, selected);
    for (const c of sch.components) this.drawComponent(sch, c, selected.has(c.id));
    this.drawJunctions(sch);
    this.drawLabels(sch);
    if (pending) this.drawPending(pending);
    if (probes.length) this.drawProbes(probes);
    if (issues.length) this.drawIssues(sch, issues);
  }
}
