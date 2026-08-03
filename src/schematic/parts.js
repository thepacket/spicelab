/**
 * Parts library — parameter sets taken from ngspice.
 *
 * PROVENANCE. Every set below is copied verbatim from a `.model` card in the
 * ngspice source tree, and each part records the exact file it came from in
 * its `source` field. ngspice's COPYING states:
 *
 *   "The ngspice license is the `Modified BSD' license. This is adopted for
 *    all of its source code, test and example files except for the files
 *    listed below."
 *
 * The listed exceptions are all source directories (m4, tclspice.c,
 * maths/sparse, maths/KLU, osdi, ndev, xspice) — none of them are the test or
 * example netlists these cards come from. So these are Modified BSD, and
 * redistributing them here is fine with attribution.
 *
 *   Retrieved:  2026-08-03
 *   Repository: https://github.com/imr/ngspice
 *   Commit:     0a9c4ea799a044cde636adb4d026639bdb3974a0
 *
 * VALIDATION. Every card was run through this project's own solver before
 * being included — diodes into 1k from 5 V, transistors in a common-emitter
 * bias — and the resulting forward drop / Vbe / beta checked for physical
 * sanity. Those measured values are quoted in each `note`, and
 * tests/schematic.test.mjs re-runs the check so a bad edit cannot slip through.
 *
 * NAMING. Labels describe what a part IS ("signal diode") rather than naming a
 * manufacturer part number: a model card is an approximation fitted to one
 * sample of one device, and should not be presented as authoritative for a
 * part you might buy. The originating ngspice model name is preserved in
 * `source`, so the lineage stays auditable.
 *
 * FOR REAL PARTS use `.include` with the manufacturer's own file, downloaded
 * under whatever agreement they attach to it. That keeps the licensing
 * question with the person who accepted the licence.
 *
 * MOSFETs. The core now implements LEVEL 1 (Shichman-Hodges) and LEVEL 3
 * (semi-empirical short-channel), so the two MOSFET parts below are real
 * process models rather than idealised placeholders. Anything else — LEVEL 2,
 * or the BSIM family — is still rejected rather than silently reinterpreted,
 * so a vendor card this core cannot evaluate fails loudly instead of
 * simulating a different device.
 */

/**
 * @typedef {object} Part
 * @property {string} id       stable key, stored in saved documents
 * @property {string} label    shown in the UI
 * @property {string} kind     'diode' | 'npn' | 'pnp'
 * @property {string} model    SPICE .model type token
 * @property {string} params   parameter text, verbatim from the source card
 * @property {string} source   originating ngspice file and model name
 * @property {string} note     what it represents, with measured behaviour
 */

