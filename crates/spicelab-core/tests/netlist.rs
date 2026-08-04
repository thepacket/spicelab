//! Netlist end-to-end tests: text in, solved circuit out.
//!
//! The subcircuit cases carry most of the weight. Hierarchical node mapping is
//! routinely underestimated, and its failure mode is quiet — two instances that
//! accidentally share an internal net still solve, they just solve a different
//! circuit than the one written.

use spicelab_core::analyses::dc::{ac_sweep, bode, op};
use spicelab_core::analyses::tran::tran;
use spicelab_core::netlist::{
    ac_spec, build, flatten, parse, parse_with, tran_options, Analysis, ErrorKind,
};
use std::f64::consts::PI;

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

fn solved(src: &str) -> spicelab_core::Circuit {
    let nl = parse(src).unwrap_or_else(|e| panic!("parse: {e}"));
    let mut c = build(&nl).unwrap_or_else(|e| panic!("build: {e}"));
    op(&mut c).unwrap_or_else(|e| panic!("op: {e}"));
    c
}

#[test]
fn resistive_divider_from_text() {
    let c = solved(
        "Divider
         V1 in 0 DC 10
         R1 in mid 1k
         R2 mid 0 3k
         .op
         .end",
    );
    check("V(mid)", c.voltage("mid").unwrap(), 7.5, 1e-9);
}

#[test]
fn engineering_suffixes_reach_the_solver() {
    // 1meg / (1meg + 1meg) = 0.5 of 10 V. If MEG were read as milli the
    // divider ratio would still be 0.5, so make the two legs differ.
    let c = solved(
        "t
         V1 in 0 10
         R1 in mid 1meg
         R2 mid 0 3meg
         .end",
    );
    check("V(mid) with meg", c.voltage("mid").unwrap(), 7.5, 1e-9);
}

#[test]
fn params_and_expressions() {
    let c = solved(
        "t
         .param rtop=1k
         .param ratio=3
         .param rbot={rtop*ratio}
         V1 in 0 DC 10
         R1 in mid {rtop}
         R2 mid 0 {rbot}
         .end",
    );
    check("V(mid) from params", c.voltage("mid").unwrap(), 7.5, 1e-9);
}

#[test]
fn subckt_basic_instantiation() {
    let c = solved(
        "t
         .subckt divider a b
         R1 a b 1k
         R2 b 0 3k
         .ends
         V1 in 0 DC 10
         X1 in mid divider
         .end",
    );
    check("V(mid) via subckt", c.voltage("mid").unwrap(), 7.5, 1e-9);
}

#[test]
fn subckt_parameter_passing_and_override() {
    // Default r=1k gives 7.5 V; the override to 2k makes the ratio 3k/5k.
    let src = "t
         .subckt divider a b params: r=1k
         R1 a b {r}
         R2 b 0 3k
         .ends
         V1 in 0 DC 10
         X1 in mid divider r=2k
         .end";
    let c = solved(src);
    check(
        "V(mid) with overridden param",
        c.voltage("mid").unwrap(),
        10.0 * 3000.0 / 5000.0,
        1e-9,
    );

    // Without the override the default applies.
    let c = solved(&src.replace("divider r=2k", "divider"));
    check("V(mid) with default param", c.voltage("mid").unwrap(), 7.5, 1e-9);
}

/// The quiet failure: two instances of one subcircuit must not share internal
/// nets. Both dividers here have an internal node called `mid`; if the prefixing
/// were dropped they would short together and still produce a plausible number.
#[test]
fn subckt_instances_do_not_share_internal_nodes() {
    let c = solved(
        "t
         .subckt divider a out params: r=1k
         R1 a mid {r}
         R2 mid 0 {r}
         R3 mid out 1
         .ends
         V1 in1 0 DC 10
         V2 in2 0 DC 4
         X1 in1 o1 divider
         X2 in2 o2 divider
         .end",
    );
    // Each instance is an independent 2:1 divider (R3 draws no current into an
    // otherwise unloaded node, so `o` sits at the internal midpoint).
    check("instance 1 output", c.voltage("o1").unwrap(), 5.0, 1e-9);
    check("instance 2 output", c.voltage("o2").unwrap(), 2.0, 1e-9);

    // And the hierarchical names really are distinct.
    let nl = parse(
        "t
         .subckt divider a out params: r=1k
         R1 a mid {r}
         R2 mid 0 {r}
         R3 mid out 1
         .ends
         V1 in1 0 DC 10
         X1 in1 o1 divider
         X2 in1 o2 divider
         .end",
    )
    .unwrap();
    let flat = flatten(&nl).unwrap();
    let names: Vec<&str> = flat.iter().map(|e| e.name.as_str()).collect();
    assert!(names.contains(&"X1.R1"), "{names:?}");
    assert!(names.contains(&"X2.R1"), "{names:?}");
    let x1r1 = flat.iter().find(|e| e.name == "X1.R1").unwrap();
    let x2r1 = flat.iter().find(|e| e.name == "X2.R1").unwrap();
    assert_eq!(x1r1.nodes[1], "X1.mid");
    assert_eq!(x2r1.nodes[1], "X2.mid");
}

