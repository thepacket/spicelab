//! Subcircuit expansion and circuit construction.
//!
//! Expansion is where the genuinely hard parts of a netlist reader live:
//! nested definitions, parameter scoping, and hierarchical node mapping. It is
//! kept separate from both parsing and matrix construction so it can be tested
//! as a data-to-data transform.
//!
//! Scoping rules implemented, matching common SPICE practice:
//!
//! * `0`, `gnd` and `ground` are global ground at every level and are never
//!   prefixed. A subcircuit wiring a node to `0` means the real ground.
//! * Every other internal node is prefixed with the instance path (`X1.X2.n`),
//!   so two instances of the same subcircuit never collide.
//! * A `.subckt` default parameter is overridden by an instance parameter. The
//!   override expression is evaluated in the CALLER's scope; the defaults are
//!   evaluated in the callee's.
//! * Models and nested `.subckt` definitions resolve innermost-first, then
//!   outward to the top level.

use std::collections::HashMap;
use std::rc::Rc;

use crate::analyses::dc::{AcScale, AcSpec, SweepProperty, SweepSpec};
use crate::analyses::tran::TranOptions;
use crate::circuit::Circuit;
use crate::context::Method;
use crate::device::DeviceKind;
use crate::devices::mosfet::{MosModel, MosType, Mosfet};
use crate::devices::primitives::{
    Capacitor, Cccs, Ccvs, Inductor, Resistor, SwitchModel, VSwitch, Vccs, Vcvs,
};
use crate::devices::semiconductors::{Bjt, BjtModel, BjtType, Diode, DiodeModel};
use crate::devices::sources::{CurrentSource, VoltageSource, Waveform};
use crate::netlist::expr::{eval, parse_number};
use crate::netlist::parse::{Analysis, Element, ErrorKind, ModelCard, Netlist, ParseError, Subckt};

/// See `ErrorKind`: "cannot do that" rather than "that is wrong".
fn err_kind<T>(
    line: usize,
    message: impl Into<String>,
    kind: ErrorKind,
) -> Result<T, ParseError> {
    Err(ParseError { line, message: message.into(), kind })
}

fn err<T>(line: usize, message: impl Into<String>) -> Result<T, ParseError> {
    Err(ParseError {
        line,
        message: message.into(),
        kind: ErrorKind::Invalid,
    })
}

fn is_ground(n: &str) -> bool {
    matches!(n.to_lowercase().as_str(), "0" | "gnd" | "ground")
}

/// A model card with its parameters evaluated in the scope where it was used.
#[derive(Debug, Clone)]
pub struct ResolvedModel {
    pub name: String,
    pub kind: String,
    pub params: HashMap<String, f64>,
    /// Parameters that could not be evaluated as numbers — typically vendor
    /// metadata such as `MFG=SIEMENS`. Harmless in itself, but checked against
    /// each device's recognised parameter list so that a value the device
    /// actually READS can never be dropped silently.
    pub unresolved: Vec<String>,
    /// The raw TEXT of each unresolved parameter, keyed by name.
    ///
    /// Kept because the key alone cannot distinguish "this is vendor metadata"
    /// from "this is a SPICE construct we do not implement". `tox=AGAUSS(...)`
    /// is ngspice's Monte Carlo syntax — valid, just unimplemented — and
    /// classifying it as a broken netlist blocked the fallback engine that
    /// does implement it.
    pub unresolved_raw: HashMap<String, String>,
}

impl ResolvedModel {
    fn get(&self, key: &str, default: f64) -> f64 {
        self.params.get(key).copied().unwrap_or(default)
    }
}

/// One element after subcircuit expansion: names and nodes are global, and the
/// parameter scope needed to evaluate its arguments travels with it.
#[derive(Debug, Clone)]
pub struct FlatElement {
    pub letter: char,
    /// Hierarchical instance name, e.g. `X1.R2`.
    pub name: String,
    /// Resolved global net names.
    pub nodes: Vec<String>,
    pub args: Vec<String>,
    pub params: HashMap<String, String>,
    /// Shared so a large subcircuit does not clone its scope per element.
    pub scope: Rc<HashMap<String, f64>>,
    pub model: Option<Rc<ResolvedModel>>,
    pub line: usize,
}

impl FlatElement {
    fn num(&self, s: &str) -> Result<f64, ParseError> {
        eval(s, &self.scope).map_err(|e| ParseError {
            kind: if e.is_unsupported() { ErrorKind::Unsupported } else { ErrorKind::Invalid },
            line: self.line,
            message: format!("{}: {e}", self.name),
        })
    }

    /// Positional argument `i`, evaluated.
    fn arg(&self, i: usize) -> Result<f64, ParseError> {
        match self.args.get(i) {
            Some(s) => self.num(s),
            None => err(
                self.line,
                format!("{}: missing argument {}", self.name, i + 1),
            ),
        }
    }

    /// A `key=value` parameter, evaluated, or a default.
    fn param(&self, key: &str, default: f64) -> Result<f64, ParseError> {
        match self.params.get(key) {
            Some(s) => self.num(s),
            None => Ok(default),
        }
    }

    fn param_opt(&self, key: &str) -> Result<Option<f64>, ParseError> {
        match self.params.get(key) {
            Some(s) => Ok(Some(self.num(s)?)),
            None => Ok(None),
        }
    }

