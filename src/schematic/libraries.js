/**
 * Where to get SPICE models and circuits that SpiceLab cannot ship.
 *
 * ## Why this is a list of links rather than a bundled library
 *
 * Almost every large model collection is aggregated vendor material. A
 * manufacturer publishes a `.lib` so you can simulate their part — that is what
 * it is for, and downloading and using one is exactly the intended use. What
 * they generally do NOT grant is the right to redistribute it inside someone
 * else's product.
 *
 * This is not a copyleft question and accepting GPL does not change it: a
 * repository that collects vendor models grants nothing its author never held.
 * So the models stay on the vendor's server and on the user's disk, and
 * SpiceLab points at them.
 *
 * ## How they are used
 *
 * There is no filesystem in a browser, so `.include "vendor.lib"` cannot reach
 * a file. Instead the contents go into a **SPICE text block** on the canvas
 * (`Blocks -> SPICE text`), and a `subckt` block instantiates the macromodel.
 * `Import model file…` does the download-to-canvas step in one go, reading the
 * file locally — it is never uploaded anywhere.
 *
 * ## `licence` values
 *
 *   'permissive'  redistributable; we could bundle it if we wanted to
 *   'download'    free to fetch and use, NOT ours to redistribute
 *   'mixed'       an aggregation; individual files carry their own terms
 *
 * `verified` records whether the licence was read from the source itself in
 * this repository's history, or is only what the site claims. Do not upgrade a
 * `false` to `true` without actually reading a LICENSE file.
 */

/** @typedef {{name:string, url:string, what:string, licence:string,
 *             verified:boolean, note?:string}} LibrarySource */

/** @type {LibrarySource[]} */
export const MODEL_SOURCES = [
  {
    name: 'ngspice model parameters',
    url: 'https://ngspice.sourceforge.io/modelparams.html',
    what: 'Starter model cards for diodes, BJTs, MOSFETs and more',
    licence: 'permissive',
    verified: true,
    note: 'Modified BSD, read from ngspice\'s COPYING. The parts library ' +
          'already in SpiceLab comes from here.',
  },
  {
    name: 'KiCad Spice Library',
    url: 'https://github.com/kicad-spice-library/KiCad-Spice-Library',
    what: '50,093 models — 97,187 .model cards and 38,898 .subckt macromodels',
    licence: 'mixed',
    verified: true,
    note: 'The largest collection there is, and the best proxy for real vendor ' +
          'parts. It carries a GPLv3 notice it had no right to grant: 1,080 ' +
          'files assert vendor copyright (Toshiba, ON Semi, Cree and others) ' +
          'and its own README admits the provenance. Download and use freely; ' +
          'do not redistribute.',
  },
  {
    name: 'Xyce regression suite',
    url: 'https://github.com/Xyce/Xyce_Regression',
    what: '4,113 netlists with the richest directive coverage anywhere',
    licence: 'permissive',
    verified: true,
    note: 'GPLv3 — but the linked COPYING file is missing from the repo, and ' +
          '18 files are third-party. Excellent as a parser corpus.',
  },
  {
    name: 'SpiceSharpParser tests',
    url: 'https://github.com/SpiceSharp/SpiceSharpParser',
    what: 'Cookbook circuits plus ~650 netlists embedded in its test suite',
    licence: 'permissive',
    verified: true,
    note: 'MIT — the cleanest licence found. Covers ako: inheritance, .MEAS, ' +
          '.FUNC and .APPENDMODEL.',
  },
  {
    name: 'GF180MCU PDK',
    url: 'https://github.com/google/gf180mcu-pdk',
    what: 'Open 180 nm process kit; dense parser stressors per byte',
    licence: 'permissive',
    verified: true,
    note: 'Apache 2.0. Nested .if/.else, sectioned .lib, agauss, temper. ' +
          'Needs the coverage engine — BSIM4 is not in the interactive core.',
  },
  {
    name: 'IHP SG13G2 PDK',
    url: 'https://github.com/IHP-GmbH/IHP-Open-PDK',
    what: 'Open 130 nm SiGe BiCMOS kit',
    licence: 'permissive',
    verified: true,
    note: 'Apache 2.0. Note its files are ISO-8859-1, not UTF-8.',
  },
  {
    name: 'Analog Devices models',
    url: 'https://www.analog.com/en/resources/design-tools-and-calculators/spice-models.html',
    what: 'Op-amps, references, amplifiers — mostly .subckt macromodels',
    licence: 'download',
    verified: false,
  },
  {
    name: 'Texas Instruments models',
    url: 'https://www.ti.com/design-resources/design-tools-simulation/models-simulators.html',
    what: 'Op-amps, regulators, power devices',
    licence: 'download',
    verified: false,
  },
  {
    name: 'SkyWater SKY130 PDK',
    url: 'https://github.com/google/skywater-pdk',
    what: 'A complete open process design kit with real BSIM4 model cards',
    licence: 'permissive',
    verified: false,
    note: 'Reported Apache 2.0 — genuinely redistributable, unlike vendor ' +
          'part libraries. Needs the coverage engine.',
  },
];

/** @type {LibrarySource[]} */
export const CIRCUIT_SOURCES = [
  {
    name: 'ngspice test suite',
    url: 'https://sourceforge.net/p/ngspice/ngspice/ci/master/tree/tests/',
    what: '~575 netlists covering most of SPICE syntax',
    licence: 'permissive',
    verified: true,
    note: 'Modified BSD. SpiceLab uses these as a parser conformance corpus ' +
          '(tests/corpus.test.mjs).',
  },
  {
    name: 'SPICE netlist datasets (symbench)',
    url: 'https://github.com/symbench/spice-datasets',
    what: '6,521 netlists scraped from KiCad projects and LTspice examples',
    licence: 'mixed',
    verified: true,
    note: 'Carries a GPLv3 sticker but its own README disclaims the content ' +
          'copyright — the LTspice half is Analog Devices\'. Local testing ' +
          'only. Reading it is what found the micro-sign bug.',
  },
  {
    name: 'eCircuit Center',
    url: 'https://www.ecircuitcenter.com/Circuits.htm',
    what: '106 clean textbook circuits with explanations',
    licence: 'download',
    verified: true,
    note: 'Copyright asserted, nothing granted. Good for learning, not for ' +
          'bundling.',
  },
  {
    name: 'All About Circuits example netlists',
    url: 'https://www.allaboutcircuits.com/textbook/reference/chpt-7/example-circuits-and-netlists/',
    what: 'Small pre-tested netlists, good for learning the format',
    licence: 'download',
    verified: false,
  },
];

/** Human-readable summary of what a licence value permits. */
export const LICENCE_NOTE = {
  permissive: 'redistributable',
  download: 'free to download and use; not ours to redistribute',
  mixed: 'aggregated — check the individual file',
};
