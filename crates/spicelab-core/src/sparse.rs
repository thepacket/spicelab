//! Sparse complex-valued linear system with a symbolic / numeric split.
//!
//! Port of `src/core/sparse.js`. See that file and CLAUDE.md for the reasoning;
//! the two invariants that must survive the port are repeated here because
//! breaking either produces believable-looking wrong answers:
//!
//! 1. Pivot search covers ALL structural nonzeros, not just the diagonal, and
//!    yields TWO independent permutations (`PAQ = LU`). MNA rows carrying only a
//!    voltage-source branch coupling have a structurally zero diagonal, so a
//!    diagonal-restricted Markowitz search calls a VCVS driving a load singular.
//!
//! 2. Real and imaginary parts live in separate `Vec<f64>`, not a `Vec<Complex>`,
//!    so the elimination loops stay vectorisable.
//!
//! Divergence from the JS oracle: the JS `Set` iterates in insertion order, so
//! its Markowitz tie-breaking depends on stamp order. Here the pattern sets are
//! `BTreeSet`, so ties break on the lowest index instead. That selects a
//! different — equally valid — pivot sequence. LU is exact up to roundoff under
//! any pivot order, so the fixture tolerances (>=1e-9 against ~1e-16 roundoff)
//! are unaffected. Determinism matters more here than matching JS bit-for-bit.

use std::collections::{BTreeMap, BTreeSet};

/// Opcode marker in the `ops` triple stream: "divide" rather than "multiply-subtract".
const OP_DIV: i32 = -1;

#[derive(Debug)]
pub enum SparseError {
    /// No pivot available during ordering — floating node, or a voltage-source
    /// loop leaving an equation with no unknown.
    StructurallySingular,
    /// A permuted row ended up with no diagonal entry. Should be impossible.
    NoPivot(usize),
}

impl std::fmt::Display for SparseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SparseError::StructurallySingular => write!(
                f,
                "structurally singular matrix: no pivot available. A node is likely \
                 floating, or a voltage source loop leaves an equation with no unknown."
            ),
            SparseError::NoPivot(i) => {
                write!(f, "structurally singular: no pivot for permuted row {i}")
            }
        }
    }
}

impl std::error::Error for SparseError {}

#[derive(Default)]
pub struct SparseSystem {
    pub n: usize,
    /// Pattern in ORIGINAL index space, row -> set of cols.
    pattern: Vec<BTreeSet<usize>>,
    pub analyzed: bool,

    // --- filled in by analyze() ---
    /// `row_perm[position] = original row`
    pub row_perm: Vec<usize>,
    /// `col_perm[position] = original column`
    pub col_perm: Vec<usize>,
    irow: Vec<usize>,
    icol: Vec<usize>,

    /// Matrix values, real part, indexed by handle.
    pub re: Vec<f64>,
    /// Matrix values, imaginary part, indexed by handle.
    pub im: Vec<f64>,

    /// Elimination schedule, flat triples (a, b, c).
    ops: Vec<i32>,
    /// Diagonal handle per permuted row.
    diag: Vec<i32>,

    // L entries grouped by permuted column.
    l_col_ptr: Vec<usize>,
    l_row_idx: Vec<usize>,
    l_handle: Vec<i32>,
    // U entries (strictly above diagonal) grouped by permuted row.
    u_row_ptr: Vec<usize>,
    u_col_idx: Vec<usize>,
    u_handle: Vec<i32>,

    handle_of: Vec<BTreeMap<usize, i32>>,

    work_re: Vec<f64>,
    work_im: Vec<f64>,
    orig_re: Vec<f64>,
    orig_im: Vec<f64>,
    pub nnz: usize,
}

impl SparseSystem {
    /// `n` is the number of unknowns; ground is not an unknown.
    pub fn new(n: usize) -> Self {
        SparseSystem {
            n,
            pattern: vec![BTreeSet::new(); n],
            ..Default::default()
        }
    }

    /// Declare that entry (i, j) will be stamped. Indices are unknown indices;
    /// pass -1 for ground and the call is ignored. Must precede `analyze`.
    #[inline]
    pub fn reserve(&mut self, i: i32, j: i32) {
        if i < 0 || j < 0 {
            return;
        }
        self.pattern[i as usize].insert(j as usize);
    }