    /// Value taken from the first positional argument, falling back to a named
    /// parameter — both `R1 a b 1k` and `R1 a b r=1k` are legal.
    fn value(&self, key: &str) -> Result<f64, ParseError> {
        if let Some(s) = self.args.first() {
            return self.num(s);
        }
        if let Some(s) = self.params.get(key) {
            return self.num(s);
        }
        err(self.line, format!("{}: missing value", self.name))
    }

    /// Model parameter, overridden by an instance parameter of the same name.
    fn mparam(&self, key: &str, default: f64) -> Result<f64, ParseError> {
        if self.params.contains_key(key) {
            return self.param(key, default);
        }
        Ok(match &self.model {
            Some(m) => m.get(key, default),
            None => default,
        })
    }
}

/// Evaluate a parameter map that may reference its own entries, by repeated
/// passes until nothing new resolves. Order-independent, which matters because
/// `.subckt` defaults arrive as an unordered map.
fn resolve_map(
    raw: &HashMap<String, String>,
    base: &HashMap<String, f64>,
    line: usize,
) -> Result<HashMap<String, f64>, ParseError> {
    let (out, unresolved, _raw) = resolve_map_lenient(raw, base);
    if let Some(k) = unresolved.first() {
        let v = &raw[k];
        let e = eval(v, &out).unwrap_err();
        return err(line, format!("parameter '{k}' = '{v}': {e}"));
    }
    Ok(out)
}

/// As `resolve_map`, but returns the keys that never resolved instead of
/// failing on the first one.
///
/// Model cards need this: real vendor `.model` lines routinely carry
/// non-numeric metadata (`MFG=SIEMENS`, `TYPE=...`), and SPICE ignores model
/// parameters it does not recognise rather than refusing the file. Aborting on
/// them would make most manufacturer models unloadable. The caller is
/// responsible for checking the unresolved list against the parameters its
/// device actually reads — see `check_unresolved`.
fn resolve_map_lenient(
    raw: &HashMap<String, String>,
    base: &HashMap<String, f64>,
) -> (HashMap<String, f64>, Vec<String>, HashMap<String, String>) {
    let mut out = base.clone();
    let mut pending: Vec<(&String, &String)> = raw.iter().collect();
    while !pending.is_empty() {
        let before = pending.len();
        pending.retain(|(k, v)| match eval(v, &out) {
            Ok(x) => {
                out.insert((*k).clone(), x);
                false
            }
            Err(_) => true,
        });
        if pending.len() == before {
            break;
        }
    }
    let raw_map: HashMap<String, String> =
        pending.iter().map(|(k, v)| ((*k).clone(), (*v).clone())).collect();
    let mut unresolved: Vec<String> = pending.into_iter().map(|(k, _)| k.clone()).collect();
    unresolved.sort();
    (out, unresolved, raw_map)
}

/// Refuse a model whose UNREADABLE parameters include one the device model
/// actually uses.
///
/// Ignoring `MFG=SIEMENS` is lossless. Ignoring `IS={typo}` is not — it would
/// substitute the default and simulate a different device with no warning,
/// which is the failure mode this project exists to avoid. So metadata passes
/// and anything the device reads must evaluate.
fn check_unresolved(e: &FlatElement, recognised: &[&str]) -> Result<(), ParseError> {
    let Some(m) = e.model.as_ref() else { return Ok(()) };
    for k in &m.unresolved {
        if recognised.contains(&k.as_str()) {
            // Distinguish "we cannot read this" from "this is nonsense". A
            // value like AGAUSS(9e-9, 9e-9, 10) is ngspice's Monte Carlo
            // distribution syntax: valid SPICE, not implemented here. Calling
            // it invalid blamed the netlist and blocked the fallback engine
            // that does implement it.
            let raw = m.unresolved_raw.get(k).map(|v| v.as_str()).unwrap_or("");
            let dist = ["agauss", "gauss", "aunif", "unif", "limit"]
                .iter()
                .any(|f| raw.trim().to_lowercase().starts_with(f));
            if dist {
                return err_kind(
                    e.line,
                    format!(
                        "{}: model '{}' parameter '{}' uses the statistical form \
                         `{}`, which is not implemented here",
                        e.name,
                        m.name,
                        k,
                        raw.trim()
                    ),
                    ErrorKind::Unsupported,
                );
            }
            return err(
                e.line,
                format!(
                    "{}: model '{}' parameter '{}' could not be evaluated, and it \
                     is a parameter this device uses — refusing rather than \
                     silently falling back to the default.",
                    e.name, m.name, k
                ),
            );
        }
    }
    Ok(())
}

/// Scope stack entry for model and subcircuit resolution.
struct Frame<'a> {
    sub: &'a Subckt,
}

fn find_model<'a>(
    name: &str,
    stack: &[Frame<'a>],
    nl: &'a Netlist,
) -> Option<&'a ModelCard> {
    let key = name.to_lowercase();
    for f in stack.iter().rev() {
        if let Some(m) = f.sub.models.get(&key) {
            return Some(m);
        }
    }
    nl.models.get(&key)
}

fn find_subckt<'a>(
    name: &str,
    stack: &[Frame<'a>],
    nl: &'a Netlist,
) -> Option<&'a Subckt> {
    let key = name.to_lowercase();
    for f in stack.iter().rev() {
        if let Some(s) = f.sub.subckts.get(&key) {
            return Some(s);
        }
    }
    nl.subckts.get(&key)
}

