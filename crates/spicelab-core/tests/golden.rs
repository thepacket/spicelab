//! Differential test against the JS oracle.
//!
//! Builds the circuits declared in `tests/fixtures/golden.json` and asserts the
//! Rust core reproduces the oracle's reference values inside each fixture's
//! stated tolerance. This is the contract between the two implementations.
//!
//! Regenerate the fixtures ONLY when the JS oracle changes and
//! `node tests/analytic.test.mjs` is green. A fixture regenerated from a broken
//! oracle silently blesses the breakage.

use serde_json::Value;
use spicelab_core::analyses::dc::{ac_sweep, op, AcScale, AcSpec};
use spicelab_core::analyses::tran::{tran, TranOptions};
use spicelab_core::circuit::Circuit;
use spicelab_core::context::Method;
use spicelab_core::device::DeviceKind;
use spicelab_core::devices::mosfet::{MosModel, MosType, Mosfet};
use spicelab_core::devices::primitives::{Capacitor, Inductor, Resistor};
use spicelab_core::devices::semiconductors::{Bjt, BjtModel, BjtType, Diode, DiodeModel};
use spicelab_core::devices::sources::{VoltageSource, Waveform};

const FIXTURES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/fixtures/golden.json"
);

fn f(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(|x| x.as_f64())
}

fn fd(v: &Value, key: &str, default: f64) -> f64 {
    f(v, key).unwrap_or(default)
}

fn waveform(w: &Value) -> Waveform {
    match w.get("type").and_then(|x| x.as_str()).unwrap_or("dc") {
        "dc" => Waveform::Dc {
            v0: fd(w, "v0", 0.0),
        },
        "sin" => Waveform::Sin {
            vo: fd(w, "vo", 0.0),
            va: fd(w, "va", 0.0),
            freq: f(w, "freq"),
            td: fd(w, "td", 0.0),
            theta: fd(w, "theta", 0.0),
            phase: fd(w, "phase", 0.0),
        },
        "pulse" => Waveform::Pulse {
            v1: fd(w, "v1", 0.0),
            v2: fd(w, "v2", 1.0),
            td: fd(w, "td", 0.0),
            tr: f(w, "tr"),
            tf: f(w, "tf"),
            pw: f(w, "pw"),
            per: f(w, "per"),
        },
        "pwl" => Waveform::Pwl {
            points: w
                .get("points")
                .and_then(|p| p.as_array())
                .map(|a| {
                    a.iter()
                        .map(|p| {
                            let p = p.as_array().unwrap();
                            (p[0].as_f64().unwrap(), p[1].as_f64().unwrap())
                        })
                        .collect()
                })
                .unwrap_or_default(),
            repeat: w
                .get("repeat")
                .and_then(|x| x.as_bool())
                .unwrap_or(false),
            period: fd(w, "period", 0.0),
        },
        "exp" => Waveform::Exp {
            v1: fd(w, "v1", 0.0),
            v2: fd(w, "v2", 1.0),
            td1: fd(w, "td1", 0.0),
            tau1: f(w, "tau1"),
            td2: f(w, "td2"),
            tau2: f(w, "tau2"),
        },
        "sffm" => Waveform::Sffm {
            vo: fd(w, "vo", 0.0),
            va: fd(w, "va", 1.0),
            fc: f(w, "fc"),
            mdi: fd(w, "mdi", 0.0),
            fs: f(w, "fs"),
        },
        "am" => Waveform::Am {
            va: fd(w, "va", 1.0),
            vo: fd(w, "vo", 0.0),
            mf: fd(w, "mf", 1.0),
            fc: f(w, "fc"),
            td: fd(w, "td", 0.0),
        },
        other => panic!("unknown waveform type {other}"),
    }
}