/// Ground must stay global at every level of hierarchy.
#[test]
fn ground_is_never_prefixed() {
    let nl = parse(
        "t
         .subckt leg a
         R1 a 0 1k
         R2 a gnd 1k
         .ends
         V1 in 0 1
         X1 in leg
         .end",
    )
    .unwrap();
    let flat = flatten(&nl).unwrap();
    for e in flat.iter().filter(|e| e.name.starts_with("X1.")) {
        assert_eq!(e.nodes[1], "0", "{} lost its ground", e.name);
    }
}

#[test]
fn nested_subckts_with_parameter_chains() {
    let c = solved(
        "t
         .subckt inner a b params: rv=1k
         R1 a b {rv}
         .ends
         .subckt outer a b params: scale=2
         X1 a b inner rv={1k*scale}
         .ends
         V1 in 0 DC 10
         X1 in mid outer scale=3
         R2 mid 0 3k
         .end",
    );
    // inner resistance = 1k*3 = 3k, so the divider is 3k/(3k+3k) = 5 V.
    check("nested param chain", c.voltage("mid").unwrap(), 5.0, 1e-9);

    // Hierarchical names nest.
    let nl = parse(
        "t
         .subckt inner a b
         R1 a b 1k
         .ends
         .subckt outer a b
         X1 a b inner
         .ends
         V1 in 0 1
         X9 in mid outer
         R2 mid 0 1k
         .end",
    )
    .unwrap();
    let flat = flatten(&nl).unwrap();
    assert!(
        flat.iter().any(|e| e.name == "X9.X1.R1"),
        "{:?}",
        flat.iter().map(|e| &e.name).collect::<Vec<_>>()
    );
}

#[test]
fn subckt_defined_inside_another_subckt() {
    let c = solved(
        "t
         .subckt outer a b
         .subckt helper c d
         R1 c d 2k
         .ends
         X1 a b helper
         .ends
         V1 in 0 DC 10
         X1 in mid outer
         R2 mid 0 2k
         .end",
    );
    check("locally scoped subckt", c.voltage("mid").unwrap(), 5.0, 1e-9);
}

#[test]
fn models_resolve_and_diode_biases() {
    let c = solved(
        "t
         V1 in 0 DC 5
         R1 in a 1k
         D1 a 0 DMOD
         .model DMOD D is=1e-14 n=1
         .end",
    );
    let vd = c.voltage("a").unwrap();
    let id = (5.0 - vd) / 1000.0;
    let vt = c.ctx.vt();
    check("diode from netlist", vd, vt * (id / 1e-14).ln(), 2e-3);
}

#[test]
fn bjt_and_mosfet_cards() {
    let c = solved(
        "t
         VCC vcc 0 12
         RB vcc b 470k
         RC vcc c 2.2k
         Q1 c b 0 QMOD
         .model QMOD NPN is=1e-16 bf=150 vaf=80
         .end",
    );
    // This is the `bjt_bias` golden fixture written as netlist text, so it must
    // reproduce the JS oracle's reference values exactly — a much stronger
    // check than a hand-estimated Vbe, and it ties the netlist path back to the
    // differential suite.
    check("BJT base voltage", c.voltage("b").unwrap(), 0.807162834981895, 1e-6);
    check(
        "BJT collector voltage",
        c.voltage("c").unwrap(),
        3.8429762093238784,
        1e-6,
    );

    // Likewise the `mos_bias` fixture.
    let c = solved(
        "t
         VDD vdd 0 5
         VG g 0 2.5
         RD vdd d 5k
         M1 d g 0 0 MMOD w=20u l=1u
         .model MMOD NMOS vto=1 kp=2e-5 lambda=0.02
         .end",
    );
    let want = {
        let raw = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/fixtures/golden.json"
        ))
        .unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        v["fixtures"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["name"] == "mos_bias")
            .unwrap()["expect"]["d"]
            .as_f64()
            .unwrap()
    };
    check("MOSFET drain voltage", c.voltage("d").unwrap(), want, 1e-7);
}

