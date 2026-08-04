/**
 * Net extraction, ERC and netlist emission.
 *
 * The cases that matter are the ones where a wrong answer still simulates. A
 * crossing that wrongly connects, a T-junction that wrongly does not, or a
 * transistor whose terminals come out in the wrong order all produce a circuit
 * that solves fine and is not the one on screen. Those get the most attention
 * here; the happy path is comparatively self-checking.
 *
 * The last section closes the loop: schematic -> netlist text -> the real Rust
 * solver -> compared against the same circuit written by hand.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { Schematic } from '../src/schematic/model.js';
import { extractNets, netAt, netNameOfPin, onSegmentInterior } from '../src/schematic/nets.js';
import { checkErc, hasBlockingErrors } from '../src/schematic/erc.js';
import { toNetlist } from '../src/schematic/emit.js';
import { PARTS, getPart, partsFor } from '../src/schematic/parts.js';
import { ART } from '../src/schematic/render.js';
import { SYMBOLS, isDirective } from '../src/schematic/model.js';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [pass] ${name}`); }
  else { fail++; failures.push(`${name}: ${detail}`); console.log(`  [FAIL] ${name} ${detail}`); }
}
const eq = (name, a, b) => check(name, a === b, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

/** Do these two pins end up on the same net? */
function sameNet(sch, a, ai, b, bi) {
  const r = extractNets(sch);
  return netNameOfPin(r, a, ai) === netNameOfPin(r, b, bi);
}

console.log('\nSegment geometry');
{
  const w = { x1: 0, y1: 0, x2: 100, y2: 0 };
  check('interior point is interior', onSegmentInterior(50, 0, w));
  check('endpoint is not interior', !onSegmentInterior(0, 0, w));
  check('far endpoint is not interior', !onSegmentInterior(100, 0, w));
  check('off-line point is not on it', !onSegmentInterior(50, 10, w));
  check('collinear but past the end is not on it', !onSegmentInterior(150, 0, w));
  check('collinear before the start is not on it', !onSegmentInterior(-50, 0, w));
  const d = { x1: 0, y1: 0, x2: 100, y2: 100 };
  check('diagonal interior', onSegmentInterior(50, 50, d));
  check('near-diagonal miss', !onSegmentInterior(50, 40, d));
}

console.log('\nBasic connectivity');
{
  const s = new Schematic();
  const r1 = s.add('resistor', 0, 0, { value: '1k' });   // pins at (0,-20),(0,20)
  const r2 = s.add('resistor', 0, 80, { value: '2k' });  // pins at (0,60),(0,100)
  s.wire(0, 20, 0, 60);
  check('wire joins two pins', sameNet(s, r1, 1, r2, 0));
  check('far pins stay separate', !sameNet(s, r1, 0, r2, 1));
}
{
  const s = new Schematic();
  const r1 = s.add('resistor', 0, 0);
  const r2 = s.add('resistor', 0, 80);
  // Pins touch directly with no wire: (0,20) and (0,60) do not coincide.
  check('non-coincident pins are not connected', !sameNet(s, r1, 1, r2, 0));
}
{
  const s = new Schematic();
  const a = s.add('resistor', 0, 0);
  const b = s.add('resistor', 0, 40); // pin 0 at (0,20) == a pin 1 at (0,20)
  check('coincident pins connect with no wire', sameNet(s, a, 1, b, 0));
}

console.log('\nT-junctions connect implicitly');
{
  const s = new Schematic();
  const r1 = s.add('resistor', 0, 0);      // pin 1 at (0,20)
  const r2 = s.add('resistor', 100, 100);  // pin 0 at (100,80)
  s.wire(0, 20, 200, 20);       // horizontal bus
  s.wire(100, 20, 100, 80);     // stub whose END lands mid-bus
  check('wire ending on another wire connects', sameNet(s, r1, 1, r2, 0));
}
{
  const s = new Schematic();
  const r1 = s.add('resistor', 0, 0);
  // A pin sitting directly on the interior of a wire.
  const probe = s.add('resistor', 100, 40, { rot: 90 }); // pin at (120,40)/(80,40)
  s.wire(0, 20, 200, 20);
  s.wire(80, 40, 80, 20);
  check('pin on a wire interior connects via its stub', sameNet(s, r1, 1, probe, 1));
}

console.log('\nCrossings do NOT connect without a dot');
/**
 * Build an X crossing with one resistor hanging off each wire's far end.
 *   rh pin 1 sits on the horizontal wire's left end  (-200, 0)
 *   rv pin 1 sits on the vertical wire's top end     (0, -200)
 * The two wires cross at the origin, and neither one's endpoint lies on the
 * other, so only an explicit junction dot may join them.
 */
