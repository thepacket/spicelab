//! SPICE netlist parsing and circuit construction.
//!
//! This is the highest-leverage piece in the project: roughly thirty primitives
//! plus a correct subcircuit engine gives access to the entire vendor
//! macromodel ecosystem — op-amps, regulators, references and comparators
//! shipped as `.subckt` text by TI, ADI, onsemi and others.
//!
//! Structure:
//!
//!   `expr`      SPICE number literals and `.param` expression evaluation.
//!   `parse`     text -> [`Netlist`], a faithful syntax tree. No semantics.
//!   `flatten`   [`Netlist`] -> a flat element list, with subcircuits expanded,
//!               parameters resolved and node names made hierarchical.
//!   `build`     flat element list -> [`Circuit`].
//!
//! The three phases are separate because subcircuit expansion is where the hard
//! parts live (nested definitions, parameter scoping, hierarchical node
//! mapping), and it is much easier to test a phase that turns data into data
//! than one that also allocates matrix unknowns.
//!
//! Node `0`, `gnd` and `ground` are global ground at every level of hierarchy
//! and are never prefixed — a subcircuit that connects to `0` internally means
//! the real ground, not a local net.

pub mod expr;
pub mod parse;

mod build;

pub use build::{ac_spec, build, dc_spec, flatten, tran_options, FlatElement, ResolvedModel};
pub use parse::{parse, parse_with, Analysis, Element, ModelCard, Netlist, ParseError, Resolver, Subckt};
