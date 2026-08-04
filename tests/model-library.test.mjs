/**
 * Downloading a third-party model library into the browser.
 *
 * Nothing from the KiCad Spice Library is vendored here — that is the whole
 * point of the feature — so these fixtures are written by hand to reproduce
 * the SHAPES that library actually contains. Each one that exists because a
 * real file broke something says so.
 *
 * The two regressions worth naming, both silent, both found by running the
 * parser over the real library rather than by reading it:
 *
 *   - CRLF offset drift. Line offsets were derived as `length + 1`, which
 *     charges one character for a two-character terminator. These files are
 *     overwhelmingly CRLF, so the error compounds per line and by line ~2,800
 *     a definition's slice lands inside some OTHER model card. Every stored
 *     definition in every CRLF file would have been quietly wrong.
 *   - Unbalanced `.subckt`. `Ltc_Old_Big.lib` has 540 `.subckt` against 539
 *     `.ends`. With a depth COUNTER the depth never returns to zero after the
 *     unbalanced block, so every later definition looks nested and is dropped
 *     — 113 real macromodels, no error.
 */
import { createRequire } from 'node:module';
import {
  readPickleIndex, sanitizeIndex, searchIndex, rankPaths, modelFileUrl,
} from '../src/schematic/model-index.js';
import {
  parseDefinitions, modelParams, decodeModelFile, rawUrl, rankDefs, indexDefs,
  partsFromDefs, downloadLibrary, listLibraryFiles, LIBRARY,
} from '../src/schematic/model-library.js';
import {
  kindForModelType, registerLibraryParts, clearLibraryParts, partsFor,
  getPart, defaultPartFor, modelName, modelCard, PARTS, LIBRARY_PARTS,
} from '../src/schematic/parts.js';
import { storageAvailable, libraryMeta } from '../src/schematic/model-store.js';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [pass] ${name}`); }
  else { fail++; failures.push(`${name}: ${detail}`); console.log(`  [FAIL] ${name} ${detail}`); }
}
const eq = (name, a, b) =>
  check(name, a === b, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

const bytes = (hex) => Uint8Array.from(hex.match(/../g).map((h) => parseInt(h, 16)));

// ---------------------------------------------------------------------------
console.log('\nPickle index reader');
{
  // Produced by real Python `pickle.dumps(..., protocol=5)`. Testing against
  // our own encoder would only prove we agree with ourselves.
  const EMPTY = '80057d942e';
  const SINGLE = '80059531000000000000007d948c05746c303732945d948c1f4f70657261746' +
                 '96f6e616c20416d706c69666965722f546c3037322e6d6f649461732e';
  const MULTI = '80059549000000000000007d948c06326e32323232945d94288c165472616e73' +
                '6973746f722f424a542f424a542e6c6962948c1c756e63617465676f72697a65' +
                '642f496465616c44696f64652e6c69629465732e';
  const MEMO = '8005954b000000000000007d94288c076a32736b333072945d948c185472616e7' +
               '36973746f722f4645542f32736b33302e6c696294618c076a32736b33306f945d' +
               '946803618c076a32736b333079945d94680361752e';

  eq('empty index decodes to an empty map', readPickleIndex(bytes(EMPTY)).size, 0);

  const one = readPickleIndex(bytes(SINGLE));
  eq('single entry: one key', one.size, 1);
  eq('single entry: path', one.get('tl072')?.[0], 'Operational Amplifier/Tl072.mod');

  // A one-entry dict emits SETITEM; a larger one emits SETITEMS after a MARK.
  // The big real index only ever uses SETITEMS, so a reader tested against it
  // alone would miss the singular form entirely.
  const many = readPickleIndex(bytes(MULTI));
  eq('multi-path entry keeps both paths', many.get('2n2222')?.length, 2);
  eq('multi-path entry: second path', many.get('2n2222')?.[1],
     'uncategorized/IdealDiode.lib');

  // Repeated strings come back through the memo (BINGET), not re-encoded.
  const memo = readPickleIndex(bytes(MEMO));
  eq('memoised index: three keys', memo.size, 3);
  eq('memoised index: shared path resolved', memo.get('j2sk30y')?.[0],
     'Transistor/FET/2sk30.lib');
  check('memoised entries are distinct lists',
        memo.get('j2sk30r') !== memo.get('j2sk30o'));
}

console.log('\nPickle reader refuses to execute');
{
  // THE security property. A general unpickler is equivalent to running the
  // file: GLOBAL/STACK_GLOBAL looks up arbitrary Python and REDUCE calls it.
  // This reader implements neither, so these must fail to parse rather than
  // be "blocked" by a check someone can later forget to apply.
  const GLOBAL = '80059514000000000000008c05706f736978948c0673797374656d9493942e';
  const REDUCE = '80059525000000000000008c05706f736978948c0673797374656d9493948c' +
                 '0a6563686f2070776e656494859452942e';
  for (const [name, hex] of [['STACK_GLOBAL', GLOBAL], ['REDUCE', REDUCE]]) {
    let threw = false, msg = '';
    try { readPickleIndex(bytes(hex)); } catch (e) { threw = true; msg = e.message; }
    check(`a pickle using ${name} is refused`, threw, 'it parsed');
    check(`the ${name} refusal names the opcode`, /opcode 0x/.test(msg), msg);
  }
  let threw = false;
  try { readPickleIndex(bytes('8002')); } catch { threw = true; }
  check('a truncated pickle is refused', threw);
  // Protocols 0-1 are a different, text-based encoding.
  threw = false;
  try { readPickleIndex(bytes('80007d2e')); } catch { threw = true; }
  check('an unsupported protocol is refused', threw);
}

console.log('\nIndex hygiene and search');
{
  const raw = new Map([
    ['good', ['Diode/D.lib']],
    ['bad-value', 'not-a-list'],
    ['traversal', ['../../etc/passwd']],
    ['mixed', ['Diode/D.lib', '../escape']],
  ]);
  const { index, dropped } = sanitizeIndex(raw);
  check('a non-list value is dropped', !index.has('bad-value'));
  check('a pure-traversal entry is dropped', !index.has('traversal'));
  eq('a traversal path is stripped from a mixed entry', index.get('mixed')?.length, 1);
  check('dropped entries are counted', dropped >= 3, String(dropped));

  const idx = new Map([
    ['tl072', ['a']], ['tl072acd', ['a']], ['xtl072', ['a']], ['lm741', ['a']],
  ]);
  const hits = searchIndex(idx, 'tl072').map((h) => h.name);
  eq('exact match ranks first', hits[0], 'tl072');
  eq('prefix match ranks above substring', hits[1], 'tl072acd');
  eq('substring match is still found', hits[2], 'xtl072');
  eq('non-matches are excluded', hits.length, 3);
  eq('an empty query returns nothing', searchIndex(idx, '   ').length, 0);

  // The library's README states this priority and it is the right one: a card
  // from the manufacturer's directory beats the same name in a scraped bucket.
  const ranked = rankPaths([
    'uncategorized/x.lib', 'Manufacturer/TI/x.mod',
    'uncategorized/spice_complete/x.lib', 'Diode/x.lib',
  ]);
  eq('manufacturer ranks first', ranked[0], 'Manufacturer/TI/x.mod');
  eq('a named category ranks second', ranked[1], 'Diode/x.lib');
  eq('spice_complete beats bare uncategorized', ranked[2],
     'uncategorized/spice_complete/x.lib');
}

console.log('\nURL construction');
{
  // Real paths contain spaces. Encoding the whole path would turn the
  // separating slashes into %2F and every request would 404.
  const u = modelFileUrl('Manufacturer/Texas Instruments/tl072.mod');
  check('spaces are percent-encoded', u.includes('Texas%20Instruments'), u);
  check('path separators survive encoding', !u.includes('%2F'), u);
  check('the models root is included', u.includes('/Models/'), u);

  const r = rawUrl('Models/Manufacturer/Texas Instruments/tl072.mod');
  check('rawUrl encodes segments too', r.includes('Texas%20Instruments'), r);
  check('rawUrl keeps separators', !r.includes('%2F'), r);

  for (const bad of ['../secrets', 'Models/../../etc/passwd', '']) {
    let threw = false;
    try { rawUrl(bad); } catch { threw = true; }
    check(`rawUrl refuses ${JSON.stringify(bad)}`, threw);
  }
}

// ---------------------------------------------------------------------------
console.log('\nDefinition parsing');
{
  const text = [
    '* a header comment',
    '.MODEL DX D(IS=1E-15 RS=0 CJO=1E-12)',
    '.SUBCKT TL072 1 2 3 4 5',
    '  j1 11 2 10 jx',
    '.model jx PJF(Is=15.00E-12 Beta=270.1E-6 Vto=-1)',
    '.ends',
    '.model QN NPN(IS=1E-16,BF=400)',
  ].join('\n');
  const defs = parseDefinitions(text, 'Models/x.lib');
  const by = (n) => defs.find((d) => d.name === n);

  eq('finds every definition', defs.length, 4);
  eq('model kind', by('dx').kind, 'model');
  eq('model type', by('dx').type, 'D');
  eq('subckt kind', by('tl072').kind, 'subckt');
  eq('subckt pins are captured in order', by('tl072').pins.join(','), '1,2,3,4,5');
  eq('a model nested in a subckt is still found', by('jx').kind, 'model');
  eq('nesting depth is recorded', by('jx').depth, 1);
  eq('a top-level definition is depth 0', by('dx').depth, 0);

  // Commas are legal SPICE separators — a stock Analog Devices card uses them.
  eq('comma-separated params survive', by('qn').params, 'IS=1E-16,BF=400');

  // The slice must be the definition itself, start to end.
  check('subckt slice starts at .SUBCKT',
        text.slice(by('tl072').start, by('tl072').end).startsWith('.SUBCKT TL072'));
  check('subckt slice ends at .ends',
        text.slice(by('tl072').start, by('tl072').end).trimEnd().endsWith('.ends'));
}

console.log('\nCRLF offsets (regression)');
{
  // The bug: offsets derived as `length + 1` charge one character for a
  // two-character terminator, so slices drift further with every line. Enough
  // lines here that a drifted slice lands on the WRONG card, which is exactly
  // how it behaved on real files.
  const cards = [];
  for (let i = 0; i < 40; i++) cards.push(`.MODEL D${i} D(IS=1E-1${i % 10} RS=${i})`);
  const text = cards.join('\r\n');
  const defs = parseDefinitions(text, 'Models/crlf.lib');
  eq('every CRLF definition is found', defs.length, 40);

  let wrong = 0;
  for (const d of defs) {
    const head = text.slice(d.start, d.end);
    if (!head.startsWith(`.MODEL ${d.name.toUpperCase()} `)) wrong++;
  }
  eq('no CRLF slice lands on another card', wrong, 0);

  const last = defs[defs.length - 1];
  eq('the last CRLF card slices exactly', text.slice(last.start, last.end),
     '.MODEL D39 D(IS=1E-19 RS=39)');
  eq('CRLF params are clean', last.params, 'IS=1E-19 RS=39');

  // A lone-CR file (classic Mac) must not fuse into a single line either.
  const cr = parseDefinitions('.MODEL A D(IS=1)\r.MODEL B D(IS=2)', 'Models/cr.lib');
  eq('lone CR separates cards', cr.length, 2);
  eq('lone CR slices exactly', cr[1].params, 'IS=2');
}

console.log('\nUnbalanced .subckt (regression)');
{
  // `Ltc_Old_Big.lib` really is 540 .subckt against 539 .ends. A depth counter
  // never returns to zero after the unbalanced block and silently swallows
  // every later definition.
  const text = [
    '.SUBCKT NEVERCLOSED 1 2',
    '  r1 1 2 1k',
    '.SUBCKT LT1673 3 2 7 4 6',
    '  r2 3 2 1k',
    '.ends',
    '.SUBCKT LT1818 1 2 3',
    '  r3 1 2 1k',
    '.ends',
    '.model AFTER D(IS=1E-14)',
  ].join('\n');
  const defs = parseDefinitions(text, 'Models/unbalanced.lib');
  const names = defs.map((d) => d.name).sort();

  check('definitions after the unbalanced block survive',
        names.includes('lt1673') && names.includes('lt1818'),
        JSON.stringify(names));
  check('a model after the unbalanced block survives', names.includes('after'),
        JSON.stringify(names));
  check('the unterminated block is still reported', names.includes('neverclosed'),
        JSON.stringify(names));
  const open = defs.find((d) => d.name === 'neverclosed');
  check('the unterminated block is flagged', open.unterminated === true);
  eq('nothing is lost', defs.length, 4);
}

console.log('\nContinuations, comments and parameters');
{
  const text = [
    '.MODEL QN NPN(IS=1.6E-16 BF=305',
    '* an interleaved comment, which is legal and common',
    '+ VAF=74 IKF=2.2E-02',
    '+ RB=90)',
    '.MODEL DNOPAREN D IS=1E-14 RS=2',
    '.MODEL DSEMI D(IS=1E-14) ; trailing comment',
  ].join('\n');
  const defs = parseDefinitions(text, 'Models/cont.lib');
  const by = (n) => defs.find((d) => d.name === n);

  eq('three cards', defs.length, 3);
  check('continuation lines are folded in', by('qn').params.includes('RB=90'),
        by('qn').params);
  check('an interleaved comment does not end the card',
        by('qn').params.includes('VAF=74'), by('qn').params);
  check('the comment text itself is not folded in',
        !/interleaved/.test(by('qn').params), by('qn').params);
  check('continuation join does not glue tokens',
        !/305VAF|02RB/.test(by('qn').params), by('qn').params);

  // Parentheses are optional in SPICE.
  eq('a parenless card keeps its params', by('dnoparen').params, 'IS=1E-14 RS=2');
  eq('a trailing ; comment is stripped', by('dsemi').params, 'IS=1E-14');

  eq('modelParams strips directive, name and type',
     modelParams('.model d1 D(is=1e-14)', 'D'), 'is=1e-14');
  eq('modelParams handles a glued paren',
     modelParams('.MODEL DX   D(IS=1E-15 RS=0)', 'D'), 'IS=1E-15 RS=0');
}

console.log('\nEncoding');
{
  // The micro sign is a single byte 0xB5 in Latin-1. Decoded leniently as
  // UTF-8 it becomes U+FFFD and the suffix is gone — the same 10^6 error as
  // the `470uF` bug in CLAUDE.md, arriving by a different route.
  const latin1 = Uint8Array.from([0x43, 0x31, 0x20, 0x31, 0x20, 0x30, 0x20, 0x34,
                                  0x37, 0x30, 0xb5, 0x46]);   // "C1 1 0 470<B5>F"
  const decoded = decodeModelFile(latin1);
  check('a Latin-1 micro sign survives decoding', decoded.includes('µ'),
        JSON.stringify(decoded));
  check('no replacement character is produced', !decoded.includes('�'),
        JSON.stringify(decoded));

  const utf8 = new TextEncoder().encode('C1 1 0 470µF');
  eq('a UTF-8 file decodes as UTF-8', decodeModelFile(utf8), 'C1 1 0 470µF');
}

// ---------------------------------------------------------------------------
console.log('\nRanking and grouping');
{
  const defs = [
    { name: 'x', kind: 'model', path: 'Models/uncategorized/a.lib', line: 1 },
    { name: 'x', kind: 'subckt', path: 'Models/Manufacturer/TI/a.mod', line: 5 },
    { name: 'x', kind: 'model', path: 'Models/Diode/a.lib', line: 2 },
    { name: 'y', kind: 'model', path: 'Models/Diode/b.lib', line: 3 },
  ];
  const byName = indexDefs(defs);
  eq('grouped by name', byName.size, 2);
  eq('a name defined three times keeps all three', byName.get('x').length, 3);
  eq('manufacturer provenance ranks first', byName.get('x')[0].path,
     'Models/Manufacturer/TI/a.mod');

  const same = rankDefs([
    { name: 'z', kind: 'model', path: 'Models/Diode/a.lib', line: 9 },
    { name: 'z', kind: 'subckt', path: 'Models/Diode/a.lib', line: 1 },
  ]);
  eq('a macromodel outranks a bare model card', same[0].kind, 'subckt');
}

console.log('\nParts registration');
{
  clearLibraryParts();
  const builtinDiodes = partsFor('diode').length;

  const defs = [
    { name: '1n4148', kind: 'model', type: 'D', params: 'IS=1E-14 RS=2',
      path: 'Models/Diode/D.lib', line: 7 },
    { name: 'q2n2222', kind: 'model', type: 'NPN', params: 'IS=1E-16 BF=200',
      path: 'Models/Manufacturer/TI/B.lib', line: 3 },
    { name: 'jfet', kind: 'model', type: 'PJF', params: 'BETA=1E-4',
      path: 'Models/x.lib', line: 1 },
    { name: 'powerfet', kind: 'model', type: 'VDMOS', params: 'pchan Vto=-4 Kp=8',
      path: 'Models/x.lib', line: 40 },
    // XSPICE digital: a code model this build cannot run at all, so it must
    // stay unmapped however many device symbols get added around it.
    { name: 'gate', kind: 'model', type: 'D_NAND', params: 'rise_delay=1n',
      path: 'Models/x.lib', line: 60 },
    { name: 'macro', kind: 'subckt', type: '', pins: ['1', '2'],
      path: 'Models/x.lib', line: 20 },
  ];
  const parts = partsFromDefs(defs, kindForModelType);
  eq('only symbol-backed model types become parts', parts.length, 4);
  check('a JFET now gets a symbol', parts.some((p) => p.kind === 'pjf'));
  check('an XSPICE code model does not', !parts.some((p) => p.id.includes('gate')));
  check('a subckt is not turned into a part', !parts.some((p) => p.id.includes('macro')));

  eq('kindForModelType maps D', kindForModelType('D'), 'diode');
  eq('kindForModelType is case-insensitive', kindForModelType('pmos'), 'pmos');
  eq('kindForModelType returns null for unsupported types',
     kindForModelType('D_NAND'), null);

  // A VDMOS states its polarity as a FLAG in the parameters, not in the type
  // token, so it is the one kind the type alone cannot place. Getting this
  // backwards puts a p-channel card on an n-channel symbol, which simulates
  // happily and answers wrongly — the failure this project treats as the worst.
  eq('VDMOS without pchan is n-channel',
     kindForModelType('VDMOS', 'Vto=4 Kp=5.9'), 'nvdmos');
  eq('VDMOS with pchan is p-channel',
     kindForModelType('VDMOS', 'pchan Vto=-4 Kp=8.8'), 'pvdmos');
  check('the pchan flag is read from the card that carries it',
        parts.find((p) => p.id.includes('powerfet')).kind === 'pvdmos');

  // VSWITCH is PSpice's spelling of a DIFFERENT device: VON/VOFF where SW has
  // VT/VH. Mapped onto the switch symbol it would emit a card whose thresholds
  // the core reads as absent, switching at 0 V instead of where it says.
  eq('SW maps to the switch symbol', kindForModelType('SW'), 'sw');
  eq('VSWITCH does not', kindForModelType('VSWITCH'), null);

  const d = parts.find((p) => p.kind === 'diode');
  check('a downloaded part id is namespaced', d.id.startsWith('lib:'), d.id);
  check('the label names the source file', d.label.includes('Diode/D.lib'), d.label);
  check('the note says it is unvalidated', /not.*validated/i.test(d.note), d.note);
  check('the note says it is not redistributable',
        /not redistributable/i.test(d.note), d.note);

  eq('registration reports what it added', registerLibraryParts(parts), 4);
  eq('registering the same parts again adds nothing', registerLibraryParts(parts), 0);
  eq('downloaded diodes join the palette', partsFor('diode').length, builtinDiodes + 1);
  eq('a downloaded part resolves by id', getPart(d.id)?.params, 'IS=1E-14 RS=2');

  // Built-ins must stay first and stay the default: the sensible curated part
  // should not be buried under 50,000 downloaded cards.
  eq('built-ins still come first', partsFor('diode')[0].id, PARTS[0].id);
  check('the default is still a built-in',
        PARTS.includes(defaultPartFor('diode')));

  check('LIBRARY_PARTS is mutated in place, never rebound',
        LIBRARY_PARTS.length === 4, String(LIBRARY_PARTS.length));
  clearLibraryParts();
  eq('clearing removes downloaded parts', partsFor('diode').length, builtinDiodes);
  check('a cleared part no longer resolves', getPart(d.id) === null);
  check('clearing does not touch built-ins', getPart(PARTS[0].id) !== null);
}

console.log('\nEmitted model names');
{
  // REGRESSION: the emitter used `part.id` as the SPICE model name. That is a
  // legal token for a built-in (`D_SIGNAL`) and NOT for a downloaded part,
  // whose id carries its provenance — the netlist came out as
  // `.model lib:1n4148@Models/Diode/DIODE2.lib#99 D (...)`, which is broken.
  eq('a built-in emits its id unchanged', modelName({ id: 'D_SIGNAL' }), 'D_SIGNAL');

  const a = { id: 'lib:1n4148@Models/Diode/DIODE2.lib#99' };
  const nameA = modelName(a);
  check('a library model name has no illegal characters',
        /^[A-Za-z0-9_]+$/.test(nameA), nameA);
  check('a library model name keeps the part name readable',
        nameA.startsWith('1n4148_'), nameA);
  eq('the derived name is stable', modelName(a), nameA);

  // This library defines 2n2222 in five files with different parameters. Two
  // of them must not collapse onto one `.model` name, or one silently wins and
  // the circuit simulates as a different one.
  const b = { id: 'lib:2n2222@Models/Transistor/BJT/BJT.lib#1' };
  const c = { id: 'lib:2n2222@Models/uncategorized/IdealDiode.lib#1' };
  check('same name from different files emits different model names',
        modelName(b) !== modelName(c), `${modelName(b)} vs ${modelName(c)}`);

  // And the emitted card must actually parse.
  const require = createRequire(import.meta.url);
  const wasm = require('../src/wasm-node/spicelab_wasm.js');
  const part = { ...a, model: 'D', params: 'Is=2.52n Rs=.568 N=1.752' };
  const nl = `emit\nV1 x 0 DC 5\nR1 x y 1k\nD1 y 0 ${modelName(part)}\n` +
             `${modelCard(part, modelName(part))}\n.op\n.end\n`;
  let ok = true, msg = '';
  try { const s = wasm.Session.fromNetlist(nl); s.solveOp(); }
  catch (e) { ok = false; msg = e.message; }
  check('a netlist using a derived model name builds and solves', ok, msg);
}

