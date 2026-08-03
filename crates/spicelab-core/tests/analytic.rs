//! Analytic validation suite.
//!
//! Every case here has a closed-form answer. This is the layer that catches the
//! silent numerical bugs — a sign error in one Jacobian entry produces waveforms
//! that look entirely plausible and are wrong, so plausibility is not a test.
//!
//! The first section ports the 27 checks from `tests/analytic.test.mjs`. The
//! second covers the paths CLAUDE.md lists as having NO coverage in either
//! implementation:
//!
//!   * coupled-inductor transient
//!   * the waveform types other than `pulse`
//!   * semiconductor transient charge paths
//!
//! The technique for the last two is to pick model parameters that collapse a
//! nonlinear element onto an exactly solvable one — a diode with `m = 0` has
//! junction charge `q = cjo * v`, i.e. a perfectly linear capacitor, so its
//! transient charge path can be checked against a textbook RC step. That
//! exercises the real `load_tran` → `integrate` → stamp plumbing while keeping
//! a closed form to compare against.

use spicelab_core::analyses::dc::{
    ac_sweep, bode, dc_sweep, op, AcScale, AcSpec, SweepProperty, SweepSpec,
};
use spicelab_core::analyses::tran::{tran, TranOptions, TransientRun};
use spicelab_core::circuit::Circuit;
use spicelab_core::context::Method;
use spicelab_core::device::DeviceKind;
use spicelab_core::devices::mosfet::{MosModel, Mosfet};
use spicelab_core::devices::primitives::{
    Capacitor, Cccs, Ccvs, Inductor, Resistor, SwitchModel, VSwitch, Vccs, Vcvs,
};
use spicelab_core::devices::semiconductors::{Bjt, BjtModel, Diode, DiodeModel};
use spicelab_core::devices::sources::{CurrentSource, VoltageSource, Waveform};
use std::f64::consts::PI;

/// Matches the JS harness: passes on absolute OR relative tolerance.
#[track_caller]
fn check(name: &str, actual: f64, expected: f64, tol: f64) {
    let err = (actual - expected).abs();
    let rel = if expected.abs() > 1e-12 {
        err / expected.abs()
    } else {
        err
    };
    assert!(
        err <= tol || rel <= tol,
        "{name}: got {actual:.6e}, expected {expected:.6e} (tol {tol:.1e})"
    );
}

