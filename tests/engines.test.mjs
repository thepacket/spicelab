/**
 * Engine contract and selection policy.
 *
 * The behaviour under test is one rule, and it is a safety rule rather than a
 * convenience: `invalid` stops the search, `unsupported` continues it. Getting
 * that backwards means a malformed netlist silently falls through to a second
 * parser that might accept it and simulate a different circuit — which is this
 * project's characteristic failure mode.
 */
import { createRequire } from 'node:module';
import { select, rustCanRun, YES } from '../src/worker/engines.js';

const require = createRequire(import.meta.url);
const wasm = require('../src/wasm-node/spicelab_wasm.js');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [pass] ${name}`); }
  else { fail++; failures.push(`${name}: ${detail}`); console.log(`  [FAIL] ${name} ${detail}`); }
}
const eq = (name, a, b) => check(name, a === b, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

// ---------------------------------------------------------------- classifier

console.log('\nRust core classifies its own refusals');
{
  const canRun = rustCanRun(wasm.Session);
  const v = (src) => canRun(src);

  eq('a good netlist runs',
     v('d\nV1 in 0 DC 1\nR1 in 0 1k\n.op\n.end').kind, 'yes');

  // Valid SPICE this core does not implement. These must NOT be reported as
  // broken netlists — they are the whole reason a second engine exists.
  eq('BSIM4 model is unsupported, not invalid',
     v('b\nVD d 0 1\nM1 d d 0 0 n\n.model n NMOS level=14\n.op\n.end').kind, 'unsupported');
  eq('JFET is unsupported, not invalid',
     v('j\nVD d 0 1\nJ1 d 0 0 n\n.model n NJF\n.op\n.end').kind, 'unsupported');
  eq('.noise is unsupported, not invalid',
     v('n\nV1 in 0 AC 1\nR1 in 0 1k\n.noise v(in) V1 dec 10 1 1k\n.end').kind, 'unsupported');

  // Genuinely broken. A bigger engine must not be given these.
  eq('a malformed card is invalid',
     v('x\nV1 in 0 DC 1\nR1 in\n.op\n.end').kind, 'invalid');
  eq('an undefined model reference is invalid',
     v('u\nVD d 0 1\nD1 d 0 NOPE\n.op\n.end').kind, 'invalid');

  // A file we cannot fetch is a THIRD kind. The netlist is fine and no other
  // engine can help — a browser has no filesystem — so it must neither be
  // called broken nor fall through.
  eq('an unfetchable .include is unresolved, not invalid',
     v('i\nV1 a 0 1\n.include vendor.lib\nR1 a 0 1k\n.op\n.end').kind, 'unresolved');
  // Commas separate parameters in SPICE, and real vendor models use them.
  eq('a comma-separated model card parses',
     v('c\nV1 a 0 DC 1\nD1 a 0 DEN\n.MODEL DEN D(IS=1E-12, RS=14.61K, AF=1)\n.op\n.end').kind,
     'yes');

  const bad = v('x\nV1 in 0 DC 1\nR1 in\n.op\n.end');
  check('the diagnosis names the line', bad.line === 3, `line ${bad.line}`);
  check('the diagnosis carries a message', /2 nodes/.test(bad.message ?? ''), bad.message);
}

// ------------------------------------------------------------------ policy

console.log('\nSelection policy');
{
  const fast = {
    id: 'fast', label: 'Fast', interactive: true,
    canRun: (n) => (n.includes('BSIM') ? { kind: 'unsupported', message: 'no BSIM' }
                  : n.includes('BROKEN') ? { kind: 'invalid', message: 'line 3: broken' }
                  : YES),
  };
  const wide = {
    id: 'wide', label: 'Wide', interactive: false,
    canRun: () => YES,
  };
  const engines = [fast, wide];

  const a = select(engines, 'plain netlist');
  eq('the preferred engine wins when it can run', a.engine?.id, 'fast');
  eq('nothing is rejected in that case', a.rejected.length, 0);

  const b = select(engines, 'uses BSIM');
  eq('unsupported falls through to the next engine', b.engine?.id, 'wide');
  eq('and the rejection is recorded', b.rejected[0]?.id, 'fast');
  check('the reason explains the fallback', /cannot/.test(b.reason), b.reason);

  // The rule this file exists for.
  const c = select(engines, 'BROKEN netlist');
  eq('invalid does NOT fall through', c.engine, null);
  eq('and reports the first engine’s diagnosis', c.verdict.kind, 'invalid');
  check('the fallback was never consulted', c.rejected.length === 1,
        `consulted ${c.rejected.length}`);
  check('the reason says the netlist is bad, not that engines are missing',
        /not valid/.test(c.reason), c.reason);

  // With no fallback registered, an unsupported design must say so clearly
  // rather than looking like a broken netlist.
  const d = select([fast], 'uses BSIM');
  eq('no engine available', d.engine, null);
  eq('reported as unsupported', d.verdict.kind, 'unsupported');
  check('the reason distinguishes it from a bad netlist',
        /no available engine/.test(d.reason), d.reason);

  // `unresolved` must stop the search like `invalid`, but say something the
  // user can act on rather than calling their netlist broken.
  const fast2 = {
    id: 'fast', label: 'Fast', interactive: true,
    canRun: () => ({ kind: 'unresolved', message: '`.include vendor.lib` requires a resolver' }),
  };
  const u = select([fast2, wide], 'anything');
  eq('unresolved does not fall through', u.engine, null);
  check('the fallback was never consulted', u.rejected.length === 1, `${u.rejected.length}`);
  check('and the message names the remedy', /SPICE text block/.test(u.reason), u.reason);
  check('it does NOT claim the netlist is invalid', !/not valid/.test(u.reason), u.reason);

  eq('an empty registry is reported, not thrown', select([], 'x').engine, null);
}

// --------------------------------------------------------- real engine wiring

console.log('\nThe Rust core satisfies the contract');
{
  const { SimEngine } = await import('../src/worker/engine.js');
  const e = new SimEngine({ Session: wasm.Session, memory: () => wasm.memory, emit: () => {} });
  for (const m of ['canRun', 'load', 'attachRing', 'op', 'tran', 'ac', 'resume', 'pause', 'cancel']) {
    check(`implements ${m}()`, typeof e[m] === 'function');
  }
  // Optional in the contract, so an engine that cannot sweep is reported by
  // name rather than throwing "undefined is not a function" at the user.
  check('implements the optional dc()', typeof e.dc === 'function');

  // The sweep must be RIGHT, not merely present. A 1k/1k divider is exactly
  // half the source at every point, so both the slope and the endpoints are
  // known in closed form. `dc_sweep` has been fixture-verified since the first
  // port; what was never checked is this path — the wasm wrapper, the staging
  // buffer and the row shape — because none of it existed.
  {
    e.load('divider\nV1 in 0 DC 0\nR1 in mid 1k\nR2 mid 0 1k\n.op\n.end');
    const res = e.dc({ source: 'V1', start: 0, stop: 10, step: 1 });
    eq('a sweep produces one row per step', res.points, 11);
    // The transient row shape, NOT AC's interleaved re/im. This is what lets
    // the probe system and the renderer stay ignorant of which analysis ran.
    eq('rows are [x, v0, v1, ...]', res.stride, 1 + e.session.numUnknowns);

    const labels = e.load('divider\nV1 in 0 DC 0\nR1 in mid 1k\nR2 mid 0 1k\n.op\n.end').labels;
    // Labels are bare net names — `mid`, not `V(mid)`. `Probe.resolve` is what
    // knows about the `V(...)` spelling, at the engine boundary.
    const mid = labels.indexOf('mid');
    check('the swept node is in the labels', mid >= 0, JSON.stringify(labels));
    const r2 = e.dc({ source: 'V1', start: 0, stop: 10, step: 1 });
    const at = (k) => r2.data[k * r2.stride + 1 + mid];
    const x = (k) => r2.data[k * r2.stride];
    check('x carries the swept value, not the row index',
          Math.abs(x(0) - 0) < 1e-12 && Math.abs(x(10) - 10) < 1e-12,
          `${x(0)} .. ${x(10)}`);
    check('the divider is exactly half at every point',
          r2.data.length > 0 &&
          [0, 3, 7, 10].every((k) => Math.abs(at(k) - x(k) / 2) < 1e-9),
          [0, 3, 7, 10].map((k) => `${x(k)}->${at(k)}`).join(' '));
  }

  // A sweep of a source that is not there must say so, not sweep nothing.
  {
    e.load('divider\nV1 in 0 DC 0\nR1 in 0 1k\n.op\n.end');
    let msg = '';
    try { e.dc({ source: 'V9', start: 0, stop: 1, step: 0.5 }); }
    catch (err) { msg = err.message; }
    check('an unknown sweep source is reported', /V9|not found/i.test(msg), msg);
  }
  eq('declares an id', e.id, 'rust');
  check('declares a label', typeof e.label === 'string' && e.label.length > 0);
  eq('claims to be interactive', e.interactive, true);

  // Wired to the real parser, not a copy of its rules.
  eq('canRun routes through the parser', e.canRun('d\nV1 in 0 DC 1\nR1 in 0 1k\n.op\n.end').kind, 'yes');
  eq('and refuses BSIM as unsupported',
     e.canRun('b\nVD d 0 1\nM1 d d 0 0 n\n.model n NMOS level=14\n.op\n.end').kind, 'unsupported');

  // Selection with the real engine and no fallback yet: this is today's state.
  const r = select([e], 'b\nVD d 0 1\nM1 d d 0 0 n\n.model n NMOS level=14\n.op\n.end');
  eq('a BSIM design has no engine today', r.engine, null);
  check('and says why in terms a user can act on', /LEVEL 14/.test(r.reason), r.reason);
}

// ------------------------------------------------- both engines, end to end

console.log('\nRouting with both engines registered');
{
  const { existsSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const built = existsSync(fileURLToPath(new URL('../src/ngspice/ngspice.mjs', import.meta.url)));
  if (!built) {
    console.log('  (ngspice wasm not built — skipping; run npm run build:ngspice)');
  } else {
    const { SimEngine } = await import('../src/worker/engine.js');
    const { NgspiceEngine } = await import('../src/worker/ngspice-engine.js');
    const rust = new SimEngine({ Session: wasm.Session, memory: () => wasm.memory, emit: () => {} });
    const ng = await NgspiceEngine.create();
    const engines = [rust, ng];

    const plain = 'd\nV1 in 0 DC 1\nR1 in 0 1k\n.op\n.end';
    eq('an ordinary design stays on the interactive engine',
       select(engines, plain).engine?.id, 'rust');
    eq('and that engine claims interactivity',
       select(engines, plain).engine?.interactive, true);

    // The whole point of the second engine.
    const bsim = 'b\nVD d 0 DC 1\nVG g 0 DC 1\nM1 d g 0 0 nch W=1u L=45n\n' +
                 '.model nch NMOS level=14 version=4.8.2 toxe=1.8e-9 vth0=0.35 u0=0.03\n.end';
    const r = select(engines, bsim);
    eq('a BSIM4 design routes to ngspice', r.engine?.id, 'ngspice');
    check('and the reason names what the fast engine could not do',
          /LEVEL 14/.test(r.reason), r.reason);
    eq('the coverage engine does not claim interactivity', r.engine?.interactive, false);

    // It must actually RUN, not merely be selected.
    const info = ng.load(bsim);
    check('ngspice loads the BSIM4 deck', info.labels.length > 0, JSON.stringify(info));
    check('and reports real nodes', info.labels.includes('d'), JSON.stringify(info.labels));

    // A broken netlist must still stop at the first engine, even though the
    // fallback exists and would happily be asked.
    const broken = select(engines, 'x\nV1 in 0 DC 1\nR1 in\n.op\n.end');
    eq('a malformed netlist is NOT rescued by the fallback', broken.engine, null);
    eq('it is reported as invalid', broken.verdict.kind, 'invalid');
    check('and ngspice was never consulted', broken.rejected.length === 1,
          `consulted ${broken.rejected.length} engines`);
  }
}

console.log(`\n${'-'.repeat(72)}\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
