//! Device contract and the dispatch enum.
//!
//! Port of the `Device` half of `src/core/device.js`.
//!
//! Two deliberate shape changes from the JS:
//!
//! * **Enum dispatch, not `Box<dyn Device>`.** The stamp pass runs thousands of
//!   times per second and trait-object indirection is measurable there.
//!   `DeviceOps` still exists for organisation — each device implements it — but
//!   the hot path goes through `DeviceKind`'s `match`, which monomorphises.
//!
//! * **Cross-device references are indices, not pointers.** A coupled inductor
//!   or a current-controlled source names another device by its position in
//!   `Circuit::devices`; the referenced branch index is resolved once during
//!   topology build (see `Circuit::build_topology`).
//!
//! Every hook is declared here even where no current device uses it
//! (`load_noise`, `max_timestep`, `temperature`). Adding a trait method later
//! means editing every device; declaring it now costs nothing.

use crate::context::Context;
use crate::devices::mosfet::Mosfet;
use crate::devices::primitives::{Capacitor, Cccs, Ccvs, Inductor, Resistor, VSwitch, Vccs, Vcvs};
use crate::devices::semiconductors::{Bjt, Diode};
use crate::devices::sources::{CurrentSource, VoltageSource, Waveform};
use crate::sparse::SparseSystem;

/// Fields every device instance carries. Embedded rather than inherited.
pub struct Common {
    /// Instance name, e.g. "R1".
    pub name: String,
    /// Unknown indices, -1 for ground.
    pub nodes: Vec<i32>,
    /// Offset into the shared state pool.
    pub state_off: usize,
    /// Indices of this device's extra unknowns (branch currents).
    pub branches: Vec<usize>,
    /// Internal nodes, one per series resistance the model asks for.
    ///
    /// A list rather than a single index because a BJT needs up to three (base,
    /// emitter and collector ohmic resistance) while a diode needs at most one.
    /// The device decides what each slot means; `n_internal` declares how many.
    pub internals: Vec<i32>,
}

impl Common {
    pub fn new(name: &str, nodes: Vec<i32>) -> Self {
        Common {
            name: name.to_string(),
            nodes,
            state_off: 0,
            branches: Vec::new(),
            internals: Vec::new(),
        }
    }
}

/// A noise current spectral density contribution, in A^2/Hz.
pub struct NoiseSource {
    pub device: String,
    pub kind: &'static str,
    pub nodes: [i32; 2],
    pub psd: f64,
}

pub trait DeviceOps {
    fn common(&self) -> &Common;
    fn common_mut(&mut self) -> &mut Common;

    /// Number of extra unknowns (branch currents) this device needs.
    fn n_branches(&self) -> usize {
        0
    }
    /// Number of state-pool slots. Slots come in (charge, current) pairs.
    fn n_states(&self) -> usize {
        0
    }
    /// How many of those slots the LTE estimator should treat as charges.
    ///
    /// Defaults to all of them. A device that also carries per-timepoint values
    /// which are NOT charges (the MOSFET keeps the previous Meyer capacitances
    /// and terminal voltages) puts them after this point, so the truncation
    /// error estimate does not try to differentiate them.
    fn n_lte_states(&self) -> usize {
        self.n_states()
    }
    /// Number of internal nodes (series resistances inside compact models).
    fn n_internal(&self) -> usize {
        0
    }
    fn is_nonlinear(&self) -> bool {
        false
    }

    /// Declare matrix pattern entries. Called once per topology change.
    ///
    /// A device whose stamp pattern depends on its own state must reserve the
    /// UNION of every pattern it can take, so that a state change never forces
    /// re-analysis. That property is what keeps a slider drag real-time.
    fn reserve(&self, sys: &mut SparseSystem);

    /// Cache matrix handles after `analyze()`. Called once per topology change.
    fn bind(&mut self, sys: &SparseSystem);

    /// Recompute temperature-dependent parameters.
    fn temperature(&mut self, _ctx: &Context) {}

    /// Stamp for DC operating point and DC sweep.
    fn load_dc(&mut self, ctx: &mut Context);

    /// Stamp for transient. Defaults to the DC stamp for memoryless devices.
    fn load_tran(&mut self, ctx: &mut Context) {
        self.load_dc(ctx);
    }

    /// Stamp small-signal contribution at `ctx.omega`, linearized about the OP.
    fn load_ac(&mut self, ctx: &mut Context) {
        self.load_dc(ctx);
    }

    /// Add noise current spectral density contributions.
    fn load_noise(&self, _ctx: &Context, _out: &mut Vec<NoiseSource>) {}

    /// Apply voltage limiting to the Newton iterate. Set `ctx.limited` if changed.
    fn limit(&mut self, _ctx: &mut Context) {}

    /// Device-specific convergence test. Clear `ctx.device_converged` to reject.
    fn check_convergence(&mut self, _ctx: &mut Context) {}

    /// Largest safe timestep this device wants, from local truncation error.
    fn max_timestep(&self, _ctx: &Context) -> f64 {
        f64::INFINITY
    }

    /// Reset internal history.
    fn reset(&mut self) {}

    /// The transient waveform, if this device drives one. Used to collect
    /// breakpoints so no source edge is stepped over.
    fn tran_waveform(&self) -> Option<&Waveform> {
        None
    }
}