/// Expand every subcircuit instance and resolve names, nodes and parameters.
pub fn flatten(nl: &Netlist) -> Result<Vec<FlatElement>, ParseError> {
    // Top-level `.param`s are ordered, so evaluate them in declaration order —
    // a later one may reference an earlier one.
    let mut globals: HashMap<String, f64> = HashMap::new();
    for (k, v) in &nl.params {
        let val = eval(v, &globals).map_err(|e| ParseError {
            kind: if e.is_unsupported() { ErrorKind::Unsupported } else { ErrorKind::Invalid },
            line: 0,
            message: format!("parameter '{k}' = '{v}': {e}"),
        })?;
        globals.insert(k.clone(), val);
    }

    let mut out = Vec::new();
    let mut stack: Vec<Frame> = Vec::new();
    expand(
        &nl.cards,
        "",
        &HashMap::new(),
        Rc::new(globals),
        nl,
        &mut stack,
        &mut out,
        0,
    )?;
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
fn expand<'n>(
    cards: &'n [Element],
    prefix: &str,
    port_map: &HashMap<String, String>,
    scope: Rc<HashMap<String, f64>>,
    nl: &'n Netlist,
    stack: &mut Vec<Frame<'n>>,
    out: &mut Vec<FlatElement>,
    depth: usize,
) -> Result<(), ParseError> {
    if depth > 64 {
        return err(0, "subcircuit nesting too deep (recursive .subckt?)");
    }

    // Map a node name as written to its global name.
    let map_node = |n: &str| -> String {
        if is_ground(n) {
            return "0".to_string();
        }
        if let Some(g) = port_map.get(&n.to_lowercase()) {
            return g.clone();
        }
        format!("{prefix}{n}")
    };

    for card in cards {
        if card.letter == 'x' {
            let sub_name = match card.args.first() {
                Some(s) => s,
                None => {
                    return err(card.line, format!("{}: missing subcircuit name", card.name))
                }
            };
            let sub = match find_subckt(sub_name, stack, nl) {
                Some(s) => s,
                None => {
                    return err(
                        card.line,
                        format!("{}: undefined subcircuit '{sub_name}'", card.name),
                    )
                }
            };
            if card.nodes.len() != sub.ports.len() {
                return err(
                    card.line,
                    format!(
                        "{}: subcircuit '{}' takes {} nodes, {} given",
                        card.name,
                        sub.name,
                        sub.ports.len(),
                        card.nodes.len()
                    ),
                );
            }

            // Ports bind to the caller's already-resolved node names.
            let mut inner_ports: HashMap<String, String> = HashMap::new();
            for (p, n) in sub.ports.iter().zip(card.nodes.iter()) {
                inner_ports.insert(p.to_lowercase(), map_node(n));
            }

            // Defaults evaluated in the callee scope, then instance overrides
            // evaluated in the CALLER scope so `X1 a b div r={rtop}` works.
            let mut inner_scope = resolve_map(&sub.params, &scope, sub.line)?;
            for (k, v) in &card.params {
                let val = eval(v, &scope).map_err(|e| ParseError {
                    kind: if e.is_unsupported() { ErrorKind::Unsupported } else { ErrorKind::Invalid },
                    line: card.line,
                    message: format!("{}: parameter '{k}': {e}", card.name),
            })?;
                inner_scope.insert(k.clone(), val);
            }

            let inner_prefix = format!("{prefix}{}.", card.name);
            stack.push(Frame { sub });
            expand(
                &sub.cards,
                &inner_prefix,
                &inner_ports,
                Rc::new(inner_scope),
                nl,
                stack,
                out,
                depth + 1,
            )?;
            stack.pop();
            continue;
        }

        // A model reference is the first positional argument for D/Q/M/S.
        let model = match card.letter {
            'd' | 'q' | 'm' | 's' => match card.args.first() {
                Some(name) => match find_model(name, stack, nl) {
                    Some(mc) => {
                        let (params, unresolved, unresolved_raw) =
                            resolve_map_lenient(&mc.params, &scope);
                        Some(Rc::new(ResolvedModel {
                            name: mc.name.clone(),
                            kind: mc.kind.clone(),
                            params,
                            unresolved,
                            unresolved_raw,
                        }))
                    }
                    None => {
                        return err(
                            card.line,
                            format!("{}: undefined model '{name}'", card.name),
                        )
                    }
                },
                None => {
                    return err(card.line, format!("{}: missing model name", card.name))
                }
            },
            // A resistor or capacitor MAY name a model — the semiconductor
            // forms, whose value comes from process parameters and geometry.
            // Looked up LENIENTLY: an ordinary `R1 a b 1k` has a number here,
            // not a model name, so a miss is normal and must not be an error.
            // Attaching it is what lets the device builder report the
            // semiconductor form as unsupported instead of complaining that
            // the value is an undefined parameter.
            'r' | 'c' => card
                .args
                .first()
                .and_then(|name| find_model(name, stack, nl))
                .map(|mc| {
                    let (params, unresolved, unresolved_raw) =
                        resolve_map_lenient(&mc.params, &scope);
                    Rc::new(ResolvedModel {
                        name: mc.name.clone(),
                        kind: mc.kind.clone(),
                        params,
                        unresolved,
                        unresolved_raw,
                    })
                }),
            _ => None,
        };

        // K, F and H name other devices, which must be prefixed to match the
        // names those devices will actually be given.
        let mut args = card.args.clone();
        match card.letter {
            'k' => {
                for a in args.iter_mut().take(2) {
                    *a = format!("{prefix}{a}");
                }
            }
            'f' | 'h' => {
                if let Some(a) = args.first_mut() {
                    *a = format!("{prefix}{a}");
                }
            }
            _ => {}
        }

        out.push(FlatElement {
            letter: card.letter,
            name: format!("{prefix}{}", card.name),
            nodes: card.nodes.iter().map(|n| map_node(n)).collect(),
            args,
            params: card.params.clone(),
            scope: Rc::clone(&scope),
            model,
            line: card.line,
        });
    }
    Ok(())
}