#[test]
fn controlled_sources_from_text() {
    let c = solved(
        "t
         V1 in 0 DC 2
         E1 out 0 in 0 5
         RL out 0 1k
         .end",
    );
    check("VCVS from netlist", c.voltage("out").unwrap(), 10.0, 1e-9);

    let c = solved(
        "t
         V1 in 0 DC 1
         R1 in 0 1k
         H1 out 0 V1 2000
         RL out 0 100
         .end",
    );
    check(
        "CCVS from netlist",
        c.voltage("out").unwrap(),
        2000.0 * c.current("V1").unwrap(),
        1e-9,
    );
}

#[test]
fn coupled_inductors_from_text() {
    let nl = parse(
        "t
         V1 in 0 0 PULSE(0 1 0 1p 1p 1 0)
         Rs in pri 1
         L1 pri 0 1m
         L2 sec 0 4m
         K1 L1 L2 1.0
         .tran 1u 200u
         .end",
    )
    .unwrap();
    let mut c = build(&nl).unwrap();
    let o = tran_options(&nl.analyses[0]).unwrap();
    let res = tran(&mut c, &o).unwrap();
    let pi_ = c.index_of("pri").unwrap() as usize;
    let si = c.index_of("sec").unwrap() as usize;
    let j = res
        .time
        .iter()
        .enumerate()
        .min_by(|a, b| {
            (a.1 - 1e-4).abs().partial_cmp(&(b.1 - 1e-4).abs()).unwrap()
        })
        .unwrap()
        .0;
    check(
        "K coupling from netlist",
        res.data[j][si] / res.data[j][pi_],
        2.0,
        1e-3,
    );
}

#[test]
fn ac_analysis_from_text() {
    let nl = parse(
        "RC low-pass
         V1 in 0 DC 0 AC 1
         R1 in out 1k
         C1 out 0 0.1u
         .ac dec 50 15.9 159000
         .end",
    )
    .unwrap();
    let mut c = build(&nl).unwrap();
    let spec = ac_spec(&nl.analyses[0]).unwrap();
    let res = ac_sweep(&mut c, &spec).unwrap();
    let (mag, phase) = bode(&res, c.index_of("out").unwrap() as usize);
    let fc = 1.0 / (2.0 * PI * 1000.0 * 1e-7);
    let mut k = 0;
    for j in 0..res.freq.len() {
        if (res.freq[j] / fc).ln().abs() < (res.freq[k] / fc).ln().abs() {
            k = j;
        }
    }
    check("netlist AC magnitude at fc", mag[k], -3.0103, 0.05);
    check("netlist AC phase at fc", phase[k], -45.0, 0.5);
}

#[test]
fn transient_from_text_matches_rc_closed_form() {
    let nl = parse(
        "RC step
         V1 in 0 DC 0 PULSE(0 1 0 1p 1p 1 0)
         R1 in out 1k
         C1 out 0 1u
         .tran 10u 5m
         .end",
    )
    .unwrap();
    let mut c = build(&nl).unwrap();
    let mut o = tran_options(&nl.analyses[0]).unwrap();
    o.tmax = Some(2e-5);
    let res = tran(&mut c, &o).unwrap();
    let oi = c.index_of("out").unwrap() as usize;
    let tau = 1e-3;
    for k in [1.0f64, 3.0] {
        let j = res
            .time
            .iter()
            .enumerate()
            .min_by(|a, b| {
                (a.1 - k * tau)
                    .abs()
                    .partial_cmp(&(b.1 - k * tau).abs())
                    .unwrap()
            })
            .unwrap()
            .0;
        check(
            &format!("netlist tran at {k}tau"),
            res.data[j][oi],
            1.0 - (-k).exp(),
            3e-3,
        );
    }
}