function crossing(withDot) {
  const s = new Schematic();
  s.wire(-200, 0, 200, 0);
  s.wire(0, -200, 0, 200);
  if (withDot) s.junction(0, 0);
  const rh = s.add('resistor', -200, -20);              // pins (-200,-40), (-200,0)
  const rv = s.add('resistor', 20, -200, { rot: 90 });  // pins (40,-200), (0,-200)
  return { s, rh, rv };
}
{
  // The load-bearing case: crossing without a dot must NOT connect.
  const { s, rh, rv } = crossing(false);
  const r = extractNets(s);
  const h = netNameOfPin(r, rh, 1);
  const v = netNameOfPin(r, rv, 1);
  check('the two wires really are attached to their resistors',
        h !== null && v !== null, `${h} / ${v}`);
  check('crossing wires stay on separate nets', h !== v, `both were ${h}`);
}
{
  // ...and DO connect once a junction dot is placed at the crossing.
  const { s, rh, rv } = crossing(true);
  const r = extractNets(s);
  const h = netNameOfPin(r, rh, 1);
  const v = netNameOfPin(r, rv, 1);
  check('a junction dot connects the crossing', h === v, `${h} vs ${v}`);
}

console.log('\nCollinear and overlapping wires');
{
  const s = new Schematic();
  const a = s.add('resistor', -120, 0, { rot: 90 });  // pin at (-100,0)
  const b = s.add('resistor', 220, 0, { rot: 90 });   // pin at (200,0)
  s.wire(-100, 0, 100, 0);
  s.wire(50, 0, 200, 0);    // overlaps the first
  check('overlapping collinear wires merge', sameNet(s, a, 1, b, 0) || sameNet(s, a, 0, b, 0) ||
        sameNet(s, a, 1, b, 1) || sameNet(s, a, 0, b, 1));
}
{
  const s = new Schematic();
  const a = s.add('resistor', -120, 0, { rot: 90 });
  const b = s.add('resistor', 320, 0, { rot: 90 });
  s.wire(-100, 0, 100, 0);
  s.wire(200, 0, 300, 0);   // collinear but disjoint
  const r = extractNets(s);
  const na = netNameOfPin(r, a, 0) ?? netNameOfPin(r, a, 1);
  const nb = netNameOfPin(r, b, 0) ?? netNameOfPin(r, b, 1);
  check('collinear but disjoint wires stay separate', na !== nb, `both ${na}`);
}

console.log('\nGround and labels');
{
  const s = new Schematic();
  const r1 = s.add('resistor', 0, 0);
  s.add('ground', 0, 20);
  const r = extractNets(s);
  eq('ground names the net 0', netNameOfPin(r, r1, 1), '0');
}
{
  const s = new Schematic();
  const r1 = s.add('resistor', 0, 0);
  s.wire(0, 20, 100, 20);
  s.label(100, 20, 'VOUT');
  const r = extractNets(s);
  eq('a label names the net', netNameOfPin(r, r1, 1), 'VOUT');
}
{
  const s = new Schematic();
  const r1 = s.add('resistor', 0, 0);
  s.wire(0, 20, 100, 20);
  s.label(50, 20, 'A');
  s.label(100, 20, 'B');
  const r = extractNets(s);
  check('conflicting labels are reported', r.conflicts.length === 1,
        JSON.stringify(r.conflicts));
  check('one of the two names is used', ['A', 'B'].includes(netNameOfPin(r, r1, 1)));
}
{
  const s = new Schematic();
  const r1 = s.add('resistor', 0, 0);
  s.wire(0, 20, 100, 20);
  s.label(100, 20, 'gnd');
  const r = extractNets(s);
  eq('a gnd label grounds the net', netNameOfPin(r, r1, 1), '0');
}

console.log('\nRotation and mirroring move pins exactly');
{
  const s = new Schematic();
  const c = s.add('resistor', 100, 100, { rot: 90 });
  const p = s.pinPositions(c);
  eq('rotated pin 0 x', p[0].x, 120);
  eq('rotated pin 0 y', p[0].y, 100);
  eq('rotated pin 1 x', p[1].x, 80);
  eq('rotated pin 1 y', p[1].y, 100);

  const q = s.add('npn', 0, 0, { rot: 180 });
  const qp = s.pinPositions(q);
  eq('rotated BJT collector x', qp[0].x, -20);
  eq('rotated BJT collector y', qp[0].y, 20);
  eq('rotated BJT base x', qp[1].x, 20);
}

