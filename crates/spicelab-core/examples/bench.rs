//! Rough native-vs-JS timing on the same transient the golden fixtures use.
//! Not a microbenchmark harness — just enough to confirm the port bought what
//! the architecture notes assumed it would.

use spicelab_core::analyses::tran::{tran, TranOptions};
use spicelab_core::circuit::Circuit;
use spicelab_core::context::Method;
use spicelab_core::device::DeviceKind;
use spicelab_core::devices::primitives::{Capacitor, Inductor, Resistor};
use spicelab_core::devices::sources::{VoltageSource, Waveform};
use std::time::Instant;

fn rlc() -> Circuit {
    let mut c = Circuit::new("rlc_ring");
    c.options.method = Method::Trap;
    let (vin, out, m) = (c.node("in"), c.node("out"), c.node("m"));
    c.add(DeviceKind::VoltageSource(
        VoltageSource::new("V1", vin, -1, 0.0).with_tran(Waveform::Pulse {
            v1: 0.0, v2: 1.0, td: 0.0,
            tr: Some(1e-12), tf: Some(1e-12), pw: Some(1.0), per: Some(0.0),
        }),
    ));
    c.add(DeviceKind::Resistor(Resistor::new("R1", vin, out, 20.0)));
    c.add(DeviceKind::Inductor(Inductor::new("L1", out, m, 1e-3)));
    c.add(DeviceKind::Capacitor(Capacitor::new("C1", m, -1, 1e-6)));
    c
}

fn main() {
    let reps = 200;
    let mut o = TranOptions::new(6e-4, 5e-7);
    o.tmax = Some(1e-6);
    o.method = Some(Method::Trap);

    // Warm up.
    let mut c = rlc();
    let r = tran(&mut c, &o).unwrap();
    let points = r.time.len();

    // Whole run: topology build (symbolic, once) + the stepping loop.
    let t0 = Instant::now();
    for _ in 0..reps {
        let mut c = rlc();
        std::hint::black_box(tran(&mut c, &o).unwrap());
    }
    let whole = t0.elapsed();

    // Topology build alone, so the numeric phase can be isolated. This split is
    // the point of the symbolic/numeric separation: only the second number is
    // what a slider drag pays.
    let t0 = Instant::now();
    for _ in 0..reps {
        let mut c = rlc();
        c.ensure_built().unwrap();
        std::hint::black_box(c.num_unknowns);
    }
    let build = t0.elapsed();

    let per = |d: std::time::Duration| d.as_secs_f64() * 1000.0 / reps as f64;
    println!("rust: {points}-point rlc transient, {reps} runs");
    println!("  whole run     {:.3} ms/run", per(whole));
    println!("  topology only {:.3} ms/run", per(build));
    println!("  stepping only {:.3} ms/run", per(whole) - per(build));

    for n in [50usize, 200] {
        let mut lo = TranOptions::new(2e-5, 1e-7);
        lo.tmax = Some(2e-7);
        lo.method = Some(Method::Trap);
        let mut c = ladder(n);
        let r = tran(&mut c, &lo).unwrap();
        let pts = r.time.len();
        let unknowns = c.num_unknowns;
        let reps = 20;
        let t0 = Instant::now();
        for _ in 0..reps {
            let mut c = ladder(n);
            std::hint::black_box(tran(&mut c, &lo).unwrap());
        }
        let el = t0.elapsed();
        println!(
            "rust: ladder n={n} ({unknowns} unknowns, {pts} points): {:.3} ms/run",
            el.as_secs_f64() * 1000.0 / reps as f64
        );
    }
}

/// An RC ladder, to see whether the gap widens once the circuit is big enough
/// that the numeric loops rather than per-point bookkeeping dominate.
pub fn ladder(n: usize) -> Circuit {
    let mut c = Circuit::new("ladder");
    c.options.method = Method::Trap;
    let inp = c.node("in");
    c.add(DeviceKind::VoltageSource(
        VoltageSource::new("V1", inp, -1, 0.0).with_tran(Waveform::Pulse {
            v1: 0.0, v2: 1.0, td: 0.0,
            tr: Some(1e-12), tf: Some(1e-12), pw: Some(1.0), per: Some(0.0),
        }),
    ));
    let mut prev = inp;
    for i in 0..n {
        let node = c.node(&format!("n{i}"));
        c.add(DeviceKind::Resistor(Resistor::new(
            &format!("R{i}"), prev, node, 1000.0,
        )));
        c.add(DeviceKind::Capacitor(Capacitor::new(
            &format!("C{i}"), node, -1, 1e-9,
        )));
        prev = node;
    }
    c
}