#[test]
fn include_pulls_in_a_model_library() {
    let mut resolver = |name: &str| match name {
        "diodes.lib" => Ok(".model DMOD D is=1e-14 n=1\n".to_string()),
        other => Err(format!("no such file: {other}")),
    };
    let nl = parse_with(
        "t
         V1 in 0 DC 5
         R1 in a 1k
         .include diodes.lib
         D1 a 0 DMOD
         .end",
        &mut resolver,
    )
    .unwrap();
    let mut c = build(&nl).unwrap();
    op(&mut c).unwrap();
    assert!(c.voltage("a").unwrap() > 0.5 && c.voltage("a").unwrap() < 0.9);
}

#[test]
fn errors_name_the_offending_line() {
    let nl = parse("t\nR1 a b 1k\nD1 a 0 NOSUCHMODEL\n").unwrap();
    let e = match build(&nl) { Ok(_) => panic!("expected a build error"), Err(e) => e };
    assert_eq!(e.line, 3);
    assert!(e.message.contains("NOSUCHMODEL"), "{}", e.message);

    let nl = parse("t\nX1 a b NOSUCHSUB\n").unwrap();
    let e = match build(&nl) { Ok(_) => panic!("expected a build error"), Err(e) => e };
    assert!(e.message.contains("NOSUCHSUB"), "{}", e.message);

    let nl = parse("t\n.subckt s a b\nR1 a b 1k\n.ends\nX1 a NOSUB s\n").unwrap();
    // Port count mismatch: the subckt takes 2 nodes, 2 given -> fine. Now the
    // genuinely wrong arity:
    let _ = build(&nl);
    let nl = parse("t\n.subckt s a b c\nR1 a b 1k\n.ends\nX1 a b s\n").unwrap();
    let e = match build(&nl) { Ok(_) => panic!("expected a build error"), Err(e) => e };
    assert!(e.message.contains("takes 3 nodes"), "{}", e.message);
}

/// A MOSFET model this core cannot evaluate must be REFUSED, not quietly
/// reinterpreted. LEVEL 1 and LEVEL 3 are implemented; BSIM cards are not, and
/// their parameters are not interchangeable — reading VTO and KP out of one and
/// applying Shichman-Hodges gives a working-looking simulation of a device that
/// does not exist.
#[test]
fn unsupported_mosfet_level_is_rejected() {
    let base = |lvl: &str| {
        format!(
            "t
             VDD d 0 5
             VG g 0 3
             RD d dd 1k
             M1 dd g 0 0 QMOD w=20u l=1u
             .model QMOD NMOS {lvl} VTO=1 KP=2e-5 THETA=0.05 KAPPA=0.5
             .end"
        )
    };

    // LEVEL 1 and LEVEL 3 are implemented; an absent LEVEL defaults to 1.
    for lvl in ["LEVEL=1", "LEVEL=3", ""] {
        let nl = parse(&base(lvl)).unwrap();
        assert!(build(&nl).is_ok(), "LEVEL '{lvl}' should be accepted");
    }

    // LEVEL 2 and the BSIM family are not, and must fail loudly rather than
    // being reinterpreted with parameters that mean something else.
    for lvl in ["LEVEL=2", "LEVEL=49", "LEVEL=54", "LEVEL=8"] {
        let nl = parse(&base(lvl)).unwrap();
        let e = match build(&nl) {
            Ok(_) => panic!("{lvl} was silently accepted"),
            Err(e) => e,
        };
        assert!(
            e.message.contains("LEVEL") && e.message.contains("only LEVEL 1"),
            "{lvl}: unhelpful message: {}",
            e.message
        );
    }
}

/// A three-terminal `M` card is a VDMOS, and must ROUTE rather than be refused.
///
/// The node count for `M` was fixed at 4, so a VDMOS — `M d g s MODEL`, no
/// substrate terminal because its body diode is intrinsic — had its model name
/// eaten as the fourth node, and the card was then reported as "missing model
/// name" with kind INVALID. `invalid` STOPS engine selection, so a power FET
/// placed from the palette was blamed on the user AND blocked from reaching
/// ngspice, which implements it. It emitted exactly this card.
#[test]
fn three_terminal_mosfet_card_is_a_vdmos() {
    let vdmos = "t\nVD d 0 10\nVG g 0 5\nM1 d g 0 PM\n\
                 .model PM VDMOS (nchan Vto=4 Kp=5.9)\n.end";
    let nl = parse(vdmos).unwrap();
    let e = match build(&nl) {
        Ok(_) => panic!("a VDMOS built as if it were a level 1 MOSFET"),
        Err(e) => e,
    };
    assert_eq!(
        e.kind,
        ErrorKind::Unsupported,
        "must stay eligible for the coverage engine, not be called malformed: {}",
        e.message
    );
    assert!(e.message.to_lowercase().contains("vdmos"), "unhelpful: {}", e.message);

    // The four-terminal form must still build here — this is the case the
    // three-terminal rule could most easily break.
    let mos = "t\nVD d 0 5\nVG g 0 3\nM1 d g 0 0 MM w=20u l=2u\n\
               .model MM NMOS (VTO=1 KP=2e-5)\n.end";
    assert!(build(&parse(mos).unwrap()).is_ok(), "a 4-node MOSFET stopped building");
}

