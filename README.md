# SpiceLab

A SPICE-class analog circuit simulator that runs entirely in the browser, with a
schematic editor, instruments and a GPU waveform renderer. Nothing is uploaded;
the solver runs on your machine.

The target is **interactive real-time** — dragging a component value re-solves
and repaints within one frame. That single requirement shapes most of the
architecture.

> **Status: working, and honest about its limits.** The numerics are validated
> against closed forms and against ngspice. The device library is small. Read
> [What it is not](#what-it-is-not) before deciding it fits your problem.

---

## Two engines, deliberately

|  | SpiceLab core | ngspice 46 |
|---|---|---|
| Role | interactive | coverage |
| Devices | 13 kinds, MOSFET levels 1 and 3 | everything ngspice has |
| Analyses | `.op` `.dc` `.ac` `.tran` | plus `.noise` `.tf` `.sens` `.pz` … |
| Value change re-solves in a frame | yes | no |
| Size | 415 KB (155 KB gzipped) | 4.9 MB, loaded only when needed |

The core is Rust compiled to WebAssembly. ngspice is compiled to WebAssembly
too, and loaded **only when a design needs something the core lacks** — a BSIM
transistor, a JFET, a transmission line. Routing happens per design, and which
engine ran is shown in the UI rather than hidden, because the two behave
differently in ways you can feel.

Both engines stream results through the same lock-free ring buffer and emit the
same row format, so probes, instruments and the renderer never learn which one
ran.

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

## Validation

Numerical bugs in a circuit simulator are silent. A sign error in one Jacobian
entry, or a charge stored from the wrong iterate, produces waveforms that look
entirely reasonable and are wrong. **Plausibility is not a test.** So there are
four independent layers, and `npm test` runs all of them:

| Layer | What it proves |
|---|---|
| Analytic suite | Closed-form answers — RC steps, LC energy conservation, transformer turns ratios, known bias points |
| Golden fixtures | The Rust core reproduces the JS reference oracle exactly |
| **ngspice differential** | An independent implementation agrees. This is the layer that found the real bugs |
| **Parser conformance** | ngspice's own 623 test netlists all parse, with none reported as malformed |

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

- **Not a replacement for ngspice or LTspice.** 13 device kinds against their
  forty-odd. No BSIM, no VDMOS, no JFET in the interactive core — those need the
  coverage engine.
- **No bundled part library.** Vendor models are free to download and use but
  not ours to redistribute. The editor lists where to get them and imports one
  from local disk in a click.
- **No noise analysis**, no pole-zero, no sensitivity in the core.
- **Not yet validated end to end against an unmodified vendor `.lib`.** The
  macromodel machinery works and is tested; the syntax found only in real vendor
  files has not been proven.

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
