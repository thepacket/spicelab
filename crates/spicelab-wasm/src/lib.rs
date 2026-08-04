//! wasm-bindgen boundary for `spicelab-core`. Contains no numerics.
//!
//! The rules this file exists to enforce, from CLAUDE.md:
//!
//! * The hot loops (`factor`, `solve`, the stamp pass) never cross the boundary.
//!   A caller asks for a batch of timesteps with one call and gets back a count.
//! * Solutions leave through a shared buffer, not through serialized return
//!   values. Rust stages completed rows into a flat `Vec<f64>` inside its own
//!   linear memory; the worker constructs a `Float64Array` view over that
//!   memory and copies straight into the ring buffer. No JSON, no per-point
//!   `postMessage`, no allocation per timepoint on the JS side.
//!
//! A note on why the staging buffer exists at all. `TransientRun` accumulates
//! its whole trajectory, which is right for a batch run and wrong for streaming
//! — it grows without bound. `advance` drains those rows into the staging
//! buffer and clears the run's own history, so a long interactive run has
//! memory proportional to the batch size rather than to elapsed simulation.
//!
//! Row layout is `[t, x0, x1, ... x(n-1)]`, so `stride == num_unknowns + 1`.
//! The JS side reads `stride` from the ring header, never hardcodes it.

use spicelab_core::analyses::dc::{ac_sweep, op, AcScale, AcSpec};
use spicelab_core::analyses::tran::{TranOptions, TransientRun};
use spicelab_core::circuit::Circuit;
use spicelab_core::context::Method;
use spicelab_core::netlist;
use wasm_bindgen::prelude::*;

/// Producer states, mirroring `src/worker/ring.js`. Kept in sync by hand; the
/// values are part of the wire format between the two files.
const STATE_DONE: i32 = 2;
const STATE_ERROR: i32 = 3;

#[wasm_bindgen]
pub struct Session {
    circuit: Circuit,
    run: Option<TransientRun>,
    stride: usize,
    /// Completed rows waiting to be copied out. Drained every `advance`.
    staging: Vec<f64>,
}

#[wasm_bindgen]
impl Session {
    /// Build a session from netlist text. `.include` is not resolved here —
    /// the host should splice includes in before calling, since a wasm module
    /// has no filesystem.
    #[wasm_bindgen(js_name = fromNetlist)]
    pub fn from_netlist(src: &str) -> Result<Session, JsError> {
        let nl = netlist::parse(src).map_err(|e| JsError::new(&e.to_string()))?;
        let circuit = netlist::build(&nl).map_err(|e| JsError::new(&e.to_string()))?;
        Ok(Session::wrap(circuit))
    }

    /// Can this core run `src`? Answers WITHOUT constructing a session.
    ///
    /// Returns JSON: `{"ok":true}` or
    /// `{"ok":false,"kind":"invalid"|"unsupported","line":N,"message":"..."}`.
    ///
    /// The point is the `kind`. A host choosing between engines must not decide
    /// by scanning the netlist itself — a second opinion about what this core
    /// supports WILL drift from what the parser actually accepts, and the drift
    /// is silent in both directions: refusing something that works, or handing
    /// a bigger engine a netlist this one would have rejected as malformed.
    /// The parser is the only thing that knows, so it is what gets asked.
    ///
    /// Structured rather than a formatted string because the alternative is the
    /// host regex-matching error text, which breaks the first time a message is
    /// reworded.
    #[wasm_bindgen(js_name = checkNetlist)]
    pub fn check_netlist(src: &str) -> String {
        fn report(e: &spicelab_core::netlist::parse::ParseError) -> String {
            // Hand-built so the crate needs no serde dependency at the boundary.
            // Escape properly. Hand-rolling JSON with three replacements
            // produced INVALID JSON the moment a message carried a control
            // byte — a carriage return from a CRLF file, a tab, a stray 0x0C
            // — and the host's JSON.parse then threw instead of reporting the
            // netlist. 63 files in one vendor library hit this.
            let mut msg = String::with_capacity(e.message.len() + 16);
            for ch in e.message.chars() {
                match ch {
                    '"' => msg.push_str("\\\""),
                    '\\' => msg.push_str("\\\\"),
                    '\n' | '\r' | '\t' => msg.push(' '),
                    c if (c as u32) < 0x20 => {
                        msg.push_str(&format!("\\u{:04x}", c as u32))
                    }
                    c => msg.push(c),
                }
            }
            format!(
                r#"{{"ok":false,"kind":"{}","line":{},"message":"{}"}}"#,
                e.kind.as_str(),
                e.line,
                msg
            )
        }
        match netlist::parse(src) {
            Err(e) => report(&e),
            Ok(nl) => match netlist::build(&nl) {
                Err(e) => report(&e),
                Ok(_) => r#"{"ok":true}"#.to_string(),
            },
        }
    }