fn diode_model(m: &Value) -> DiodeModel {
    let d = DiodeModel::default();
    DiodeModel {
        is: fd(m, "is", d.is),
        n: fd(m, "n", d.n),
        rs: fd(m, "rs", d.rs),
        cjo: fd(m, "cjo", d.cjo),
        vj: fd(m, "vj", d.vj),
        m: fd(m, "m", d.m),
        tt: fd(m, "tt", d.tt),
        bv: fd(m, "bv", d.bv),
        ibv: fd(m, "ibv", d.ibv),
        eg: fd(m, "eg", d.eg),
        xti: fd(m, "xti", d.xti),
        fc: fd(m, "fc", d.fc),
        kf: fd(m, "kf", d.kf),
        af: fd(m, "af", d.af),
        area: fd(m, "area", d.area),
    }
}

fn bjt_model(m: &Value) -> BjtModel {
    let d = BjtModel::default();
    BjtModel {
        kind: match m.get("type").and_then(|x| x.as_str()) {
            Some("pnp") => BjtType::Pnp,
            _ => BjtType::Npn,
        },
        is: fd(m, "is", d.is),
        bf: fd(m, "bf", d.bf),
        nf: fd(m, "nf", d.nf),
        vaf: fd(m, "vaf", d.vaf),
        ikf: fd(m, "ikf", d.ikf),
        ise: fd(m, "ise", d.ise),
        ne: fd(m, "ne", d.ne),
        br: fd(m, "br", d.br),
        nr: fd(m, "nr", d.nr),
        var: fd(m, "var", d.var),
        ikr: fd(m, "ikr", d.ikr),
        isc: fd(m, "isc", d.isc),
        nc: fd(m, "nc", d.nc),
        rb: fd(m, "rb", d.rb),
        re: fd(m, "re", d.re),
        rc: fd(m, "rc", d.rc),
        cje: fd(m, "cje", d.cje),
        vje: fd(m, "vje", d.vje),
        mje: fd(m, "mje", d.mje),
        cjc: fd(m, "cjc", d.cjc),
        vjc: fd(m, "vjc", d.vjc),
        mjc: fd(m, "mjc", d.mjc),
        xcjc: fd(m, "xcjc", d.xcjc),
        tf: fd(m, "tf", d.tf),
        tr: fd(m, "tr", d.tr),
        fc: fd(m, "fc", d.fc),
        eg: fd(m, "eg", d.eg),
        xti: fd(m, "xti", d.xti),
        xtb: fd(m, "xtb", d.xtb),
        area: fd(m, "area", d.area),
        kf: fd(m, "kf", d.kf),
        af: fd(m, "af", d.af),
    }
}

/// Model and instance parameters are merged, matching the JS
/// `{...defaults, ...model, ...inst}`.
fn mos_model(model: &Value, inst: &Value) -> MosModel {
    let d = MosModel::default();
    let g = |k: &str, dv: f64| f(inst, k).or_else(|| f(model, k)).unwrap_or(dv);
    MosModel {
        kind: match model.get("type").and_then(|x| x.as_str()) {
            Some("pmos") => MosType::Pmos,
            _ => MosType::Nmos,
        },
        vto: g("vto", d.vto),
        kp: g("kp", d.kp),
        gamma: g("gamma", d.gamma),
        phi: g("phi", d.phi),
        lambda: g("lambda", d.lambda),
        rd: g("rd", d.rd),
        rs: g("rs", d.rs),
        is: g("is", d.is),
        js: g("js", d.js),
        cbd: g("cbd", d.cbd),
        cbs: g("cbs", d.cbs),
        pb: g("pb", d.pb),
        cgso: g("cgso", d.cgso),
        cgdo: g("cgdo", d.cgdo),
        cgbo: g("cgbo", d.cgbo),
        cj: g("cj", d.cj),
        mj: g("mj", d.mj),
        cjsw: g("cjsw", d.cjsw),
        mjsw: g("mjsw", d.mjsw),
        fc: g("fc", d.fc),
        tox: g("tox", d.tox),
        l: g("l", d.l),
        w: g("w", d.w),
        ad: g("ad", d.ad),
        as_: g("as", d.as_),
        pd: g("pd", d.pd),
        ps: g("ps", d.ps),
        nrd: g("nrd", d.nrd),
        nrs: g("nrs", d.nrs),
        rsh: g("rsh", d.rsh),
        kf: g("kf", d.kf),
        af: g("af", d.af),
        // Level 3 parameters; the fixtures are all Level 1, so the defaults
        // apply unless a card names them.
        level: g("level", 1.0) as u32,
        nsub: g("nsub", d.nsub),
        xj: g("xj", d.xj),
        ld: g("ld", d.ld),
        uo: g("uo", d.uo),
        vmax: g("vmax", d.vmax),
        theta: g("theta", d.theta),
        eta: g("eta", d.eta),
        kappa: g("kappa", d.kappa),
        delta: g("delta", d.delta),
        nfs: g("nfs", d.nfs),
    }
}

