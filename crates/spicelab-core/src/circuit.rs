//! Circuit container and build pipeline. Port of `src/core/circuit.js`.
//!
//! The build is split into two phases on purpose:
//!
//!   `build_topology()` — allocates unknowns, reserves the matrix pattern, runs
//!                        symbolic analysis, binds handles. Expensive. Runs only
//!                        when wires or component counts change.
//!
//!   everything else    — stamps values into the already-analysed matrix.
//!
//! This split is the whole basis of interactive real-time. Dragging a
//! potentiometer changes a value, not a topology, so it never touches phase one.

use std::collections::HashMap;

use crate::context::{Context, Method, Mode};
use crate::device::DeviceKind;
use crate::devices::primitives::Couple;
use crate::sparse::SparseSystem;
use crate::SimError;

#[derive(Clone, Debug)]
pub struct Options {
    pub gmin: f64,
    pub reltol: f64,
    pub vntol: f64,
    pub abstol: f64,
    pub chgtol: f64,
    /// DC operating point iteration limit.
    pub itl1: usize,
    /// DC sweep iteration limit.
    pub itl2: usize,
    /// Transient iteration limit per timepoint.
    pub itl4: usize,
    pub trtol: f64,
    pub temp: f64,
    pub nom_temp: f64,
    pub method: Method,
    pub maxord: usize,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            gmin: 1e-12,
            reltol: 1e-3,
            vntol: 1e-6,
            abstol: 1e-12,
            chgtol: 1e-14,
            itl1: 100,
            itl2: 50,
            itl4: 10,
            trtol: 7.0,
            temp: 300.15,
            nom_temp: 300.15,
            method: Method::Trap,
            maxord: 2,
        }
    }
}

pub struct Circuit {
    pub title: String,
    pub devices: Vec<DeviceKind>,
    /// Node name (lowercased) -> unknown index.
    node_map: HashMap<String, usize>,
    /// Unknown index -> label.
    pub labels: Vec<String>,
    pub num_nodes: usize,
    pub num_unknowns: usize,
    pub ctx: Context,
    pub topology_dirty: bool,
    pub options: Options,
}

impl Circuit {
    pub fn new(title: &str) -> Self {
        Circuit {
            title: title.to_string(),
            devices: Vec::new(),
            node_map: HashMap::new(),
            labels: Vec::new(),
            num_nodes: 0,
            num_unknowns: 0,
            ctx: Context::new(SparseSystem::new(0), 0, 1),
            topology_dirty: true,
            options: Options::default(),
        }
    }

    /// Resolve a node name to an unknown index. "0", "gnd", "ground" and "" are
    /// ground and return -1.
    pub fn node(&mut self, name: &str) -> i32 {
        let key = name.to_lowercase();
        if key == "0" || key == "gnd" || key == "ground" || key.is_empty() {
            return -1;
        }
        if let Some(&i) = self.node_map.get(&key) {
            return i as i32;
        }
        let idx = self.num_nodes;
        self.num_nodes += 1;
        self.node_map.insert(key, idx);
        if self.labels.len() <= idx {
            self.labels.resize(idx + 1, String::new());
        }
        self.labels[idx] = name.to_string();
        self.topology_dirty = true;
        idx as i32
    }

    /// Add a device and return its index, which is how other devices refer to it.
    pub fn add(&mut self, d: DeviceKind) -> usize {
        self.devices.push(d);
        self.topology_dirty = true;
        self.devices.len() - 1
    }

    /// Mutual inductance: `K<name> L1 L2 <coupling coefficient>`.
    ///
    /// Unlike the JS oracle this is not a device — it has no stamps of its own,
    /// it only installs a `Couple` on each of the two inductors.
    pub fn couple(&mut self, l1: usize, l2: usize, k: f64) -> Result<(), SimError> {
        let (v1, v2) = match (&self.devices[l1], &self.devices[l2]) {
            (DeviceKind::Inductor(a), DeviceKind::Inductor(b)) => (a.l, b.l),
            _ => return Err(SimError::Build("K must couple two inductors".into())),
        };
        let m = k * (v1 * v2).sqrt();
        if let DeviceKind::Inductor(a) = &mut self.devices[l1] {
            a.couples.push(Couple {
                other_dev: l2,
                m,
                other_branch: 0,
            });
        }
        if let DeviceKind::Inductor(b) = &mut self.devices[l2] {
            b.couples.push(Couple {
                other_dev: l1,
                m,
                other_branch: 0,
            });
        }
        self.topology_dirty = true;
        Ok(())
    }

    fn label_at(&mut self, idx: usize, s: String) {
        if self.labels.len() <= idx {
            self.labels.resize(idx + 1, String::new());
        }
        self.labels[idx] = s;
    }

