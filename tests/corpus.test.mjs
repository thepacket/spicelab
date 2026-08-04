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
 * TWO corpora, neither committed — both are fetched separately and each is
 * skipped when absent:
 *
 *   ngspice  its own regression suite, ~623 files. Budget 0.
 *   Xyce     Xyce_Regression, small files only. Far heavier on directives —
 *            `.measure` in 446 files, `.step` in 480, `.sens` in 241, where
 *            ngspice's suite barely exercises them. Budget is currently above
 *            zero: a list of known gaps, not an acceptance of them.
 *
 * Neither is vendored. They are large, and their licences (Modified BSD and
 * GPLv3 respectively) permit redistribution but there is no reason to carry
 * thousands of third-party files to run a check that can fetch them.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const wasm = require('../src/wasm-node/spicelab_wasm.js');

/**
 * Each corpus: where to find it, which files to read, and how many netlists may
 * currently be reported `invalid`.
 *
 * The budgets are ratchets. A number above zero is a list of known gaps, not
 * an acceptance of them; lower it whenever one is fixed, and never raise it.
 *
 * `minOk` is the opposite ratchet — a floor on how many netlists build cleanly,
 * so a change that quietly stops accepting valid SPICE is caught. Raise it when
 * coverage improves; lowering it needs a reason written down, because the
 * obvious way to satisfy a floor is to accept things you should not.
 *
 * It has been lowered once, and that reason is the point of the whole file.
 * ngspice's floor was 61 until the `.model` TYPE guard landed: 41 of those 61
 * are CIDER netlists using `NBJT`, `NUMOS` and `NUMD`, ngspice's NUMERICAL
 * device models — a mesh-based physical simulation with nothing in common with
 * Gummel-Poon or Shichman-Hodges. This core was reading them as ordinary BJTs
 * and MOSFETs and reporting that they parsed cleanly. They were never `ok`;
 * they were false positives, and 20 is what the honest count always was.
 */
const CORPORA = [
  {
    id: 'ngspice',
    // Its own regression suite: real SPICE by many hands over decades.
    roots: [process.env.NGSPICE_SRC,
            new URL('../.ngspice-build/ngspice-46', import.meta.url).pathname],
    subdirs: ['tests', 'examples'],
    pattern: /\.(cir|net|sp|deck)$/i,
    maxBytes: Infinity,
    budget: 0,
    minOk: 20,
    hint: 'npm run build:ngspice  (or set NGSPICE_SRC)',
  },
  {
    id: 'xyce',
    // Xyce's regression suite. Far heavier on directives than ngspice's:
    // .measure in 446 files, .step in 480, .sens in 241. Restricted to small
    // files because the large ones are mostly generated device sweeps that add
    // volume without adding syntax.
    roots: [process.env.XYCE_SRC,
            new URL('../.xyce-regression', import.meta.url).pathname],
    subdirs: ['Netlists'],
    pattern: /\.cir$/i,
    maxBytes: 3072,
    // RAISED 150 -> 165 -> 180 on 2026-08-04, the only times this has gone up,
    // and the reason is recorded because the rule is otherwise "never raise".
    //
    // Accepting `.measure` took `ok` from 1,202 to 1,439 — 237 more netlists
    // now parse to the end instead of stopping at their first measure card.
    // Some of those reach a LATER problem that was previously never seen, so
    // `invalid` rose with them. Nothing got worse: those netlists did not
    // simulate before either, they were merely misfiled as `unsupported`, and
    // for several the new verdict is the more accurate one — this corpus
    // contains NEGATIVE tests, decks written to prove Xyce rejects them
    // (`specials_in_subckt_dot_param.cir` says so in its own header), and
    // `invalid` is the right answer there.
    //
    // Accepting `.step` did the same thing again a few hours later: `ok`
    // 1,439 -> 1,621, `invalid` 165 -> 180. Identical trade, identical reason.
    //
    // The pattern is worth naming: every directive this parser learns to
    // ACCEPT moves netlists from "stopped early" to "parsed to the end", and
    // some of those then reach a real gap further down. `ok` is the number
    // that measures progress here; `invalid` measures how much further we can
    // now see. Watch them together — a rise in `invalid` with `ok` flat WOULD
    // be a regression, and this floor is what would catch it.
    //
    // The remaining causes are a long tail: models that a missing `.include`
    // would have defined, mutual-inductance references, short `.tran` cards.
    // Ratchet down from 180.
    budget: 180,
    minOk: 1600,
    hint: 'git clone --depth 1 https://github.com/Xyce/Xyce_Regression .xyce-regression',
  },
];

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [pass] ${name}`); }
  else { fail++; failures.push(`${name}: ${detail}`); console.log(`  [FAIL] ${name} ${detail}`); }
}

function walk(dir, pattern, maxBytes, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, pattern, maxBytes, out);
    else if (pattern.test(e) && st.size <= maxBytes) out.push(p);
  }
  return out;
}

let ran = 0;
for (const c of CORPORA) {
  const root = c.roots.filter(Boolean)
    .find((p) => existsSync(p) && c.subdirs.some((d) => existsSync(join(p, d))));
  if (!root) {
    console.log(`\n${c.id}: not present — skipping. Get it with:\n  ${c.hint}`);
    continue;
  }
  ran++;

  const files = [];
  for (const sub of c.subdirs) {
    const d = join(root, sub);
    if (existsSync(d)) walk(d, c.pattern, c.maxBytes, files);
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
      if (r.kind === 'invalid') invalid.push([f.replace(`${root}/`, ''), r.message]);
    }
  }

  console.log(`\n${c.id}: ${files.length} netlists`);
  console.log(`  ok ${kinds.ok}   unsupported ${kinds.unsupported}   ` +
              `unresolved ${kinds.unresolved}   invalid ${kinds.invalid}`);

  check(`${c.id}: corpus found and read`, files.length > 300, `${files.length} files`);
  check(`${c.id}: at least ${c.minOk} build cleanly`, kinds.ok >= c.minOk,
        `${kinds.ok} ok`);
  check(`${c.id}: at most ${c.budget} called invalid`, invalid.length <= c.budget,
        `${invalid.length} > ${c.budget}:\n` +
        invalid.slice(0, 20)
          .map(([f, m]) => `      ${f}\n        ${m.slice(0, 100)}`).join('\n'));

  if (invalid.length && invalid.length <= c.budget) {
    // Within budget, but each is still a gap. Summarise so it stays visible.
    const byCause = new Map();
    for (const [, m] of invalid) {
      const k = m.replace(/'[^']*'/g, "'X'").replace(/\b\d+\b/g, 'N').slice(0, 64);
      byCause.set(k, (byCause.get(k) ?? 0) + 1);
    }
    console.log(`  known gaps, by cause (${byCause.size} distinct):`);
    for (const [k, n] of [...byCause].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
      console.log(`    ${String(n).padStart(4)}  ${k}`);
    }
  }
}

if (!ran) {
  console.log('\nno corpora present — nothing checked.');
  console.log('\n0 passed, 0 failed (skipped)');
  process.exit(0);
}

console.log(`\n${'-'.repeat(72)}\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