    fn wrap(mut circuit: Circuit) -> Session {
        // Build topology now so `stride` is known before the first analysis and
        // the host can size its ring buffer.
        let _ = circuit.ensure_built();
        let stride = circuit.num_unknowns + 1;
        Session {
            circuit,
            run: None,
            stride,
            staging: Vec::new(),
        }
    }

    /// Values per row: time plus one per unknown.
    #[wasm_bindgen(getter)]
    pub fn stride(&self) -> usize {
        self.stride
    }

    #[wasm_bindgen(getter, js_name = numUnknowns)]
    pub fn num_unknowns(&self) -> usize {
        self.circuit.num_unknowns
    }

    /// Unknown labels, newline-separated. Newline-joined rather than a
    /// `js_sys::Array` to keep this crate's dependency surface to
    /// `wasm-bindgen` alone.
    pub fn labels(&self) -> String {
        self.circuit.labels[..self.circuit.num_unknowns].join("\n")
    }

    /// Index of a named node, or -1 for ground. Returns -2 if unknown, so the
    /// caller can tell "ground" from "no such node" without an exception.
    #[wasm_bindgen(js_name = indexOf)]
    pub fn index_of(&self, name: &str) -> i32 {
        self.circuit.index_of(name).unwrap_or(-2)
    }

    /// Solve the DC operating point. The solution is staged as a single row
    /// with `t = 0`.
    #[wasm_bindgen(js_name = solveOp)]
    pub fn solve_op(&mut self) -> Result<(), JsError> {
        op(&mut self.circuit).map_err(|e| JsError::new(&e.to_string()))?;
        self.staging.clear();
        self.staging.push(0.0);
        self.staging.extend_from_slice(&self.circuit.ctx.x);
        Ok(())
    }

    /// Start a transient run. `method` is "be", "trap" or "gear2"; anything
    /// else keeps the circuit's configured method.
    #[wasm_bindgen(js_name = beginTran)]
    pub fn begin_tran(
        &mut self,
        tstop: f64,
        tstep: f64,
        tmax: f64,
        uic: bool,
        method: &str,
    ) -> Result<(), JsError> {
        let mut o = TranOptions::new(tstop, tstep);
        // A non-positive tmax means "unset": let the run pick its own.
        o.tmax = if tmax > 0.0 { Some(tmax) } else { None };
        o.uic = uic;
        o.method = Method::parse(method);

        let mut run = TransientRun::new(&self.circuit, &o);
        run.begin(&mut self.circuit)
            .map_err(|e| JsError::new(&e.to_string()))?;
        self.run = Some(run);
        self.staging.clear();
        self.drain_run();
        Ok(())
    }

    /// Move whatever the run has recorded into the staging buffer and clear the
    /// run's own history, so streaming memory stays bounded.
    fn drain_run(&mut self) {
        if let Some(run) = self.run.as_mut() {
            for (i, t) in run.times.iter().enumerate() {
                self.staging.push(*t);
                self.staging.extend_from_slice(&run.data[i]);
            }
            run.times.clear();
            run.data.clear();
        }
    }