// ------------------------------------------------------------ source specs

/// Parse the value section of a `V`/`I` card: an optional DC level, an optional
/// AC magnitude/phase, and an optional transient waveform, in any order.
fn source_spec(
    e: &FlatElement,
) -> Result<(f64, Option<(f64, f64)>, Option<Waveform>), ParseError> {
    let mut dc = 0.0;
    let mut ac = None;
    let mut tran = None;
    let mut i = 0;
    let mut seen_positional = false;

    while i < e.args.len() {
        let tok = e.args[i].clone();
        let upper = tok.to_uppercase();
        let head = upper.split('(').next().unwrap_or("").to_string();

        if head == "DC" {
            i += 1;
            if i < e.args.len() {
                dc = e.arg(i)?;
                i += 1;
            }
            continue;
        }
        if head == "AC" {
            i += 1;
            let mag = if i < e.args.len() && parse_number(&e.args[i]).is_some() {
                let v = e.arg(i)?;
                i += 1;
                v
            } else {
                1.0
            };
            let phase = if i < e.args.len() && parse_number(&e.args[i]).is_some() {
                let v = e.arg(i)?;
                i += 1;
                v
            } else {
                0.0
            };
            ac = Some((mag, phase));
            continue;
        }
        if matches!(
            head.as_str(),
            "PULSE" | "SIN" | "SINE" | "EXP" | "PWL" | "SFFM" | "AM"
        ) {
            // Arguments may be inside parentheses on this token, or follow as
            // separate tokens, or both.
            let mut nums: Vec<String> = Vec::new();
            if let Some(open) = tok.find('(') {
                let inner = tok[open + 1..].trim_end_matches(')');
                nums.extend(
                    inner
                        .split(|c: char| c.is_whitespace() || c == ',')
                        .filter(|s| !s.is_empty())
                        .map(str::to_string),
                );
            }
            i += 1;
            while i < e.args.len() && parse_number(&e.args[i]).is_some() {
                nums.push(e.args[i].clone());
                i += 1;
            }
            let v: Result<Vec<f64>, ParseError> = nums.iter().map(|s| e.num(s)).collect();
            let v = v?;
            let g = |k: usize| v.get(k).copied();
            let d = |k: usize, dv: f64| v.get(k).copied().unwrap_or(dv);
            tran = Some(match head.as_str() {
                "PULSE" => Waveform::Pulse {
                    v1: d(0, 0.0),
                    v2: d(1, 1.0),
                    td: d(2, 0.0),
                    tr: g(3),
                    tf: g(4),
                    pw: g(5),
                    per: g(6),
                },
                "SIN" | "SINE" => Waveform::Sin {
                    vo: d(0, 0.0),
                    va: d(1, 0.0),
                    freq: g(2),
                    td: d(3, 0.0),
                    theta: d(4, 0.0),
                    phase: d(5, 0.0),
                },
                "EXP" => Waveform::Exp {
                    v1: d(0, 0.0),
                    v2: d(1, 1.0),
                    td1: d(2, 0.0),
                    tau1: g(3),
                    td2: g(4),
                    tau2: g(5),
                },
                "PWL" => Waveform::Pwl {
                    points: v.chunks(2).filter(|c| c.len() == 2).map(|c| (c[0], c[1])).collect(),
                    repeat: false,
                    period: 0.0,
                },
                "SFFM" => Waveform::Sffm {
                    vo: d(0, 0.0),
                    va: d(1, 1.0),
                    fc: g(2),
                    mdi: d(3, 0.0),
                    fs: g(4),
                },
                "AM" => Waveform::Am {
                    va: d(0, 1.0),
                    vo: d(1, 0.0),
                    mf: d(2, 1.0),
                    fc: g(3),
                    td: d(4, 0.0),
                },
                _ => unreachable!(),
            });
            continue;
        }

        // A bare leading number is the DC level.
        if !seen_positional && parse_number(&tok).is_some() {
            dc = e.arg(i)?;
            seen_positional = true;
            i += 1;
            continue;
        }
        i += 1;
    }
    Ok((dc, ac, tran))
}

// -------------------------------------------------------------- device build