console.log('\nERC catches the mistakes that would be silent');
{
  const s = new Schematic();
  s.add('resistor', 0, 0, { value: '1k' });
  const issues = checkErc(s, extractNets(s));
  check('missing ground is an error', issues.some((i) => i.code === 'no-ground'));
  check('blocks simulation', hasBlockingErrors(issues));
}
{
  const s = new Schematic();
  const r = s.add('resistor', 0, 0, { value: '1k' });
  s.add('ground', 0, 20);
  const issues = checkErc(s, extractNets(s));
  check('unconnected pin is an error',
        issues.some((i) => i.code === 'unconnected-pin'), JSON.stringify(issues));
}
{
  const s = new Schematic();
  const v = s.add('vsource', 0, 0, { value: 'DC 5' });
  s.wire(0, -20, 0, 20);   // shorts + to -
  s.add('ground', 0, 20);
  const issues = checkErc(s, extractNets(s));
  check('shorted source is an error', issues.some((i) => i.code === 'shorted-source'));
}
{
  const s = new Schematic();
  s.add('vsource', 0, 0, { ref: 'V1', value: 'DC 5' });
  s.add('vsource', 100, 0, { ref: 'V2', value: 'DC 3' });
  s.wire(0, -20, 100, -20);
  s.wire(0, 20, 100, 20);
  s.add('ground', 0, 20);
  const issues = checkErc(s, extractNets(s));
  check('paralleled sources are an error',
        issues.some((i) => i.code === 'parallel-sources'), JSON.stringify(issues.map(i=>i.code)));
}
{
  const s = new Schematic();
  s.add('resistor', 0, 0, { ref: 'R1', value: '1k' });
  s.add('resistor', 100, 0, { ref: 'R1', value: '2k' });
  const issues = checkErc(s, extractNets(s));
  check('duplicate reference is an error', issues.some((i) => i.code === 'duplicate-ref'));
}
{
  const s = new Schematic();
  s.add('resistor', 0, 0, { value: '' });
  const issues = checkErc(s, extractNets(s));
  check('missing value is an error', issues.some((i) => i.code === 'missing-value'));
}

console.log('\nRound trip: schematic -> netlist -> real solver');
{
  // A 10 V source across a 1k/3k divider, drawn as geometry.
  //
  // The routing has to avoid running a wire alongside a component, which would
  // short it. An earlier version of this test did exactly that and emitted
  // `R1 N1 N1` — the extractor was right and the drawing was wrong, which is
  // precisely the confusion this round trip exists to expose.
  const s = new Schematic();
  const v1 = s.add('vsource', 0, 0, { ref: 'V1', value: 'DC 10' });
  const r1 = s.add('resistor', 200, -40, { ref: 'R1', value: '1k' });  // (200,-60),(200,-20)
  const r2 = s.add('resistor', 200, 40, { ref: 'R2', value: '3k' });   // (200,20),(200,60)
  s.add('ground', 0, 20);

  // V+ up and across to the top of R1.
  s.wire(0, -20, 0, -60);
  s.wire(0, -60, 200, -60);
  // R1 bottom straight down to R2 top: this is the divider midpoint.
  s.wire(200, -20, 200, 20);
  // R2 bottom back across and up to V- / ground.
  s.wire(200, 60, 0, 60);
  s.wire(0, 60, 0, 20);
  // Label the midpoint. (200,0) is interior to the R1-R2 wire.
  s.label(200, 0, 'MID');

  const { netlist, issues, ok } = toNetlist(s, {
    title: 'divider from schematic',
    analyses: ['.op'],
  });
  console.log(netlist.split('\n').map((l) => '      ' + l).join('\n'));
  check('ERC clean', ok, JSON.stringify(issues.map((i) => i.code + ':' + i.message)));

  const require = createRequire(import.meta.url);
  const wasm = require('../src/wasm-node/spicelab_wasm.js');
  const sess = wasm.Session.fromNetlist(netlist);
  sess.solveOp();
  const view = new Float64Array(wasm.memory.buffer, sess.stagingPtr, sess.stagingLen);
  const labels = sess.labels().split('\n');
  const mid = view[1 + labels.indexOf('MID')];
  check('solver agrees with the hand-written divider',
        Math.abs(mid - 7.5) < 1e-9, `V(MID) = ${mid}`);
}

