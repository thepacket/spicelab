# SpiceLab

[![tests](https://github.com/thepacket/spicelab/actions/workflows/tests.yml/badge.svg)](https://github.com/thepacket/spicelab/actions/workflows/tests.yml)

A SPICE-class analog circuit simulator that runs entirely in the browser, with a
schematic editor, instruments and a GPU waveform renderer. Nothing is uploaded;
the solver runs on your machine.

The target is **interactive real-time** — dragging a component value re-solves
and repaints within one frame. That single requirement shapes most of the
architecture.

> **Status: first hours of its development. The UI is rough and incomplete.**
> The numerics are validated against closed forms and against ngspice. The
> built-in device library is small, though the editor can download a large
> third-party one. Read [What it is not](#what-it-is-not) before deciding it
> fits your problem.

---

## Two engines, deliberately

|  | SpiceLab core | ngspice 46 |
|---|---|---|
| Role | interactive | coverage |
| Devices | 13 kinds, MOSFET levels 1 and 3 | 59 implementations — BSIM, VBIC, HiSIM, VDMOS, JFET, transmission lines — minus the XSPICE code models |
| Analyses | `.op` `.dc` `.ac` `.tran` `.tf` | the same set |
| Value change re-solves in a frame | yes | no |
| Size | ~430 KB, always loaded | ~4.9 MB, loaded only when needed |

The core is Rust compiled to WebAssembly. ngspice is compiled to WebAssembly
too, and loaded **only when a design needs something the core lacks** — a BSIM
transistor, a JFET, a transmission line. Routing happens per design, and which
engine ran is shown in the UI rather than hidden, because the two behave
differently in ways you can feel.

Both engines stream results through the same lock-free ring buffer and emit the
same row format, so probes, instruments and the renderer never learn which one
ran.

**The coverage engine buys devices, not analyses.** It is driven by explicit
nutmeg commands rather than by the netlist's own analysis cards, so a design
carrying `.noise` routes there correctly and is then asked to run a transient —
the card is never executed. Both engines offer exactly the analyses above.

`.four`, `.measure` and `.step` are implemented *above* both engines, on the
rows they already emit, so they work whichever one ran.

## Quick start

```bash
npm install
npm run build:wasm      # Rust core -> WebAssembly
npm run dev             # serves with the COOP/COEP headers SharedArrayBuffer needs
```

Then open `/demo/editor.html`.

`npm run build:ngspice` additionally builds the coverage engine (~5 minutes,
needs Emscripten). Everything works without it; designs that need it say so
instead of running.

## Parts and symbols

Nothing is bundled, and that is not caution — a repository that aggregates
vendor models grants nothing its author ever held. Instead the editor fetches
on one explicit click, into your browser, and keeps it there:

| | Source | Scale |
|---|---|---|
| Models | KiCad Spice Library | 154,009 definitions — 106,210 `.model` cards, 47,799 `.subckt` macromodels |
| Symbols | KiCad symbol library | 17,038 symbols, so a macromodel draws as the part it is |

**93,538 of those models are directly placeable** on a symbol — diodes, BJTs,
MOSFETs, JFETs, power FETs and switches. The rest are macromodels, which are
placed as a Subcircuit with the pin list filled in from the parsed `.subckt`
line: pin order is the netlist contract, and re-keying it by hand is how you
manufacture an error.

Choosing a part is a chooser dialog opened from the component and filtered to
its type, with the parameters that distinguish candidates shown per row — you
should not have to know a part number to find a part.

## Validation

Numerical bugs in a circuit simulator are silent. A sign error in one Jacobian
entry, or a charge stored from the wrong iterate, produces waveforms that look
entirely reasonable and are wrong. **Plausibility is not a test.** So there are
four independent layers, and `npm test` runs all of them — around 690 JS
checks plus 80-odd Rust tests:

| Layer | What it proves |
|---|---|
| Analytic suite | Closed-form answers — RC steps, LC energy conservation, transformer turns ratios, known bias points |
| Golden fixtures | The Rust core reproduces the JS reference oracle exactly |
| **ngspice differential** | An independent implementation agrees. This is the layer that found the real bugs |
| **Parser conformance** | Third-party regression suites — ngspice's 623 netlists and Xyce's 3,726 — parse without being reported as malformed, and over 1,600 of the Xyce set build cleanly |

The third layer earns its keep. The oracle only proves the Rust core reproduces
*itself* — both were written from the same reading of the same equations, so a
shared misreading agrees perfectly and is wrong together. Diffing against
ngspice found MOSFET bulk junctions missing entirely, BJT ohmic resistances
parsed and never stamped, and every p-channel MOSFET wrong since the original
port.

The fourth layer proves something different again: that SpiceLab can *read what
people actually write*. It found `.MODEL D(IS=1E-12, RS=14.6K)` failing because
commas were not treated as separators, and — worse — `470µF` evaluating to 470
**farads**, because the suffix matcher compared bytes and a UTF-8 micro sign
starts with `0xC2`.

`CLAUDE.md` records every silent-failure bug found so far, with the reasoning
that caught it. It is the most useful file in the repository.

## What it is not

- **Not a replacement for ngspice or LTspice.** The interactive core has 13
  device kinds — R, C, L, the four controlled sources, both independent
  sources, a voltage-controlled switch, diode, Gummel-Poon BJT and MOSFET
  (levels 1 and 3). ngspice ships **59** device implementations, and roughly
  half of those are alternative MOSFET and BJT model families — BSIM, HiSIM,
  VBIC, SOI, HFET — rather than different element types. **That is the real
  gap: no BSIM, so no modern IC process work in the interactive core.**
  (JFETs and power FETs *are* placeable and do simulate — they route to the
  coverage engine, which is the two-engine design working, not a limitation.)
- **No bundled part library.** Vendor models are free to download and use but
  not ours to redistribute, so they are fetched into your browser rather than
  shipped here. Nothing is uploaded either way.
- **No noise analysis**, no pole-zero, no distortion, no sensitivity. `.noise`
  is further off than it looks: the flicker-noise parameters are parsed and
  never stamped, and there is no noise pass at all.
- **`POLY()` does not run.** It is gated behind XSPICE, which is now compiled
  in — but ngspice implements POLY by rewriting the source into an XSPICE
  code-model instance, and code models are `dlopen`ed `.cm` bundles Emscripten
  cannot load without building them as side modules. That is **361 of the
  2,073 files** in the KiCad library, including TI's own TL072, so it is the
  largest single gap in vendor-model coverage. The same work would unblock the
  74xx logic libraries.
- **Not yet validated end to end against an unmodified vendor `.lib`.** No
  longer for want of a file — TI's TL072 macromodel ships with the library
  above, and native ngspice runs it at 106.9 dB against the datasheet's 106 dB
  typical. It is blocked on the POLY gap. `tests/vendor-model.test.mjs` asserts
  the routing today and skips the measurements with that reason, so it starts
  passing when code models land.
- **The UI is unfinished.** The layout is being moved to a docked arrangement;
  the left palette is still a list of text buttons rather than a toolbar.

## Requirements

Cross-origin isolation is **required**, in production too. Without
`SharedArrayBuffer` the worker streams into memory the page cannot see and every
run silently produces an empty plot, so SpiceLab refuses to start rather than
degrade:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

WebGPU is optional — the oscilloscope falls back to Canvas2D.

## Contributing

**Pull requests are not accepted** and are closed automatically. This is about
capacity, not about your change: reviewing an outside contribution to the
standard above means reproducing the analysis that justifies it.

**Issues are welcome**, especially a netlist that reproduces a wrong number or a
parse failure. A reproducer is worth more here than a patch. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

**GPL-3.0-or-later.** The build links ngspice, whose KLU solver and `numparam`
evaluator are LGPL-2.1, statically, into a single WebAssembly module. A
permissive licence was available by disabling KLU, and was rejected — it is the
reason large circuits are fast, and trading that for a licence badge would be a
bad deal. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for the full
reasoning and every component's terms.