/// A `.model` card's TYPE must match the device that references it.
///
/// Every model reader used to pick behaviour with a match ending in `_`, so an
/// unrecognised type silently became the default. `M1 ... SOMEVDMOS` was read
/// as a LEVEL 1 Shichman-Hodges MOSFET, and `LPNP` — which vendor op-amp
/// macromodels use for the lateral PNP — was read as an NPN. Neither errored.
///
/// The card's own parameters cannot save you, because unknown model parameters
/// are deliberately ignored as metadata (see the test below, which is the rule
/// that makes vendor cards loadable at all). So a VDMOS's `rg` and `mtriode`
/// are dropped and its `vto`/`kp` are fed to equations they do not belong to.
///
/// This matters at scale: the KiCad Spice Library carries 4,372 VDMOS cards —
/// the power FETs — plus 2,326 NJF, 2,478 PJF and 3,311 VSWITCH.
///
/// The verdict must be `Unsupported`, not `Invalid`: these are perfectly
/// ordinary SPICE models that ngspice implements, so the netlist has to stay
/// eligible for the coverage engine rather than being called malformed.
#[test]
fn mismatched_model_type_is_rejected() {
    // (element line, model card, the type token that should be reported)
    let cases: &[(&str, &str, &str)] = &[
        ("M1 dd g 0 0 QM", ".model QM VDMOS (VTO=4 KP=2 RG=3 MTRIODE=0.5)", "VDMOS"),
        ("M1 dd g 0 0 QM", ".model QM PMOS (VTO=-1 KP=2e-5)", ""), // legal, see below
        ("Q1 dd g 0 QM", ".model QM LPNP (IS=1e-16 BF=150)", "LPNP"),
        ("Q1 dd g 0 QM", ".model QM NJF (VTO=-2 BETA=1e-3)", "NJF"),
        ("D1 dd 0 QM", ".model QM NPN (IS=1e-16)", "NPN"),
        ("S1 dd 0 g 0 QM", ".model QM VSWITCH (RON=1 ROFF=1e6 VON=2 VOFF=1)", "VSWITCH"),
    ];

    for (elem, card, expect) in cases {
        let text = format!("t\nVDD dd 0 5\nVG g 0 3\n{elem}\n{card}\n.end");
        let nl = parse(&text).unwrap();
        let res = build(&nl);
        if expect.is_empty() {
            assert!(res.is_ok(), "{card}: a matching type must still build");
            continue;
        }
        let e = match res {
            Ok(_) => panic!("{card} was silently accepted by `{elem}`"),
            Err(e) => e,
        };
        assert!(
            e.message.contains(expect),
            "{card}: message does not name the offending type: {}",
            e.message
        );
        assert_eq!(
            e.kind,
            ErrorKind::Unsupported,
            "{card}: must stay eligible for the coverage engine, not be \
             called malformed"
        );
    }
}

