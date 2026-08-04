/**
 * KiCad legacy `.lib` symbol parsing.
 *
 * Nothing from the KiCad symbol library is vendored — that is the whole point
 * of the feature — so these fixtures are written by hand to reproduce the
 * records that library actually contains, taken from the shapes of `Device.lib`
 * and `Amplifier_Operational.lib`.
 *
 * The load-bearing case is the Y NEGATION. KiCad measures Y upward and canvas
 * measures it downward, so every coordinate flips. Get it wrong and a symbol
 * is mirrored vertically — which on an op-amp swaps `+` and `-`, giving a
 * schematic that reads as one circuit and simulates as another. That is this
 * project's characteristic failure, so the op-amp's input order is asserted
 * against its geometry rather than against itself.
 */
import { parseSymbolLib, symbolPins, symbolBounds, drawSymbol, SCALE }
  from '../src/schematic/symbol-library.js';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [pass] ${name}`); }
  else { fail++; failures.push(`${name}: ${detail}`); console.log(`  [FAIL] ${name} ${detail}`); }
}
const eq = (name, a, b) =>
  check(name, a === b, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
const near = (name, a, b, tol = 1e-9) =>
  check(name, Math.abs(a - b) <= tol, `got ${a}, expected ${b}`);

// Shapes taken from the real library's records.
const LIB = `EESchema-LIBRARY Version 2.4
#encoding utf-8
#
# R
#
DEF R R 0 0 N Y 1 F N
F0 "R" 80 0 50 V V C CNN
F1 "R" 0 0 50 V V C CNN
DRAW
S -40 -100 40 100 0 1 10 N
X ~ 1 0 150 50 D 50 50 1 1 P
X ~ 2 0 -150 50 U 50 50 1 1 P
ENDDRAW
ENDDEF
#
# Opamp_Dual_Generic
#
DEF Opamp_Dual_Generic U 0 5 Y Y 3 F N
F0 "U" 0 200 50 H V L CNN
F1 "Opamp_Dual_Generic" 0 -200 50 H V L CNN
ALIAS LM358 TL072
DRAW
P 4 0 1 10 -200 200 200 0 -200 -200 -200 200 f
X ~ 1 300 0 100 L 50 50 1 1 O
X + 2 -300 100 100 R 50 50 1 1 I
X - 3 -300 -100 100 R 50 50 1 1 I
X V+ 4 -100 300 150 D 50 50 0 1 W
X V- 5 -100 -300 150 U 50 50 0 1 W
X ~ 7 300 0 100 L 50 50 2 1 O
X + 5 -300 100 100 R 50 50 2 1 I
X - 6 -300 -100 100 R 50 50 2 1 I
P 4 2 1 10 -200 200 200 0 -200 -200 -200 200 f
S -10 -10 10 10 1 2 10 N
T 0 0 0 50 0 0 1 IGNORED Normal 0 C C
B 4 0 1 0 0 0 1 1 2 2 3 3 N
ENDDRAW
ENDDEF
#
# BrokenDef
#
DEF
ENDDEF
#
# L
#
DEF L L 0 0 N N 1 F N
F0 "L" -50 0 50 V V C CNN
DRAW
A 0 -75 25 -899 899 0 1 0 N 0 -100 0 -50
A 0 -25 25 -899 899 0 1 0 N 0 -50 0 0
C 0 60 8 0 1 0 F
X ~ 1 0 100 0 D 50 50 1 1 P
X ~ 2 0 -100 0 U 50 50 1 1 P
ENDDRAW
ENDDEF
`;

const lib = parseSymbolLib(LIB);

console.log('\nParsing');
{
  check('the resistor is found', lib.has('r'));
  check('the op-amp is found', lib.has('opamp_dual_generic'));
  check('the inductor is found', lib.has('l'));
  // An alias is a distinct part sharing one drawing; over 2,000 of the real
  // library's names exist only this way, so dropping them loses most of it.
  check('an alias resolves to the same drawing', lib.has('lm358') && lib.has('tl072'));
  eq('and keeps its own name', lib.get('tl072').name, 'TL072');
  eq('while sharing the pins', lib.get('tl072').pins.length, 5);

  // A dual or quad part is ONE DEF carrying several units. Merging them
  // stacked both halves and returned EIGHT pins for a dual op-amp, two of them
  // a duplicated + and -. Found by parsing the REAL Amplifier_Operational.lib,
  // not by these fixtures — which is why the fixture now carries a unit 2.
  const oaSym = lib.get('opamp_dual_generic');
  eq('the unit count is recorded', oaSym.units, 3);
  eq('only unit 1 and shared pins are kept', oaSym.pins.length, 5);
  check('no pin number appears twice',
        new Set(oaSym.pins.map((p) => p.num)).size === oaSym.pins.length,
        JSON.stringify(oaSym.pins.map((p) => p.num)));
  check('the second unit body is not drawn on top of the first',
        oaSym.shapes.filter((x) => x.k === 'poly').length === 1,
        JSON.stringify(oaSym.shapes.map((x) => x.k)));
  check('the De Morgan alternate body is skipped too',
        !oaSym.shapes.some((x) => x.k === 'rect'),
        JSON.stringify(oaSym.shapes.map((x) => x.k)));

  // Tolerance in both directions: an unknown record must not kill a symbol,
  // but a malformed DEF must not swallow the file either.
  eq('T and B records are skipped, not fatal',
     lib.get('opamp_dual_generic').shapes.length, 1);
  check('a malformed DEF drops only itself', !lib.has('brokendef') && lib.has('l'));
}

console.log('\nGeometry: KiCad Y is UP, canvas Y is DOWN');
{
  const r = symbolPins(lib.get('r'));
  eq('pins come back in pin-number order', r.map((p) => p.num).join(','), '1,2');
  // KiCad puts pin 1 at y=+150 (above). On canvas that must be NEGATIVE y.
  near('pin 1 is above the body on screen', r[0].y, -150 * SCALE);
  near('pin 2 is below it', r[1].y, 150 * SCALE);
  near('and the scale is the editor grid', r[0].y, -30);
  check('an unnamed pin falls back to its number', r[0].name === '1', r[0].name);

  // The one that matters. `+` is pin 2 at KiCad y=+100, so it must land ABOVE
  // `-` (pin 3, y=-100) on screen. If the negation were dropped, the op-amp
  // would be mirrored and every circuit using it would invert.
  const oa = symbolPins(lib.get('opamp_dual_generic'));
  const plus = oa.find((p) => p.name === '+');
  const minus = oa.find((p) => p.name === '-');
  check('the op-amp keeps + above -', plus.y < minus.y,
        `+ at ${plus.y}, - at ${minus.y}`);
  check('both inputs are on the left', plus.x < 0 && minus.x < 0,
        `${plus.x}, ${minus.x}`);
  check('the output is on the right', oa.find((p) => p.num === '1').x > 0);
  check('the supplies are top and bottom',
        oa.find((p) => p.name === 'V+').y < 0 && oa.find((p) => p.name === 'V-').y > 0);
}

console.log('\nBounds');
{
  const b = symbolBounds(lib.get('r'));
  check('bounds enclose the pins', b.y1 <= -30 && b.y2 >= 30, JSON.stringify(b));
  check('and the body', b.x1 <= -40 * SCALE && b.x2 >= 40 * SCALE, JSON.stringify(b));
  // A symbol with no drawing at all must still get a usable box rather than
  // Infinity, which would make hit-testing match everywhere.
  const empty = symbolBounds({ shapes: [], pins: [] });
  check('an empty symbol gets a finite fallback box',
        Number.isFinite(empty.x1) && Number.isFinite(empty.y2), JSON.stringify(empty));
}

console.log('\nDrawing exercises every primitive');
{
  // A recording context: proves each shape reaches the canvas, and that the
  // arc's direction flag is set (the half that is easy to forget, and which
  // silently draws the arc's complement).
  const calls = [];
  const g = new Proxy({}, {
    get: (_, k) => (...a) => { calls.push([String(k), ...a]); },
  });
  for (const name of ['l', 'r', 'opamp_dual_generic']) drawSymbol(g, lib.get(name));
  check('rectangles are drawn', calls.some((c) => c[0] === 'rect'));
  check('polylines are drawn', calls.some((c) => c[0] === 'lineTo'));
  const arcs = calls.filter((c) => c[0] === 'arc');
  check('arcs and circles are drawn', arcs.length >= 3, String(arcs.length));
  check('arcs sweep anticlockwise to undo the Y flip',
        arcs.some((c) => c[6] === true), JSON.stringify(arcs[0]));
  check('a filled shape is filled', calls.some((c) => c[0] === 'fill'));
}

console.log(`\n${'-'.repeat(72)}\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  ' + f);
  process.exit(1);
}