console.log('\nEvery palette part emits a simulatable netlist');
{
  // REGRESSION: the emitter used to write `<ref>_MOD` and never define it, so
  // every diode, BJT and MOSFET placed from the palette produced a netlist
  // that failed to build. A dangling model reference is not a default.
  const require2 = createRequire(import.meta.url);
  const wasm2 = require2('../src/wasm-node/spicelab_wasm.js');

  const build = (type, ref, props = {}) => {
    const s = new Schematic();
    s.add('vsource', -200, 0, { ref: 'V1', value: 'DC 5' });
    s.add('resistor', -60, -60, { ref: 'R1', value: '1k', rot: 90 });
    s.add(type, 60, 0, { ref, props });
    s.add('ground', -200, 60);
    s.wire(-200, -20, -200, -60);
    s.wire(-200, -60, -80, -60);
    s.wire(-40, -60, 60, -60);
    s.wire(60, -60, 60, -20);
    s.wire(60, 20, 60, 60);
    s.wire(60, 60, -200, 60);
    s.wire(-200, 60, -200, 20);
    return s;
  };

  // Two-terminal semiconductors wire cleanly into the test harness above.
  for (const type of ['diode']) {
    const b = toNetlist(build(type, 'D1'), { title: 'palette' });
    check(`${type}: ERC clean straight from the palette`, b.ok,
          JSON.stringify(b.issues.map((i) => i.code)));
    check(`${type}: netlist defines the model it references`,
          /^\.model /m.test(b.netlist), b.netlist);
    let ok = true, msg = '';
    try {
      const sess = wasm2.Session.fromNetlist(b.netlist + '\n.op\n.end');
      sess.solveOp();
    } catch (e) { ok = false; msg = e.message; }
    check(`${type}: builds and solves`, ok, msg);
  }

  // Every library part must parse AND bias physically. Parsing alone is not
  // enough: a card can load fine and describe a device that cannot conduct.
  const solveOp = (netlist) => {
    const sess = wasm2.Session.fromNetlist(netlist);
    sess.solveOp();
    const row = new Float64Array(wasm2.memory.buffer, sess.stagingPtr, sess.stagingLen);
    const L = sess.labels().split('\n');
    return (n) => row[1 + L.indexOf(n)];
  };

  // Parts whose device the INTERACTIVE core does not implement, so there is no
  // honest bias check to run here — they route to ngspice, and that is where
  // they are checked (tests/ngspice-diff.test.mjs). Named explicitly rather
  // than skipped by a default branch, so adding a part to a kind that has no
  // check cannot pass silently: the assertion below fails on an unknown kind.
  const COVERAGE_ONLY = new Set(['njf', 'pjf', 'nvdmos', 'pvdmos']);

  let bad = null;
  for (const p of PARTS) {
    try {
      if (COVERAGE_ONLY.has(p.kind)) {
        // Still assert the claim the part makes about itself: a VDMOS states
        // its polarity in the parameters, and getting that backwards would put
        // a p-channel card on an n-channel symbol.
        if (p.kind === 'pvdmos' && !/\bpchan\b/i.test(p.params)) {
          bad = `${p.id}: p-channel part without pchan in its card`;
        } else if (p.kind === 'nvdmos' && /\bpchan\b/i.test(p.params)) {
          bad = `${p.id}: n-channel part whose card says pchan`;
        }
        continue;
      }
      if (p.kind === 'sw') {
        // The switch must actually switch, and must do it at the threshold the
        // card states rather than at 0 V. Control below vt-vh: open, so the
        // divider sits at the source. Above vt+vh: closed, so it collapses.
        const rig = (vc) => solveOp(
          ['t', 'V1 in 0 DC 5', `VC c 0 DC ${vc}`, 'R1 in a 100k',
           'S1 a 0 c 0 M', `.model M ${p.model} (${p.params})`, '.end'].join('\n'));
        const open = rig(0)('a'), closed = rig(5)('a');
        if (!(open > 4.9)) bad = `${p.id}: control low, V(a) = ${open} (not open)`;
        else if (!(closed < 0.2)) bad = `${p.id}: control high, V(a) = ${closed} (not closed)`;
        continue;
      }
      if (p.kind === 'diode') {
        // 5 V through 1k: the forward drop must be physical for a junction.
        const v = solveOp(['t', 'V1 in 0 DC 5', 'R1 in a 1k', 'D1 a 0 M',
                           `.model M ${p.model} (${p.params})`, '.end'].join('\n'));
        const vf = v('a');
        if (!(vf > 0.1 && vf < 1.4)) bad = `${p.id}: Vf = ${vf}`;
      } else if (p.kind === 'nmos' || p.kind === 'pmos') {
        // Resistor-loaded common-source stage, polarity flipped for PMOS.
        const sgn = p.kind === 'nmos' ? 1 : -1;
        const v = solveOp(['t', `VDD vdd 0 DC ${5 * sgn}`, `VG g 0 DC ${3 * sgn}`,
                           'RD vdd d 5k', 'M1 d g 0 0 M w=20u l=2u',
                           `.model M ${p.model} (${p.params})`, '.end'].join('\n'));
        const vd = sgn * v('d');
        // The stage must actually amplify: the drain has to sit inside the
        // rails, not pinned at either end.
        if (!(vd > 0.05 && vd < 4.95)) bad = `${p.id}: V(d) = ${vd} (not in rail)`;
      } else if (p.kind === 'npn' || p.kind === 'pnp') {
        // Common-emitter bias, polarity flipped for PNP.
        const sgn = p.kind === 'npn' ? 1 : -1;
        const v = solveOp(['t', `VCC vcc 0 DC ${12 * sgn}`, 'RB vcc b 470k',
                           'RC vcc c 2.2k', 'Q1 c b 0 M',
                           `.model M ${p.model} (${p.params})`, '.end'].join('\n'));
        const vbe = sgn * v('b'), vc = sgn * v('c');
        const ic = (12 - vc) / 2200;
        if (!(vbe > 0.4 && vbe < 1.0)) bad = `${p.id}: Vbe = ${vbe}`;
        else if (!(vc > 0 && vc < 12)) bad = `${p.id}: Vc = ${vc} (not in rail)`;
        else if (!(ic > 0)) bad = `${p.id}: Ic = ${ic}`;
      } else {
        // No default branch. This loop used to end in a bare `else` that ran
        // the BJT rig, so a part of any new kind would have been biased as a
        // transistor and, if it happened to pass, reported as validated. That
        // is the same shape as the `_` arm this session removed from the Rust
        // model readers: an unrecognised case silently treated as the default.
        bad = `${p.id}: kind '${p.kind}' has no bias check in this suite`;
      }
    } catch (e) { if (!bad) bad = `${p.id}: ${e.message}`; }
    if (bad) break;
  }
  check('every library part parses AND biases physically', bad === null, bad ?? '');

  // Every device symbol needs its own drawing. `drawComponent` used to fall
  // back to `ART.resistor` for a type with no art, so adding a device and
  // forgetting the drawing showed a RESISTOR where a transistor is — the
  // picture disagreeing with the netlist, which is precisely what drawing
  // through the same transform as `pinPositions` exists to prevent. The
  // fallback is now a crossed box that cannot be mistaken for a component,
  // and this check means it should never be reached.
  //
  // Directives and subcircuits are excluded because the renderer draws them
  // through their own paths (`_drawDirective`, `_drawSubckt`), not through ART.
  const needsArt = Object.keys(SYMBOLS)
    .filter((t) => !isDirective(t) && t !== 'subckt');
  check('every device symbol has its own drawing',
        needsArt.every((t) => typeof ART[t] === 'function'),
        JSON.stringify(needsArt.filter((t) => typeof ART[t] !== 'function')));

  // EVERY symbol must be placeable from the palette.
  //
  // A component's `type` is fixed once placed — `partsFor` offers only parts of
  // that kind, and `assignPart` refuses a kind mismatch, both correctly, since
  // a PNP card on an NPN symbol simulates happily and answers wrongly. So a
  // symbol with no palette button is not merely inconvenient, it is
  // UNREACHABLE. `pnp`, `pmos`, `pjf` and `pvdmos` all were: the symbols, the
  // art and validated built-in cards existed, and nothing could place one.
  //
  // Reading the palette out of the HTML is deliberately crude. The alternative
  // is asserting a hand-written list, which is the same list that was wrong.
  {
    const html = readFileSync(new URL('../demo/editor.html', import.meta.url), 'utf8');
    const placeable = new Set(
      [...html.matchAll(/data-place="([a-z0-9]+)"/gi)].map((m) => m[1]));
    const missing = Object.keys(SYMBOLS).filter((t) => !placeable.has(t));
    check('every symbol has a palette button', missing.length === 0,
          `unreachable from the editor: ${JSON.stringify(missing)}`);
    // And the reverse: a button for a symbol that does not exist would throw
    // on click.
    const bogus = [...placeable].filter((t) => !SYMBOLS[t]);
    check('every palette button names a real symbol', bogus.length === 0,
          JSON.stringify(bogus));
  }

  // Instance parameters must reach the SOLVER, not just the netlist text.
  //
  // W and L were unreachable from the editor: the property panel offered a
  // part picker and nothing else, so every MOSFET emitted `M1 d g s b MODEL`
  // and took the core's default L = W = 100u. The default is SPICE's own
  // DEFL/DEFW and is correct; being unable to override it is not, because W/L
  // is the design parameter of a MOSFET. This suite hid it: the bias rig above
  // passes `w=20u l=2u` directly, so it was checking geometry the editor could
  // not produce.
  //
  // A level 1 device in saturation has Id proportional to W/L, so doubling L
  // must halve the current — an exact ratio, not merely "a different number".
  {
    const idFor = (inst) => {
      const nl = ['geom',
                  'VDD d 0 DC 5',
                  'VG g 0 DC 3',
                  `M1 d g 0 0 MM ${inst}`,
                  '.model MM NMOS (LEVEL=1 VTO=1 KP=2e-5 LAMBDA=0)',
                  '.op', '.end'].join('\n');
      const sess = wasm2.Session.fromNetlist(nl);
      sess.solveOp();
      const row = new Float64Array(wasm2.memory.buffer, sess.stagingPtr, sess.stagingLen);
      const L = sess.labels().split('\n');
      return Math.abs(row[1 + L.indexOf('I(VDD)')]);
    };
    const wide = idFor('w=20u l=2u');
    const long = idFor('w=20u l=4u');
    const none = idFor('');
    check('geometry reaches the solver', wide > 0 && Math.abs(wide - none) / wide > 0.1,
          `w=20u l=2u gave ${wide}, no geometry gave ${none}`);
    check('doubling L halves the current, as Id ~ W/L',
          Math.abs(long / wide - 0.5) < 1e-6, `ratio ${long / wide}`);
  }

  // Provenance must stay attached: these are redistributed under ngspice's
  // Modified BSD, which requires attribution.
  check('every part records its ngspice source',
        PARTS.every((p) => /^ngspice \S+ \.model \S+$/.test(p.source)),
        JSON.stringify(PARTS.find((p) => !/^ngspice /.test(p.source))?.source));
  check('no part claims a manufacturer part number as its label',
        PARTS.every((p) => !/\b(1N\d|2N\d|BC\d|BF\w|MJE\d|MBR)/i.test(p.label)),
        JSON.stringify(PARTS.find((p) => /\b(1N\d|2N\d)/i.test(p.label))?.label));

  // Two instances of one part must emit ONE card, not a duplicate definition.
  const s2 = new Schematic();
  s2.add('vsource', -200, 0, { ref: 'V1', value: 'DC 5' });
  s2.add('diode', 0, 0, { ref: 'D1' });
  s2.add('diode', 100, 0, { ref: 'D2' });
  s2.add('ground', -200, 60);
  const n2 = toNetlist(s2, { title: 't' }).netlist;
  eq('one model card for two instances of the same part',
     (n2.match(/^\.model D_SIGNAL /gm) ?? []).length, 1);

  // An explicit model name (from an .include) must NOT get a generated card.
  const s3 = new Schematic();
  s3.add('diode', 0, 0, { ref: 'D1', props: { model: 'MY1N4148' } });
  const n3 = toNetlist(s3, { title: 't' }).netlist;
  check('an external model name emits no card', !/^\.model /m.test(n3), n3);
  check('and is referenced by name', /D1 \S+ \S+ MY1N4148/.test(n3), n3);

  check('parts are offered per symbol type',
        partsFor('diode').length >= 3 && partsFor('npn').length >= 2);
  check('part ids resolve', PARTS.every((p) => getPart(p.id) === p));
}