/** @type {Part[]} */
export const PARTS = [
  {
    id: "D_SIGNAL",
    label: "Signal diode (small-signal switching)",
    kind: "diode",
    model: "D",
    // Verbatim from examples/Monte_Carlo/OpWien.sp
    params: "Is=0.1p Rs=16 CJO=2p Tt=12n Bv=100 Ibv=0.4n",
    source: "ngspice examples/Monte_Carlo/OpWien.sp .model D1N914",
    note: "Fast small-signal silicon switching diode: ~0.70 V forward at a few mA. The default for logic clamps, detectors and general signal work.",
  },
  {
    id: "D_SILICON",
    label: "Silicon diode (generic)",
    kind: "diode",
    model: "D",
    // Verbatim from examples/cider/bjt_meclgate.cir
    params: "rs=40 tt=0.1ns cjo=0.9pf n=1 is=1e-14 eg=1.11 vj=0.8 m=0.5",
    source: "ngspice examples/cider/bjt_meclgate.cir .model dmod",
    note: "Plain silicon junction with a higher series resistance: ~0.86 V forward at a few mA. A stand-in when the exact part does not matter.",
  },
  {
    id: "D_SCHOTTKY",
    label: "Schottky diode (low forward drop)",
    kind: "diode",
    model: "D",
    // Verbatim from examples/vdmos/dcdc.sp
    params: "Is=22.6u Rs=.042 N=1.094 Cjo=480p M=.61 Eg=.69 Xti=2",
    source: "ngspice examples/vdmos/dcdc.sp .model MBRS340",
    note: "Schottky barrier: ~0.15 V forward at a few mA and no stored charge, so it switches fast. Note the large junction capacitance.",
  },
  {
    id: "D_ZENER_22V",
    label: "Zener / avalanche diode (22 V)",
    kind: "diode",
    model: "D",
    // Verbatim from examples/various/diode_ac_par.sp
    params: "IS = 1.50E-07 N = 1.0 RS = 9 TT = 100n CJ0 = 1.01p VJ = 0.44 M = 0.5 EG = 1.11 XTI = 3 KF = 0 AF = 1 FC = 0.5 BV = 22 IBV = 10u",
    source: "ngspice examples/various/diode_ac_par.sp .model myd",
    note: "Operated in reverse breakdown as a shunt reference; bv=22 sets the knee. Forward drop is unusually low (~0.31 V) because is is large.",
  },
  {
    id: "D_PIN",
    label: "PIN diode (RF switching)",
    kind: "diode",
    model: "D",
    // Verbatim from examples/numparam/pin.mod
    params: "IS=0.974p RS=0.1 N=1.986196 BV=7.1 IBV=0.1n CJO=99.2p VJ=0.455536 M=0.418717 TT=500n",
    source: "ngspice examples/numparam/pin.mod .model pndiode",
    note: "Thick intrinsic region: ~1.14 V forward, very high capacitance and a 500 ns transit time. Behaves as a current-controlled RF resistor.",
  },
  {
    id: "Q_NPN_GP",
    label: "NPN general purpose (small signal)",
    kind: "npn",
    model: "NPN",
    // Verbatim from examples/noise/bipolar-noise.cir
    params: "is=19f bf=150 vaf=100 ikf=0.18 ise=50p ne=2.5 br=7.5 var=6.4 ikr=12m isc=8.7p nc=1.2 rb=50 re=0.4 rc=0.3 cje=26p tf=0.5n cjc=11p tr=7n xtb=1.5 kf=0.032f af=1",
    source: "ngspice examples/noise/bipolar-noise.cir .model t2n2222",
    note: "The workhorse small-signal NPN: amplifier stages, switches, current sources. Measured beta about 130, Vbe 0.67 V at a few mA.",
  },
  {
    id: "Q_NPN_RF",
    label: "NPN RF / wideband",
    kind: "npn",
    model: "NPN",
    // Verbatim from examples/various/bjt_ac_par.sp
    params: "level=1 IS=0.48F NF=1.008 BF=99.655 VAF=90.000 IKF=0.190 ISE=7.490F NE=1.762 NR=1.010 BR=38.400 VAR=7.000 IKR=93.200M ISC=0.200F NC=1.042 RB=1.500 IRB=0.100M RBM=1.200 RE=0.500 RC=2.680 CJE=1.325P VJE=0.700 MJE=0.220 FC=0.890 CJC=1.050P VJC=0.610 MJC=0.240 XCJC=0.400 TF=56.940P TR=1.000N PTF=21.000 XTF=68.398 VTF=0.600 ITF=0.700 XTB=1.600 EG=1.110 XTI=3.000 KF=1.000F AF=1.000",
    source: "ngspice examples/various/bjt_ac_par.sp .model BFS17",
    note: "High transition frequency for RF and fast switching. Small junction capacitances; measured beta about 95.",
  },
  {
    id: "Q_NPN_POWER",
    label: "NPN power (high voltage)",
    kind: "npn",
    model: "NPN",
    // Verbatim from examples/vdmos/100W.sp
    params: "Is=1.03431e-13 BF=172.974 NF=.939811 VAF=27.3487 IKF=0.0260146 ISE=4.48447e-11 Ne=1.61605 Br=16.6725 Nr=0.796984 VAR=6.11596 IKR=0.10004 Isc=9.99914e-14 Nc=1.99995 RB=1.47761 IRB=0.2 RBM=1.47761 Re=0.0001 RC=1.42228 XTB=2.70726 XTI=1 Eg=1.206 CJE=1e-11 VJE=0.75 Mje=.33 TF=1e-09 XTF=1 VTF=10 ITF=0.01 CJC=1e-11 VJC=.75 MJC=0.33 XCJC=.9 Fc=0.5 CJS=0 VJS=0.75 MJS=0.5 TR=1e-07 PTF=0 KF=1e-15 AF=1",
    source: "ngspice examples/vdmos/100W.sp .model MJE340",
    note: "Amp-class high-voltage NPN. Low beta (about 30 at 1 mA) and slow, as power devices are. Use for output stages and drivers.",
  },
  {
    id: "Q_NPN_IC",
    label: "NPN integrated (BiCMOS process)",
    kind: "npn",
    model: "NPN",
    // Verbatim from examples/cider/parallel_BICMOS.LIB
    params: "is=1.3e-16 nf=1.00 bf=262.5 ikf=25mA vaf=20v nr=1.00 br=97.5 ikr=0.5mA var=1.8v rc=20.0 re=0.09 rb=15.0 ise=4.0e-16 ne=2.1 isc=7.2e-17 nc=2.0 tf=9.4ps itf=26uA xtf=0.5 tr=10ns cje=89.44fF vje=0.95 mje=0.5 cjc=12.82fF vjc=0.73 mjc=0.49",
    source: "ngspice examples/cider/parallel_BICMOS.LIB .model M_GNPN",
    note: "On-chip NPN from a BiCMOS process: tiny geometry, measured beta about 150, femtofarad capacitances, picosecond transit time.",
  },
  {
    id: "Q_PNP_POWER",
    label: "PNP power (high voltage)",
    kind: "pnp",
    model: "PNP",
    // Verbatim from examples/vdmos/100W.sp
    params: "Is=6.01619e-15 BF=157.387 NF=.910131 VAF=23.273 IKF=0.0564808 Ise=4.48479e-12 Ne=1.58557 BR=0.1 NR=1.03823 VAR=4.14543 IKR=.0999978 ISC=1.00199e-13 Nc=1.98851 RB=.1 IRB=0.202965 RBM=0.1 Re=.0710678 Rc=.355339 XTB=1.03638 XTI=3.8424 Eg=1.206 Cje=1e-11 Vje=0.75 Mje=0.33 TF=1e-09 XTF=1 VTF=10 ITF=0.01 Cjc=1e-11 Vjc=0.75 Mjc=0.33 XCJC=0.9 Fc=0.5 Cjs=0 Vjs=0.75 Mjs=0.5 TR=1e-07 PTF=0 KF=1e-15 AF=1",
    source: "ngspice examples/vdmos/100W.sp .model MJE350",
    note: "Complementary partner to the power NPN, for high-side switching and complementary output stages. Measured beta about 70.",
  },
  {
    id: "Q_PNP_IC",
    label: "PNP integrated (BiCMOS process)",
    kind: "pnp",
    model: "PNP",
    // Verbatim from examples/cider/parallel_BICMOS.LIB
    params: "is=5.8e-17 nf=1.001 bf=96.4 ikf=12mA vaf=29v nr=1.0 br=17.3 ikr=0.2mA var=2.0v rc=50.0 re=0.17 rb=20.0 ise=6.8e-17 ne=2.0 isc=9.0e-17 nc=2.1 tf=27.4ps itf=26uA xtf=0.5 tr=10ns cje=55.36fF vje=0.95 mje=0.58 cjc=11.80fF vjc=0.72 mjc=0.46",
    source: "ngspice examples/cider/parallel_BICMOS.LIB .model M_GPNP",
    note: "On-chip PNP complement from the same BiCMOS process. Measured beta about 70.",
  },
  {
    id: 'M_NMOS_CMOS',
    label: 'NMOS (logic process, Level 3)',
    kind: 'nmos',
    model: 'NMOS',
    // Verbatim from examples/digital/compare/74HCng_short_2.lib
    params: 'LEVEL=3 KP=45.3E-6 VTO=0.72 TOX=51.5E-9 NSUB=2.8E15 GAMMA=0.94 PHI=0.65 VMAX=150E3 RS=40 RD=40 XJ=0.11E-6 LD=0.52E-6 DELTA=0.315 THETA=0.054 ETA=0.025 KAPPA=0.0',
    source: 'ngspice examples/digital/compare/74HCng_short_2.lib .model MHCNEN',
    note: 'N-channel from a 74HC-class CMOS logic process. A real Level 3 model: short-channel threshold shift, velocity saturation and gate-field mobility degradation all active.',
  },
  {
    id: 'M_PMOS_CMOS',
    label: 'PMOS (logic process, Level 3)',
    kind: 'pmos',
    model: 'PMOS',
    // Verbatim from examples/digital/compare/74HCng_short_2.lib
    params: 'LEVEL=3 KP=22.1E-6 VTO=-0.71 TOX=51.5E-9 NSUB=3.3E16 GAMMA=0.92 PHI=0.65 VMAX=970E3 RS=80 RD=80 XJ=0.63E-6 LD=0.23E-6 DELTA=2.24 THETA=0.108 ETA=0.322 KAPPA=0.0',
    source: 'ngspice examples/digital/compare/74HCng_short_2.lib .model MHCPEN',
    note: 'P-channel complement from the same 74HC-class process. Lower KP and a larger DELTA, as p-channel devices have.',
  },
];

const BY_ID = new Map(PARTS.map((p) => [p.id, p]));

export function getPart(id) {
  return BY_ID.get(id) ?? null;
}

/** Parts usable for a given symbol type. */
export function partsFor(kind) {
  return PARTS.filter((p) => p.kind === kind);
}

/** The part used when the user has not chosen one. */
export function defaultPartFor(kind) {
  return partsFor(kind)[0] ?? null;
}

/** The `.model` card text for a part, under a given model name. */
export function modelCard(part, name) {
  return `.model ${name} ${part.model} (${part.params})`;
}