/// Real vendor `.model` cards carry non-numeric metadata (`MFG=SIEMENS`,
/// `TYPE=...`, part numbers). SPICE ignores model parameters it does not
/// recognise; aborting on them would make most manufacturer models unloadable.
///
/// But the leniency must not extend to parameters the device actually READS —
/// dropping `IS` and falling back to the default would simulate a different
/// device with no warning.
#[test]
fn model_metadata_is_ignored_but_read_params_are_not() {
    let card = |extra: &str| {
        format!(
            "t
             VCC vcc 0 DC 12
             RB vcc b 470k
             RC vcc c 2.2k
             Q1 c b 0 QM
             .model QM NPN (IS=1e-16 BF=150 VAF=100 {extra})
             .end"
        )
    };

    // Metadata of every shape: bare identifiers, suffixed numbers, unknown keys.
    for extra in [
        "MFG=SIEMENS",
        "VCEO=300 ICRATING=500m MFG=ONSEMI tnom=25",
        "TYPE=SILICON pd_max=0.625 rth0=200",
    ] {
        let nl = parse(&card(extra)).unwrap();
        let mut c = build(&nl).unwrap_or_else(|e| panic!("{extra}: {e}"));
        op(&mut c).unwrap_or_else(|e| panic!("{extra}: op: {e}"));
        // The model still took effect: a biased NPN sits near 0.7 V Vbe.
        let vbe = c.voltage("b").unwrap();
        assert!((0.4..1.0).contains(&vbe), "{extra}: Vbe = {vbe}");
    }

    // A parameter the device reads must evaluate, or the model is refused.
    for bad in ["IS={nosuchparam}", "BF=NOTANUMBER", "VAF={1/}"] {
        let nl = match parse(&card(bad)) {
            Ok(n) => n,
            Err(_) => continue, // malformed at parse time is also acceptable
        };
        match build(&nl) {
            Ok(_) => panic!("{bad} was silently accepted"),
            Err(e) => assert!(
                e.message.contains("this device uses") || e.message.contains("expression"),
                "{bad}: unhelpful message: {}",
                e.message
            ),
        }
    }
}

#[test]
fn analysis_cards_round_trip() {
    let nl = parse("t\nR1 a 0 1k\n.tran 1u 1m 0 0.5u uic\n.end").unwrap();
    match &nl.analyses[0] {
        Analysis::Tran { .. } => {}
        other => panic!("expected tran, got {other:?}"),
    }
    let o = tran_options(&nl.analyses[0]).unwrap();
    assert_eq!(o.tstep, 1e-6);
    assert_eq!(o.tstop, 1e-3);
    assert_eq!(o.tmax, Some(5e-7));
    assert!(o.uic);
}

/// A single-pole op-amp macromodel in the shape vendors actually ship: a
/// `.subckt` with parameters, a differential input sensed by a VCVS, an RC
/// dominant pole, and an output gain stage.
///
/// NOTE ON SCOPE: CLAUDE.md asks that the parser be proved by loading an
/// *unmodified vendor* model and checking open-loop gain against the datasheet.
/// This is not that test — the model below is written here, so it cannot catch
/// syntax that only appears in real vendor files. It exercises the same parser
/// machinery (nested subckts, parameter passing, expression evaluation, model
/// cards), but the vendor-file check is still outstanding and needs a real
/// `.lib` to run against.
const OPAMP_LIB: &str = "
.subckt OPAMP inp inn out params: gain=1e5 fp=10
Rin inp inn 1meg
E1 n1 0 inp inn 1
R1 n1 n2 1k
C1 n2 0 {1/(2*3.14159265358979*fp*1k)}
E2 out 0 n2 0 {gain}
.ends
";

#[test]
fn opamp_macromodel_open_loop_gain_and_pole() {
    let (gain, fp): (f64, f64) = (1e5, 10.0);
    let src = format!(
        "{OPAMP_LIB}
         Vin inp 0 DC 0 AC 1
         X1 inp 0 out OPAMP gain={gain} fp={fp}
         RL out 0 1meg
         .ac dec 20 0.1 10meg
         .end"
    );
    let nl = parse(&src).unwrap_or_else(|e| panic!("parse: {e}"));
    let mut c = build(&nl).unwrap_or_else(|e| panic!("build: {e}"));
    let spec = ac_spec(&nl.analyses[0]).unwrap();
    let res = ac_sweep(&mut c, &spec).unwrap();
    let (mag, phase) = bode(&res, c.index_of("out").unwrap() as usize);

    let at = |f: f64| {
        let mut k = 0;
        for j in 0..res.freq.len() {
            if (res.freq[j] / f).ln().abs() < (res.freq[k] / f).ln().abs() {
                k = j;
            }
        }
        k
    };

    // Open-loop DC gain, well below the pole.
    check("open-loop gain (dB)", mag[at(0.1)], 20.0 * gain.log10(), 0.05);
    // -3 dB at the dominant pole, with -45 degrees of phase.
    check("gain at fp (dB)", mag[at(fp)], 20.0 * gain.log10() - 3.0103, 0.05);
    check("phase at fp (deg)", phase[at(fp)], -45.0, 0.5);
    // Single-pole rolloff: -20 dB per decade above fp.
    check(
        "rolloff a decade past fp",
        mag[at(fp * 10.0)] - mag[at(fp * 100.0)],
        20.0,
        0.2,
    );
    // Unity-gain bandwidth = gain * fp for a single-pole model, so the
    // magnitude must cross 0 dB there.
    check("gain at unity-gain frequency (dB)", mag[at(gain * fp)], 0.0, 0.05);
}

