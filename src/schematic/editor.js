/**
 * Schematic editor: input handling on top of the model and renderer.
 *
 * UNDO IS SNAPSHOT-BASED. A schematic is small (kilobytes) and edits are
 * user-paced, so cloning the document per committed edit costs nothing and
 * removes a whole class of bugs — an inverse-operation undo has to get every
 * command exactly right, and the one that is wrong corrupts the document in a
 * way the user cannot see until they simulate. Snapshots cannot be subtly
 * wrong. Revisit only if profiling says so.
 *
 * Everything snaps to the grid on commit, never on preview, so a drag reads
 * smoothly but can only ever land on a lattice point. Net extraction compares
 * coordinates exactly, so an off-grid endpoint is a disconnected wire that
 * looks connected.
 */
import { GRID, SYMBOLS, snap, Schematic } from './model.js';
import { onSegmentInclusive } from './nets.js';

/** Distance from a point to a segment, for wire hit testing. */
function distToSegment(px, py, w) {
  const dx = w.x2 - w.x1;
  const dy = w.y2 - w.y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - w.x1, py - w.y1);
  let t = ((px - w.x1) * dx + (py - w.y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (w.x1 + t * dx), py - (w.y1 + t * dy));
}

/** Half-extent of a symbol's clickable box, in document units. */
const HIT_BOX = 22;

/**
 * Route a connection as up-to-two orthogonal segments, snapped to the grid.
 *
 * Diagonal wires are legal in the model but are never produced here.
 * Orthogonal routing is what makes T-junctions land on lattice points
 * reliably; a diagonal that ALMOST touches a pin is the classic invisible open
 * circuit — it looks connected and is not.
 *
 * Exported as a free function so it can be tested without a DOM.
 */
export function routeOrthogonal(x1, y1, x2, y2) {
  const ax = snap(x1), ay = snap(y1), bx = snap(x2), by = snap(y2);
  if (ax === bx && ay === by) return [];
  if (ax === bx || ay === by) return [{ x1: ax, y1: ay, x2: bx, y2: by }];
  // Horizontal first, then vertical.
  return [
    { x1: ax, y1: ay, x2: bx, y2: ay },
    { x1: bx, y1: ay, x2: bx, y2: by },
  ];
}