console.log('\nA looked-up definition still knows its name');
{
  // REGRESSION: records are stored UNDER their name, so they do not carry it.
  // Building a part straight from a lookup result produced
  // `lib:undefined@...` for every downloaded model.
  const stored = { path: 'Models/Diode/D.lib', kind: 'model', type: 'D',
                   params: 'IS=1E-14', line: 9, start: 0, end: 20, depth: 0 };
  const without = partsFromDefs([stored], kindForModelType)[0];
  check('a nameless record yields an undefined id (the bug)',
        !without || without.id.includes('undefined'),
        without?.id);
  const with_ = partsFromDefs([{ ...stored, name: '1n4148' }], kindForModelType)[0];
  check('reattaching the key fixes it', with_.id.startsWith('lib:1n4148@'), with_.id);
  check('and the emitted name is clean', /^1n4148_[a-z0-9]+$/.test(modelName(with_)),
        modelName(with_));
}

console.log('\nA downloaded card builds and solves');
{
  // Closes the loop: a card of the shape this feature delivers must reach the
  // real solver, not merely parse. Parse conformance is not simulation.
  const require = createRequire(import.meta.url);
  const wasm = require('../src/wasm-node/spicelab_wasm.js');

  const text = '.MODEL DLIB D(IS=1E-14 RS=2 N=1.05)\r\n.MODEL QLIB NPN(IS=1E-16,BF=200)';
  const defs = parseDefinitions(text, 'Models/Diode/D.lib');
  const parts = partsFromDefs(defs, kindForModelType);

  const diode = parts.find((p) => p.kind === 'diode');
  const nl = `downloaded diode\nV1 a 0 DC 5\nR1 a b 1k\nD1 b 0 DMOD\n` +
             `.model DMOD ${diode.model} (${diode.params})\n.op\n.end\n`;
  let ok = true, msg = '', vb = NaN;
  try {
    const sess = wasm.Session.fromNetlist(nl);
    sess.solveOp();
    const view = new Float64Array(wasm.memory.buffer, sess.stagingPtr, sess.stagingLen);
    // SPICE identifiers are case-insensitive and this core preserves whatever
    // the netlist wrote, so the lookup must be too.
    const labels = sess.labels().split('\n').map((s) => s.toLowerCase());
    vb = view[1 + labels.indexOf('b')];
  } catch (e) { ok = false; msg = e.message; }
  check('a downloaded diode card builds and solves', ok, msg);
  // 5 V through 1k into a silicon diode: a forward drop in the sane range is
  // the check that the params arrived intact rather than half-parsed.
  check('the solved forward drop is physical', vb > 0.3 && vb < 1.0, `V(B) = ${vb}`);

  const npn = parts.find((p) => p.kind === 'npn');
  const nl2 = `downloaded bjt\nV1 c 0 DC 5\nVB bb 0 DC 0.7\nR1 c cc 1k\n` +
              `Q1 cc bb 0 QMOD\n.model QMOD ${npn.model} (${npn.params})\n.op\n.end\n`;
  let ok2 = true, msg2 = '';
  try { const s = wasm.Session.fromNetlist(nl2); s.solveOp(); }
  catch (e) { ok2 = false; msg2 = e.message; }
  check('a comma-separated downloaded BJT card builds and solves', ok2, msg2);
}

