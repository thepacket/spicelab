/**
 * `.step` card parsing.
 *
 * The cases that matter are the REFUSALS. `.step R1:R` and `.step temp` are
 * both common and neither is a `.param`, so running them through the override
 * mechanism would define an unused parameter and simulate the same circuit N
 * times — N identical points, which draws a flat line rather than an error.
 * That is the failure this project treats as the dangerous one, so it is
 * asserted directly.
 */
import { parseStep, parseSteps, withoutSteps } from '../src/instruments/step.js';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [pass] ${name}`); }
  else { fail++; failures.push(`${name}: ${detail}`); console.log(`  [FAIL] ${name} ${detail}`); }
}
const eq = (name, a, b) =>
  check(name, a === b, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
const arr = (name, a, b, tol = 1e-9) =>
  check(name, a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol),
        `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

console.log('\nLinear ranges');
{
  const s = parseStep('.step param rval 1k 5k 1k');
  eq('the parameter name', s.param, 'rval');
  arr('values are inclusive of both ends', s.values, [1e3, 2e3, 3e3, 4e3, 5e3]);

  // Derived from the index, not accumulated: 0.1 added thirty times is not 3,
  // and an accumulating loop drops the endpoint.
  const f = parseStep('.step param x 0 3 0.1');
  eq('a fractional step keeps every point', f.values.length, 31);
  check('and lands exactly on the stop',
        Math.abs(f.values[f.values.length - 1] - 3) < 1e-12,
        String(f.values[f.values.length - 1]));

  arr('a descending range works', parseStep('.step param x 5 1 1').values,
      [5, 4, 3, 2, 1]);
  eq('PARAM is optional', parseStep('.step rval 1 3 1').param, 'rval');
  arr('suffixes are read', parseStep('.step param c 1n 3n 1n').values,
      [1e-9, 2e-9, 3e-9], 1e-18);
}

console.log('\nLIST and log ranges');
{
  arr('LIST takes the values verbatim',
      parseStep('.step param r list 1k 4.7k 10k').values, [1e3, 4.7e3, 1e4]);
  const d = parseStep('.step param r dec 1 1 100');
  arr('DEC gives one point per decade, inclusive', d.values, [1, 10, 100]);
  const l = parseStep('.step param r lin 5 0 1');
  arr('LIN gives `points` points', l.values, [0, 0.25, 0.5, 0.75, 1]);
}

console.log('\nRefusals — the load-bearing part');
{
  // Neither of these is a .param, so an override would leave the circuit
  // unchanged and draw N identical points.
  const dev = parseStep('.step R1:R 1k 5k 1k');
  check('a device parameter is refused', !!dev.error, JSON.stringify(dev));
  check('and the message says what to do instead',
        /\.param/.test(dev.error ?? ''), dev.error);
  check('it yields no values, so nothing can run it by accident',
        dev.values.length === 0);

  const t = parseStep('.step temp -40 125 5');
  check('temperature is refused', !!t.error, JSON.stringify(t));
  check('temper is refused too', !!parseStep('.step temper 0 100 10').error);

  check('a card with no name is refused', !!parseStep('.step').error);
  check('a malformed range is refused', !!parseStep('.step param x wat').error);
  check('DEC from zero is refused rather than producing Infinity',
        !!parseStep('.step param x dec 10 0 100').error);
}

console.log('\nNested .step is refused, not silently truncated');
{
  const netlist = [
    'title',
    '.step param a 1 3 1',
    '.step param b 1 3 1',
    '.end',
  ].join('\n');
  const ss = parseSteps(netlist);
  eq('both cards are seen', ss.length, 2);
  check('the first runs', !ss[0].error, JSON.stringify(ss[0]));
  check('the second is reported, not ignored', !!ss[1].error, JSON.stringify(ss[1]));
  check('and carries no values', ss[1].values.length === 0);
}

console.log('\nStripping .step from the per-case netlist');
{
  const netlist = [
    'title', 'R1 a b {rval}', '.step param rval 1k 5k 1k',
    '.tran 1u 1m', '.end',
  ].join('\n');
  const out = withoutSteps(netlist);
  check('the .step card is gone', !/\.step/i.test(out), out);
  check('everything else survives',
        /R1 a b \{rval\}/.test(out) && /\.tran 1u 1m/.test(out), out);
  // Without this the worker would re-read the card on every case. Harmless
  // today because the parser ignores it, but it would mean each case carried
  // an instruction to sweep itself.
  eq('line count drops by exactly one',
     out.split('\n').length, netlist.split('\n').length - 1);
}

console.log(`\n${'-'.repeat(72)}\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  ' + f);
  process.exit(1);
}