/// Refuse a `.model` card whose TYPE is not one this device implements.
///
/// Every model reader below used to select behaviour with a match whose final
/// arm was `_`, so an unrecognised type silently became the default: a `VDMOS`
/// power-FET card read as a LEVEL 1 Shichman-Hodges MOSFET, an `LPNP` read as
/// an NPN. Nothing errored. The card's own parameters do not save you either,
/// because unknown parameters are deliberately IGNORED as metadata (that rule
/// is what makes vendor cards loadable at all), so a VDMOS's `rg`, `mtriode`
/// and `ksubthres` vanish and its `vto`/`kp` are read into an entirely
/// different set of equations.
///
/// This is the same hazard `mos_model` already refuses loudly for `LEVEL`, and
/// the reasoning there applies verbatim: the parameters are not
/// interchangeable, so loading the card would simulate a device that does not
/// exist. It matters at scale — the KiCad Spice Library alone carries 4,372
/// `VDMOS` cards, which are exactly the power FETs a user reaches for.
///
/// `Unsupported` rather than `Invalid`: these are real, ordinary SPICE models
/// that ngspice implements and this core does not, so the netlist must stay
/// eligible for the coverage engine. See `ErrorKind` in parse.rs.
fn check_model_kind(
    e: &FlatElement,
    accepted: &[&str],
) -> Result<(), ParseError> {
    let Some(m) = e.model.as_ref() else { return Ok(()) };
    if accepted.iter().any(|k| k.eq_ignore_ascii_case(&m.kind)) {
        return Ok(());
    }
    err_kind(
        e.line,
        format!(
            "{}: model '{}' is of type {}, which this core does not \
             implement; it reads {}. The parameters are not interchangeable, \
             so loading it would silently simulate a different device.",
            e.name,
            m.name,
            m.kind.to_uppercase(),
            accepted.join("/").to_uppercase(),
        ),
        ErrorKind::Unsupported,
    )
}

/// Parameters the diode model reads. A card whose value for one of these fails
/// to evaluate is refused; anything else is metadata and ignored.
const DIODE_PARAMS: &[&str] = &[
    "is", "n", "rs", "cjo", "cj0", "vj", "m", "tt", "bv", "ibv", "eg", "xti",
    "fc", "kf", "af", "area",
];

fn diode_model(e: &FlatElement) -> Result<DiodeModel, ParseError> {
    check_model_kind(e, &["d"])?;
    check_unresolved(e, DIODE_PARAMS)?;
    let d = DiodeModel::default();
    Ok(DiodeModel {
        is: e.mparam("is", d.is)?,
        n: e.mparam("n", d.n)?,
        rs: e.mparam("rs", d.rs)?,
        cjo: e.mparam("cjo", e.mparam("cj0", d.cjo)?)?,
        vj: e.mparam("vj", d.vj)?,
        m: e.mparam("m", d.m)?,
        tt: e.mparam("tt", d.tt)?,
        bv: e.mparam("bv", d.bv)?,
        ibv: e.mparam("ibv", d.ibv)?,
        eg: e.mparam("eg", d.eg)?,
        xti: e.mparam("xti", d.xti)?,
        fc: e.mparam("fc", d.fc)?,
        kf: e.mparam("kf", d.kf)?,
        af: e.mparam("af", d.af)?,
        area: e.param("area", d.area)?,
    })
}

const BJT_PARAMS: &[&str] = &[
    "is", "bf", "nf", "vaf", "va", "ikf", "ise", "ne", "br", "nr", "var", "vb",
    "ikr", "isc", "nc", "rb", "re", "rc", "cje", "vje", "mje", "cjc", "vjc",
    "mjc", "xcjc", "tf", "tr", "fc", "eg", "xti", "xtb", "area", "kf", "af",
];

fn bjt_model(e: &FlatElement) -> Result<BjtModel, ParseError> {
    check_model_kind(e, &["npn", "pnp"])?;
    check_unresolved(e, BJT_PARAMS)?;
    let d = BjtModel::default();
    // Safe to fall through to Npn only because `check_model_kind` has already
    // established that the type is one of exactly these two.
    let kind = match e.model.as_ref().map(|m| m.kind.as_str()) {
        Some("pnp") => BjtType::Pnp,
        _ => BjtType::Npn,
    };
    Ok(BjtModel {
        kind,
        is: e.mparam("is", d.is)?,
        bf: e.mparam("bf", d.bf)?,
        nf: e.mparam("nf", d.nf)?,
        vaf: e.mparam("vaf", e.mparam("va", d.vaf)?)?,
        ikf: e.mparam("ikf", d.ikf)?,
        ise: e.mparam("ise", d.ise)?,
        ne: e.mparam("ne", d.ne)?,
        br: e.mparam("br", d.br)?,
        nr: e.mparam("nr", d.nr)?,
        var: e.mparam("var", e.mparam("vb", d.var)?)?,
        ikr: e.mparam("ikr", d.ikr)?,
        isc: e.mparam("isc", d.isc)?,
        nc: e.mparam("nc", d.nc)?,
        rb: e.mparam("rb", d.rb)?,
        re: e.mparam("re", d.re)?,
        rc: e.mparam("rc", d.rc)?,
        cje: e.mparam("cje", d.cje)?,
        vje: e.mparam("vje", d.vje)?,
        mje: e.mparam("mje", d.mje)?,
        cjc: e.mparam("cjc", d.cjc)?,
        vjc: e.mparam("vjc", d.vjc)?,
        mjc: e.mparam("mjc", d.mjc)?,
        xcjc: e.mparam("xcjc", d.xcjc)?,
        tf: e.mparam("tf", d.tf)?,
        tr: e.mparam("tr", d.tr)?,
        fc: e.mparam("fc", d.fc)?,
        eg: e.mparam("eg", d.eg)?,
        xti: e.mparam("xti", d.xti)?,
        xtb: e.mparam("xtb", d.xtb)?,
        area: e.param("area", d.area)?,
        kf: e.mparam("kf", d.kf)?,
        af: e.mparam("af", d.af)?,
    })
}