    /// Compute ordering, predict fill-in, and emit the elimination schedule.
    /// Call once per topology change.
    pub fn analyze(&mut self) -> Result<(), SparseError> {
        let n = self.n;
        let (row_perm, col_perm) = self.markowitz_order()?;

        let mut irow = vec![0usize; n];
        let mut icol = vec![0usize; n];
        for p in 0..n {
            irow[row_perm[p]] = p;
            icol[col_perm[p]] = p;
        }

        // Rebuild the pattern in permuted space. After permutation the chosen
        // pivots sit on the diagonal, so the elimination below is diagonal.
        let mut pat: Vec<BTreeSet<usize>> = vec![BTreeSet::new(); n];
        for i in 0..n {
            let pi = irow[i];
            for &j in &self.pattern[i] {
                pat[pi].insert(icol[j]);
            }
        }
        for (i, row) in pat.iter_mut().enumerate() {
            row.insert(i);
        }

        // Symbolic factorization: right-looking elimination on the pattern.
        // Column lists let us find rows touching pivot k without scanning.
        let mut col_of: Vec<BTreeSet<usize>> = vec![BTreeSet::new(); n];
        for i in 0..n {
            for &j in &pat[i] {
                col_of[j].insert(i);
            }
        }

        for k in 0..n {
            let krow: Vec<usize> = pat[k].iter().copied().filter(|&j| j > k).collect();
            let rows: Vec<usize> = col_of[k].iter().copied().filter(|&i| i > k).collect();
            for i in rows {
                for &j in &krow {
                    if pat[i].insert(j) {
                        col_of[j].insert(i);
                    }
                }
            }
        }

        // Assign a storage handle to every (row, col) in the filled pattern.
        let mut sorted_cols: Vec<Vec<usize>> = Vec::with_capacity(n);
        let mut nnz = 0usize;
        for row in pat.iter() {
            let cols: Vec<usize> = row.iter().copied().collect();
            nnz += cols.len();
            sorted_cols.push(cols);
        }

        let mut handle_of: Vec<BTreeMap<usize, i32>> = Vec::with_capacity(n);
        let mut h: i32 = 0;
        for cols in sorted_cols.iter() {
            let mut m = BTreeMap::new();
            for &j in cols {
                m.insert(j, h);
                h += 1;
            }
            handle_of.push(m);
        }

        // The ordering guarantees a structural diagonal; assert it cheaply.
        for i in 0..n {
            if !handle_of[i].contains_key(&i) {
                return Err(SparseError::NoPivot(i));
            }
        }

        // Rows below the diagonal that touch each pivot column.
        let mut col_rows: Vec<Vec<usize>> = vec![Vec::new(); n];
        for i in 0..n {
            for &j in &sorted_cols[i] {
                if j < i {
                    col_rows[j].push(i);
                }
            }
        }

        // Emit the elimination schedule.
        let mut ops: Vec<i32> = Vec::new();
        for k in 0..n {
            let pk = handle_of[k][&k];
            for &i in &col_rows[k] {
                let lh = handle_of[i][&k];
                ops.push(lh);
                ops.push(pk);
                ops.push(OP_DIV);
                for &j in &sorted_cols[k] {
                    if j <= k {
                        continue;
                    }
                    ops.push(handle_of[i][&j]);
                    ops.push(lh);
                    ops.push(handle_of[k][&j]);
                }
            }
        }

        // Pack L (by column) and U (by row) for the triangular solves.
        let mut l_col_ptr = vec![0usize; n + 1];
        let mut l_row_idx: Vec<usize> = Vec::new();
        let mut l_handle: Vec<i32> = Vec::new();
        for k in 0..n {
            l_col_ptr[k] = l_row_idx.len();
            for &i in &col_rows[k] {
                l_row_idx.push(i);
                l_handle.push(handle_of[i][&k]);
            }
        }
        l_col_ptr[n] = l_row_idx.len();

        let mut u_row_ptr = vec![0usize; n + 1];
        let mut u_col_idx: Vec<usize> = Vec::new();
        let mut u_handle: Vec<i32> = Vec::new();
        let mut diag = vec![0i32; n];
        for i in 0..n {
            u_row_ptr[i] = u_col_idx.len();
            diag[i] = handle_of[i][&i];
            for &j in &sorted_cols[i] {
                if j > i {
                    u_col_idx.push(j);
                    u_handle.push(handle_of[i][&j]);
                }
            }
        }
        u_row_ptr[n] = u_col_idx.len();

        self.row_perm = row_perm;
        self.col_perm = col_perm;
        self.irow = irow;
        self.icol = icol;
        self.re = vec![0.0; nnz];
        self.im = vec![0.0; nnz];
        self.ops = ops;
        self.diag = diag;
        self.l_col_ptr = l_col_ptr;
        self.l_row_idx = l_row_idx;
        self.l_handle = l_handle;
        self.u_row_ptr = u_row_ptr;
        self.u_col_idx = u_col_idx;
        self.u_handle = u_handle;
        self.handle_of = handle_of;
        self.work_re = vec![0.0; n];
        self.work_im = vec![0.0; n];
        self.orig_re = vec![0.0; nnz];
        self.orig_im = vec![0.0; nnz];
        self.nnz = nnz;
        self.analyzed = true;
        Ok(())
    }