// ---------------------------------------------------------------------------
console.log('\nDownloading');
{
  // A fake fetch, so the suite never touches the network.
  const files = {
    'Models/a.lib': '.MODEL A D(IS=1E-14)',
    'Models/b.lib': '.MODEL B NPN(IS=1E-16)\r\n.SUBCKT S 1 2\r\n.ends',
    'Models/missing.lib': null,
  };
  const seen = [];
  let inFlight = 0, peak = 0;
  const fetchImpl = async (url) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    const path = decodeURIComponent(new URL(url).pathname.split('/master/').pop());
    seen.push(path);
    const body = files['Models/' + path.replace(/^Models\//, '')];
    if (body == null) return { ok: false, status: 404 };
    return { ok: true, status: 200,
             arrayBuffer: async () => new TextEncoder().encode(body).buffer };
  };

  const list = Object.keys(files).map((path) => ({ path, size: 10 }));
  const progress = [];
  const res = await downloadLibrary({
    fetchImpl, files: list, concurrency: 2,
    onProgress: (p) => progress.push(p),
  });

  eq('every reachable file is stored', res.files.size, 2);
  eq('definitions are parsed while downloading', res.defs.length, 3);
  check('a subckt from a CRLF file is found',
        res.defs.some((d) => d.kind === 'subckt' && d.name === 's'),
        JSON.stringify(res.defs.map((d) => d.name)));

  // One bad file out of thousands must cost that file, not the whole run.
  eq('a failed file is reported, not fatal', res.failed.length, 1);
  eq('the failure names the path', res.failed[0].path, 'Models/missing.lib');

  check('concurrency is bounded', peak <= 2, `peak ${peak}`);
  check('progress is reported', progress.length > 0);
  eq('progress ends complete', progress[progress.length - 1].fraction, 1);
  eq('progress counts every file', progress[progress.length - 1].done, 3);
}

console.log('\nListing failures are honest');
{
  const rateLimited = async () => ({
    ok: false, status: 403,
    headers: { get: () => String(Math.floor(Date.now() / 1000) + 600) },
  });
  let msg = '';
  try { await listLibraryFiles({ fetchImpl: rateLimited }); }
  catch (e) { msg = e.message; }
  check('a 403 is reported as the rate limit it is', /rate limit/i.test(msg), msg);
  check('the rate-limit message offers the manual path',
        /Import model file/i.test(msg), msg);

  const truncated = async () => ({
    ok: true, status: 200,
    json: async () => ({ truncated: true, tree: [] }),
  });
  msg = '';
  try { await listLibraryFiles({ fetchImpl: truncated }); }
  catch (e) { msg = e.message; }
  // A silently partial list means a silently partial library.
  check('a truncated listing is refused', /truncated/i.test(msg), msg);

  const good = async () => ({
    ok: true, status: 200,
    json: async () => ({
      truncated: false,
      tree: [
        { type: 'blob', path: 'Models/a.lib', size: 10 },
        { type: 'blob', path: 'README.md', size: 10 },
        { type: 'tree', path: 'Models/sub', size: 0 },
        { type: 'blob', path: 'Scripts/x.py', size: 10 },
      ],
    }),
  });
  const listed = await listLibraryFiles({ fetchImpl: good });
  eq('only Models/ blobs are listed', listed.length, 1);
  eq('the listed path is right', listed[0].path, 'Models/a.lib');
}

console.log('\nA stored definition keeps everything a part needs');
{
  // REGRESSION: the record written to IndexedDB enumerates its fields, so a
  // field added in `parseDefinitions` is silently dropped here. `params` was,
  // and the effect was that a fully downloaded library registered ZERO
  // placeable parts — every card present, every one stripped of its
  // parameters. Same shape as `enabled` vanishing from `toJSON`.
  //
  // Node has no IndexedDB, so this asserts the CONTRACT the store must
  // preserve: whatever a part is built from has to survive the round trip.
  const defs = parseDefinitions('.MODEL DX D(IS=1E-14 RS=2)', 'Models/a.lib');
  const built = partsFromDefs(defs, kindForModelType);
  eq('a part is built before storage', built.length, 1);

  // Mirror what saveLibrary persists, then rebuild from that alone.
  const stored = defs.map((d) => ({
    path: d.path, kind: d.kind, type: d.type, pins: d.pins, line: d.line,
    start: d.start, end: d.end, depth: d.depth ?? 0,
    ...(d.params ? { params: d.params } : {}),
  }));
  const rebuilt = partsFromDefs(
    stored.map((d, i) => ({ ...d, name: defs[i].name })), kindForModelType);
  eq('the same part is rebuilt from the stored record', rebuilt.length, 1);
  eq('the stored record keeps its params', rebuilt[0].params, built[0].params);
  check('params are non-empty after the round trip', !!rebuilt[0].params);
}

console.log('\nStorage degrades gracefully');
{
  // Node has no IndexedDB. The library is an enhancement, so its absence must
  // report "nothing installed" rather than throw on startup.
  eq('storage is correctly reported unavailable', storageAvailable(), false);
  eq('meta is null when storage is unavailable', await libraryMeta(), null);
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  ' + f);
  process.exit(1);
}