console.log('\nPicking a net by clicking');
{
  // The probe tool clicks the MIDDLE of a wire, which is not a declared lattice
  // point, so an exact point lookup finds nothing. netAt must fall back to
  // wire-body hit testing or probing silently does nothing.
  const s = new Schematic();
  s.add('resistor', 0, 0);
  s.wire(0, 20, 200, 20);
  s.label(200, 20, 'OUT');
  const r = extractNets(s);
  eq('click mid-wire resolves the net', netAt(s, r, 100, 20)?.name, 'OUT');
  eq('click on a wire end resolves', netAt(s, r, 200, 20)?.name, 'OUT');
  eq('click just off the wire misses', netAt(s, r, 100, 30)?.name ?? null, null);
  eq('click in empty space misses', netAt(s, r, 900, 900)?.name ?? null, null);

  // Two separate nets must not be confused by proximity.
  const t = new Schematic();
  t.wire(0, 0, 100, 0);
  t.wire(0, 40, 100, 40);
  t.label(0, 0, 'A');
  t.label(0, 40, 'B');
  const tr = extractNets(t);
  eq('picks the nearer of two parallel wires', netAt(t, tr, 50, 2)?.name, 'A');
  eq('and the other one', netAt(t, tr, 50, 38)?.name, 'B');

  check('every wire maps to a net', t.wires.every((w) => tr.netOfWire.has(w.id)));
}

