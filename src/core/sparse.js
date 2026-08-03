/**
 * Sparse complex-valued linear system with a symbolic / numeric split.
 *
 * WHY COMPLEX ALWAYS: AC analysis needs a complex MNA matrix. Building a
 * real-only solver and retrofitting complex support later means rewriting every
 * device stamp. We pay ~2x memory and keep one code path forever.
 *
 * WHY THE SYMBOLIC SPLIT: interactive real-time depends on the fact that
 * changing a component *value* does not change the matrix *structure*. The
 * expensive work (ordering, fill-in prediction, emitting the elimination
 * schedule) runs once per topology change. Re-solving after a slider drag runs
 * only `factor()` + `solve()`, which are flat loops over typed arrays.
 *
 * WASM-SHAPE NOTE: all hot-loop state lives in Float64Array / Int32Array. There
 * are no object allocations inside factor() or solve(). Porting this file to
 * Rust is a mechanical translation; nothing above it needs to change.
 */

/** Opcode marker: entry in ops triple meaning "divide" rather than "multiply-subtract". */
const OP_DIV = -1;

export class SparseSystem {
  /** @param {number} n number of unknowns (ground is not an unknown) */
  constructor(n) {
    this.n = n;
    /** @type {Set<number>[]} pattern in ORIGINAL index space, row -> set of cols */
    this._pattern = Array.from({ length: n }, () => new Set());
    this.analyzed = false;

    // --- filled in by analyze() ---
    /** @type {Int32Array} rowPerm[position] = original row */
    this.rowPerm = new Int32Array(0);
    /** @type {Int32Array} colPerm[position] = original column */
    this.colPerm = new Int32Array(0);
    /** @type {Int32Array} inverse of rowPerm */
    this.irow = new Int32Array(0);
    /** @type {Int32Array} inverse of colPerm */
    this.icol = new Int32Array(0);
    /** @type {Float64Array} */
    this.re = new Float64Array(0);
    /** @type {Float64Array} */
    this.im = new Float64Array(0);
    /** @type {Int32Array} elimination schedule, triples (a,b,c) */
    this.ops = new Int32Array(0);
    /** @type {Int32Array} diagonal handle per permuted row */
    this.diag = new Int32Array(0);
    // L entries grouped by permuted column, CSR-style
    this.lColPtr = new Int32Array(0);
    this.lRowIdx = new Int32Array(0);
    this.lHandle = new Int32Array(0);
    // U entries (strictly above diagonal) grouped by permuted row
    this.uRowPtr = new Int32Array(0);
    this.uColIdx = new Int32Array(0);
    this.uHandle = new Int32Array(0);

    this._workRe = new Float64Array(0);
    this._workIm = new Float64Array(0);
    this._origRe = null;
    this._origIm = null;
  }

  /**
   * Declare that entry (i, j) will be stamped. Indices are unknown indices;
   * pass -1 for ground and the call is ignored.
   * Must be called before analyze().
   */
  reserve(i, j) {
    if (i < 0 || j < 0) return;
    this._pattern[i].add(j);
  }

  /**
   * Compute ordering, predict fill-in, and emit the elimination schedule.
   * Call once per topology change.
   */
  analyze() {
    const n = this.n;

    const { rowPerm, colPerm } = this._markowitzOrder();
    const irow = new Int32Array(n);
    const icol = new Int32Array(n);
    for (let p = 0; p < n; p++) { irow[rowPerm[p]] = p; icol[colPerm[p]] = p; }

    // Rebuild the pattern in permuted space. After permutation the chosen
    // pivots sit on the diagonal, so the elimination below is diagonal.
    /** @type {Set<number>[]} */
    const pat = Array.from({ length: n }, () => new Set());
    for (let i = 0; i < n; i++) {
      const pi = irow[i];
      for (const j of this._pattern[i]) pat[pi].add(icol[j]);
    }
    for (let i = 0; i < n; i++) pat[i].add(i);

    // Symbolic factorization: right-looking elimination on the pattern.
    // Column lists let us find rows that touch pivot k without scanning.
    /** @type {Set<number>[]} */
    const colOf = Array.from({ length: n }, () => new Set());
    for (let i = 0; i < n; i++) for (const j of pat[i]) colOf[j].add(i);

    for (let k = 0; k < n; k++) {
      const krow = pat[k];
      for (const i of colOf[k]) {
        if (i <= k) continue;
        for (const j of krow) {
          if (j <= k) continue;
          if (!pat[i].has(j)) {
            pat[i].add(j);
            colOf[j].add(i);
          }
        }
      }
    }

    // Assign a storage handle to every (row, col) in the filled pattern.
    const rowPtr = new Int32Array(n + 1);
    let nnz = 0;
    /** @type {Int32Array[]} */
    const sortedCols = [];
    for (let i = 0; i < n; i++) {
      const cols = Int32Array.from(pat[i]).sort();
      sortedCols.push(cols);
      rowPtr[i] = nnz;
      nnz += cols.length;
    }
    rowPtr[n] = nnz;

    /** @type {Map<number, number>[]} col -> handle, per row */
    const handleOf = [];
    const colIdx = new Int32Array(nnz);
    let h = 0;
    for (let i = 0; i < n; i++) {
      const m = new Map();
      for (const j of sortedCols[i]) {
        colIdx[h] = j;
        m.set(j, h);
        h++;
      }
      handleOf.push(m);
    }

    // Emit the elimination schedule.
    /** @type {number[]} */
    const ops = [];
    const colRows = Array.from({ length: n }, () => []);
    for (let i = 0; i < n; i++) for (const j of sortedCols[i]) if (j < i) colRows[j].push(i);

    for (let k = 0; k < n; k++) {
      const pk = handleOf[k].get(k);
      const krow = sortedCols[k];
      for (const i of colRows[k]) {
        const lh = handleOf[i].get(k);
        ops.push(lh, pk, OP_DIV);
        for (const j of krow) {
          if (j <= k) continue;
          ops.push(handleOf[i].get(j), lh, handleOf[k].get(j));
        }
      }
    }

    // Pack L (by column) and U (by row) for triangular solves.
    const lColPtr = new Int32Array(n + 1);
    const lRowIdx = [];
    const lHandle = [];
    for (let k = 0; k < n; k++) {
      lColPtr[k] = lRowIdx.length;
      for (const i of colRows[k]) {
        lRowIdx.push(i);
        lHandle.push(handleOf[i].get(k));
      }
    }
    lColPtr[n] = lRowIdx.length;

    const uRowPtr = new Int32Array(n + 1);
    const uColIdx = [];
    const uHandle = [];
    const diag = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      uRowPtr[i] = uColIdx.length;
      diag[i] = handleOf[i].get(i);
      for (const j of sortedCols[i]) {
        if (j > i) {
          uColIdx.push(j);
          uHandle.push(handleOf[i].get(j));
        }
      }
    }
    uRowPtr[n] = uColIdx.length;