export class Editor {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('./render.js').Renderer} renderer
   */
  constructor(canvas, renderer, schematic = new Schematic()) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.sch = schematic;

    this.tool = 'select';
    /** Symbol type placed by the 'place' tool. */
    this.placeType = 'resistor';
    this.selected = new Set();
    this.issues = [];
    /** Probe markers to draw. Owned by the app, not the editor. */
    this.probes = [];
    /** Called with a document point when the probe tool is used. */
    this.onProbePick = null;

    this._undo = [];
    this._redo = [];
    this._drag = null;
    this._wireStart = null;
    this._cursor = { x: 0, y: 0 };
    this._listeners = new Set();

    this._bind();
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _changed() {
    for (const fn of this._listeners) fn(this);
    this.draw();
  }

  // ------------------------------------------------------------ undo/redo

  /** Snapshot BEFORE mutating. Call once per user-visible edit. */
  commit() {
    this._undo.push(this.sch.clone());
    if (this._undo.length > 200) this._undo.shift();
    this._redo.length = 0;
  }

  undo() {
    if (!this._undo.length) return;
    this._redo.push(this.sch.clone());
    this.sch = this._undo.pop();
    this.selected.clear();
    this._changed();
  }

  redo() {
    if (!this._redo.length) return;
    this._undo.push(this.sch.clone());
    this.sch = this._redo.pop();
    this.selected.clear();
    this._changed();
  }

  // ------------------------------------------------------------ hit testing

  /** Topmost component under a document point, or null. */
  componentAt(x, y) {
    for (let i = this.sch.components.length - 1; i >= 0; i--) {
      const c = this.sch.components[i];
      if (Math.abs(x - c.x) <= HIT_BOX && Math.abs(y - c.y) <= HIT_BOX) return c;
    }
    return null;
  }

  wireAt(x, y, tol = 5) {
    for (let i = this.sch.wires.length - 1; i >= 0; i--) {
      if (distToSegment(x, y, this.sch.wires[i]) <= tol) return this.sch.wires[i];
    }
    return null;
  }

  // ------------------------------------------------------------ operations

  place(type, x, y, opts = {}) {
    this.commit();
    const c = this.sch.add(type, x, y, opts);
    this.selected = new Set([c.id]);
    this._changed();
    return c;
  }

  routeWire(x1, y1, x2, y2) {
    return routeOrthogonal(x1, y1, x2, y2);
  }

  addWireSegments(segs) {
    if (!segs.length) return;
    this.commit();
    for (const s of segs) {
      if (s.x1 === s.x2 && s.y1 === s.y2) continue;
      this.sch.wire(s.x1, s.y1, s.x2, s.y2);
    }
    this._changed();
  }

  deleteSelection() {
    if (!this.selected.size) return;
    this.commit();
    this.sch.deleteIds(this.selected);
    this.selected.clear();
    this._changed();
  }

  rotateSelection(delta = 90) {
    const comps = this.sch.components.filter((c) => this.selected.has(c.id));
    if (!comps.length) return;
    this.commit();
    for (const c of comps) c.rot = (((c.rot + delta) % 360) + 360) % 360;
    this._changed();
  }

  mirrorSelection() {
    const comps = this.sch.components.filter((c) => this.selected.has(c.id));
    if (!comps.length) return;
    this.commit();
    for (const c of comps) c.mirror = !c.mirror;
    this._changed();
  }

  /** Toggle an explicit junction dot, the way a crossing is deliberately joined. */
  toggleJunction(x, y) {
    const jx = snap(x), jy = snap(y);
    const i = this.sch.junctions.findIndex((j) => j.x === jx && j.y === jy);
    this.commit();
    if (i >= 0) this.sch.junctions.splice(i, 1);
    else this.sch.junctions.push({ x: jx, y: jy });
    this._changed();
  }

  addLabel(x, y, name) {
    this.commit();
    this.sch.label(x, y, name);
    this._changed();
  }

  setValue(id, value) {
    const c = this.sch.components.find((k) => k.id === id);
    if (!c) return;
    this.commit();
    c.value = value;
    this._changed();
  }

  setRef(id, ref) {
    const c = this.sch.components.find((k) => k.id === id);
    if (!c) return;
    this.commit();
    c.ref = ref;
    this._changed();
  }

  load(json) {
    this.commit();
    this.sch = Schematic.fromJSON(json);
    this.selected.clear();
    this._changed();
  }

  // ------------------------------------------------------------ input

  /**
   * Pointer event -> document coordinates.
   *
   * `getBoundingClientRect` is in CSS pixels but the renderer's transform works
   * in BACKING-STORE pixels, so the two differ by the device pixel ratio.
   * Skipping this conversion still "works" — clicks land on the grid, wires
   * come out orthogonal — they just land somewhere other than where the user
   * clicked, by exactly the dpr factor. On a 1x display it is invisible; on a
   * Retina display everything is off by 2x.
   *
   * The ratio is derived from the element rather than read from
   * `devicePixelRatio` so it stays correct if the two ever disagree (a canvas
   * sized for one dpr and then moved to another monitor).
   */
  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    const kx = r.width ? this.canvas.width / r.width : 1;
    const ky = r.height ? this.canvas.height / r.height : 1;
    return this.renderer.toDoc((e.clientX - r.left) * kx, (e.clientY - r.top) * ky);
  }

  _bind() {
    const cv = this.canvas;

    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      const p = this._pos(e);
      this._cursor = p;

      if (this.tool === 'place') {
        this.place(this.placeType, p.x, p.y);
        return;
      }

      if (this.tool === 'wire') {
        if (!this._wireStart) {
          this._wireStart = { x: snap(p.x), y: snap(p.y) };
        } else {
          const segs = this.routeWire(
            this._wireStart.x, this._wireStart.y, p.x, p.y,
          );
          this.addWireSegments(segs);
          // Chain from the endpoint so a multi-corner run is natural.
          this._wireStart = { x: snap(p.x), y: snap(p.y) };
        }
        this.draw();
        return;
      }

      if (this.tool === 'junction') {
        this.toggleJunction(p.x, p.y);
        return;
      }

      if (this.tool === 'probe') {
        this.onProbePick?.(snap(p.x), snap(p.y));
        return;
      }

      // Select tool.
      const c = this.componentAt(p.x, p.y);
      const w = c ? null : this.wireAt(p.x, p.y);
      const hit = c ?? w;

      if (!hit) {
        if (!e.shiftKey) this.selected.clear();
        this.draw();
        return;
      }
      if (e.shiftKey) {
        if (this.selected.has(hit.id)) this.selected.delete(hit.id);
        else this.selected.add(hit.id);
      } else if (!this.selected.has(hit.id)) {
        this.selected = new Set([hit.id]);
      }
      // Snapshot once at drag start, not per move, so an entire drag is one undo.
      this._drag = { start: p, moved: false };
      this.draw();
    });

    cv.addEventListener('pointermove', (e) => {
      const p = this._pos(e);
      this._cursor = p;

      if (this._drag) {
        const dxRaw = p.x - this._drag.start.x;
        const dyRaw = p.y - this._drag.start.y;
        const dx = snap(dxRaw);
        const dy = snap(dyRaw);
        if (dx === 0 && dy === 0) return;
        if (!this._drag.moved) {
          this.commit();
          this._drag.moved = true;
        }
        this._moveSelected(dx, dy);
        this._drag.start = { x: this._drag.start.x + dx, y: this._drag.start.y + dy };
        this._changed();
        return;
      }
      if (this.tool === 'wire' && this._wireStart) this.draw();
    });

    cv.addEventListener('pointerup', (e) => {
      cv.releasePointerCapture(e.pointerId);
      this._drag = null;
    });

    cv.addEventListener('dblclick', () => {
      // Finish a wire run.
      if (this.tool === 'wire') {
        this._wireStart = null;
        this.draw();
      }
    });

    cv.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.tool === 'wire') {
        this._wireStart = null;
        this.draw();
      }
    });

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.shiftKey ? this.redo() : this.undo();
        return;
      }
      switch (e.key) {
        case 'Escape':
          this._wireStart = null;
          this.selected.clear();
          this.setTool('select');
          this.draw();
          break;
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          this.deleteSelection();
          break;
        case 'r': case 'R': this.rotateSelection(90); break;
        case 'm': case 'M': this.mirrorSelection(); break;
        case 'w': case 'W': this.setTool('wire'); break;
        case 'v': case 'V': this.setTool('select'); break;
        default: break;
      }
    });
  }

  _moveSelected(dx, dy) {
    for (const c of this.sch.components) {
      if (this.selected.has(c.id)) { c.x += dx; c.y += dy; }
    }
    for (const w of this.sch.wires) {
      if (this.selected.has(w.id)) {
        w.x1 += dx; w.y1 += dy; w.x2 += dx; w.y2 += dy;
      }
    }
  }

  setTool(tool, placeType) {
    this.tool = tool;
    if (placeType) this.placeType = placeType;
    if (tool !== 'wire') this._wireStart = null;
    this._changed();
  }

  /** Preview segments for the wire currently being drawn. */
  pendingWire() {
    if (this.tool !== 'wire' || !this._wireStart) return null;
    return this.routeWire(
      this._wireStart.x, this._wireStart.y, this._cursor.x, this._cursor.y,
    );
  }

  draw() {
    this.renderer.render(this.sch, {
      selected: this.selected,
      issues: this.issues,
      pending: this.pendingWire(),
      probes: this.probes,
    });
  }
}