console.log('\nWire routing (pure, no DOM)');
{
  const { routeOrthogonal } = await import('../src/schematic/editor.js');
  eq('same point routes nothing', routeOrthogonal(10, 10, 10, 10).length, 0);
  eq('horizontal is one segment', routeOrthogonal(0, 0, 100, 0).length, 1);
  eq('vertical is one segment', routeOrthogonal(0, 0, 0, 100).length, 1);

  const L = routeOrthogonal(0, 0, 100, 50);
  eq('diagonal becomes two segments', L.length, 2);
  check('segments are orthogonal',
        L.every((s) => s.x1 === s.x2 || s.y1 === s.y2), JSON.stringify(L));
  check('segments are contiguous', L[0].x2 === L[1].x1 && L[0].y2 === L[1].y1);
  check('route ends where asked', L[1].x2 === 100 && L[1].y2 === 50);

  // Off-grid input must be snapped: an endpoint one unit off a pin is an open
  // circuit that looks closed.
  const S = routeOrthogonal(3, 4, 97, 52);
  check('endpoints land on the grid',
        [S[0].x1, S[0].y1, S.at(-1).x2, S.at(-1).y2].every((v) => v % 10 === 0),
        JSON.stringify(S));
}

console.log(`\n${'-'.repeat(72)}`);

// ------------------------------------------- analyses as placed components

