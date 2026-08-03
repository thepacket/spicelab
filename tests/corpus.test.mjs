/**
 * Parser conformance against ngspice's own test suite.
 *
 * ngspice ships ~575 netlists it uses to test itself: real SPICE, written by
 * many hands over decades, exercising syntax no hand-written test would think
 * to cover. Running them through OUR parser is the cheapest broad check we
 * have, and it is a different kind of evidence from the analytic suite — those
 * prove the numbers are right, this proves we can read what people actually
 * write.
 *
 * The three-way verdict from `checkNetlist` is what makes it actionable:
 *
 *   unsupported  expected, and fine. Devices and analyses we do not implement.
 *   unresolved   expected here. The corpus is full of `.include`, and this
 *                runner deliberately supplies no resolver.
 *   INVALID      a claim that ngspice's own working test is malformed. Each one
 *                is either a parser bug or a feature we should be classifying
 *                as unsupported instead.
 *
 * It found one real bug on its first run: commas separate parameters in SPICE
 * (`.MODEL DEN D(IS=1E-12, RS=14.61K)` is an Analog Devices macromodel) and the
 * tokenizer split on whitespace only, so the value came out as `1E-12,` and the
 * netlist was rejected as broken.
 *
 * Skips cleanly when the ngspice source tree is absent — it is a build
 * artifact of `npm run build:ngspice`, not something committed.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const wasm = require('../src/wasm-node/spicelab_wasm.js');

const ROOTS = [
  process.env.NGSPICE_SRC,
  new URL('../.ngspice-build/ngspice-46', import.meta.url).pathname,
].filter(Boolean);
const ROOT = ROOTS.find((p) => existsSync(join(p, 'tests')));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [pass] ${name}`); }
  else { fail++; failures.push(`${name}: ${detail}`); console.log(`  [FAIL] ${name} ${detail}`); }
}

if (!ROOT) {
  console.log('\nngspice source tree not found — skipping conformance corpus.');
  console.log('Get it with: npm run build:ngspice  (or set NGSPICE_SRC)');
  console.log('\n0 passed, 0 failed (skipped)');
  process.exit(0);
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    // `.deck` is ordinary netlist text and there are 48 of them; skipping it
    // left a chunk of the corpus unread for no reason.
    else if (/\.(cir|net|sp|deck)$/i.test(e)) out.push(p);
  }
  return out;
}

const files = [];
for (const sub of ['tests', 'examples']) {
  const d = join(ROOT, sub);
  if (existsSync(d)) walk(d, files);
}

const kinds = { ok: 0, unsupported: 0, unresolved: 0, invalid: 0 };
const invalid = [];
for (const f of files) {
  let r;
  try { r = JSON.parse(wasm.Session.checkNetlist(readFileSync(f, 'utf8'))); }
  catch (e) { r = { ok: false, kind: 'invalid', message: `threw: ${e.message}` }; }
  if (r.ok) kinds.ok++;
  else {
    kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
    if (r.kind === 'invalid') invalid.push([f.replace(`${ROOT}/`, ''), r.message]);
  }
}

console.log(`\nngspice conformance corpus: ${files.length} netlists`);
console.log(`  ok ${kinds.ok}   unsupported ${kinds.unsupported}   ` +
            `unresolved ${kinds.unresolved}   invalid ${kinds.invalid}\n`);

check('the corpus was actually found and read', files.length > 300, `${files.length} files`);
check('something parses cleanly', kinds.ok > 20, `${kinds.ok} ok`);

// `.include` failures must be `unresolved`, never `invalid`: the netlist is
// fine, we simply cannot fetch the file. Calling it invalid told the user their
// netlist was broken AND stopped engine selection with the wrong message.
check('unfetchable includes are classified unresolved', kinds.unresolved > 50,
      `${kinds.unresolved} unresolved`);

// The budget is ZERO, and it got there by fixing four real defects: commas as
// parameter separators, POLY() sources, statistical model parameters
// (AGAUSS), and semiconductor resistors. Three of those were features we do
// not implement being reported as MALFORMED NETLISTS, which both blamed the
// user's deck and stopped it routing to the engine that does implement them.
//
// Ratchet this DOWN, never up. A new entry means either a parser bug or a
// refusal classified as `invalid` when it should be `unsupported`.
const BUDGET = 0;
check(`at most ${BUDGET} netlists are called invalid`, invalid.length <= BUDGET,
      `${invalid.length}:\n` + invalid.map(([f, m]) => `      ${f}\n        ${m.slice(0, 100)}`).join('\n'));

if (invalid.length) {
  console.log('  still refused (each is a bug or a misclassification):');
  for (const [f, m] of invalid) console.log(`    ${f}\n      ${m.slice(0, 110)}`);
}

console.log(`\n${'-'.repeat(72)}\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