const MOS_PARAMS: &[&str] = &[
    "nsub", "xj", "ld", "uo", "vmax", "theta", "eta", "kappa", "delta", "nfs",
    "level", "vto", "vt0", "kp", "gamma", "phi", "lambda", "rd", "rs", "is",
    "js", "cbd", "cbs", "pb", "cgso", "cgdo", "cgbo", "cj", "mj", "cjsw",
    "mjsw", "fc", "tox", "l", "w", "ad", "as", "pd", "ps", "nrd", "nrs",
    "rsh", "kf", "af",
];

fn mos_model(e: &FlatElement) -> Result<MosModel, ParseError> {
    check_model_kind(e, &["nmos", "pmos"])?;
    check_unresolved(e, MOS_PARAMS)?;
    let d = MosModel::default();
    // See `bjt_model`: the `_` arm is only safe after `check_model_kind`.
    let kind = match e.model.as_ref().map(|m| m.kind.as_str()) {
        Some("pmos") => MosType::Pmos,
        _ => MosType::Nmos,
    };

    // Refuse a MOSFET model this core cannot actually evaluate.
    //
    // LEVEL 1 (Shichman-Hodges) and LEVEL 3 (semi-empirical short-channel) are
    // implemented. Anything else — LEVEL 2, or the BSIM family at 8/49/54 — has
    // parameters that are NOT interchangeable: reading VTO and KP out of a BSIM
    // card and applying Shichman-Hodges produces a working-looking simulation
    // of a device that does not exist. That is the project's characteristic
    // failure mode, so it is refused loudly instead.
    let level = e.mparam("level", 1.0)?;
    if level != 1.0 && level != 3.0 {
        return err_kind(
            e.line,
            format!(
                "{}: MOSFET model '{}' is LEVEL {}; only LEVEL 1 \
                 (Shichman-Hodges) and LEVEL 3 (semi-empirical short-channel) \
                 are implemented. Its parameters are not interchangeable with \
                 those, so loading it would silently simulate a different \
                 device.",
                e.name,
                e.model.as_ref().map(|m| m.name.as_str()).unwrap_or("?"),
                level as i64,
            ),
            ErrorKind::Unsupported,
        );
    }
    Ok(MosModel {
        kind,
        level: level as u32,
        nsub: e.mparam("nsub", d.nsub)?,
        xj: e.mparam("xj", d.xj)?,
        ld: e.mparam("ld", d.ld)?,
        uo: e.mparam("uo", d.uo)?,
        vmax: e.mparam("vmax", d.vmax)?,
        theta: e.mparam("theta", d.theta)?,
        eta: e.mparam("eta", d.eta)?,
        kappa: e.mparam("kappa", d.kappa)?,
        delta: e.mparam("delta", d.delta)?,
        nfs: e.mparam("nfs", d.nfs)?,
        vto: e.mparam("vto", e.mparam("vt0", d.vto)?)?,
        kp: e.mparam("kp", d.kp)?,
        gamma: e.mparam("gamma", d.gamma)?,
        phi: e.mparam("phi", d.phi)?,
        lambda: e.mparam("lambda", d.lambda)?,
        rd: e.mparam("rd", d.rd)?,
        rs: e.mparam("rs", d.rs)?,
        is: e.mparam("is", d.is)?,
        js: e.mparam("js", d.js)?,
        cbd: e.mparam("cbd", d.cbd)?,
        cbs: e.mparam("cbs", d.cbs)?,
        pb: e.mparam("pb", d.pb)?,
        cgso: e.mparam("cgso", d.cgso)?,
        cgdo: e.mparam("cgdo", d.cgdo)?,
        cgbo: e.mparam("cgbo", d.cgbo)?,
        cj: e.mparam("cj", d.cj)?,
        mj: e.mparam("mj", d.mj)?,
        cjsw: e.mparam("cjsw", d.cjsw)?,
        mjsw: e.mparam("mjsw", d.mjsw)?,
        fc: e.mparam("fc", d.fc)?,
        tox: e.mparam("tox", d.tox)?,
        // Geometry is normally an instance parameter, but a model may set a
        // default; `mparam` already gives the instance priority.
        l: e.mparam("l", d.l)?,
        w: e.mparam("w", d.w)?,
        ad: e.mparam("ad", d.ad)?,
        as_: e.mparam("as", d.as_)?,
        pd: e.mparam("pd", d.pd)?,
        ps: e.mparam("ps", d.ps)?,
        nrd: e.mparam("nrd", d.nrd)?,
        nrs: e.mparam("nrs", d.nrs)?,
        rsh: e.mparam("rsh", d.rsh)?,
        kf: e.mparam("kf", d.kf)?,
        af: e.mparam("af", d.af)?,
    })
}