console.log('\nAnalyses on the canvas');
{
  const build = () => {
    const s = new Schematic();
    s.add('vsource', 0, 0, { value: 'DC 5' });
    s.add('resistor', 40, 0, { value: '1k' });
    s.add('ground', 0, 40);
    s.wire(0, -20, 40, -20); s.wire(0, 20, 0, 40); s.wire(40, 20, 0, 20);
    return s;
  };

  const s = build();
  const t = s.add('tran', 100, 0);
  check('a placed analysis seeds its declared defaults',
        t.props.tstep === '10u' && t.props.tstop === '5m', JSON.stringify(t.props));
  check('it is enabled by default', t.enabled === true);

  let out = toNetlist(s);
  check('the card appears in the netlist', /^\.tran 10u 5m$/m.test(out.netlist), out.netlist);
  check('and is reported to the caller', out.analyses.includes('.tran 10u 5m'),
        JSON.stringify(out.analyses));
  check('an analysis is not an ERC error for having no value',
        !out.issues.some((i) => i.code === 'missing-value'),
        JSON.stringify(out.issues.map((i) => i.code)));

  // The point of putting them on the canvas: they disable like any part.
  t.enabled = false;
  out = toNetlist(s);
  check('a disabled analysis emits nothing', !/\.tran/.test(out.netlist), out.netlist);
  check('and is not reported as an analysis', out.analyses.length === 0,
        JSON.stringify(out.analyses));

  // Same flag, same effect, on an ordinary part.
  const s2 = build();
  const r2 = s2.add('resistor', 80, 0, { ref: 'R9', value: '2k' });
  check('an enabled part is emitted', /R9/.test(toNetlist(s2).netlist));
  r2.enabled = false;
  check('a disabled part is skipped', !/R9/.test(toNetlist(s2).netlist));

  // Two enabled analyses of one kind is ambiguous — warn, do not fail.
  const s3 = build();
  s3.add('tran', 100, 0);
  s3.add('tran', 140, 0);
  const dup = toNetlist(s3).issues.find((i) => i.code === 'duplicate-analysis');
  check('two enabled analyses of a kind warn', !!dup);
  check('and only warn, so the run still happens', dup?.severity === 'warning', dup?.severity);

  // A blank required parameter would emit a malformed card.
  const s4 = build();
  const a4 = s4.add('ac', 100, 0);
  a4.props.points = '';
  check('a blank analysis parameter is an error',
        toNetlist(s4).issues.some((i) => i.code === 'analysis-param'));
  // tstart is declared optional and must NOT be demanded.
  const s5 = build();
  s5.add('tran', 100, 0);
  check('an optional parameter left blank is fine',
        !toNetlist(s5).issues.some((i) => i.code === 'analysis-param'));

  // Persistence.
  const s6 = build();
  const t6 = s6.add('tran', 100, 0);
  t6.props.tstop = '3m';
  t6.enabled = false;
  const back = Schematic.fromJSON(JSON.parse(JSON.stringify(s6.toJSON())));
  const r6 = back.components.find((c) => c.type === 'tran');
  check('props survive save/reload', r6.props.tstop === '3m', r6.props.tstop);
  check('enabled survives save/reload', r6.enabled === false, String(r6.enabled));

  // Documents written before `enabled` existed must load as enabled, or every
  // component in every older file would silently vanish from the netlist.
  const legacy = Schematic.fromJSON({
    components: [{ id: 'c1', type: 'resistor', ref: 'R1', value: '1k', x: 0, y: 0, props: {} }],
  });
  check('a component saved without `enabled` loads enabled',
        legacy.components[0].enabled === true, String(legacy.components[0].enabled));
}


// ------------------------------------------------- subcircuit instances

