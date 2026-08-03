//! SpiceLab simulation core.
//!
//! A SPICE-class analog circuit simulator: sparse complex LU with a symbolic /
//! numeric split, charge-based device models, and `.op` / `.dc` / `.ac` /
//! `.tran` analyses.
//!
//! This crate carries no wasm dependencies on purpose, so the numerics stay
//! testable and benchmarkable natively. The `wasm-bindgen` boundary lives in
//! `spicelab-wasm` and contains no numerics.
//!
//! It is a port of the verified JS oracle in `src/core/`, which remains the
//! reference implementation. `tests/golden.rs` builds the same circuits as
//! `tests/fixtures/golden.json` and asserts agreement inside each fixture's
//! stated tolerance. See CLAUDE.md for why the oracle exists and which two bugs
//! it caught — both of which this port can reintroduce.

pub mod analyses;
pub mod circuit;
pub mod context;
pub mod device;
pub mod devices;
pub mod limiting;
pub mod netlist;
pub mod newton;
pub mod sparse;

pub use circuit::{Circuit, Options};
pub use context::{Context, Method, Mode};
pub use device::{DeviceKind, DeviceOps};
pub use sparse::{SparseError, SparseSystem};

#[derive(Debug)]
pub enum SimError {
    /// Topology could not be built or a name did not resolve.
    Build(String),
    /// Ordering or factorization found the matrix structurally singular.
    Sparse(SparseError),
    /// Newton failed even after the full convergence ladder.
    Convergence { message: String, time: Option<f64> },
}

impl std::fmt::Display for SimError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SimError::Build(m) => write!(f, "{m}"),
            SimError::Sparse(e) => write!(f, "{e}"),
            SimError::Convergence { message, .. } => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for SimError {}

impl From<SparseError> for SimError {
    fn from(e: SparseError) -> Self {
        SimError::Sparse(e)
    }
}