/// Build a [`Circuit`] from a parsed netlist.
pub fn build(nl: &Netlist) -> Result<Circuit, ParseError> {
    let flat = flatten(nl)?;
    let mut c = Circuit::new(if nl.title.is_empty() {
        "netlist"
    } else {
        &nl.title
    });

    // `.options` that map onto solver settings.
    let opt = |k: &str| nl.options.get(k).and_then(|v| parse_number(v));
    if let Some(v) = opt("gmin") {
        c.options.gmin = v;
    }
    if let Some(v) = opt("reltol") {
        c.options.reltol = v;
    }
    if let Some(v) = opt("abstol") {
        c.options.abstol = v;
    }
    if let Some(v) = opt("vntol") {
        c.options.vntol = v;
    }
    if let Some(v) = opt("chgtol") {
        c.options.chgtol = v;
    }
    if let Some(v) = opt("trtol") {
        c.options.trtol = v;
    }
    if let Some(v) = opt("temp") {
        // .options temp is in Celsius.
        c.options.temp = v + 273.15;
    }
    if let Some(m) = nl.options.get("method").and_then(|s| Method::parse(&s.to_lowercase())) {
        c.options.method = m;
    }

    let mut index: HashMap<String, usize> = HashMap::new();
    // Pass 1: everything that does not reference another device by name.
    let mut deferred: Vec<&FlatElement> = Vec::new();

    for e in &flat {
        let n: Vec<i32> = e.nodes.iter().map(|s| c.node(s)).collect();
        let dev = match e.letter {
            'r' => {
                // `R3 4 0 rmodel1 L=11u W=2u` is a SEMICONDUCTOR resistor: its
                // value comes from a `.model ... R` card and its geometry,
                // not from a number. Not implemented — but ordinary SPICE, so
                // it is unsupported rather than a broken netlist. Without this
                // the bare model name was parsed as an expression and reported
                // as an undefined parameter, which blames the wrong thing and
                // blocks the fallback engine that does implement it.
                if e.model.is_some() {
                    return err_kind(
                        e.line,
                        format!(
                            "{}: semiconductor resistors (a resistor taking its \
                             value from a .model card) are not implemented",
                            e.name
                        ),
                        ErrorKind::Unsupported,
                    );
                }
                let mut r = Resistor::new(&e.name, n[0], n[1], e.value("r")?);
                r.tc1 = e.param("tc1", 0.0)?;
                r.tc2 = e.param("tc2", 0.0)?;
                DeviceKind::Resistor(r)
            }
            'c' => {
                let mut cap = Capacitor::new(&e.name, n[0], n[1], e.value("c")?);
                cap.ic = e.param_opt("ic")?;
                DeviceKind::Capacitor(cap)
            }
            'l' => {
                let mut l = Inductor::new(&e.name, n[0], n[1], e.value("l")?);
                l.ic = e.param_opt("ic")?;
                DeviceKind::Inductor(l)
            }
            'v' => {
                let (dc, ac, tran) = source_spec(e)?;
                let mut v = VoltageSource::new(&e.name, n[0], n[1], dc);
                if let Some((mag, ph)) = ac {
                    v = v.with_ac(mag, ph);
                }
                if let Some(w) = tran {
                    v = v.with_tran(w);
                }
                DeviceKind::VoltageSource(v)
            }
            'i' => {
                let (dc, ac, tran) = source_spec(e)?;
                let mut i = CurrentSource::new(&e.name, n[0], n[1], dc);
                if let Some((mag, ph)) = ac {
                    i = i.with_ac(mag, ph);
                }
                if let Some(w) = tran {
                    i = i.with_tran(w);
                }
                DeviceKind::CurrentSource(i)
            }
            // PSpice-family BEHAVIOURAL sources: `E1 out 0 VALUE {expr}`, plus
            // TABLE, LAPLACE, FREQ and POLY. They take two nodes and an
            // expression where a plain VCVS takes four nodes and a gain, and
            // vendor macromodels use them constantly — 70+ files in one library.
            //
            // The keyword is checked across NODES as well as arguments because
            // a four-node device swallows `VALUE` as its third node long before
            // the argument list is read; looking only at args never matched.
            //
            // Unsupported, not invalid: this is ordinary SPICE, and misfiling
            // it both blamed the vendor's file and stopped it routing to an
            // engine that implements it.
            'e' | 'g' if e.nodes.iter().chain(e.args.iter()).any(|a| {
                let t = a.to_lowercase();
                // Both spellings occur, and `pair_up` glues the second into one
                // token: `VALUE {expr}` stays two, `value={expr}` becomes one.
                // Matching only the bare word missed 50+ real vendor files.
                ["value", "table", "laplace", "freq", "poly"]
                    .iter()
                    .any(|k| t == *k || t.starts_with(&format!("{k}=")))
            }) =>
            {
                return err_kind(
                    e.line,
                    format!("{}: behavioural sources are not implemented", e.name),
                    ErrorKind::Unsupported,
                )
            }
            'e' => DeviceKind::Vcvs(Vcvs::new(&e.name, n[0], n[1], n[2], n[3], e.arg(0)?)),
            'g' => DeviceKind::Vccs(Vccs::new(&e.name, n[0], n[1], n[2], n[3], e.arg(0)?)),
            'd' => DeviceKind::Diode(Diode::new(&e.name, n[0], n[1], diode_model(e)?)),
            'q' => {
                let sub = if n.len() > 3 { n[3] } else { -1 };
                DeviceKind::Bjt(Bjt::new(&e.name, n[0], n[1], n[2], sub, bjt_model(e)?))
            }
            'm' => DeviceKind::Mosfet(Mosfet::new(
                &e.name,
                n[0],
                n[1],
                n[2],
                n[3],
                mos_model(e)?,
            )),
            's' => {
                // A `VSWITCH` card is the PSpice spelling and is NOT this
                // device: it states its thresholds as VON/VOFF where SW states
                // VT/VH, so reading one here would take vt=vh=0 from the
                // defaults and switch at 0 V instead of wherever the card says.
                // There are 3,311 of them in the KiCad Spice Library alone.
                check_model_kind(e, &["sw"])?;
                let m = e.model.as_ref();
                DeviceKind::VSwitch(VSwitch::new(
                    &e.name,
                    n[0],
                    n[1],
                    n[2],
                    n[3],
                    SwitchModel {
                        vt: m.map(|m| m.get("vt", 0.0)).unwrap_or(0.0),
                        vh: m.map(|m| m.get("vh", 0.0)).unwrap_or(0.0),
                        ron: m.map(|m| m.get("ron", 1.0)).unwrap_or(1.0),
                        roff: m.map(|m| m.get("roff", 1e12)).unwrap_or(1e12),
                    },
                ))
            }
            'k' | 'f' | 'h' => {
                deferred.push(e);
                continue;
            }
            other => {
                return err_kind(
                    e.line,
                    format!("unsupported element '{other}'"),
                    ErrorKind::Unsupported,
                );
            }
        };
        let idx = c.add(dev);
        index.insert(e.name.to_lowercase(), idx);
    }

    // Pass 2: elements that reference another device by name, now that every
    // name exists.
    for e in deferred {
        match e.letter {
            'k' => {
                let (a, b) = (
                    e.args
                        .first()
                        .ok_or_else(|| ParseError {
                            line: e.line,
                            message: format!("{}: K needs two inductor names", e.name),
                kind: ErrorKind::Invalid,
            })?
                        .to_lowercase(),
                    e.args
                        .get(1)
                        .ok_or_else(|| ParseError {
                            line: e.line,
                            message: format!("{}: K needs two inductor names", e.name),
                kind: ErrorKind::Invalid,
            })?
                        .to_lowercase(),
                );
                let ia = *index.get(&a).ok_or_else(|| ParseError {
                    line: e.line,
                    message: format!("{}: unknown inductor '{a}'", e.name),
                kind: ErrorKind::Invalid,
            })?;
                let ib = *index.get(&b).ok_or_else(|| ParseError {
                    line: e.line,
                    message: format!("{}: unknown inductor '{b}'", e.name),
                kind: ErrorKind::Invalid,
            })?;
                let k = e.arg(2)?;
                c.couple(ia, ib, k).map_err(|err| ParseError {
                    line: e.line,
                    message: format!("{}: {err}", e.name),
                kind: ErrorKind::Invalid,
            })?;
            }
            'f' | 'h' => {
                let n: Vec<i32> = e.nodes.iter().map(|s| c.node(s)).collect();
                let ctrl_name = e.args.first().ok_or_else(|| ParseError {
                    line: e.line,
                    message: format!("{}: missing controlling source", e.name),
                kind: ErrorKind::Invalid,
            })?;
                let ctrl = *index.get(&ctrl_name.to_lowercase()).ok_or_else(|| {
                    // POLY(n) is the polynomial form of a controlled source.
                    // It is ordinary SPICE, widely used in vendor op-amp
                    // macromodels, and simply not implemented here — so it is
                    // UNSUPPORTED, not a broken netlist. Getting that wrong
                    // stopped engine selection and reported a valid deck as
                    // malformed instead of routing it to a bigger engine.
                    let poly = ctrl_name.to_uppercase().contains("POLY");
                    ParseError {
                        line: e.line,
                        message: if poly {
                            format!(
                                "{}: POLY() polynomial controlled sources are not \
                                 implemented",
                                e.name
                            )
                        } else {
                            format!("{}: unknown controlling source '{ctrl_name}'", e.name)
                        },
                        kind: if poly { ErrorKind::Unsupported } else { ErrorKind::Invalid },
                    }
                })?;
                let gain = e.arg(1)?;
                let dev = if e.letter == 'f' {
                    DeviceKind::Cccs(Cccs::new(&e.name, n[0], n[1], ctrl, gain))
                } else {
                    DeviceKind::Ccvs(Ccvs::new(&e.name, n[0], n[1], ctrl, gain))
                };
                let idx = c.add(dev);
                index.insert(e.name.to_lowercase(), idx);
            }
            _ => unreachable!(),
        }
    }

    Ok(c)
}