/// The way the macromodel is actually used: closed-loop inverting gain must be
/// -Rf/Rin, independent of the open-loop gain. Two instances also confirm the
/// subcircuit's internal nodes stay separate under real loading.
#[test]
fn opamp_closed_loop_inverting_gain() {
    let src = format!(
        "{OPAMP_LIB}
         Vin in 0 DC 0.1
         Rin in sj 1k
         Rf sj out 10k
         X1 0 sj out OPAMP gain=1e6 fp=10
         .op
         .end"
    );
    let nl = parse(&src).unwrap_or_else(|e| panic!("parse: {e}"));
    let mut c = build(&nl).unwrap_or_else(|e| panic!("build: {e}"));
    op(&mut c).unwrap_or_else(|e| panic!("op: {e}"));
    // Ideal inverting gain -10, so 0.1 V in gives -1 V out. The finite
    // open-loop gain leaves a ~1e-5 relative error, hence the 1e-4 tolerance.
    check("inverting gain", c.voltage("out").unwrap(), -1.0, 1e-4);
    // The summing junction is a virtual ground.
    check("virtual ground", c.voltage("sj").unwrap(), 0.0, 1e-5);
}

/// Two instances of the same macromodel in one circuit, each in a different
/// closed-loop configuration, must not interact.
#[test]
fn two_opamp_instances_stay_independent() {
    let src = format!(
        "{OPAMP_LIB}
         Vin in 0 DC 0.1
         Rin1 in sj1 1k
         Rf1 sj1 o1 10k
         X1 0 sj1 o1 OPAMP gain=1e6 fp=10
         Rin2 o1 sj2 1k
         Rf2 sj2 o2 2k
         X2 0 sj2 o2 OPAMP gain=1e6 fp=10
         .op
         .end"
    );
    let nl = parse(&src).unwrap_or_else(|e| panic!("parse: {e}"));
    let mut c = build(&nl).unwrap_or_else(|e| panic!("build: {e}"));
    op(&mut c).unwrap_or_else(|e| panic!("op: {e}"));
    check("first stage (-10x)", c.voltage("o1").unwrap(), -1.0, 1e-4);
    check("second stage (-2x)", c.voltage("o2").unwrap(), 2.0, 1e-4);
}

/// `PARAMS:` is the PSpice-family keyword introducing a subcircuit parameter
/// list, on the definition, the instance, or both. It carries no information
/// beyond "key=value pairs follow" — but leaving it in the token stream made
/// the token after the subcircuit name look positional, so the name did not
/// resolve and an ordinary vendor macromodel was reported as referencing an
/// undefined subcircuit. Vendor `.lib` files use this spelling constantly.
#[test]
fn pspice_params_keyword_is_accepted() {
    let build = |inst: &str, def: &str| {
        let src = format!(
            "psp\nV1 1 0 DC 1\n{inst}\n{def}\nR1 a b {{RVAL*1000}}\n.ENDS\n.op\n.end"
        );
        let nl = parse(&src).expect("parses");
        let mut c = build(&nl).expect("builds");
        op(&mut c).unwrap();
        // R = V / I, with the source current negative into the source.
        1.0 / -c.current("V1").unwrap()
    };
    let near = |got: f64, want: f64| {
        assert!((got - want).abs() < 1e-6, "got {got}, expected {want}");
    };
    near(build("X1 1 0 SUB1 PARAMS: RVAL=2", ".SUBCKT SUB1 a b PARAMS: RVAL=1"), 2000.0);
    near(build("X1 1 0 SUB1 RVAL=2", ".SUBCKT SUB1 a b PARAMS: RVAL=1"), 2000.0);
    near(build("X1 1 0 SUB1 RVAL=2", ".SUBCKT SUB1 a b RVAL=1"), 2000.0);
    // The definition's default must survive when the instance overrides nothing.
    near(build("X1 1 0 SUB1", ".SUBCKT SUB1 a b PARAMS: RVAL=5"), 5000.0);
}