    this.rowPerm = rowPerm;
    this.colPerm = colPerm;
    this.irow = irow;
    this.icol = icol;
    this.re = new Float64Array(nnz);
    this.im = new Float64Array(nnz);
    this.ops = Int32Array.from(ops);
    this.diag = diag;
    this.lColPtr = lColPtr;
    this.lRowIdx = Int32Array.from(lRowIdx);
    this.lHandle = Int32Array.from(lHandle);
    this.uRowPtr = uRowPtr;
    this.uColIdx = Int32Array.from(uColIdx);
    this.uHandle = Int32Array.from(uHandle);
    this._handleOf = handleOf;
    // Diagonal of the permuted matrix must be structurally present; the
    // ordering guarantees this by construction, but assert it cheaply.
    for (let i = 0; i < n; i++) {
      if (handleOf[i].get(i) === undefined) {
        throw new Error(`structurally singular: no pivot for permuted row ${i}`);
      }
    }
    this._workRe = new Float64Array(n);
    this._workIm = new Float64Array(n);
    this._origRe = new Float64Array(nnz);
    this._origIm = new Float64Array(nnz);
    this.nnz = nnz;
    this.analyzed = true;
    return this;
  }

  /**
   * Full Markowitz ordering over all structural nonzeros.
   *
   * At each step it picks the remaining entry (i, j) minimising
   * (rowCount-1) * (colCount-1) — the pivot predicted to create the least
   * fill-in — and permutes it onto the diagonal.
   *
   * Restricting candidates to the diagonal does NOT work for MNA. A node whose
   * only entry is a voltage-source branch coupling has a structurally zero
   * diagonal, so a diagonal-only search reports a singular matrix on circuits
   * as simple as a VCVS driving a load. Row and column permutations must be
   * independent, which is why this returns both.
   *
   * @returns {{rowPerm: Int32Array, colPerm: Int32Array}}
   */
  _markowitzOrder() {
    const n = this.n;
    const rows = this._pattern.map((s) => new Set(s));
    /** @type {Set<number>[]} */
    const cols = Array.from({ length: n }, () => new Set());
    for (let i = 0; i < n; i++) for (const j of rows[i]) cols[j].add(i);

    const rowAlive = new Uint8Array(n).fill(1);
    const colAlive = new Uint8Array(n).fill(1);
    const rowPerm = new Int32Array(n);
    const colPerm = new Int32Array(n);

    for (let step = 0; step < n; step++) {
      let bi = -1;
      let bj = -1;
      let bestCost = Infinity;

      // Scanning rows in increasing occupancy order finds a zero-cost pivot
      // (a singleton row or column) almost immediately in practice.
      const order = [];
      for (let i = 0; i < n; i++) if (rowAlive[i]) order.push(i);
      order.sort((a, b) => rows[a].size - rows[b].size);

      outer:
      for (const i of order) {
        if ((rows[i].size - 1) * 0 > bestCost) break;
        for (const j of rows[i]) {
          if (!colAlive[j]) continue;
          const cost = (rows[i].size - 1) * (cols[j].size - 1);
          if (cost < bestCost) {
            bestCost = cost;
            bi = i;
            bj = j;
            if (cost === 0) break outer;
          }
        }
      }

      if (bi < 0) {
        throw new Error(
          'structurally singular matrix: no pivot available. A node is likely ' +
          'floating, or a voltage source loop leaves an equation with no unknown.'
        );
      }

      rowPerm[step] = bi;
      colPerm[step] = bj;
      rowAlive[bi] = 0;
      colAlive[bj] = 0;

      // Simulate the fill-in this pivot creates so later counts stay honest.
      for (const i of cols[bj]) {
        if (!rowAlive[i]) continue;
        for (const j of rows[bi]) {
          if (!colAlive[j]) continue;
          if (!rows[i].has(j)) {
            rows[i].add(j);
            cols[j].add(i);
          }
        }
      }
      for (const i of cols[bj]) rows[i].delete(bj);
      for (const j of rows[bi]) cols[j].delete(bi);
      rows[bi].clear();
      cols[bj].clear();
    }
    return { rowPerm, colPerm };
  }

  /** Storage handle for entry (i, j) in original index space, or -1 for ground. */
  handle(i, j) {
    if (i < 0 || j < 0) return -1;
    const h = this._handleOf[this.irow[i]].get(this.icol[j]);
    return h === undefined ? -1 : h;
  }

  /** Zero all matrix values. Call at the start of each stamp pass. */
  zero() {
    this.re.fill(0);
    this.im.fill(0);
  }

  /** @param {number} h @param {number} v */
  add(h, v) {
    if (h >= 0) this.re[h] += v;
  }

  /** @param {number} h @param {number} vr @param {number} vi */
  addComplex(h, vr, vi) {
    if (h < 0) return;
    this.re[h] += vr;
    this.im[h] += vi;
  }

  /** Keep a copy of the stamped matrix so gmin stepping can restamp cheaply. */
  snapshot() {
    this._origRe.set(this.re);
    this._origIm.set(this.im);
  }

  restore() {
    this.re.set(this._origRe);
    this.im.set(this._origIm);
  }

  /**
   * Numeric LU factorization following the precomputed schedule.
   * @param {number} [pivotTol] smallest acceptable |pivot|
   * @returns {number} index of the failing permuted row, or -1 on success
   */
  factor(pivotTol = 1e-30) {
    const { ops, re, im, diag, n } = this;
    const nOps = ops.length;
    for (let t = 0; t < nOps; t += 3) {
      const a = ops[t];
      const b = ops[t + 1];
      const c = ops[t + 2];
      if (c === OP_DIV) {
        const br = re[b];
        const bi = im[b];
        const d = br * br + bi * bi;
        if (d < pivotTol) return b;
        const ar = re[a];
        const ai = im[a];
        re[a] = (ar * br + ai * bi) / d;
        im[a] = (ai * br - ar * bi) / d;
      } else {
        const br = re[b];
        const bi = im[b];
        const cr = re[c];
        const ci = im[c];
        re[a] -= br * cr - bi * ci;
        im[a] -= br * ci + bi * cr;
      }
    }
    for (let k = 0; k < n; k++) {
      const d = diag[k];
      if (re[d] * re[d] + im[d] * im[d] < pivotTol) return d;
    }
    return -1;
  }

  /**
   * Solve LUx = b in place on caller-supplied original-space vectors.
   * @param {Float64Array} bRe length n, overwritten with solution
   * @param {Float64Array} [bIm] length n, overwritten with solution
   */
  solve(bRe, bIm) {
    const { n, rowPerm, colPerm, re, im, diag, lColPtr, lRowIdx, lHandle, uRowPtr, uColIdx, uHandle } = this;
    const yr = this._workRe;
    const yi = this._workIm;
    const hasIm = bIm !== undefined;

    for (let k = 0; k < n; k++) {
      yr[k] = bRe[rowPerm[k]];
      yi[k] = hasIm ? bIm[rowPerm[k]] : 0;
    }

    // Forward substitution (L has unit diagonal).
    for (let k = 0; k < n; k++) {
      const vr = yr[k];
      const vi = yi[k];
      if (vr === 0 && vi === 0) continue;
      const end = lColPtr[k + 1];
      for (let p = lColPtr[k]; p < end; p++) {
        const i = lRowIdx[p];
        const h = lHandle[p];
        const lr = re[h];
        const li = im[h];
        yr[i] -= lr * vr - li * vi;
        yi[i] -= lr * vi + li * vr;
      }
    }

    // Back substitution.
    for (let k = n - 1; k >= 0; k--) {
      let sr = yr[k];
      let si = yi[k];
      const end = uRowPtr[k + 1];
      for (let p = uRowPtr[k]; p < end; p++) {
        const j = uColIdx[p];
        const h = uHandle[p];
        const ur = re[h];
        const ui = im[h];
        sr -= ur * yr[j] - ui * yi[j];
        si -= ur * yi[j] + ui * yr[j];
      }
      const d = diag[k];
      const dr = re[d];
      const di = im[d];
      const den = dr * dr + di * di;
      yr[k] = (sr * dr + si * di) / den;
      yi[k] = (si * dr - sr * di) / den;
    }

    for (let k = 0; k < n; k++) {
      bRe[colPerm[k]] = yr[k];
      if (hasIm) bIm[colPerm[k]] = yi[k];
    }
  }
}