fn step_1v() -> Waveform {
    Waveform::Pulse {
        v1: 0.0,
        v2: 1.0,
        td: 0.0,
        tr: Some(1e-12),
        tf: Some(1e-12),
        pw: Some(1.0),
        per: Some(0.0),
    }
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

fn branch_of(c: &Circuit, name: &str) -> usize {
    c.devices[c.device_index(name).unwrap()].branches()[0]
}

// ============================================================ ported cases

#[test]
fn resistive_divider_kirchhoff() {
    let mut c = Circuit::new("divider");
    let (vin, mid) = (c.node("in"), c.node("mid"));
    c.add(DeviceKind::VoltageSource(VoltageSource::new(
        "V1", vin, -1, 10.0,
    )));
    c.add(DeviceKind::Resistor(Resistor::new("R1", vin, mid, 1000.0)));
    c.add(DeviceKind::Resistor(Resistor::new("R2", mid, -1, 3000.0)));
    op(&mut c).unwrap();
    check("V(mid) = 10 * 3k/4k", c.voltage("mid").unwrap(), 7.5, 1e-9);
    check("I(V1) = -2.5 mA", c.current("V1").unwrap(), -2.5e-3, 1e-9);
}

#[test]
fn current_source_ohm() {
    let mut c = Circuit::new("isrc");
    let a = c.node("a");
    c.add(DeviceKind::CurrentSource(CurrentSource::new(
        "I1", -1, a, 1e-3,
    )));
    c.add(DeviceKind::Resistor(Resistor::new("R1", a, -1, 2200.0)));
    op(&mut c).unwrap();
    check("V(a) = 1mA * 2.2k", c.voltage("a").unwrap(), 2.2, 1e-9);
}

#[test]
fn controlled_sources() {
    // VCVS. This is also the circuit that a diagonal-restricted Markowitz
    // search declares singular; see sparse.rs.
    let mut c = Circuit::new("vcvs");
    let (i, o) = (c.node("in"), c.node("out"));
    c.add(DeviceKind::VoltageSource(VoltageSource::new("V1", i, -1, 2.0)));
    c.add(DeviceKind::Vcvs(Vcvs::new("E1", o, -1, i, -1, 5.0)));
    c.add(DeviceKind::Resistor(Resistor::new("RL", o, -1, 1000.0)));
    op(&mut c).unwrap();
    check("VCVS gain 5", c.voltage("out").unwrap(), 10.0, 1e-9);

    let mut c = Circuit::new("vccs");
    let (i, o) = (c.node("in"), c.node("out"));
    c.add(DeviceKind::VoltageSource(VoltageSource::new("V1", i, -1, 2.0)));
    c.add(DeviceKind::Vccs(Vccs::new("G1", o, -1, i, -1, 1e-3)));
    c.add(DeviceKind::Resistor(Resistor::new("RL", o, -1, 1000.0)));
    op(&mut c).unwrap();
    check("VCCS 1mS into 1k", c.voltage("out").unwrap(), -2.0, 1e-9);
}

#[test]
fn rc_step_response_all_methods() {
    let (r, cap) = (1000.0, 1e-6);
    let tau = r * cap;
    for method in [Method::Be, Method::Trap, Method::Gear2] {
        let mut c = Circuit::new("rc");
        c.options.method = method;
        let (vin, out) = (c.node("in"), c.node("out"));
        c.add(DeviceKind::VoltageSource(
            VoltageSource::new("V1", vin, -1, 0.0).with_tran(step_1v()),
        ));
        c.add(DeviceKind::Resistor(Resistor::new("R1", vin, out, r)));
        c.add(DeviceKind::Capacitor(Capacitor::new("C1", out, -1, cap)));

        let mut o = TranOptions::new(5.0 * tau, tau / 100.0);
        o.tmax = Some(tau / 50.0);
        let res = tran(&mut c, &o).unwrap();
        let oi = c.index_of("out").unwrap() as usize;
        for k in [1.0, 3.0] {
            let j = nearest(&res.time, k * tau);
            check(
                &format!("{method:?}: V(out) at {k}tau"),
                res.data[j][oi],
                1.0 - (-k).exp(),
                3e-3,
            );
        }
    }
}

#[test]
fn underdamped_rlc_ringing() {
    let (r, l, cap): (f64, f64, f64) = (20.0, 1e-3, 1e-6);
    let w0 = 1.0 / (l * cap).sqrt();
    let alpha = r / (2.0 * l);
    let wd = (w0 * w0 - alpha * alpha).sqrt();

    let mut c = Circuit::new("rlc");
    c.options.method = Method::Trap;
    let (vin, out) = (c.node("in"), c.node("out"));
    let m = c.node("m");
    c.add(DeviceKind::VoltageSource(
        VoltageSource::new("V1", vin, -1, 0.0).with_tran(step_1v()),
    ));
    c.add(DeviceKind::Resistor(Resistor::new("R1", vin, out, r)));
    c.add(DeviceKind::Inductor(Inductor::new("L1", out, m, l)));
    c.add(DeviceKind::Capacitor(Capacitor::new("C1", m, -1, cap)));

    let period = (2.0 * PI) / wd;
    let mut o = TranOptions::new(3.0 * period, period / 400.0);
    o.tmax = Some(period / 200.0);
    let res = tran(&mut c, &o).unwrap();
    let mi = c.index_of("m").unwrap() as usize;

    let mut peak = 0;
    for j in 1..res.data.len() {
        if res.data[j][mi] > res.data[peak][mi] {
            peak = j;
        }
    }
    check("first peak time = pi/wd", res.time[peak], PI / wd, 0.02);
    let overshoot = 1.0 + ((-alpha * PI) / wd).exp();
    check("first peak value", res.data[peak][mi], overshoot, 0.02);
}

#[test]
fn lc_tank_conserves_energy() {
    // The most load-bearing test in the suite. It catches integration errors
    // immediately and nothing else does — in particular it is the check that
    // fails if the post-convergence charge commit in TransientRun::step is
    // dropped.
    let (l, cap): (f64, f64) = (1e-3, 1e-6);
    let w0 = 1.0 / (l * cap).sqrt();
    let period = (2.0 * PI) / w0;

    let mut c = Circuit::new("lc_tank");
    c.options.method = Method::Trap;
    let a = c.node("a");
    let mut cp = Capacitor::new("C1", a, -1, cap);
    cp.ic = Some(1.0);
    c.add(DeviceKind::Capacitor(cp));
    c.add(DeviceKind::Inductor(Inductor::new("L1", a, -1, l)));
    c.add(DeviceKind::Resistor(Resistor::new("Rleak", a, -1, 1e12)));

    let mut o = TranOptions::new(20.0 * period, period / 200.0);
    o.tmax = Some(period / 100.0);
    o.uic = true;
    o.method = Some(Method::Trap);

    let mut run = TransientRun::new(&c, &o);
    run.begin(&mut c).unwrap();
    run.run_to_completion(&mut c).unwrap();

    let ai = c.index_of("a").unwrap() as usize;
    let bi = branch_of(&c, "L1");
    let last = run.data.len() - 1;
    let energy = |k: usize| {
        0.5 * cap * run.data[k][ai].powi(2) + 0.5 * l * run.data[k][bi].powi(2)
    };
    let e0 = 0.5 * cap * 1.0;
    check("energy after 20 cycles / initial", energy(last) / e0, 1.0, 0.02);
}

#[test]
fn rc_lowpass_ac() {
    let (r, cap) = (1000.0, 1e-7);
    let fc = 1.0 / (2.0 * PI * r * cap);
    let mut c = Circuit::new("rc_ac");
    let (vin, out) = (c.node("in"), c.node("out"));
    c.add(DeviceKind::VoltageSource(
        VoltageSource::new("V1", vin, -1, 0.0).with_ac(1.0, 0.0),
    ));
    c.add(DeviceKind::Resistor(Resistor::new("R1", vin, out, r)));
    c.add(DeviceKind::Capacitor(Capacitor::new("C1", out, -1, cap)));

    let res = ac_sweep(
        &mut c,
        &AcSpec {
            scale: AcScale::Dec,
            points: 50,
            start: fc / 100.0,
            stop: fc * 100.0,
        },
    )
    .unwrap();
    let (mag, phase) = bode(&res, c.index_of("out").unwrap() as usize);
    let mut k = 0;
    for j in 0..res.freq.len() {
        if (res.freq[j] / fc).ln().abs() < (res.freq[k] / fc).ln().abs() {
            k = j;
        }
    }
    check("magnitude at fc = -3.01 dB", mag[k], -3.0103, 0.05);
    check("phase at fc = -45 deg", phase[k], -45.0, 0.5);
    check("magnitude a decade up = -20 dB", mag[k + 50], -20.04, 0.3);
}

#[test]
fn series_rl_ac_corner() {
    let (r, l) = (100.0, 1e-3);
    let fc = r / (2.0 * PI * l);
    let mut c = Circuit::new("rl_ac");
    let (vin, out) = (c.node("in"), c.node("out"));
    c.add(DeviceKind::VoltageSource(
        VoltageSource::new("V1", vin, -1, 0.0).with_ac(1.0, 0.0),
    ));
    c.add(DeviceKind::Inductor(Inductor::new("L1", vin, out, l)));
    c.add(DeviceKind::Resistor(Resistor::new("R1", out, -1, r)));

    let res = ac_sweep(
        &mut c,
        &AcSpec {
            scale: AcScale::Dec,
            points: 40,
            start: fc / 100.0,
            stop: fc * 100.0,
        },
    )
    .unwrap();
    let (mag, _) = bode(&res, c.index_of("out").unwrap() as usize);
    let mut k = 0;
    for j in 0..res.freq.len() {
        if (res.freq[j] / fc).ln().abs() < (res.freq[k] / fc).ln().abs() {
            k = j;
        }
    }
    check("RL magnitude at fc", mag[k], -3.0103, 0.05);
}

#[test]
fn diode_shockley() {
    let (is, n) = (1e-14, 1.0);
    let mut c = Circuit::new("diode");
    let a = c.node("a");
    c.add(DeviceKind::VoltageSource(VoltageSource::new("V1", a, -1, 0.6)));
    c.add(DeviceKind::Diode(Diode::new(
        "D1",
        a,
        -1,
        DiodeModel {
            is,
            n,
            rs: 0.0,
            ..Default::default()
        },
    )));
    op(&mut c).unwrap();
    let vt = c.ctx.vt();
    let expected = is * ((0.6 / (n * vt)).exp() - 1.0);
    check("I(D1) at 0.6 V", -c.current("V1").unwrap(), expected, 1e-3);
}

#[test]
fn diode_series_resistor_consistency() {
    let mut c = Circuit::new("diode_r");
    let (vin, a) = (c.node("in"), c.node("a"));
    c.add(DeviceKind::VoltageSource(VoltageSource::new("V1", vin, -1, 5.0)));
    c.add(DeviceKind::Resistor(Resistor::new("R1", vin, a, 1000.0)));
    c.add(DeviceKind::Diode(Diode::new(
        "D1",
        a,
        -1,
        DiodeModel {
            is: 1e-14,
            n: 1.0,
            ..Default::default()
        },
    )));
    op(&mut c).unwrap();
    let vd = c.voltage("a").unwrap();
    let id = (5.0 - vd) / 1000.0;
    let vt = c.ctx.vt();
    check(
        "diode KCL consistency",
        1e-14 * ((vd / vt).exp() - 1.0),
        id,
        1e-3,
    );
    check("forward drop = Vt*ln(Id/Is)", vd, vt * (id / 1e-14).ln(), 2e-3);
}

#[test]
fn bjt_forward_beta() {
    let mut c = Circuit::new("bjt");
    let (b, col) = (c.node("b"), c.node("c"));
    c.add(DeviceKind::CurrentSource(CurrentSource::new(
        "IB", -1, b, 10e-6,
    )));
    c.add(DeviceKind::VoltageSource(VoltageSource::new("VC", col, -1, 5.0)));
    c.add(DeviceKind::Bjt(Bjt::new(
        "Q1",
        col,
        b,
        -1,
        -1,
        BjtModel {
            is: 1e-16,
            bf: 100.0,
            vaf: f64::INFINITY,
            ..Default::default()
        },
    )));
    op(&mut c).unwrap();
    check(
        "Ic = beta * Ib",
        -c.current("VC").unwrap(),
        100.0 * 10e-6,
        0.02,
    );
}

#[test]
fn bjt_common_emitter_gain() {
    let mut c = Circuit::new("bjt_ce");
    let vcc = c.node("vcc");
    let b = c.node("b");
    let col = c.node("c");
    let inp = c.node("in");
    c.add(DeviceKind::VoltageSource(VoltageSource::new(
        "VCC", vcc, -1, 10.0,
    )));
    c.add(DeviceKind::VoltageSource(
        VoltageSource::new("VIN", inp, -1, 0.0).with_ac(1.0, 0.0),
    ));
    c.add(DeviceKind::Capacitor(Capacitor::new("Cin", inp, b, 1e-3)));
    c.add(DeviceKind::CurrentSource(CurrentSource::new(
        "IB", -1, b, 20e-6,
    )));
    c.add(DeviceKind::Resistor(Resistor::new("RC", vcc, col, 2000.0)));
    c.add(DeviceKind::Bjt(Bjt::new(
        "Q1",
        col,
        b,
        -1,
        -1,
        BjtModel {
            is: 1e-16,
            bf: 100.0,
            vaf: 100.0,
            ..Default::default()
        },
    )));

    let res = ac_sweep(
        &mut c,
        &AcSpec {
            scale: AcScale::Dec,
            points: 10,
            start: 1e3,
            stop: 1e5,
        },
    )
    .unwrap();
    let (mag, _) = bode(&res, c.index_of("c").unwrap() as usize);
    let q = match &c.devices[c.device_index("Q1").unwrap()] {
        DeviceKind::Bjt(q) => q,
        _ => unreachable!(),
    };
    let gm = q.gmf().abs();
    let ro = 100.0 / q.ic.abs();
    let rout = 1.0 / (1.0 / 2000.0 + 1.0 / ro);
    check("CE voltage gain (dB)", mag[5], 20.0 * (gm * rout).log10(), 0.5);
}

#[test]
fn mosfet_saturation_and_linear() {
    let (kp, w, l, vto) = (2e-5, 10e-6, 1e-6, 1.0);

    let mut c = Circuit::new("mos_sat");
    let (g, d) = (c.node("g"), c.node("d"));
    c.add(DeviceKind::VoltageSource(VoltageSource::new("VG", g, -1, 3.0)));
    c.add(DeviceKind::VoltageSource(VoltageSource::new("VD", d, -1, 5.0)));
    c.add(DeviceKind::Mosfet(Mosfet::new(
        "M1",
        d,
        g,
        -1,
        -1,
        MosModel {
            vto,
            kp,
            lambda: 0.0,
            w,
            l,
            ..Default::default()
        },
    )));
    op(&mut c).unwrap();
    let beta = kp * (w / l);
    check(
        "Id in saturation",
        -c.current("VD").unwrap(),
        (beta / 2.0) * (3.0 - vto).powi(2),
        1e-6,
    );

    let mut c = Circuit::new("mos_lin");
    let (g, d) = (c.node("g"), c.node("d"));
    c.add(DeviceKind::VoltageSource(VoltageSource::new("VG", g, -1, 5.0)));
    c.add(DeviceKind::VoltageSource(VoltageSource::new("VD", d, -1, 0.5)));
    c.add(DeviceKind::Mosfet(Mosfet::new(
        "M1",
        d,
        g,
        -1,
        -1,
        MosModel {
            vto,
            kp,
            w,
            l,
            ..Default::default()
        },
    )));
    op(&mut c).unwrap();
    check(
        "Id in linear region",
        -c.current("VD").unwrap(),
        beta * ((5.0 - vto) - 0.5 / 2.0) * 0.5,
        1e-6,
    );
}

#[test]
fn dc_sweep_diode_iv() {
    let mut c = Circuit::new("sweep");
    let a = c.node("a");
    let k = c.node("k");
    c.add(DeviceKind::VoltageSource(VoltageSource::new("V1", a, -1, 0.0)));
    c.add(DeviceKind::Resistor(Resistor::new("Rs", a, k, 10.0)));
    c.add(DeviceKind::Diode(Diode::new(
        "D1",
        k,
        -1,
        DiodeModel {
            is: 1e-14,
            n: 1.0,
            ..Default::default()
        },
    )));
    let res = dc_sweep(
        &mut c,
        &SweepSpec {
            device: "V1".into(),
            property: SweepProperty::Dc,
            start: 0.0,
            stop: 1.0,
            step: 0.01,
        },
        None,
    )
    .unwrap();
    let bi = branch_of(&c, "V1");
    let sols = &res.sweeps[0].solutions;
    for i in 1..sols.len() {
        assert!(
            -sols[i][bi] >= -sols[i - 1][bi] - 1e-12,
            "sweep is not monotonic at step {i}"
        );
    }
    check("sweep starts at zero current", -sols[0][bi], 0.0, 1e-9);
}

// ================================================== NEW: documented gaps

/// Builds an open-secondary transformer driven through a series resistance.
///
/// The series R matters: a voltage source placed DIRECTLY across an inductor is
/// a shorted source at DC (the inductor is a short, so two independent
/// equations both fix the same node) and the operating point is legitimately
/// singular. Real SPICE rejects that netlist too. `rs` breaks the loop.
fn transformer(lp: f64, ls: f64, k: f64, rs: f64) -> Circuit {
    let mut c = Circuit::new("transformer");
    c.options.method = Method::Be;
    let inp = c.node("in");
    let pri = c.node("pri");
    let sec = c.node("sec");
    c.add(DeviceKind::VoltageSource(
        VoltageSource::new("V1", inp, -1, 0.0).with_tran(step_1v()),
    ));
    c.add(DeviceKind::Resistor(Resistor::new("Rs", inp, pri, rs)));
    let li1 = c.add(DeviceKind::Inductor(Inductor::new("L1", pri, -1, lp)));
    let li2 = c.add(DeviceKind::Inductor(Inductor::new("L2", sec, -1, ls)));
    c.couple(li1, li2, k).unwrap();
    c
}

/// Coupled-inductor transient. CLAUDE.md lists coupling as verified at AC but
/// untested in transient.
///
/// With the secondary open no secondary current can flow, so its flux is purely
/// the mutual term `M * i1` and its terminal voltage is `M * di1/dt`. The
/// primary winding sees `V(pri) = L1 * di1/dt`. Dividing, the drive waveform
/// cancels entirely:
///
///     V(sec) / V(pri) = M / L1 = k * sqrt(L2 / L1)
///
/// which is the ideal transformer turns ratio, and holds at every instant
/// rather than only in steady state.
#[test]
fn coupled_inductor_transient_turns_ratio() {
    let (l1, l2, k): (f64, f64, f64) = (1e-3, 4e-3, 1.0);
    let expected_ratio = k * (l2 / l1).sqrt(); // = 2.0
    let mut c = transformer(l1, l2, k, 1.0);

    let mut o = TranOptions::new(2e-4, 1e-6);
    o.tmax = Some(2e-6);
    let res = tran(&mut c, &o).unwrap();
    let pi_ = c.index_of("pri").unwrap() as usize;
    let si = c.index_of("sec").unwrap() as usize;

    // Sample while V(pri) is still well above noise (tau = L1/Rs = 1 ms).
    for t in [2e-5, 5e-5, 1e-4] {
        let j = nearest(&res.time, t);
        let ratio = res.data[j][si] / res.data[j][pi_];
        check(
            &format!("transformer turns ratio at t={t:.0e}"),
            ratio,
            expected_ratio,
            1e-3,
        );
    }

    // Secondary current must stay zero: nothing completes that loop.
    let b2 = branch_of(&c, "L2");
    let j = nearest(&res.time, 1e-4);
    check("open secondary carries no current", res.data[j][b2], 0.0, 1e-12);
}

/// Mutual coupling must be symmetric: driving the 4 mH winding and reading the
/// 1 mH winding gives the reciprocal ratio. Catches a one-sided `Couple` fixup,
/// where only the driven inductor's mutual term is stamped.
#[test]
fn coupled_inductor_reciprocity() {
    let (l1, l2, k): (f64, f64, f64) = (1e-3, 4e-3, 1.0);
    // Drive the 4 mH winding this time.
    let mut c = transformer(l2, l1, k, 1.0);
    let mut o = TranOptions::new(2e-4, 1e-6);
    o.tmax = Some(2e-6);
    let res = tran(&mut c, &o).unwrap();
    let pi_ = c.index_of("pri").unwrap() as usize;
    let si = c.index_of("sec").unwrap() as usize;
    let j = nearest(&res.time, 1e-4);
    check(
        "reciprocal turns ratio",
        res.data[j][si] / res.data[j][pi_],
        k * (l1 / l2).sqrt(),
        1e-3,
    );
}

/// Coupling with `k < 1` must scale the mutual term, and `k = 0` must decouple
/// the windings entirely.
#[test]
fn coupling_coefficient_scales_mutual_term() {
    let (l1, l2): (f64, f64) = (1e-3, 4e-3);
    for k in [0.0, 0.25, 0.5, 0.9] {
        let mut c = transformer(l1, l2, k, 1.0);
        let mut o = TranOptions::new(1e-4, 1e-6);
        o.tmax = Some(2e-6);
        let res = tran(&mut c, &o).unwrap();
        let pi_ = c.index_of("pri").unwrap() as usize;
        let si = c.index_of("sec").unwrap() as usize;
        let j = nearest(&res.time, 5e-5);
        check(
            &format!("turns ratio at k={k}"),
            res.data[j][si] / res.data[j][pi_],
            k * (l2 / l1).sqrt(),
            1e-3,
        );
    }
}

/// Every waveform type other than `pulse` is listed as untested. These are pure
/// functions with exact closed forms.
#[test]
fn waveform_closed_forms() {
    let (tstep, tstop) = (1e-6, 1e-3);

    // --- pulse: midpoint of the rising edge is the midpoint voltage.
    let w = Waveform::Pulse {
        v1: 0.0,
        v2: 2.0,
        td: 1e-6,
        tr: Some(2e-6),
        tf: Some(2e-6),
        pw: Some(4e-6),
        per: Some(0.0),
    };
    check("pulse at mid-rise", w.eval(2e-6, tstep, tstop), 1.0, 1e-12);
    check("pulse on plateau", w.eval(4e-6, tstep, tstop), 2.0, 1e-12);
    check("pulse at mid-fall", w.eval(8e-6, tstep, tstop), 1.0, 1e-12);
    check("pulse before delay", w.eval(0.0, tstep, tstop), 0.0, 1e-12);

    // --- sin: quarter period past the delay is the positive peak.
    let w = Waveform::Sin {
        vo: 1.0,
        va: 3.0,
        freq: Some(1000.0),
        td: 0.0,
        theta: 0.0,
        phase: 0.0,
    };
    check("sin at quarter period", w.eval(0.25e-3, tstep, tstop), 4.0, 1e-9);
    check("sin at half period", w.eval(0.5e-3, tstep, tstop), 1.0, 1e-9);
    // Damped: envelope is exp(-theta*t).
    let w = Waveform::Sin {
        vo: 0.0,
        va: 1.0,
        freq: Some(1000.0),
        td: 0.0,
        theta: 500.0,
        phase: 0.0,
    };
    check(
        "damped sin envelope",
        w.eval(0.25e-3, tstep, tstop),
        (-500.0f64 * 0.25e-3).exp(),
        1e-9,
    );
    // Phase in degrees, evaluated before td.
    let w = Waveform::Sin {
        vo: 0.0,
        va: 2.0,
        freq: Some(1000.0),
        td: 1e-3,
        theta: 0.0,
        phase: 90.0,
    };
    check("sin before delay uses phase", w.eval(0.0, tstep, tstop), 2.0, 1e-12);

    // --- pwl: exact linear interpolation, and clamping outside the range.
    let w = Waveform::Pwl {
        points: vec![(0.0, 0.0), (1e-3, 10.0), (2e-3, -10.0)],
        repeat: false,
        period: 0.0,
    };
    check("pwl interpolates", w.eval(0.5e-3, tstep, tstop), 5.0, 1e-12);
    check("pwl at a knot", w.eval(1e-3, tstep, tstop), 10.0, 1e-12);
    check("pwl mid second segment", w.eval(1.5e-3, tstep, tstop), 0.0, 1e-12);
    check("pwl clamps past the end", w.eval(9e-3, tstep, tstop), -10.0, 1e-12);
    check("pwl clamps before the start", w.eval(-1.0, tstep, tstop), 0.0, 1e-12);

    // --- exp: one time constant after td1 is 1 - 1/e of the way.
    let w = Waveform::Exp {
        v1: 0.0,
        v2: 5.0,
        td1: 0.0,
        tau1: Some(1e-4),
        td2: Some(1.0),
        tau2: Some(1e-4),
    };
    check(
        "exp at one tau",
        w.eval(1e-4, tstep, tstop),
        5.0 * (1.0 - (-1.0f64).exp()),
        1e-9,
    );

    // --- sffm and am: direct evaluation of the defining expression.
    let w = Waveform::Sffm {
        vo: 1.0,
        va: 2.0,
        fc: Some(1e4),
        mdi: 3.0,
        fs: Some(1e3),
    };
    let t = 3.7e-5;
    check(
        "sffm",
        w.eval(t, tstep, tstop),
        1.0 + 2.0 * (2.0 * PI * 1e4 * t + 3.0 * (2.0 * PI * 1e3 * t).sin()).sin(),
        1e-12,
    );

    let w = Waveform::Am {
        va: 2.0,
        vo: 1.0,
        mf: 1e3,
        fc: Some(1e4),
        td: 0.0,
    };
    check(
        "am",
        w.eval(t, tstep, tstop),
        2.0 * (1.0 + (2.0 * PI * 1e3 * t).sin()) * (2.0 * PI * 1e4 * t).sin(),
        1e-12,
    );

    // --- run-dependent defaults resolve from tstep/tstop, not construction.
    let w = Waveform::Pulse {
        v1: 0.0,
        v2: 1.0,
        td: 0.0,
        tr: None,
        tf: None,
        pw: None,
        per: None,
    };
    check(
        "pulse default tr = tstep",
        w.eval(tstep / 2.0, tstep, tstop),
        0.5,
        1e-12,
    );
}

/// Waveform breakpoints must land on every edge, or the stepper walks over
/// them and the response is silently wrong.
#[test]
fn pulse_breakpoints_cover_every_edge() {
    let w = Waveform::Pulse {
        v1: 0.0,
        v2: 1.0,
        td: 1e-6,
        tr: Some(1e-6),
        tf: Some(1e-6),
        pw: Some(2e-6),
        per: Some(10e-6),
    };
    let bp = w.breakpoints(25e-6);
    for edge in [1e-6, 2e-6, 4e-6, 5e-6, 11e-6, 12e-6, 14e-6, 15e-6, 21e-6] {
        assert!(
            bp.iter().any(|&t| (t - edge).abs() < 1e-15),
            "missing breakpoint at {edge:e}; got {bp:?}"
        );
    }
    assert!(bp.windows(2).all(|p| p[0] <= p[1]), "breakpoints not sorted");
}

/// Semiconductor transient charge path. CLAUDE.md lists diode/BJT/MOSFET
/// transient charge as untested.
///
/// A junction with grading coefficient `m = 0` has
///     q(v) = cjo*vj*(1 - (1 - v/vj)^1)/1 = cjo*v
/// i.e. it is exactly a linear capacitor of value `cjo`. That makes the whole
/// `load_tran` -> `integrate` -> stamp path checkable against a textbook RC
/// step while still running the real diode code.
#[test]
fn diode_transient_charge_is_exact_rc() {
    let (r, cjo) = (1000.0, 1e-9);
    let tau = r * cjo;

    for method in [Method::Be, Method::Trap, Method::Gear2] {
        let mut c = Circuit::new("diode_cap");
        c.options.method = method;
        let (vin, out) = (c.node("in"), c.node("out"));
        c.add(DeviceKind::VoltageSource(
            VoltageSource::new("V1", vin, -1, 0.0).with_tran(step_1v()),
        ));
        c.add(DeviceKind::Resistor(Resistor::new("R1", vin, out, r)));
        // Anode grounded, cathode at `out`: the junction sits reverse-biased
        // for a positive step, so conduction stays negligible and only the
        // charge path is exercised.
        c.add(DeviceKind::Diode(Diode::new(
            "D1",
            -1,
            out,
            DiodeModel {
                is: 1e-20,
                cjo,
                vj: 1.0,
                m: 0.0,
                tt: 0.0,
                ..Default::default()
            },
        )));

        let mut o = TranOptions::new(5.0 * tau, tau / 100.0);
        o.tmax = Some(tau / 50.0);
        let res = tran(&mut c, &o).unwrap();
        let oi = c.index_of("out").unwrap() as usize;
        for k in [1.0, 3.0] {
            let j = nearest(&res.time, k * tau);
            check(
                &format!("{method:?}: diode junction charge RC at {k}tau"),
                res.data[j][oi],
                1.0 - (-k).exp(),
                3e-3,
            );
        }
    }
}

/// MOSFET transient gate charge. With the device held off, the Meyer model
/// gives `cgb = cox` and the overlaps are constant, so a gate driven through a
/// resistor against tied source/drain/bulk is again an exact RC.
#[test]
fn mosfet_transient_gate_charge_is_exact_rc() {
    let (r, tox, w, l) = (1e6, 1e-7, 1e-4, 1e-4);
    // Meyer oxide capacitance, the same expression the device uses.
    let cox = (3.9 * 8.854e-12 / tox) * w * l;
    let tau = r * cox;

    let mut c = Circuit::new("mos_gate");
    c.options.method = Method::Trap;
    let (vin, g) = (c.node("in"), c.node("g"));
    c.add(DeviceKind::VoltageSource(
        VoltageSource::new("V1", vin, -1, 0.0).with_tran(step_1v()),
    ));
    c.add(DeviceKind::Resistor(Resistor::new("Rg", vin, g, r)));
    c.add(DeviceKind::Mosfet(Mosfet::new(
        "M1",
        -1, // drain to ground
        g,
        -1, // source to ground
        -1, // bulk to ground
        MosModel {
            // vto well above the 1 V step keeps the channel off, so cgb = cox
            // for the whole run and the capacitance is constant.
            vto: 5.0,
            kp: 2e-5,
            tox,
            w,
            l,
            ..Default::default()
        },
    )));

    let mut o = TranOptions::new(5.0 * tau, tau / 100.0);
    o.tmax = Some(tau / 50.0);
    let res = tran(&mut c, &o).unwrap();
    let gi = c.index_of("g").unwrap() as usize;
    for k in [1.0, 3.0] {
        let j = nearest(&res.time, k * tau);
        check(
            &format!("MOSFET gate charge RC at {k}tau"),
            res.data[j][gi],
            1.0 - (-k).exp(),
            5e-3,
        );
    }
}

/// BJT transient charge: with `cje`/`cjc` graded junctions replaced by a pure
/// transit-time term the base charge is `tf * Ic`, so at a fixed bias the
/// stored charge must equal `tf * Ic` once the transient settles.
#[test]
fn bjt_transient_stored_charge_matches_transit_time() {
    let tf = 1e-9;
    let mut c = Circuit::new("bjt_tran");
    c.options.method = Method::Trap;
    let (b, col) = (c.node("b"), c.node("c"));
    c.add(DeviceKind::CurrentSource(CurrentSource::new(
        "IB", -1, b, 10e-6,
    )));
    c.add(DeviceKind::VoltageSource(VoltageSource::new("VC", col, -1, 5.0)));
    c.add(DeviceKind::Bjt(Bjt::new(
        "Q1",
        col,
        b,
        -1,
        -1,
        BjtModel {
            is: 1e-16,
            bf: 100.0,
            tf,
            ..Default::default()
        },
    )));

    let mut o = TranOptions::new(1e-6, 1e-8);
    o.tmax = Some(2e-8);
    tran(&mut c, &o).unwrap();

    // At the settled bias the base-emitter charge is tf * Icc (the ideal
    // forward transport current), read straight out of the state pool.
    let off = c.devices[c.device_index("Q1").unwrap()].state_off();
    let qbe = c.ctx.state.at(0)[off];
    let ic = match &c.devices[c.device_index("Q1").unwrap()] {
        DeviceKind::Bjt(q) => q.ic,
        _ => unreachable!(),
    };
    check("BJT stored base charge = tf * Ic", qbe, tf * ic, 2e-2);
}

/// Current-controlled sources, which the JS analytic suite does not cover.
#[test]
fn current_controlled_sources() {
    // CCCS: F1 mirrors the current through V1 with gain 3.
    let mut c = Circuit::new("cccs");
    let (i, o) = (c.node("in"), c.node("out"));
    c.add(DeviceKind::VoltageSource(VoltageSource::new("V1", i, -1, 1.0)));
    c.add(DeviceKind::Resistor(Resistor::new("R1", i, -1, 1000.0)));
    let v1 = c.device_index("V1").unwrap();
    c.add(DeviceKind::Cccs(Cccs::new("F1", o, -1, v1, 3.0)));
    c.add(DeviceKind::Resistor(Resistor::new("RL", o, -1, 100.0)));
    op(&mut c).unwrap();
    // I(V1) = -1 mA (current into the source's positive terminal), so the
    // controlled current is 3 * -1 mA driven into `out` through 100 ohm.
    let iv1 = c.current("V1").unwrap();
    check("CCCS output", c.voltage("out").unwrap(), -3.0 * iv1 * 100.0, 1e-9);

    // CCVS: H1 produces 2000 * I(V1) volts.
    let mut c = Circuit::new("ccvs");
    let (i, o) = (c.node("in"), c.node("out"));
    c.add(DeviceKind::VoltageSource(VoltageSource::new("V1", i, -1, 1.0)));
    c.add(DeviceKind::Resistor(Resistor::new("R1", i, -1, 1000.0)));
    let v1 = c.device_index("V1").unwrap();
    c.add(DeviceKind::Ccvs(Ccvs::new("H1", o, -1, v1, 2000.0)));
    c.add(DeviceKind::Resistor(Resistor::new("RL", o, -1, 100.0)));
    op(&mut c).unwrap();
    let iv1 = c.current("V1").unwrap();
    check("CCVS output", c.voltage("out").unwrap(), 2000.0 * iv1, 1e-9);
}

/// Voltage-controlled switch, including that hysteresis actually latches.
#[test]
fn voltage_controlled_switch() {
    let build = |vctrl: f64| {
        let mut c = Circuit::new("vswitch");
        let (ctl, o) = (c.node("ctl"), c.node("out"));
        c.add(DeviceKind::VoltageSource(VoltageSource::new(
            "VC", ctl, -1, vctrl,
        )));
        c.add(DeviceKind::VoltageSource(VoltageSource::new("V1", o, -1, 5.0)));
        c.add(DeviceKind::VSwitch(VSwitch::new(
            "S1",
            o,
            -1,
            ctl,
            -1,
            SwitchModel {
                vt: 2.5,
                vh: 0.5,
                ron: 10.0,
                roff: 1e9,
            },
        )));
        c
    };

    // Control above vt + vh: closed, so the source drives 5 V through 10 ohm.
    let mut c = build(5.0);
    op(&mut c).unwrap();
    check("switch on current", -c.current("V1").unwrap(), 5.0 / 10.0, 1e-6);

    // Control below vt - vh: open.
    let mut c = build(0.0);
    op(&mut c).unwrap();
    check("switch off current", -c.current("V1").unwrap(), 5.0 / 1e9, 1e-12);
}

/// The symbolic/numeric split is the basis of interactive real-time: changing a
/// component VALUE must not require re-analysis. A sweep that silently rebuilt
/// the topology would still give right answers, just far too slowly, so nothing
/// else in the suite would catch it.
#[test]
fn value_change_does_not_dirty_topology() {
    let mut c = Circuit::new("realtime");
    let (vin, mid) = (c.node("in"), c.node("mid"));
    c.add(DeviceKind::VoltageSource(VoltageSource::new(
        "V1", vin, -1, 10.0,
    )));
    c.add(DeviceKind::Resistor(Resistor::new("R1", vin, mid, 1000.0)));
    c.add(DeviceKind::Resistor(Resistor::new("R2", mid, -1, 1000.0)));
    op(&mut c).unwrap();
    assert!(!c.topology_dirty, "topology should be clean after a build");

    let nnz_before = c.ctx.sys.nnz;
    let _ = dc_sweep(
        &mut c,
        &SweepSpec {
            device: "V1".into(),
            property: SweepProperty::Dc,
            start: 0.0,
            stop: 10.0,
            step: 1.0,
        },
        None,
    )
    .unwrap();
    assert!(
        !c.topology_dirty,
        "a value sweep must never dirty the topology"
    );
    assert_eq!(
        nnz_before, c.ctx.sys.nnz,
        "matrix structure changed during a value-only sweep"
    );
}

/// BJT ohmic base / emitter / collector resistance.
///
/// These are read from every realistic model card and were silently ignored
/// until a differential run against ngspice exposed a 2.5 mV shift in Vbe on a
/// general-purpose part — a 0.4% error invisible to any closed-form check that
/// did not specifically look for it.
///
/// The closed form: inserting rb and re raises the EXTERNAL base-emitter
/// voltage by the ohmic drops, `Ib*rb + Ie*re`, while the intrinsic junction
/// sees the same voltage as before. Collector resistance drops `Ic*rc` off the
/// collector node.
#[test]
fn bjt_ohmic_resistances_shift_the_terminal_voltages() {
    let model = |rb: f64, re: f64, rc: f64| BjtModel {
        is: 1e-16,
        bf: 150.0,
        vaf: 80.0,
        rb,
        re,
        rc,
        ..Default::default()
    };

    let bias = |m: BjtModel| {
        let mut c = Circuit::new("ce");
        let (vcc, b, col) = (c.node("vcc"), c.node("b"), c.node("c"));
        c.add(DeviceKind::VoltageSource(VoltageSource::new(
            "VCC", vcc, -1, 12.0,
        )));
        c.add(DeviceKind::Resistor(Resistor::new("RB", vcc, b, 470e3)));
        c.add(DeviceKind::Resistor(Resistor::new("RC", vcc, col, 2200.0)));
        c.add(DeviceKind::Bjt(Bjt::new("Q1", col, b, -1, -1, m)));
        op(&mut c).unwrap();
        let vb = c.voltage("b").unwrap();
        let vc = c.voltage("c").unwrap();
        // Currents follow from the bias network, independent of the model.
        let ib = (12.0 - vb) / 470e3;
        let ic = (12.0 - vc) / 2200.0;
        (vb, vc, ib, ic)
    };

    let (vb0, _vc0, ib0, ic0) = bias(model(0.0, 0.0, 0.0));

    // Base resistance alone: V(b) rises by Ib * rb.
    let rb = 1000.0;
    let (vb1, _, ib1, _) = bias(model(rb, 0.0, 0.0));
    check(
        "rb raises the external base voltage by Ib*rb",
        vb1 - vb0,
        ib1 * rb,
        0.02,
    );

    // Emitter resistance alone: the drop appears at the base too, since the
    // emitter terminal is grounded and Ie flows through re.
    let re = 10.0;
    let (vb2, _, ib2, ic2) = bias(model(0.0, re, 0.0));
    check(
        "re raises the external base voltage by Ie*re",
        vb2 - vb0,
        (ib2 + ic2) * re,
        0.03,
    );

    // Collector resistance is INSIDE the device: the external collector node is
    // pinned by the 2.2k bias resistor, so the Ic*rc drop appears between the
    // terminal and the INTERNAL collector, not at the terminal. (Measuring the
    // terminal instead shows a tiny rise, because the reduced intrinsic Vce
    // pulls Ic down slightly through the Early effect.)
    let rc = 100.0;
    let mut c = Circuit::new("ce_rc");
    let (vcc, b, col) = (c.node("vcc"), c.node("b"), c.node("c"));
    c.add(DeviceKind::VoltageSource(VoltageSource::new(
        "VCC", vcc, -1, 12.0,
    )));
    c.add(DeviceKind::Resistor(Resistor::new("RB", vcc, b, 470e3)));
    c.add(DeviceKind::Resistor(Resistor::new("RC", vcc, col, 2200.0)));
    c.add(DeviceKind::Bjt(Bjt::new(
        "Q1", col, b, -1, -1, model(0.0, 0.0, rc),
    )));
    op(&mut c).unwrap();
    let vc_ext = c.voltage("c").unwrap();
    let ic = (12.0 - vc_ext) / 2200.0;
    // Only rc is non-zero, so it owns internal slot 0.
    let idx = c
        .labels
        .iter()
        .position(|l| l == "Q1:int0")
        .expect("rc should allocate an internal collector node");
    let vc_int = c.ctx.x[idx];
    check(
        "rc drops Ic*rc between terminal and internal collector",
        vc_ext - vc_int,
        ic * rc,
        0.02,
    );

    // Zero resistances must allocate no internal nodes: a model that does not
    // ask for them should not pay an extra unknown per device.
    let mut plain = Circuit::new("plain");
    let b = plain.node("b");
    plain.add(DeviceKind::Bjt(Bjt::new(
        "Q1", -1, b, -1, -1, model(0.0, 0.0, 0.0),
    )));
    plain.add(DeviceKind::Resistor(Resistor::new("R1", b, -1, 1e3)));
    plain.build_topology().unwrap();
    assert_eq!(
        plain.num_unknowns, 1,
        "a BJT with no ohmic resistance should add no internal nodes"
    );

    let mut withr = Circuit::new("withr");
    let b = withr.node("b");
    withr.add(DeviceKind::Bjt(Bjt::new(
        "Q1", -1, b, -1, -1, model(10.0, 1.0, 0.0),
    )));
    withr.add(DeviceKind::Resistor(Resistor::new("R1", b, -1, 1e3)));
    withr.build_topology().unwrap();
    assert_eq!(
        withr.num_unknowns, 3,
        "rb and re should add exactly two internal nodes"
    );

    let _ = (ib0, ic0);
}

/// P-channel MOSFET threshold sign.
///
/// A PMOS card states `vto` NEGATIVE, while the current equation works in a
/// mirrored frame where the device looks n-channel. Mirroring the voltages but
/// not the threshold turns the device on `2*|vto|` too early. That was the
/// state of both this port and the JS oracle until a differential run against
/// ngspice exposed it: a level-1 PMOS ngspice put at -3.000 V sat at -1.127 V.
///
/// No MOSFET test used a p-channel device, which is the whole reason it
/// survived. The closed form is the same square law as the n-channel case, with
/// every sign flipped.
#[test]
fn pmos_threshold_sign_matches_the_square_law() {
    let (kp, w, l, vto) = (2e-5, 20e-6, 2e-6, -1.0);
    let beta = kp * (w / l);

    // Saturation: |vgs| = 3, |vto| = 1, so |vgst| = 2 and Id = beta/2 * vgst^2.
    let mut c = Circuit::new("pmos_sat");
    let (g, d) = (c.node("g"), c.node("d"));
    c.add(DeviceKind::VoltageSource(VoltageSource::new("VG", g, -1, -3.0)));
    c.add(DeviceKind::VoltageSource(VoltageSource::new("VD", d, -1, -5.0)));
    c.add(DeviceKind::Mosfet(Mosfet::new(
        "M1",
        d,
        g,
        -1,
        -1,
        MosModel {
            kind: spicelab_core::devices::mosfet::MosType::Pmos,
            vto,
            kp,
            w,
            l,
            lambda: 0.0,
            ..Default::default()
        },
    )));
    op(&mut c).unwrap();
    // Current out of VD is positive for a PMOS sourcing into the drain supply.
    check(
        "PMOS saturation current",
        c.current("VD").unwrap().abs(),
        (beta / 2.0) * (3.0f64 - 1.0).powi(2),
        1e-6,
    );

    // Below threshold it must be OFF, not conducting. With the sign bug this
    // device carried current because vgst came out as |vgs| + |vto|.
    let mut c = Circuit::new("pmos_off");
    let (g, d) = (c.node("g"), c.node("d"));
    c.add(DeviceKind::VoltageSource(VoltageSource::new("VG", g, -1, -0.5)));
    c.add(DeviceKind::VoltageSource(VoltageSource::new("VD", d, -1, -5.0)));
    c.add(DeviceKind::Mosfet(Mosfet::new(
        "M1",
        d,
        g,
        -1,
        -1,
        MosModel {
            kind: spicelab_core::devices::mosfet::MosType::Pmos,
            vto,
            kp,
            w,
            l,
            ..Default::default()
        },
    )));
    op(&mut c).unwrap();
    // "Off" means the CHANNEL carries nothing. The reverse-biased bulk-drain
    // junction still leaks its gmin current (1e-12 S across 5 V = 5 pA), which
    // is physically right and is what ngspice reports too — so the bound is a
    // few pA, not exactly zero. With the threshold-sign bug this device carried
    // hundreds of microamps.
    check(
        "PMOS below threshold: channel off, only junction leakage",
        c.current("VD").unwrap().abs(),
        0.0,
        1e-10,
    );

    // And the n-channel case with the mirrored card must give the same current,
    // which is what "mirrored frame" actually means.
    let mut c = Circuit::new("nmos_mirror");
    let (g, d) = (c.node("g"), c.node("d"));
    c.add(DeviceKind::VoltageSource(VoltageSource::new("VG", g, -1, 3.0)));
    c.add(DeviceKind::VoltageSource(VoltageSource::new("VD", d, -1, 5.0)));
    c.add(DeviceKind::Mosfet(Mosfet::new(
        "M1",
        d,
        g,
        -1,
        -1,
        MosModel {
            vto: 1.0,
            kp,
            w,
            l,
            lambda: 0.0,
            ..Default::default()
        },
    )));
    op(&mut c).unwrap();
    check(
        "NMOS mirror gives the same magnitude",
        c.current("VD").unwrap().abs(),
        (beta / 2.0) * (3.0f64 - 1.0).powi(2),
        1e-6,
    );
}

// ---------------------------------------------------------------------------
// MOSFET bulk junction charge, and the diffusion sheet resistance
// ---------------------------------------------------------------------------

/// Zero-bias and reverse-bias bulk junction capacitance against the closed form.
///
/// The depletion capacitance of a graded junction is
///
///     C(v) = cz*(1 - v/pb)^-mj + czsw*(1 - v/pb)^-mjsw
///
/// with `cz = cj*area` and `czsw = cjsw*perimeter`. Both were parsed into the
/// model and stamped nowhere, so DC was right and every transient and AC result
/// was missing the bulk charge — the same "read but never stamped" shape as the
/// BJT ohmic resistances and the MOSFET's own `rd`/`rs`.
///
/// Measured as the admittance a small-signal AC source sees looking into the
/// bulk, with drain, gate and source grounded and the gate off, so the only
/// path is the two junctions in parallel.
#[test]
fn bulk_junction_capacitance_matches_the_depletion_formula() {
    // Branch-current index for a named source.
    trait BranchOf { fn branch_of(&self, n: &str) -> usize; }
    impl BranchOf for Circuit {
        fn branch_of(&self, n: &str) -> usize {
            let i = self.device_index(n).unwrap();
            self.devices[i].branches()[0]
        }
    }

    let (cj, cjsw, mj, mjsw, pb) = (2e-4, 1e-9, 0.5, 0.33, 0.8);
    let (ad, pd) = (1e-10, 6e-5);
    let cz = cj * ad;
    let czsw = cjsw * pd;
    let f = 1e6;
    let w = 2.0 * PI * f;

    for vb in [-3.0, -1.0, 0.0] {
        let mut c = Circuit::new("bulkcap");
        let b = c.node("b");
        c.add(DeviceKind::VoltageSource(
            VoltageSource::new("VB", b, -1, vb).with_ac(1.0, 0.0),
        ));
        c.add(DeviceKind::Mosfet(Mosfet::new(
            "M1", -1, -1, -1, b,
            MosModel {
                vto: 1.0,
                kp: 2e-5,
                // tox unstated: no intrinsic gate capacitance, so nothing but
                // the two junctions is in the measurement.
                cj, cjsw, mj, mjsw, pb,
                ad, as_: ad, pd, ps: pd,
                w: 20e-6, l: 2e-6,
                ..Default::default()
            },
        )));

        let res = ac_sweep(
            &mut c,
            &AcSpec { scale: AcScale::Lin, points: 2, start: f, stop: f },
        )
        .unwrap();
        // The source's own branch current IS the admittance looking into b,
        // since the AC magnitude is 1 V.
        let i = c.branch_of("VB");
        let y = (res.re[0][i].powi(2) + res.im[0][i].powi(2)).sqrt();

        let arg: f64 = 1.0 - vb / pb;
        let cap = 2.0 * (cz * arg.powf(-mj) + czsw * arg.powf(-mjsw));
        // Compared as a RATIO: `check` passes on absolute OR relative
        // tolerance, and these capacitances are ~1e-13 F, so any absolute
        // tolerance loose enough to type passes even when the stamp is missing
        // entirely. The first version of this test did exactly that and
        // survived deleting the capacitance from `load_ac`.
        check(
            &format!("bulk junction capacitance at vb={vb}"),
            y / w / cap,
            1.0,
            1e-9,
        );
    }
}

/// `rsh * nrd` is the other way a process card states the drain resistance.
///
/// ngspice prefers an explicit `rd` and falls back to the sheet form; a card
/// carrying only `rsh`/`nrd` otherwise silently gets no series resistance, and
/// the drain comes out high by Id*(rd+rs).
#[test]
fn sheet_resistance_equals_an_explicit_series_resistance() {
    let bias = |m: MosModel| {
        let mut c = Circuit::new("rsh");
        let (d, g, vdd) = (c.node("d"), c.node("g"), c.node("vdd"));
        c.add(DeviceKind::VoltageSource(VoltageSource::new("VDD", vdd, -1, 5.0)));
        c.add(DeviceKind::VoltageSource(VoltageSource::new("VG", g, -1, 3.0)));
        c.add(DeviceKind::Resistor(Resistor::new("RL", vdd, d, 5e3)));
        c.add(DeviceKind::Mosfet(Mosfet::new("M1", d, g, -1, -1, m)));
        op(&mut c).unwrap();
        c.voltage("d").unwrap()
    };
    let base = MosModel { vto: 1.0, kp: 2e-5, w: 20e-6, l: 2e-6, ..Default::default() };
    let explicit = bias(MosModel { rd: 200.0, rs: 100.0, ..base.clone() });
    let sheet = bias(MosModel { rsh: 50.0, nrd: 4.0, nrs: 2.0, ..base.clone() });
    let none = bias(base);
    check("rsh*nrd matches an explicit rd", sheet, explicit, 1e-12);
    // And it has to actually do something, or the check above is vacuous.
    assert!(
        (sheet - none).abs() > 1e-4,
        "series resistance changed nothing: {sheet} vs {none}"
    );
}