/// Dispatch enum. The hot path matches on this rather than going through a
/// trait object; see the module docs.
pub enum DeviceKind {
    Resistor(Resistor),
    Capacitor(Capacitor),
    Inductor(Inductor),
    Vcvs(Vcvs),
    Vccs(Vccs),
    Cccs(Cccs),
    Ccvs(Ccvs),
    VSwitch(VSwitch),
    VoltageSource(VoltageSource),
    CurrentSource(CurrentSource),
    Diode(Diode),
    Bjt(Bjt),
    Mosfet(Mosfet),
}

/// Expands `$body` once per variant, binding the inner device to `$d`.
macro_rules! dispatch {
    ($self:expr, $d:ident, $body:expr) => {
        match $self {
            DeviceKind::Resistor($d) => $body,
            DeviceKind::Capacitor($d) => $body,
            DeviceKind::Inductor($d) => $body,
            DeviceKind::Vcvs($d) => $body,
            DeviceKind::Vccs($d) => $body,
            DeviceKind::Cccs($d) => $body,
            DeviceKind::Ccvs($d) => $body,
            DeviceKind::VSwitch($d) => $body,
            DeviceKind::VoltageSource($d) => $body,
            DeviceKind::CurrentSource($d) => $body,
            DeviceKind::Diode($d) => $body,
            DeviceKind::Bjt($d) => $body,
            DeviceKind::Mosfet($d) => $body,
        }
    };
}

impl DeviceKind {
    #[inline]
    pub fn common(&self) -> &Common {
        dispatch!(self, d, d.common())
    }
    #[inline]
    pub fn common_mut(&mut self) -> &mut Common {
        dispatch!(self, d, d.common_mut())
    }
    #[inline]
    pub fn name(&self) -> &str {
        &self.common().name
    }
    #[inline]
    pub fn nodes(&self) -> &[i32] {
        &self.common().nodes
    }
    #[inline]
    pub fn branches(&self) -> &[usize] {
        &self.common().branches
    }
    #[inline]
    pub fn state_off(&self) -> usize {
        self.common().state_off
    }
    #[inline]
    pub fn n_branches(&self) -> usize {
        dispatch!(self, d, d.n_branches())
    }
    #[inline]
    pub fn n_states(&self) -> usize {
        dispatch!(self, d, d.n_states())
    }

    pub fn n_lte_states(&self) -> usize {
        dispatch!(self, d, d.n_lte_states())
    }
    #[inline]
    pub fn n_internal(&self) -> usize {
        dispatch!(self, d, d.n_internal())
    }
    #[inline]
    pub fn is_nonlinear(&self) -> bool {
        dispatch!(self, d, d.is_nonlinear())
    }
    #[inline]
    pub fn reserve(&self, sys: &mut SparseSystem) {
        dispatch!(self, d, d.reserve(sys))
    }
    #[inline]
    pub fn bind(&mut self, sys: &SparseSystem) {
        dispatch!(self, d, d.bind(sys))
    }
    #[inline]
    pub fn temperature(&mut self, ctx: &Context) {
        dispatch!(self, d, d.temperature(ctx))
    }
    #[inline]
    pub fn load_dc(&mut self, ctx: &mut Context) {
        dispatch!(self, d, d.load_dc(ctx))
    }
    #[inline]
    pub fn load_tran(&mut self, ctx: &mut Context) {
        dispatch!(self, d, d.load_tran(ctx))
    }
    #[inline]
    pub fn load_ac(&mut self, ctx: &mut Context) {
        dispatch!(self, d, d.load_ac(ctx))
    }
    #[inline]
    pub fn load_noise(&self, ctx: &Context, out: &mut Vec<NoiseSource>) {
        dispatch!(self, d, d.load_noise(ctx, out))
    }
    #[inline]
    pub fn limit(&mut self, ctx: &mut Context) {
        dispatch!(self, d, d.limit(ctx))
    }
    #[inline]
    pub fn check_convergence(&mut self, ctx: &mut Context) {
        dispatch!(self, d, d.check_convergence(ctx))
    }
    #[inline]
    pub fn max_timestep(&self, ctx: &Context) -> f64 {
        dispatch!(self, d, d.max_timestep(ctx))
    }
    #[inline]
    pub fn reset(&mut self) {
        dispatch!(self, d, d.reset())
    }
    #[inline]
    pub fn tran_waveform(&self) -> Option<&Waveform> {
        dispatch!(self, d, d.tran_waveform())
    }
}

/// Two-terminal conductance stamp helpers, shared by the primitives.
/// Node index -1 is ground and every helper skips it via `SparseSystem`.
#[inline]
pub fn reserve2(sys: &mut SparseSystem, p: i32, n: i32) {
    sys.reserve(p, p);
    sys.reserve(p, n);
    sys.reserve(n, p);
    sys.reserve(n, n);
}

#[inline]
pub fn bind2(sys: &SparseSystem, p: i32, n: i32) -> [i32; 4] {
    [
        sys.handle(p, p),
        sys.handle(p, n),
        sys.handle(n, p),
        sys.handle(n, n),
    ]
}

#[inline]
pub fn stamp2(sys: &mut SparseSystem, h: &[i32; 4], g: f64) {
    sys.add(h[0], g);
    sys.add(h[1], -g);
    sys.add(h[2], -g);
    sys.add(h[3], g);
}

#[inline]
pub fn stamp2c(sys: &mut SparseSystem, h: &[i32; 4], gr: f64, gi: f64) {
    sys.add_complex(h[0], gr, gi);
    sys.add_complex(h[1], -gr, -gi);
    sys.add_complex(h[2], -gr, -gi);
    sys.add_complex(h[3], gr, gi);
}