/// Translate a parsed `.tran` card into runnable options.
pub fn tran_options(a: &Analysis) -> Option<TranOptions> {
    match a {
        Analysis::Tran {
            tstep,
            tstop,
            tstart,
            tmax,
            uic,
        } => {
            let mut o = TranOptions::new(parse_number(tstop)?, parse_number(tstep)?);
            o.tstart = tstart.as_deref().and_then(parse_number).unwrap_or(0.0);
            o.tmax = tmax.as_deref().and_then(parse_number);
            o.uic = *uic;
            Some(o)
        }
        _ => None,
    }
}

/// Translate a parsed `.ac` card into a sweep spec.
pub fn ac_spec(a: &Analysis) -> Option<AcSpec> {
    match a {
        Analysis::Ac {
            scale,
            points,
            start,
            stop,
        } => Some(AcSpec {
            scale: match scale.as_str() {
                "oct" => AcScale::Oct,
                "lin" => AcScale::Lin,
                _ => AcScale::Dec,
            },
            points: parse_number(points)? as usize,
            start: parse_number(start)?,
            stop: parse_number(stop)?,
        }),
        _ => None,
    }
}

/// Translate a parsed `.dc` card into a sweep spec.
pub fn dc_spec(a: &Analysis) -> Option<SweepSpec> {
    match a {
        Analysis::Dc {
            source,
            start,
            stop,
            step,
        } => Some(SweepSpec {
            device: source.clone(),
            property: SweepProperty::Dc,
            start: parse_number(start)?,
            stop: parse_number(stop)?,
            step: parse_number(step)?,
        }),
        _ => None,
    }
}