/// Build a circuit from a declarative spec. Mirrors `build()` in
/// `tests/make-fixtures.mjs`.
fn build(spec: &Value) -> Circuit {
    let mut c = Circuit::new(spec["name"].as_str().unwrap_or("circuit"));
    if let Some(o) = spec.get("options") {
        if let Some(m) = o.get("method").and_then(|x| x.as_str()) {
            c.options.method = Method::parse(m).expect("unknown method");
        }
    }
    let empty = Value::Object(Default::default());

    for d in spec["devices"].as_array().unwrap() {
        let name = d["name"].as_str().unwrap();
        let nodes: Vec<&str> = d["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n.as_str().unwrap())
            .collect();
        let n: Vec<i32> = nodes.iter().map(|s| c.node(s)).collect();
        let kind = d["kind"].as_str().unwrap();

        match kind {
            "R" => {
                c.add(DeviceKind::Resistor(Resistor::new(
                    name,
                    n[0],
                    n[1],
                    d["value"].as_f64().unwrap(),
                )));
            }
            "C" => {
                let mut cap = Capacitor::new(name, n[0], n[1], d["value"].as_f64().unwrap());
                cap.ic = f(d, "ic");
                c.add(DeviceKind::Capacitor(cap));
            }
            "L" => {
                let mut l = Inductor::new(name, n[0], n[1], d["value"].as_f64().unwrap());
                l.ic = f(d, "ic");
                c.add(DeviceKind::Inductor(l));
            }
            "V" => {
                let spec = d.get("spec").unwrap_or(&empty);
                let mut v = VoltageSource::new(name, n[0], n[1], fd(spec, "dc", 0.0));
                if let Some(ac) = spec.get("ac") {
                    v = v.with_ac(fd(ac, "mag", 0.0), fd(ac, "phase", 0.0));
                }
                if let Some(t) = spec.get("tran") {
                    v = v.with_tran(waveform(t));
                }
                c.add(DeviceKind::VoltageSource(v));
            }
            "D" => {
                c.add(DeviceKind::Diode(Diode::new(
                    name,
                    n[0],
                    n[1],
                    diode_model(d.get("model").unwrap_or(&empty)),
                )));
            }
            "Q" => {
                let sub = if n.len() > 3 { n[3] } else { -1 };
                c.add(DeviceKind::Bjt(Bjt::new(
                    name,
                    n[0],
                    n[1],
                    n[2],
                    sub,
                    bjt_model(d.get("model").unwrap_or(&empty)),
                )));
            }
            "M" => {
                c.add(DeviceKind::Mosfet(Mosfet::new(
                    name,
                    n[0],
                    n[1],
                    n[2],
                    n[3],
                    mos_model(
                        d.get("model").unwrap_or(&empty),
                        d.get("inst").unwrap_or(&empty),
                    ),
                )));
            }
            other => panic!("unknown device kind {other}"),
        }
    }
    c
}

/// Absolute agreement, with a relative allowance on large values so a fixture
/// tolerance stated for order-1 node voltages does not become unreasonably
/// strict on a resonant peak.
fn close(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() <= tol * b.abs().max(1.0)
}

fn nearest(times: &[f64], t: f64) -> usize {
    let mut best = 0;
    for j in 0..times.len() {
        if (times[j] - t).abs() < (times[best] - t).abs() {
            best = j;
        }
    }
    best
}

#[test]
fn golden_fixtures_match_js_oracle() {
    let raw = std::fs::read_to_string(FIXTURES).expect("read golden.json");
    let root: Value = serde_json::from_str(&raw).expect("parse golden.json");
    let fixtures = root["fixtures"].as_array().expect("fixtures array");

    let mut failures: Vec<String> = Vec::new();
    let mut checks = 0usize;

    for fx in fixtures {
        let name = fx["name"].as_str().unwrap();
        let analysis = fx["analysis"].as_str().unwrap();
        let tol = fx["tolerance"].as_f64().unwrap();
        let mut c = build(&fx["circuit"]);

        match analysis {
            "op" => {
                op(&mut c).unwrap_or_else(|e| panic!("{name}: op failed: {e}"));
                for (probe, want) in fx["expect"].as_object().unwrap() {
                    let got = c.voltage(probe).unwrap();
                    let want = want.as_f64().unwrap();
                    checks += 1;
                    if !close(got, want, tol) {
                        failures.push(format!(
                            "{name}: V({probe}) = {got:.12e}, expected {want:.12e} (tol {tol:.1e})"
                        ));
                    }
                }
            }

            "tran" => {
                let run = &fx["run"];
                let mut o = TranOptions::new(
                    run["tstop"].as_f64().unwrap(),
                    run["tstep"].as_f64().unwrap(),
                );
                o.tmax = f(run, "tmax");
                o.uic = run.get("uic").and_then(|x| x.as_bool()).unwrap_or(false);
                o.method = run
                    .get("method")
                    .and_then(|x| x.as_str())
                    .and_then(Method::parse);

                let r = tran(&mut c, &o).unwrap_or_else(|e| panic!("{name}: tran failed: {e}"));
                for pt in fx["expect"].as_array().unwrap() {
                    let t = pt["t"].as_f64().unwrap();
                    let j = nearest(&r.time, t);
                    for (probe, want) in pt["v"].as_object().unwrap() {
                        let idx = c.index_of(probe).unwrap() as usize;
                        let got = r.data[j][idx];
                        let want = want.as_f64().unwrap();
                        checks += 1;
                        if !close(got, want, tol) {
                            failures.push(format!(
                                "{name}: V({probe}) @ t={t:.4e} = {got:.9e}, expected \
                                 {want:.9e} (tol {tol:.1e}, matched t={:.4e})",
                                r.time[j]
                            ));
                        }
                    }
                }
            }

            "ac" => {
                let sw = &fx["sweep"];
                let spec = AcSpec {
                    scale: match sw["type"].as_str().unwrap() {
                        "dec" => AcScale::Dec,
                        "oct" => AcScale::Oct,
                        _ => AcScale::Lin,
                    },
                    points: sw["points"].as_u64().unwrap() as usize,
                    start: sw["start"].as_f64().unwrap(),
                    stop: sw["stop"].as_f64().unwrap(),
                };
                let probe = fx["probe"].as_str().unwrap();
                let r =
                    ac_sweep(&mut c, &spec).unwrap_or_else(|e| panic!("{name}: ac failed: {e}"));
                let idx = c.index_of(probe).unwrap() as usize;
                for pt in fx["expect"].as_array().unwrap() {
                    let want_f = pt["f"].as_f64().unwrap();
                    let k = nearest(&r.freq, want_f);
                    assert!(
                        (r.freq[k] - want_f).abs() <= 1e-6 * want_f,
                        "{name}: frequency grid diverged: got {:.9e}, expected {want_f:.9e}",
                        r.freq[k]
                    );
                    for (label, got, want) in [
                        ("re", r.re[k][idx], pt["re"].as_f64().unwrap()),
                        ("im", r.im[k][idx], pt["im"].as_f64().unwrap()),
                    ] {
                        checks += 1;
                        if !close(got, want, tol) {
                            failures.push(format!(
                                "{name}: {label}(V({probe})) @ f={want_f:.4e} = {got:.9e}, \
                                 expected {want:.9e} (tol {tol:.1e})"
                            ));
                        }
                    }
                }
            }

            other => panic!("unknown analysis {other}"),
        }
    }

    if !failures.is_empty() {
        panic!(
            "{} of {checks} golden checks failed:\n  {}",
            failures.len(),
            failures.join("\n  ")
        );
    }
    println!("{checks} golden checks passed across {} fixtures", fixtures.len());
}