    /// Full topology build. Expensive; call only when structure changes.
    pub fn build_topology(&mut self) -> Result<(), SimError> {
        let mut unknown = self.num_nodes;
        let mut state_size = 0usize;

        // Pass 1: allocate internal nodes, branch currents and state slots.
        for i in 0..self.devices.len() {
            let name = self.devices[i].name().to_string();
            let n_int = self.devices[i].n_internal();
            let mut internals = Vec::with_capacity(n_int);
            for k in 0..n_int {
                internals.push(unknown as i32);
                self.label_at(unknown, format!("{name}:int{k}"));
                unknown += 1;
            }
            self.devices[i].common_mut().internals = internals;
            let nb = self.devices[i].n_branches();
            let mut branches = Vec::with_capacity(nb);
            for _ in 0..nb {
                branches.push(unknown);
                self.label_at(unknown, format!("I({name})"));
                unknown += 1;
            }
            self.devices[i].common_mut().branches = branches;
            self.devices[i].common_mut().state_off = state_size;
            state_size += self.devices[i].n_states();
        }

        // Pass 2: resolve cross-device references now that every branch index
        // exists. The JS oracle dereferences object pointers here; indices need
        // an explicit fixup pass.
        let branch_of: Vec<Vec<usize>> = self
            .devices
            .iter()
            .map(|d| d.branches().to_vec())
            .collect();
        for d in self.devices.iter_mut() {
            match d {
                DeviceKind::Inductor(l) => {
                    for cpl in l.couples.iter_mut() {
                        cpl.other_branch = *branch_of[cpl.other_dev].first().ok_or_else(|| {
                            SimError::Build("coupled inductor has no branch current".into())
                        })?;
                    }
                }
                DeviceKind::Cccs(s) => {
                    s.ctrl_branch = *branch_of[s.ctrl_dev].first().ok_or_else(|| {
                        SimError::Build(format!(
                            "{}: controlling device has no branch current",
                            s.c.name
                        ))
                    })?;
                }
                DeviceKind::Ccvs(s) => {
                    s.ctrl_branch = *branch_of[s.ctrl_dev].first().ok_or_else(|| {
                        SimError::Build(format!(
                            "{}: controlling device has no branch current",
                            s.c.name
                        ))
                    })?;
                }
                _ => {}
            }
        }

        self.num_unknowns = unknown;

        // Pass 3: symbolic analysis, then bind handles.
        let mut sys = SparseSystem::new(unknown);
        for d in self.devices.iter() {
            d.reserve(&mut sys);
        }
        sys.analyze()?;
        for d in self.devices.iter_mut() {
            d.bind(&sys);
        }

        let mut ctx = Context::new(sys, unknown, state_size.max(1));
        let o = &self.options;
        ctx.gmin = o.gmin;
        ctx.reltol = o.reltol;
        ctx.vntol = o.vntol;
        ctx.abstol = o.abstol;
        ctx.chgtol = o.chgtol;
        ctx.temp = o.temp;
        ctx.nom_temp = o.nom_temp;
        ctx.method = o.method;
        for d in self.devices.iter_mut() {
            d.temperature(&ctx);
        }
        self.ctx = ctx;
        self.topology_dirty = false;
        Ok(())
    }

    pub fn ensure_built(&mut self) -> Result<(), SimError> {
        if self.topology_dirty {
            self.build_topology()?;
        }
        Ok(())
    }

    /// Stamp every device for the current mode. Allocation-free.
    pub fn load(&mut self, mode: Mode) {
        let Circuit { devices, ctx, .. } = self;
        ctx.mode = mode;
        ctx.sys.zero();
        ctx.rhs_re.iter_mut().for_each(|v| *v = 0.0);
        ctx.rhs_im.iter_mut().for_each(|v| *v = 0.0);
        match mode {
            Mode::Tran => {
                for d in devices.iter_mut() {
                    d.load_tran(ctx);
                }
            }
            Mode::Ac => {
                for d in devices.iter_mut() {
                    d.load_ac(ctx);
                }
            }
            _ => {
                for d in devices.iter_mut() {
                    d.load_dc(ctx);
                }
            }
        }
    }

    /// Index of a named node, or an error. Ground resolves to -1.
    pub fn index_of(&self, name: &str) -> Result<i32, SimError> {
        let key = name.to_lowercase();
        if key == "0" || key == "gnd" || key == "ground" {
            return Ok(-1);
        }
        self.node_map
            .get(&key)
            .map(|&i| i as i32)
            .ok_or_else(|| SimError::Build(format!("unknown node: {name}")))
    }

    /// Voltage at a named node in the current solution.
    pub fn voltage(&self, name: &str) -> Result<f64, SimError> {
        let i = self.index_of(name)?;
        Ok(if i < 0 { 0.0 } else { self.ctx.x[i as usize] })
    }

    pub fn device_index(&self, name: &str) -> Option<usize> {
        let lower = name.to_lowercase();
        self.devices
            .iter()
            .position(|d| d.name().to_lowercase() == lower)
    }

    /// Current through a named device that owns a branch current.
    pub fn current(&self, device_name: &str) -> Result<f64, SimError> {
        let i = self
            .device_index(device_name)
            .ok_or_else(|| SimError::Build(format!("no such device: {device_name}")))?;
        let b = self.devices[i].branches();
        if b.is_empty() {
            return Err(SimError::Build(format!(
                "no branch current for {device_name}"
            )));
        }
        Ok(self.ctx.x[b[0]])
    }

    /// Snapshot of every unknown, keyed by label.
    pub fn snapshot(&self) -> Vec<(String, f64)> {
        (0..self.num_unknowns)
            .map(|i| {
                let l = self
                    .labels
                    .get(i)
                    .filter(|s| !s.is_empty())
                    .cloned()
                    .unwrap_or_else(|| format!("x{i}"));
                (l, self.ctx.x[i])
            })
            .collect()
    }
}