    /// Full Markowitz ordering over all structural nonzeros.
    ///
    /// At each step picks the remaining entry (i, j) minimising
    /// `(rowCount-1) * (colCount-1)` — the pivot predicted to create the least
    /// fill-in — and permutes it onto the diagonal.
    ///
    /// Restricting candidates to the diagonal does NOT work for MNA; see the
    /// module docs. Row and column permutations are independent, hence both are
    /// returned.
    fn markowitz_order(&self) -> Result<(Vec<usize>, Vec<usize>), SparseError> {
        let n = self.n;
        let mut rows: Vec<BTreeSet<usize>> = self.pattern.clone();
        let mut cols: Vec<BTreeSet<usize>> = vec![BTreeSet::new(); n];
        for i in 0..n {
            for &j in &rows[i] {
                cols[j].insert(i);
            }
        }

        let mut row_alive = vec![true; n];
        let mut col_alive = vec![true; n];
        let mut row_perm = vec![0usize; n];
        let mut col_perm = vec![0usize; n];

        for step in 0..n {
            let mut bi: isize = -1;
            let mut bj: isize = -1;
            let mut best_cost = usize::MAX;

            // Scanning rows in increasing occupancy order finds a zero-cost
            // pivot (a singleton row or column) almost immediately in practice.
            let mut order: Vec<usize> = (0..n).filter(|&i| row_alive[i]).collect();
            order.sort_by_key(|&i| rows[i].len());

            // NOTE: the JS oracle has an early-exit here written as
            //   `if ((rows[i].size - 1) * 0 > bestCost) break;`
            // which is `0 > bestCost` — always false, so it never fires. It is
            // dead code, not a real bound: the cheapest cost reachable in a row
            // is (rlen-1)*(minColLen-1), which is 0 whenever any live column is
            // a singleton, so no bound based on rlen alone is valid. Ported as
            // the no-op it actually is rather than "fixed" into a wrong prune.
            'outer: for i in order {
                let rlen = rows[i].len();
                for &j in &rows[i] {
                    if !col_alive[j] {
                        continue;
                    }
                    let cost = (rlen - 1) * (cols[j].len() - 1);
                    if cost < best_cost {
                        best_cost = cost;
                        bi = i as isize;
                        bj = j as isize;
                        if cost == 0 {
                            break 'outer;
                        }
                    }
                }
            }

            if bi < 0 {
                return Err(SparseError::StructurallySingular);
            }
            let (bi, bj) = (bi as usize, bj as usize);

            row_perm[step] = bi;
            col_perm[step] = bj;
            row_alive[bi] = false;
            col_alive[bj] = false;

            // Simulate the fill-in this pivot creates so later counts stay honest.
            let pivot_row: Vec<usize> = rows[bi]
                .iter()
                .copied()
                .filter(|&j| col_alive[j])
                .collect();
            let pivot_col: Vec<usize> = cols[bj]
                .iter()
                .copied()
                .filter(|&i| row_alive[i])
                .collect();
            for &i in &pivot_col {
                for &j in &pivot_row {
                    if rows[i].insert(j) {
                        cols[j].insert(i);
                    }
                }
            }
            let touched: Vec<usize> = cols[bj].iter().copied().collect();
            for i in touched {
                rows[i].remove(&bj);
            }
            let touched: Vec<usize> = rows[bi].iter().copied().collect();
            for j in touched {
                cols[j].remove(&bi);
            }
            rows[bi].clear();
            cols[bj].clear();
        }
        Ok((row_perm, col_perm))
    }

    /// Storage handle for entry (i, j) in original index space, or -1 for ground
    /// / structurally absent.
    #[inline]
    pub fn handle(&self, i: i32, j: i32) -> i32 {
        if i < 0 || j < 0 {
            return -1;
        }
        let r = self.irow[i as usize];
        let c = self.icol[j as usize];
        self.handle_of[r].get(&c).copied().unwrap_or(-1)
    }

    /// Zero all matrix values. Call at the start of each stamp pass.
    #[inline]
    pub fn zero(&mut self) {
        self.re.iter_mut().for_each(|v| *v = 0.0);
        self.im.iter_mut().for_each(|v| *v = 0.0);
    }

    #[inline]
    pub fn add(&mut self, h: i32, v: f64) {
        if h >= 0 {
            self.re[h as usize] += v;
        }
    }

    #[inline]
    pub fn add_complex(&mut self, h: i32, vr: f64, vi: f64) {
        if h >= 0 {
            self.re[h as usize] += vr;
            self.im[h as usize] += vi;
        }
    }

    /// Keep a copy of the stamped matrix so gmin stepping can restamp cheaply.
    pub fn snapshot(&mut self) {
        self.orig_re.copy_from_slice(&self.re);
        self.orig_im.copy_from_slice(&self.im);
    }

    pub fn restore(&mut self) {
        self.re.copy_from_slice(&self.orig_re);
        self.im.copy_from_slice(&self.orig_im);
    }

    /// Numeric LU factorization following the precomputed schedule.
    /// Returns the handle of the failing pivot, or -1 on success.
    pub fn factor(&mut self, pivot_tol: f64) -> i32 {
        let re = &mut self.re;
        let im = &mut self.im;
        let ops = &self.ops;
        let mut t = 0;
        while t < ops.len() {
            let a = ops[t] as usize;
            let b = ops[t + 1] as usize;
            let c = ops[t + 2];
            if c == OP_DIV {
                let br = re[b];
                let bi = im[b];
                let d = br * br + bi * bi;
                if d < pivot_tol {
                    return b as i32;
                }
                let ar = re[a];
                let ai = im[a];
                re[a] = (ar * br + ai * bi) / d;
                im[a] = (ai * br - ar * bi) / d;
            } else {
                let c = c as usize;
                let br = re[b];
                let bi = im[b];
                let cr = re[c];
                let ci = im[c];
                re[a] -= br * cr - bi * ci;
                im[a] -= br * ci + bi * cr;
            }
            t += 3;
        }
        for k in 0..self.n {
            let d = self.diag[k] as usize;
            if re[d] * re[d] + im[d] * im[d] < pivot_tol {
                return d as i32;
            }
        }
        -1
    }

    /// Solve `LUx = b` in place on caller-supplied original-space vectors.
    /// `b_im` may be `None` for purely real analyses.
    pub fn solve(&mut self, b_re: &mut [f64], mut b_im: Option<&mut [f64]>) {
        let n = self.n;
        let (yr, yi) = (&mut self.work_re, &mut self.work_im);
        let re = &self.re;
        let im = &self.im;

        for k in 0..n {
            let src = self.row_perm[k];
            yr[k] = b_re[src];
            yi[k] = match &b_im {
                Some(v) => v[src],
                None => 0.0,
            };
        }

        // Forward substitution (L has unit diagonal).
        for k in 0..n {
            let vr = yr[k];
            let vi = yi[k];
            if vr == 0.0 && vi == 0.0 {
                continue;
            }
            for p in self.l_col_ptr[k]..self.l_col_ptr[k + 1] {
                let i = self.l_row_idx[p];
                let h = self.l_handle[p] as usize;
                let lr = re[h];
                let li = im[h];
                yr[i] -= lr * vr - li * vi;
                yi[i] -= lr * vi + li * vr;
            }
        }

        // Back substitution.
        for k in (0..n).rev() {
            let mut sr = yr[k];
            let mut si = yi[k];
            for p in self.u_row_ptr[k]..self.u_row_ptr[k + 1] {
                let j = self.u_col_idx[p];
                let h = self.u_handle[p] as usize;
                let ur = re[h];
                let ui = im[h];
                sr -= ur * yr[j] - ui * yi[j];
                si -= ur * yi[j] + ui * yr[j];
            }
            let d = self.diag[k] as usize;
            let dr = re[d];
            let di = im[d];
            let den = dr * dr + di * di;
            yr[k] = (sr * dr + si * di) / den;
            yi[k] = (si * dr - sr * di) / den;
        }

        for k in 0..n {
            let dst = self.col_perm[k];
            b_re[dst] = yr[k];
            if let Some(v) = b_im.as_deref_mut() {
                v[dst] = yi[k];
            }
        }
    }
}