console.log('\nSubcircuit instances');
{
  const { pinsOf, subcktPins } = await import('../src/schematic/model.js');
  const s = new Schematic();
  const x = s.add('subckt', 0, 0, {
    ref: 'X1', props: { name: 'OPA', pins: 'in+ in- out' },
  });

  check('pins come from the instance, not the symbol',
        pinsOf(x).map((p) => p.name).join(',') === 'in+,in-,out',
        JSON.stringify(pinsOf(x).map((p) => p.name)));
  check('a symbol with fixed pins is unaffected',
        pinsOf(s.add('resistor', 60, 0, { value: '1k' })).length === 2);

  // Pin ORDER is the netlist contract for a macromodel, exactly as terminal
  // order is for a transistor. Both separators are accepted because vendors
  // write `.subckt` lines both ways.
  check('commas and spaces both split', subcktPins('a, b,c  d').join('|') === 'a|b|c|d',
        subcktPins('a, b,c  d').join('|'));
  check('pin order is preserved',
        pinsOf(x)[0].name === 'in+' && pinsOf(x)[2].name === 'out');
  x.props.pins = 'out in- in+';
  check('reordering the list reorders the pins',
        pinsOf(x)[0].name === 'out', pinsOf(x)[0].name);
  x.props.pins = 'in+ in- out';

  // The X card, with nodes in declaration order.
  const s2 = new Schematic();
  s2.add('subckt', 0, 0, { ref: 'X1', props: { name: 'OPA', pins: 'a b c' } });
  s2.add('ground', 0, 100);
  const out = toNetlist(s2);
  check('emits an X card naming the subcircuit', /^X1 .* OPA$/m.test(out.netlist), out.netlist);
  check('with one node per declared pin',
        (out.netlist.match(/^X1 (\S+) (\S+) (\S+) OPA$/m) ?? []).length === 4, out.netlist);

  // A macromodel goes from the downloaded library to an emitted X card with
  // its pin order intact and NOTHING retyped in between.
  //
  // The editor used to place only the text block and instruct the user to
  // create a Subcircuit and re-enter the pin list "in declaration order". That
  // was the most dangerous step in the flow: pin order is the netlist
  // contract, transposing two pins wires the part differently and simulates
  // perfectly happily, and the correct order had already been parsed off the
  // `.subckt` line. This asserts the order survives the whole path, which is
  // the property that made the manual step worth deleting.
  {
    const { parseDefinitions } = await import('../src/schematic/model-library.js');
    // Vendor shape: continuation lines, a PARAMS: list, CRLF, mixed case.
    const src = [
      '* a vendor macromodel',
      '.SUBCKT OP_AMP_X 3 2 7 4 6 PARAMS: GBW=10Meg',
      'R1 3 2 1meg',
      '.ENDS',
    ].join('\r\n');
    const def = parseDefinitions(src, 'Models/Manufacturer/X/opamp.lib')
      .find((d) => d.kind === 'subckt');
    check('the library parses the macromodel', !!def, JSON.stringify(def));
    check('and recovers its pins in declaration order',
          def.pins.join(' ') === '3 2 7 4 6', JSON.stringify(def?.pins));

    // Exactly what the editor now does with that record.
    const s5 = new Schematic();
    s5.add('subckt', 0, 0, {
      ref: 'X1', props: { name: def.name, pins: def.pins.join(' ') },
    });
    s5.add('ground', 0, 200);
    const card = toNetlist(s5).netlist.split('\n').find((l) => l.startsWith('X1'));
    check('the placed instance has one node per declared pin',
          card.split(/\s+/).length === 7, card);
    check('and names the subcircuit the library found',
          card.endsWith(def.name), card);
    check('the pin count survives the round trip',
          pinsOf(s5.components[0]).length === def.pins.length, card);
  }

  // A subcircuit has no value field, like a semiconductor.
  check('no missing-value error for a subcircuit',
        !out.issues.some((i) => i.code === 'missing-value'),
        JSON.stringify(out.issues.map((i) => i.code)));

  // But it must name something and have pins.
  const s3 = new Schematic();
  s3.add('subckt', 0, 0, { props: { name: '', pins: '' } });
  s3.add('ground', 0, 100);
  const codes = toNetlist(s3).issues.map((i) => i.code);
  check('an unnamed subcircuit is an error', codes.includes('subckt-name'), JSON.stringify(codes));
  check('a pinless subcircuit is an error', codes.includes('subckt-pins'), JSON.stringify(codes));

  // Raw SPICE text blocks: the escape hatch that makes a macromodel usable in a
  // browser, where there is no filesystem for `.include`.
  const s4 = new Schematic();
  s4.add('ground', 0, 100);
  s4.add('spice', 0, 0, { props: { text: '.subckt OPA a b c\nR1 a c 1meg\n.ends' } });
  const t4 = toNetlist(s4).netlist;
  check('raw text is emitted verbatim', /\.subckt OPA a b c/.test(t4) && /\.ends/.test(t4), t4);
  check('and multi-line text keeps its lines', t4.split('\n').filter((l) => /R1 a c/.test(l)).length === 1, t4);
}


// ---------------------------------------------- naming a model defined elsewhere

console.log('\nA model defined in a SPICE text block');
{
  const mk = (props, text) => {
    const s = new Schematic();
    s.add('vsource', -200, 0, { ref: 'V1', value: 'DC 5' });
    s.add('ground', -200, 60);
    s.add('npn', 60, 0, { ref: 'Q1', props });
    if (text != null) s.add('spice', 0, 200, { props: { text } });
    return s;
  };

  // Naming a model emits the REFERENCE and no card of its own — the card comes
  // from the text block.
  const s = mk({ model: 'QVEND' }, '.model QVEND NPN (IS=1e-16 BF=200)');
  const out = toNetlist(s).netlist;
  check('the instance names the model', /^Q?Q1 \S+ \S+ \S+ QVEND$/m.test(out), out);
  check('and no card is invented for it',
        (out.match(/^\.model /gm) ?? []).length === 1, out);

  // The trap this enforcement exists for: `resolveModel` only honours
  // props.model when props.part is unset, so a component carrying both must
  // not silently emit the part's card while the panel shows a model name.
  const both = toNetlist(mk({ model: 'QVEND', part: 'Q_NPN_GP' },
                            '.model QVEND NPN (IS=1e-16 BF=200)')).netlist;
  check('with a part also set, the part wins — and that is visible',
        !/ QVEND$/m.test(both), both);

  // ERC must name the component, not leave the parser to complain about
  // generated text.
  const missing = mk({ model: 'QTYPO' }, '.model QVEND NPN (IS=1e-16)');
  const codes = checkErc(missing, extractNets(missing)).map((i) => i.code);
  check('an undefined model is reported at the component',
        codes.includes('undefined-model'), JSON.stringify(codes));
  const ok = mk({ model: 'QVEND' }, '.model QVEND NPN (IS=1e-16)');
  check('a defined one is not',
        !checkErc(ok, extractNets(ok)).map((i) => i.code).includes('undefined-model'));
  // A warning, not a blocker: this check can only see this sheet.
  check('it does not block simulation',
        !hasBlockingErrors(checkErc(missing, extractNets(missing)).filter(
          (i) => i.code === 'undefined-model')));
}

console.log(`\n${'-'.repeat(72)}\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  ' + f);
  process.exit(1);
}