    /// Advance the transient by at most `max_steps` step attempts, stopping
    /// early once `max_rows` completed rows are staged.
    ///
    /// `max_rows` is how the host applies back-pressure: it passes the ring's
    /// free space, so the solver never produces rows that have nowhere to go.
    /// Returns the number of rows now staged.
    pub fn advance(&mut self, max_steps: usize, max_rows: usize) -> Result<usize, JsError> {
        self.staging.clear();
        if max_rows == 0 {
            return Ok(0);
        }
        let mut steps = 0;
        loop {
            let finished = match self.run.as_ref() {
                Some(r) => r.done,
                None => return Ok(0),
            };
            if finished || steps >= max_steps {
                break;
            }
            // One boundary crossing covers many timesteps; this inner call is
            // pure Rust and does not allocate in factor/solve.
            let res = self.run.as_mut().unwrap().step(&mut self.circuit);
            steps += 1;
            if let Err(e) = res {
                self.drain_run();
                return Err(JsError::new(&e.to_string()));
            }
            self.drain_run();
            if self.staging.len() / self.stride >= max_rows {
                break;
            }
        }
        Ok(self.staging.len() / self.stride)
    }

    #[wasm_bindgen(getter)]
    pub fn done(&self) -> bool {
        self.run.as_ref().map(|r| r.done).unwrap_or(true)
    }

    #[wasm_bindgen(getter, js_name = simTime)]
    pub fn sim_time(&self) -> f64 {
        self.run.as_ref().map(|r| r.time).unwrap_or(0.0)
    }

    #[wasm_bindgen(getter)]
    pub fn accepted(&self) -> usize {
        self.run.as_ref().map(|r| r.accepted).unwrap_or(0)
    }

    #[wasm_bindgen(getter)]
    pub fn rejected(&self) -> usize {
        self.run.as_ref().map(|r| r.rejected).unwrap_or(0)
    }

    /// Pointer to the staged rows, for a `Float64Array` view over wasm memory.
    ///
    /// The view is invalidated by the next `advance` (which clears the buffer)
    /// and by any wasm memory growth, so the host must build it fresh after
    /// every call and copy out before calling again.
    #[wasm_bindgen(getter, js_name = stagingPtr)]
    pub fn staging_ptr(&self) -> *const f64 {
        self.staging.as_ptr()
    }

    #[wasm_bindgen(getter, js_name = stagingLen)]
    pub fn staging_len(&self) -> usize {
        self.staging.len()
    }

    /// Run an AC sweep to completion and stage it as rows of
    /// `[freq, re0, im0, re1, im1, ...]`.
    ///
    /// AC is not streamed: it is a fixed, usually small point count, and the
    /// row shape differs from transient, so it gets its own call rather than
    /// complicating the ring format.
    #[wasm_bindgen(js_name = runAc)]
    pub fn run_ac(
        &mut self,
        scale: &str,
        points: usize,
        start: f64,
        stop: f64,
    ) -> Result<usize, JsError> {
        let spec = AcSpec {
            scale: match scale {
                "oct" => AcScale::Oct,
                "lin" => AcScale::Lin,
                _ => AcScale::Dec,
            },
            points,
            start,
            stop,
        };
        let res = ac_sweep(&mut self.circuit, &spec).map_err(|e| JsError::new(&e.to_string()))?;
        self.staging.clear();
        for (k, f) in res.freq.iter().enumerate() {
            self.staging.push(*f);
            for i in 0..self.circuit.num_unknowns {
                self.staging.push(res.re[k][i]);
                self.staging.push(res.im[k][i]);
            }
        }
        Ok(res.freq.len())
    }
}

/// Ring producer states, exported so the worker does not duplicate the numbers.
#[wasm_bindgen(js_name = stateDone)]
pub fn state_done() -> i32 {
    STATE_DONE
}

#[wasm_bindgen(js_name = stateError)]
pub fn state_error() -> i32 {
    STATE_ERROR
}
