/**
 * Probe resolution, routing and persistence.
 *
 * The behaviour worth protecting is late binding. A probe names a NET, not a
 * column, so editing the circuit must either keep the probe pointing at the
 * same signal or say plainly that it cannot — never silently start reading
 * whatever now occupies that column index. That failure would look exactly like
 * a working scope showing a wrong trace.
 */
import { createRequire } from 'node:module';
import { Probe, ProbeKind, ProbeSet } from '../src/instruments/probe.js';
import { eng } from '../src/instruments/instruments.js';
import { Schematic } from '../src/schematic/model.js';
import { toNetlist } from '../src/schematic/emit.js';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [pass] ${name}`); }
  else { fail++; failures.push(`${name}: ${detail}`); console.log(`  [FAIL] ${name} ${detail}`); }
}
const eqv = (name, a, b) =>
  check(name, a === b, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
const near = (name, a, b, tol = 1e-9) =>
  check(name, Math.abs(a - b) <= tol, `got ${a}, expected ${b}`);

const LABELS = ['in', 'out', 'I(V1)'];

console.log('\nProbe resolution');
{
  const p = new Probe({ kind: ProbeKind.VOLTAGE, target: 'out' });
  const r = p.resolve(LABELS);
  check('voltage probe resolves', r.ok);
  eqv('unit is volts', r.unit, 'V');
  // Row layout: [v_in, v_out, i_v1]
  const row = new Float64Array([1.0, 0.4, -0.0006]);
  near('reads the right column', r.read(row, 0), 0.4);
  eqv('default label', p.label, 'V(out)');
}
{
  const p = new Probe({ kind: ProbeKind.CURRENT, target: 'V1' });
  const r = p.resolve(LABELS);
  check('current probe finds I(V1)', r.ok);
  eqv('unit is amps', r.unit, 'A');
  near('reads the branch column', r.read(new Float64Array([1, 0.4, -6e-4]), 0), -6e-4);
}
{
  const p = new Probe({ kind: ProbeKind.CURRENT, target: 'R1' });
  const r = p.resolve(LABELS);
  check('current probe on a resistor is refused', !r.ok);
  check('and says why', /branch current/.test(r.reason), r.reason);
}
{
  const p = new Probe({
    kind: ProbeKind.DIFFERENTIAL, target: 'in', target2: 'out',
  });
  const r = p.resolve(LABELS);
  check('differential resolves', r.ok);
  near('computes the difference', r.read(new Float64Array([1.0, 0.4, 0]), 0), 0.6);
  eqv('default differential label', p.label, 'V(in,out)');
}
{
  const p = new Probe({ kind: ProbeKind.DIFFERENTIAL, target: 'in', target2: '0' });
  const r = p.resolve(LABELS);
  check('ground is a valid differential reference', r.ok);
  near('ground reads as zero', r.read(new Float64Array([2.5, 0, 0]), 0), 2.5);
}

console.log('\nLate binding survives (or reports) an edit');
{
  const p = new Probe({ kind: ProbeKind.VOLTAGE, target: 'out' });
  // Same nets, different column order — as happens when the topology changes.
  const reordered = ['out', 'in', 'I(V1)'];
  const r = p.resolve(reordered);
  check('follows the net when columns move', r.ok);
  near('reads the NEW column for the same net',
       r.read(new Float64Array([0.4, 1.0, 0]), 0), 0.4);
}
{
  const p = new Probe({ kind: ProbeKind.VOLTAGE, target: 'deleted_net' });
  const r = p.resolve(LABELS);
  check('a vanished net is reported, not silently mis-read', !r.ok);
  check('and names the net', /deleted_net/.test(r.reason), r.reason);
}

console.log('\nAC layout: interleaved re/im');
{
  const p = new Probe({ kind: ProbeKind.VOLTAGE, target: 'out' });
  const r = p.resolve(LABELS);
  // One AC row: [freq, re_in, im_in, re_out, im_out, re_i, im_i]
  const row = new Float64Array([1000, 1, 0, 0.6, -0.8, 0, 0]);
  near('real part of the right unknown', r.read(row, 1, 2, 0), 0.6);
  near('imaginary part of the right unknown', r.read(row, 1, 2, 1), -0.8);

  const d = new Probe({ kind: ProbeKind.DIFFERENTIAL, target: 'in', target2: 'out' })
    .resolve(LABELS);
  near('differential real part', d.read(row, 1, 2, 0), 0.4);
  near('differential imaginary part', d.read(row, 1, 2, 1), 0.8);
}

console.log('\nRouting');
{
  const set = new ProbeSet();
  const a = set.add({ kind: ProbeKind.VOLTAGE, target: 'out' });
  const b = set.add({ kind: ProbeKind.VOLTAGE, target: 'in' });

  set.route('scope', a.id);
  set.route('scope', b.id);
  set.route('meter', a.id);

  eqv('scope sees two probes', set.routedTo('scope').length, 2);
  eqv('meter sees one', set.routedTo('meter').length, 1);
  check('one probe feeds two instruments',
        set.isRouted('scope', a.id) && set.isRouted('meter', a.id));
  eqv('unrouted instrument sees none', set.routedTo('bode').length, 0);

  set.route('scope', b.id, false);
  eqv('unrouting works', set.routedTo('scope').length, 1);

  b.enabled = false;
  set.route('scope', b.id, true);
  eqv('disabled probes are excluded', set.routedTo('scope').length, 1);

  // Deleting must not leave a dangling route.
  set.remove(a.id);
  eqv('probe removed from every instrument', set.routedTo('scope').length, 0);
  eqv('and from the meter', set.routedTo('meter').length, 0);
}

console.log('\nPersistence');
{
  const set = new ProbeSet();
  const a = set.add({ kind: ProbeKind.VOLTAGE, target: 'out', label: 'Output' });
  const b = set.add({ kind: ProbeKind.CURRENT, target: 'V1' });
  set.route('scope', a.id);
  set.route('bode', a.id);
  set.route('meter', b.id);

  const json = JSON.parse(JSON.stringify(set.toJSON()));
  const back = ProbeSet.fromJSON(json);

  eqv('probe count survives', back.probes.length, 2);
  eqv('custom label survives', back.get(a.id).label, 'Output');
  eqv('kind survives', back.get(b.id).kind, ProbeKind.CURRENT);
  eqv('scope routing survives', back.routedTo('scope').length, 1);
  eqv('bode routing survives', back.routedTo('bode').length, 1);
  eqv('meter routing survives', back.routedTo('meter').length, 1);

  // New probes after a load must not collide with loaded ids.
  const c = back.add({ kind: ProbeKind.VOLTAGE, target: 'in' });
  check('fresh ids do not collide', !back.probes.filter((p) => p.id === c.id)[1],
        c.id);
}

console.log('\nEngineering formatting');
{
  eqv('millivolts', eng(0.0123, 'V', 3), '12.3 mV');
  eqv('kilohms', eng(4700, 'ohm', 3), '4.70 kohm');
  eqv('microamps', eng(1.5e-6, 'A', 2), '1.5 uA');
  eqv('zero', eng(0, 'V'), '0 V');
  eqv('picofarads', eng(2.2e-12, 'F', 2), '2.2 pF');
}

console.log('\nAgainst a real solved circuit');
{
  const s = new Schematic();
  s.add('vsource', -100, 0, { ref: 'V1', value: 'DC 10' });
  s.add('resistor', 100, -40, { ref: 'R1', value: '1k' });
  s.add('resistor', 100, 40, { ref: 'R2', value: '3k' });
  s.add('ground', -100, 60);
  s.wire(-100, -20, -100, -60);
  s.wire(-100, -60, 100, -60);
  s.wire(100, -20, 100, 20);
  s.wire(100, 60, -100, 60);
  s.wire(-100, 60, -100, 20);
  s.label(100, 0, 'MID');
  s.label(-100, -60, 'TOP');

  const { netlist, ok } = toNetlist(s, { title: 'probe test' });
  check('schematic is clean', ok, netlist);

  const require = createRequire(import.meta.url);
  const wasm = require('../src/wasm-node/spicelab_wasm.js');
  const sess = wasm.Session.fromNetlist(netlist + '\n.op\n.end');
  sess.solveOp();
  const labels = sess.labels().split('\n');
  const row = new Float64Array(wasm.memory.buffer, sess.stagingPtr, sess.stagingLen);
  // Row is [t, ...unknowns]; probes index the unknown vector, so base = 1.
  const solution = row.subarray(1);

  const vmid = new Probe({ kind: ProbeKind.VOLTAGE, target: 'MID' }).resolve(labels);
  check('MID resolves against the real run', vmid.ok, vmid.reason ?? '');
  near('divider midpoint is 7.5 V', vmid.read(solution, 0), 7.5, 1e-9);

  const diff = new Probe({
    kind: ProbeKind.DIFFERENTIAL, target: 'TOP', target2: 'MID',
  }).resolve(labels);
  near('drop across R1 is 2.5 V', diff.read(solution, 0), 2.5, 1e-9);

  const i = new Probe({ kind: ProbeKind.CURRENT, target: 'V1' }).resolve(labels);
  check('source current resolves', i.ok, i.reason ?? '');
  near('current is 10V / 4k', Math.abs(i.read(solution, 0)), 2.5e-3, 1e-12);
}

console.log(`\n${'-'.repeat(72)}`);

// --------------------------------------------------- colour resolves late

console.log('\nProbe colour follows the theme');
{
  const { probeColor } = await import('../src/instruments/probe.js');
  const { setTheme, SERIES } = await import('../src/schematic/render.js');

  setTheme('dark');
  const darkFirst = SERIES[0];
  const slot0 = new Probe({ kind: ProbeKind.VOLTAGE, target: 'out', colorIndex: 0 });
  check('a palette slot resolves to the dark palette', probeColor(slot0) === darkFirst,
        `${probeColor(slot0)} vs ${darkFirst}`);

  setTheme('light');
  const lightFirst = SERIES[0];
  check('the two palettes actually differ', darkFirst !== lightFirst,
        `${darkFirst} === ${lightFirst}`);
  check('the SAME probe now resolves to the light palette',
        probeColor(slot0) === lightFirst, `${probeColor(slot0)} vs ${lightFirst}`);

  // An explicit choice must NOT be repainted by a theme change.
  const explicit = new Probe({ kind: ProbeKind.VOLTAGE, target: 'out', color: '#ff00ff' });
  check('an explicit colour survives the theme', probeColor(explicit) === '#ff00ff',
        probeColor(explicit));
  setTheme('dark');
  check('and survives switching back', probeColor(explicit) === '#ff00ff',
        probeColor(explicit));

  // Documents saved before colorIndex existed carry a hex and must keep working.
  const legacy = Probe.fromJSON({ id: 'p9', kind: 'voltage', target: 'out', color: '#58a6ff' });
  check('a legacy saved probe keeps its stored colour',
        probeColor(legacy) === '#58a6ff', probeColor(legacy));

  // And one saved with neither falls back to its position rather than throwing.
  const bare = Probe.fromJSON({ id: 'p8', kind: 'voltage', target: 'out' });
  check('a probe with no colour at all resolves by position',
        probeColor(bare, 2) === SERIES[2], `${probeColor(bare, 2)} vs ${SERIES[2]}`);

  const round = Probe.fromJSON(JSON.parse(JSON.stringify(slot0.toJSON())));
  check('colorIndex round-trips through save/load', round.colorIndex === 0,
        String(round.colorIndex));
}


// ------------------------------------------ resolving across both engines

console.log('\nProbes resolve on either engine');
{
  // The two engines report the same quantities under different names and in a
  // different case. A probe is a saved object that outlives a routing decision,
  // so it must resolve on both — otherwise re-routing a design to the coverage
  // engine silently breaks its instrumentation, with an error message that
  // sounds correct ("net no longer exists") about a net that plainly does.
  const rustLabels = ['in', 'out', 'X1.m', 'I(V1)', 'I(L1)'];
  const ngLabels   = ['I(v1)', 'I(l1)', 'x1.m', 'out', 'in'];

  const cases = [
    ['node voltage', new Probe({ kind: ProbeKind.VOLTAGE, target: 'out' })],
    ['hierarchical node', new Probe({ kind: ProbeKind.VOLTAGE, target: 'X1.m' })],
    ['branch current', new Probe({ kind: ProbeKind.CURRENT, target: 'V1' })],
    ['inductor current', new Probe({ kind: ProbeKind.CURRENT, target: 'L1' })],
    ['differential', new Probe({ kind: ProbeKind.DIFFERENTIAL, target: 'in', target2: 'out' })],
  ];
  for (const [name, p] of cases) {
    check(`${name} resolves on the Rust core`, p.resolve(rustLabels).ok,
          p.resolve(rustLabels).reason);
    check(`${name} resolves on ngspice`, p.resolve(ngLabels).ok,
          p.resolve(ngLabels).reason);
  }

  // Same probe, same value, whichever engine produced the row. Columns are in
  // a different ORDER on the two engines, so this also proves resolution is by
  // name rather than by position.
  const rustRow = [1.0, 0.25, 0.5, -1e-3, 2e-3];      // in out X1.m I(V1) I(L1)
  const ngRow   = [-1e-3, 2e-3, 0.5, 0.25, 1.0];      // I(v1) I(l1) x1.m out in
  const readBoth = (p) => [
    p.resolve(rustLabels).read(rustRow, 0),
    p.resolve(ngLabels).read(ngRow, 0),
  ];
  for (const [name, p] of cases) {
    const [a, b] = readBoth(p);
    check(`${name} reads the same value on both`, Math.abs(a - b) < 1e-15,
          `rust ${a} vs ngspice ${b}`);
  }

  // And a genuinely missing net must STILL be reported. Case-insensitive
  // matching must not degrade into matching anything.
  const gone = new Probe({ kind: ProbeKind.VOLTAGE, target: 'nosuchnet' });
  check('a missing net is still reported', !gone.resolve(ngLabels).ok);
  const noBranch = new Probe({ kind: ProbeKind.CURRENT, target: 'R1' });
  check('a device with no branch current is still reported',
        !noBranch.resolve(ngLabels).ok);
}

console.log(`${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  ' + f);
  process.exit(1);
}
