# SpiceLab — project context

Browser-based analog circuit simulator: SPICE-class solver, schematic editor,
save/reload, full instrument set. Target is **interactive real-time** — dragging
a component value re-solves and repaints within one frame.

**The core is Rust, compiled to WASM.** The JavaScript in `src/core/` is not the
production path. It is a verified reference oracle, and its job is to be the
thing the Rust core is diffed against.

Read this file before changing anything in `src/core/` or `crates/`.

---

## What exists

`src/core/` — complete JS oracle. All 27 analytic cases pass.
`crates/spicelab-core/` — Rust core. At fixture parity with the oracle.

```
npm test                          # everything below, in order
npm run test:js                   # JS oracle, closed-form. Must stay green.
npm run test:rust                 # 76 tests: golden diff, analytic, netlist
npm run test:ring                 # ring buffer, incl. a real cross-thread run
npm run test:stream               # netlist -> wasm -> ring -> main thread
npm run test:engines              # engine contract + which engine runs a design
npm run test:ngspice-engine       # ngspice-in-wasm streaming through the ring
npm run build:ngspice             # build ngspice 46 -> src/ngspice/ (~5 min)
npm run test:schematic            # net extraction, ERC, emit, solver round trip
npm run test:probes               # probe resolution, routing, persistence
npm run test:batch                # sweeps, Monte Carlo, measurement reduction
npm run test:ngspice              # differential vs real ngspice (skips if absent)
npm run build:wasm                # rebuild wasm + JS bindings (both targets)
npm run dev                       # dev server with COOP/COEP, then open /
npm run fixtures                  # regenerate tests/fixtures/golden.json
```

`npm run test:stream` needs `npm run build:wasm` first; the generated bindings
in `src/wasm/` and `src/wasm-node/` are build artifacts and are not committed.

Homebrew's rustup does not put shims on `PATH`. If `cargo` is not found:

```
export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"
```

| Piece | JS oracle | Rust core |
|---|---|---|
| Sparse complex LU, full Markowitz ordering | Verified | Verified |
| BE / trapezoidal / Gear2 + LTE control | Verified | Verified |
| R C L K E F G H, voltage-controlled switch | Verified | Verified, incl. coupled-inductor transient |
| Independent sources, all SPICE waveforms | Pulse only | All seven, closed-form |
| Diode, Gummel-Poon BJT, MOSFET level 1 | DC and AC | DC, AC, and transient charge paths |
| MOSFET gate + bulk charge (Meyer, depletion) | Textbook Meyer, DC/AC only | ngspice's `DEVqmeyer`, incrementally integrated |
| MOSFET level 3 (short-channel) | Not implemented | Verified against ngspice over a bias grid |
| Newton + gmin/source stepping | Verified | Verified |
| `.op`, `.dc`, `.ac`, `.tran` | Verified | Verified |
| Netlist parser, `.subckt`, `.param` | Not started | Implemented (see caveat below) |

Above the core, in JS: worker protocol + SharedArrayBuffer ring (`src/worker/`),
schematic editor with net extraction and ERC (`src/schematic/`), the probe /
instrument system and WebGPU waveform renderer (`src/instruments/`), and the
batch worker pool for sweeps and Monte Carlo (`src/worker/batch*.js`).

**All seven build-order items are complete.** The application is
`demo/editor.html`. What remains is listed at the end of the build order.

The Rust core reproduces all 11 golden fixtures (72 value checks) and adds an
analytic suite of its own covering the three paths this file previously listed
as untested. Both suites must stay green at every commit.

`tests/fixtures/golden.json` holds 11 declarative circuits with reference
results. This is the contract between the two implementations.

**A third opinion: ngspice.** The JS oracle only proves the Rust core reproduces
*itself* — both were written here from the same reading of the same equations,
so a shared misreading would agree perfectly and be wrong together.
`tests/ngspice-diff.test.mjs` feeds the SAME netlist text to ngspice (an
independent implementation descended from Berkeley SPICE3) and diffs op,
transient, AC and every library part. Install with `brew install ngspice`; the
test skips cleanly when it is absent.

That harness earned its keep on its first run — see the BJT ohmic resistance
entry below — and has since found every real bug in the device models.

**The oracle has been outgrown in one place, deliberately.** The Rust core's
MOSFET gate charge is now ngspice's `DEVqmeyer` integrated incrementally; the
oracle still has the textbook three-region Meyer expression with `q = C(v)*v`.
That is within the oracle's documented scope (semiconductors: DC and AC), and
the only MOSFET golden fixture is an `op` case, so the contract still holds —
but do NOT add a MOSFET transient or AC-with-gate-charge fixture regenerated
from the oracle. For those paths ngspice is the reference, not `src/core/`.

---

## Why the oracle exists

Numerical bugs in a circuit simulator are silent. A sign error in one Jacobian
entry, or a charge stored from the wrong iterate, produces waveforms that look
entirely reasonable and are wrong. Plausibility is not a test.

Two real bugs were caught this way, and both are worth knowing about because the
Rust port can reintroduce either:

**Diagonal-only pivot selection.** MNA rows carrying only a voltage-source
branch coupling have a structurally zero diagonal, so a diagonal-restricted
Markowitz search reports a singular matrix on something as simple as a VCVS
driving a load. The ordering must search all structural nonzeros and produce
**two independent permutations** — `PAQ = LU`, gather by row permutation,
scatter by column permutation. Do not paper over this by adding gmin from every
node to ground; that perturbs every DC result and hides the defect.

**Charge committed from the pre-solve iterate.** Devices compute `q(v)` during
the load pass, which runs *before* the solve. Nonlinear circuits iterate until
`v` stops moving, so the stored charge ends up consistent. Linear circuits exit
Newton after one iteration and the stored charge is left one timepoint stale,
silently corrupting every subsequent integration and LTE estimate. The fix is
one extra stamp pass at the converged solution, in `TransientRun.step()`. Keep
it in the Rust version.

Neither of these produced an error message. Both produced believable output.

The same shape keeps recurring outside the numerics, so two more are recorded
here as a warning about where to look:

**A background tab throttled the whole simulator.** `SimClient` drained the ring
on `requestAnimationFrame`, which does not fire in a hidden tab; the obvious
"fix", `setTimeout`, is clamped to 1 Hz there. Because the ring applies
back-pressure, the consumer's schedule became the solver's speed limit: a 200k
point run took 47 s instead of 0.67 s, with the solver idle almost the entire
time. Nothing errored — it just looked like a slow simulator. The pump now uses
a `MessageChannel` task when hidden, which is not clamped. Whenever a consumer
applies back-pressure, its scheduling is a correctness concern, not a UI detail.

**A destroyed GPU buffer silently dropped a copy.** `GpuScope._grow` destroyed
the old storage buffers before `finish()`/`submit()`, so the copy preserving
existing samples never ran. The waveform then showed a straight ramp from zero
across everything recorded before the last reallocation — no error, no warning,
just a plausible wrong picture. Submit first, destroy after. And look at the
plot: this one was invisible in every numeric check and obvious on screen.

**MOSFET bulk junctions did not exist.** The bulk-source and bulk-drain diodes
were never stamped, so with the gate off and the bulk forward biased to 0.7 V
ngspice conducted 11 mA and this device conducted exactly zero. Invisible
whenever the bulk is tied to the source — which every test did — and wrong the
moment it is not, which is the normal case on-chip and the mechanism behind a
power FET's body diode. This one was PREDICTED from the pattern of the previous
two (parameters read into the model and used nowhere) and confirmed in a single
ngspice run. If a model struct carries a parameter, check that something stamps
it.

**Every PMOS was wrong, in both implementations.** A p-channel card states
`vto` as a NEGATIVE number, and `load_dc` already mirrors the terminal voltages
so the device looks n-channel to the current equation. The threshold has to be
mirrored with them — it was not, so a PMOS turned on `2*|vto|` too early. A
level-1 PMOS that ngspice puts at -3.000 V sat at -1.127 V here. This was not a
Level 3 regression: it had been there from the original port, and the JS oracle
had it too, because the two share the formulation. Nothing caught it because
EVERY MOSFET test used an n-channel device — the golden fixtures, the analytic
suite, all of it. A whole device polarity was untested and therefore wrong.
Fixed in both, with the differential suite now sweeping both polarities at both
levels.

**BJT ohmic resistances were read and never stamped.** `rb`, `re` and `rc` were
parsed into the model and used nowhere: only the diode had internal-node
support, and the framework allocated at most ONE internal node per device. Every
realistic BJT card specifies them, so every realistic BJT was wrong by the IR
drop — 2.5 mV of Vbe on a general-purpose part at a few mA. No closed-form test
caught it because none looked; the JS oracle agreed because it has the same
omission. Diffing against ngspice found it in one run, and the arithmetic
matched to three digits (predicted 2.462 mV, observed 2.456 mV). `Common` now
carries a LIST of internal nodes and the BJT allocates one per non-zero
resistance. Error against ngspice fell from 6.7e-3 to 2.8e-6.

**Every PMOS was wrong in TRANSIENT too, by the same mechanism.** The DC fix
mirrored `vto`; the charge path was left alone. Device voltages and charges are
computed in a sign-mirrored frame, so the integrator's equivalent CURRENT has to
be mirrored back before it reaches the nodes — the conductance does not, being
`dq/dv` with both mirrored. It was not, and the p-channel companion model was
therefore unstable rather than merely inverted: a gate overlap capacitance that
should have passed 50 uA passed 1.2 mA and climbing. Fixed in both
implementations. The lesson is the one the DC fix should already have taught:
when a device works in a mirrored frame, EVERY quantity crossing back out of it
needs the mirror, not just the one that was noticed.

**`q = C(v) * v` is not a charge.** The Meyer gate capacitance was integrated
that way, and whenever `C` moves the product jumps, so crossing a region
boundary injects a current impulse from nowhere. SPICE integrates it
incrementally instead — `q(t) = q(t-1) + Cavg*(v(t) - v(t-1))`, where `Cavg` is
the mean of this timepoint's capacitance and the last one's. That is what
ngspice's "return half the capacitance, add the other half from last time"
convention computes. The symptom was not a wrong number: with `tox` given, a
switching PMOS drove the timestep to collapse, and REFINING the timestep made it
worse. A convergence failure that gets worse with smaller steps is a
formulation error, not a tolerance problem. The textbook three-region Meyer
expression was replaced with ngspice's `DEVqmeyer`, which is continuous through
`vgst = 0` and written in terms of `vdsat` (floored at 25 mV) rather than
`vgs - vth`.

**Overlap capacitances followed the drain/source swap.** A device with `vds < 0`
exchanges the roles of drain and source, and the intrinsic channel charge
partitioning genuinely does swap with them. A gate-drain OVERLAP capacitance is
a fixed piece of geometry and does not. Adding the overlaps before the swap
moved `cgdo` onto the source the instant `vds` crossed zero — a step change in
the Jacobian at a point circuits pass through on every switching edge. It also
left `load_ac` (which never swapped) and `load_tran` (which did) disagreeing
about where the same capacitance lived, so the AC and transient answers for one
circuit came from different netlists.

**Reverse conduction was unreachable.** `lim_vds` refuses to let `vds` fall
below -0.5 V per Newton iteration, which is correct for a forward-biased device
where a large negative excursion is an overshoot. Applied unconditionally it
means Newton can never REACH a genuinely negative `vds`: the drain of a switch
being turned off, a body diode, either half of a transmission gate. The step is
rejected, the timestep collapses, and an entirely ordinary circuit becomes a
hard convergence error. ngspice limits the mirrored quantities when `vds` is
already negative; so does this now. Worth noting because the limiter is
"convergence machinery" and easy to assume cannot affect an answer — here it
decided which answers existed.

**Two analysis-level bugs surfaced the same way, both in `tran.rs`:**

- **The transient operating point used DC source values.** A source written
  `DC 0 PULSE(5 0 ...)` sits at 5 V when transient time starts, and the run
  began from the 0 V operating point instead, so every device jumped
  discontinuously at the first step. SPICE evaluates the waveform at t=0 for
  the transient op (`MODETRANOP`); only `.op` uses the DC value. `Context` now
  carries `tran_op` to distinguish them.
- **Integration order never restarted at a breakpoint.** Trapezoidal carries the
  previous step's branch current forward, and across a source discontinuity that
  history belongs to the other side of the edge. In a branch with no resistance
  to damp it the error alternates in sign and never decays — a gate overlap
  capacitance driven by a PULSE rang at exactly TWICE the correct current,
  forever, with the correct mean. That is why it looked like a plausible
  waveform instead of an error. One backward-Euler step at each breakpoint
  discards the stale history, which is what SPICE has always done.

**The micro SIGN is not the letter u, and matching bytes missed it.** Suffix
selection read `rest.as_bytes()[0]`, which for a UTF-8 `µ` is 0xC2 — no suffix
matched, so it fell through to the "decorative unit text" branch and returned
the mantissa unscaled. **`470µF` evaluated to 470 farads instead of 470
microfarads**: a 10^6 error, no diagnostic, and a perfectly believable waveform.
LTspice and vendor libraries write `µ` constantly — a survey of one public
corpus found 14,593 component values using it across 3,517 files — so this was
not an edge case, it was most real-world input. Two codepoints mean micro and
both occur: U+00B5 MICRO SIGN and U+03BC GREEK SMALL LETTER MU, visually
identical. Match the CHAR, not the byte. (A file in Latin-1 rather than UTF-8
fails loudly at the boundary instead, which is the safe direction.)

A further one, found while wiring the schematic emitter to the parser, has the
same shape and is worth recording because the fix is a rule rather than a patch:

**A "smart" netlist title heuristic.** The parser decided whether line 1 was a
title or a card by asking whether it looked like a card — leading element letter
plus enough tokens. Element prefixes are ordinary English initials, so the title
`divider from schematic` parsed as a DIODE named `divider` between nodes `from`
and `schematic`, and `Common emitter amplifier` would have become a capacitor.
No error: you silently lose a component and gain a phantom one. The rule now
matches SPICE exactly — line 1 is always the title, the sole exception being a
leading `.`, which no prose can be mistaken for. When a heuristic disambiguates
data from metadata, prefer the boring positional rule; the clever one fails
quietly on real input.

---

## Architecture decisions — settled, with reasons

**The solver does not run on the GPU.** Circuit matrices are small (100–2000
unknowns), extremely sparse, and irregular. Sparse LU on them is a sequential
dependency chain; a single GPU dispatch costs more in latency than the whole CPU
solve, before counting the readback stall. WebGPU is for waveform rendering and
for *batch* analyses — Monte Carlo, parameter sweeps, corners — where hundreds of
independent circuits factor in parallel. If you find yourself writing a compute
shader that factors one matrix, stop.

**The matrix is complex-valued everywhere.** AC analysis needs it. Building
real-only and retrofitting means rewriting every device stamp. Real analyses
leave the imaginary part at zero; the cost is ~2x memory and one code path.

**Symbolic and numeric phases are separate.** Ordering, fill-in prediction, and
handle binding happen once per topology change. Everything after that only
stamps values into an already-analysed matrix. This split *is* the real-time
capability — a slider drag must never trigger a re-analysis. Guard it: a device
whose stamp pattern depends on its own state must reserve the union pattern up
front.

**Devices report charge, not capacitance.** `q(v)` and `dq/dv` go to the
integrator, which differentiates. Stamping capacitance directly fails to
conserve charge across timestep changes and produces slow drift in switching
circuits — close to undiagnosable once the codebase is large.

**Every device hook exists on the base trait**, including ones no current device
uses (`load_noise`, `max_timestep`, `temperature`). Adding a trait method later
means editing every device; declaring it now costs nothing.

**Transient is a resumable stepper, not a loop.** `advance_for(ms)` runs for a
slice of wall-clock time and yields. A run-to-completion loop would have to be
rewritten to support interactive playback.

---

## Rust core

Suggested layout. The split matters more than the names: keep the numerics free
of `wasm-bindgen` so they can be tested and benchmarked natively.

```
crates/
  spicelab-core/     no wasm deps. sparse, devices, analyses.
  spicelab-wasm/     wasm-bindgen boundary only. no numerics.
```

Boundary rules:

- The hot loops (`factor`, `solve`, the stamp pass) must not allocate and must
  not cross the wasm boundary. One call in, one call out per timestep at most.
- Solutions go out through a `SharedArrayBuffer` ring buffer, not through
  serialized return values. Note this needs COOP/COEP headers — decide hosting
  now, it is painful to retrofit.
- Build with `simd128` enabled. **The "10–30x the JS" estimate that used to sit
  here was wrong.** Measured native Rust vs the JS oracle, same algorithm, same
  circuits (`cargo run -p spicelab-core --example bench --release`):

  | Circuit | JS | Rust | Speedup |
  |---|---|---|---|
  | RLC ring, 6 unknowns, 663 points | 0.433 ms | 0.248 ms | 1.7x |
  | RC ladder, 52 unknowns, 151 points | 1.48 ms | 0.54 ms | 2.7x |
  | RC ladder, 202 unknowns, 151 points | 4.40 ms | 2.03 ms | 2.2x |

  The oracle is already written in a wasm-shaped style — flat typed arrays, no
  allocation in `factor`/`solve` — which V8 JITs well, and both sides execute
  the same operation count. These are *native* numbers; wasm will be somewhat
  slower again. Do not plan on an order of magnitude. The real arguments for the
  Rust core are predictable latency with no GC pauses, direct control over the
  `SharedArrayBuffer` layout, and batch parallelism for sweeps and Monte Carlo.
- Devices should be an enum dispatched in a match, not `Box<dyn Device>`. The
  stamp pass runs thousands of times per second and trait-object indirection is
  measurable there. The trait can still exist for organisation; the hot path
  should not go through it.
- Store the matrix as parallel `Vec<f64>` for real and imaginary parts, not
  `Vec<Complex>`. Keeps the loops vectorisable.

Differential testing:

```
tests/fixtures/golden.json   # 11 circuits + reference results + per-case tolerance
```

Build the same circuits from that JSON in Rust and assert agreement. Regenerate
the fixtures **only** when the JS oracle changes and `analytic.test.mjs` is
green — a fixture regenerated from a broken oracle silently blesses the
breakage.

Port order: `sparse.rs` first and diff it on the `op` fixtures, then the
integrators against the `tran` fixtures, then devices, then analyses. Do not
port everything and then test.

---

## Conventions

- Node index `-1` is ground. Every stamp helper must skip it.
- `nodes[0]` is the positive terminal; current flows in at `nodes[0]`.
- Device state lives in a shared pool at `state_off`; slot `k` is a charge and
  slot `k+1` is the corresponding branch current (SPICE3 convention). LTE
  estimation relies on this pairing — do not break it.
- Extra unknowns (branch currents) are allocated during topology build and
  handed to the device.
- The JS side has no build step: plain ES modules with JSDoc, runs unmodified in
  Node and in a browser worker. Keep it that way; it is what makes the oracle
  cheap to run.

---

## Build order

Each item constrains the next; deviating tends to cause rework.

1. ~~**Rust core to fixture parity.**~~ **Done.** All 11 golden fixtures pass in
   both implementations. Both documented bug classes were mutation-tested
   against the suite: removing the post-convergence charge commit fails
   `lc_tank_energy`, and restricting the Markowitz search to the diagonal fails
   every fixture containing a voltage source.
2. ~~**Extend the analytic suite.**~~ **Done** for the three named gaps, in
   `crates/spicelab-core/tests/analytic.rs`. Coupled-inductor transient is
   checked against the ideal transformer turns ratio (plus reciprocity and `k`
   scaling); all seven waveform types have closed-form checks; the semiconductor
   transient charge paths are covered by collapsing a nonlinear element onto an
   exactly solvable one — a diode with `m = 0` has `q(v) = cjo*v`, so it is a
   perfectly linear capacitor and its charge path must reproduce a textbook RC
   step. Same trick for the MOSFET, held off so `cgb = cox` stays constant.
3. **Netlist parser + `.subckt` + `.include`.** Implemented in
   `crates/spicelab-core/src/netlist/`: three phases (`parse` -> `flatten` ->
   `build`), full `.param` expression evaluator, nested definitions, parameter
   passing with caller/callee scoping, hierarchical node mapping, `.model`
   resolution innermost-first, and `.include` through a resolver callback so the
   same code serves native and wasm.

   **Parts library — sourced from ngspice, Modified BSD.**
   `src/schematic/parts.js` carries 11 parts (5 diodes, 4 NPN, 2 PNP), each
   copied verbatim from a `.model` card in the ngspice tree with the originating
   file recorded in a `source` field. ngspice's COPYING puts "all of its source
   code, test and example files" under Modified BSD, and its listed exceptions
   are all source directories — not the example netlists these come from. So
   redistribution is fine with attribution, which the `source` field provides.

   Every card was run through this solver before inclusion and the resulting
   forward drop / Vbe / beta checked for physical sanity;
   `tests/schematic.test.mjs` re-runs that so a bad edit cannot slip through.
   Labels say what a part IS rather than naming a manufacturer part number — a
   model card is a fit to one sample, not an authority on a part you can buy.

   Vendor `.lib` files are free to download but almost always forbid
   redistribution, so none are bundled — `.include` is the path for real parts,
   which keeps the licence with whoever accepted it.

   **Vendor cards carry non-numeric metadata**, and refusing it made most of
   them unloadable: `MFG=SIEMENS` on a real ngspice example aborted the parse
   because every model parameter was evaluated as a number. Model parameters
   that fail to evaluate are now IGNORED, as SPICE does — but only if the device
   does not read them. Each device declares its recognised parameter list
   (`DIODE_PARAMS`, `BJT_PARAMS`, `MOS_PARAMS`) and a failure on one of those is
   still fatal, because silently defaulting `IS` would simulate a different
   device.

   Two things this fixed, both of which made whole classes of part unusable:

   - **The emitter wrote a model reference it never defined.** Every diode, BJT
     and MOSFET placed from the palette produced `D1 n1 n2 D1_MOD` with no
     matching `.model`, so it failed to build. A dangling reference is not a
     default. The emitter is now self-contained: it emits the card for whatever
     part is selected, once per distinct model.
   - **ERC demanded a `value` from semiconductors**, whose behaviour comes from
     a `.model` card rather than a number — so every transistor was a hard
     error. They are exempt now, and an unresolvable part id is reported
     instead of silently falling back to a different device.

   **MOSFET Level 3 is implemented**, transcribed from ngspice's reference
   implementation (`src/spicelib/devices/mos3/`, Modified BSD) so the
   formulation matches the simulator it is diffed against: short-channel
   threshold (`xj`, `ld`), narrow width (`delta`), static feedback (`eta`),
   weak inversion (`nfs`), gate-field mobility degradation (`theta`), velocity
   saturation (`vmax`) and channel-length modulation (`kappa`). Agreement with
   ngspice is ~1e-6 relative away from threshold, worst 4e-4 within tens of mV
   of it where the current is tiny.

   `LEVEL` outside {1, 3} is still REJECTED rather than silently reinterpreted:
   reading VTO and KP out of a BSIM card and applying Shichman-Hodges gives a
   working-looking simulation of a device that does not exist. Discrete power
   FETs shipped as `.subckt` macromodels around a Level 3 core should now load.

   **Still outstanding:** the validation this list originally asked for — load an
   *unmodified vendor* op-amp model and check open-loop gain against the
   datasheet. The current op-amp test uses a macromodel written in the test
   file, so it exercises the machinery but cannot catch syntax that only appears
   in real vendor `.lib` files. Get a real one and run it before trusting the
   parser on the wild ecosystem.
4. ~~**Worker protocol + SharedArrayBuffer ring buffer.**~~ **Done.**
   `crates/spicelab-wasm/` is the boundary (no numerics); `src/worker/` is the
   JS side. Verified end to end in Node (`tests/stream.test.mjs`) and in a real
   browser (`demo/index.html`).

   - **Ring** (`src/worker/ring.js`): lock-free SPSC, monotonic row counters,
     power-of-two capacity, release/acquire via `Atomics.store`/`load`. Lossless
     with back-pressure rather than overwriting, because the same buffer carries
     full analysis runs whose points must all arrive.
   - **Back-pressure reaches the solver.** The worker passes the ring's free
     space into `Session.advance(max_steps, max_rows)`, so the solver never
     computes rows that have nowhere to go. Producing-and-discarding would be
     both wasteful and silently lossy.
   - **Never cache a view over wasm memory.** Growing the wasm heap detaches
     every existing `ArrayBuffer` view. `SimEngine._stagedView` rebuilds on
     every call; a cached view works until the first heap growth and then reads
     zeroes.
   - `TransientRun` yields via `advance_steps(n)` rather than the JS
     `advanceFor(ms)`: `Instant::now` does not exist on
     `wasm32-unknown-unknown`, so the host owns the wall-clock budget.

   **Hosting is decided: cross-origin isolation is required, in production too.**
   It is not an optimization. A plain `ArrayBuffer` sent to a worker is copied or
   detached, so without `SharedArrayBuffer` the worker streams into memory the
   main thread cannot see and every run silently yields an empty plot.
   `SimClient.load` therefore throws rather than degrading. Serve with:

   ```
   Cross-Origin-Opener-Policy: same-origin
   Cross-Origin-Embedder-Policy: require-corp
   ```

   Any host that can set response headers works (Netlify `_headers`, Cloudflare
   Pages, CloudFront response-headers policy, nginx). Raw GitHub Pages cannot.
   The standing cost is that every cross-origin subresource must opt in via
   CORP/CORS — keep fonts, images and third-party scripts same-origin.
5. **Schematic editor.** Net extraction, ERC and netlist emission are **done**
   and headless, in `src/schematic/` with `tests/schematic.test.mjs` (40
   checks). The interactive canvas is **not started** — see below.

   Extraction is union-find over two element kinds, lattice POINTS (`P:x,y`)
   and WIRES (`W:id`), so coincidence is free: two pins at one coordinate are
   literally the same DSU element. Coordinates are integers on a grid, because
   "same point" must be exact equality — float coordinates turn connectivity
   into a tolerance question that a rotation's rounding error can silently
   change.

   The rules, and which ones bite:

   - A wire endpoint lying strictly INSIDE another wire connects (T-junction,
     no dot needed).
   - Two wires that merely CROSS do **not** connect. Only an explicit junction
     dot joins them. This is the one whose violation is silent — a crossing
     that wrongly connects still simulates, it just simulates a different
     circuit. Rules 3 and 4 are the same geometric test with different endpoint
     policies, which is exactly why they are easy to conflate; they are written
     as two separate predicates on purpose.
   - Pin ORDER in `SYMBOLS` is part of the netlist contract, not a display
     detail. Getting it wrong reverses a diode or swaps a BJT's collector and
     emitter, which simulates happily and answers wrongly.

   ERC blocks simulate on: no ground reference, unconnected pin, shorted or
   paralleled ideal sources, duplicate refs, missing values — each with a
   message pointing at the component, because the solver can only report that a
   pivot was unavailable, not that R3's pin is one grid square off the wire.

   The emitter produces ordinary netlist text and feeds the same parser as
   hand-written input. The editor gets no private path into the solver, so
   anything drawable is also typeable, saveable and diffable.

   **The canvas is done too.** `src/schematic/render.js` and `editor.js`, with
   the application at `demo/editor.html`: palette, placement, orthogonal wire
   routing, select/drag/rotate/mirror/delete, snapshot undo, wheel zoom about
   the cursor, save/load JSON, live ERC and netlist panels, and simulate with a
   waveform plot. Verified in-browser end to end (place, wire, undo, transient).

   - **Symbols draw through the same transform `pinPositions` uses.** Drawing
     pins at hand-placed screen coordinates would let the picture drift from
     the netlist — the schematic would show one circuit and simulate another.
   - **Junction dots are derived, not stored**, so the dot you see always
     reflects what the extractor actually did.
   - **Undo is snapshot-based.** Documents are kilobytes and edits are
     user-paced, so cloning per edit is free, and an inverse-operation undo has
     to get every command right — the one that is wrong corrupts the document
     invisibly until you simulate.
   - **Wire routing is orthogonal and snapped on commit.** A diagonal that
     almost touches a pin is the classic invisible open circuit.
   - Canvas sizing gotcha: a `<canvas width="2000">` has a 2000px intrinsic CSS
     width, which silently blows the grid layout wider than the viewport. The
     element needs explicit CSS sizing plus `min-width: 0` on the grid child.
   - **Pointer coordinates must be scaled by the backing-store ratio.**
     `getBoundingClientRect` is in CSS pixels; the renderer transform is in
     backing-store pixels. Skipping the conversion still "works" — clicks snap
     to the grid, wires come out orthogonal — they just land somewhere other
     than where the user clicked, by exactly the dpr factor. Invisible at 1x,
     everything is 2x off on a Retina display. `Editor._pos` derives the ratio
     from the element rather than reading `devicePixelRatio`, so it stays right
     if the two disagree.
6. ~~**Instruments**, on a probe system where probes are first-class persisted
   objects routable to any instrument.~~ **Done.** `src/instruments/`, with
   `tests/probes.test.mjs` (48 checks) and verified in-browser.

   A probe is a saved object naming a node voltage, a branch current or a
   differential, with its own id, label and colour — **not** a plot line and not
   a column index. It resolves LATE, against each run's labels:

   - Column indices change whenever the topology changes, so anything holding
     one silently starts displaying a different signal after an edit. A probe
     follows the NET.
   - A probe pointing at a net that no longer exists REPORTS that rather than
     reading whatever now occupies the column. That is the difference between a
     visible error and a plausible wrong trace.
   - **Colour resolves late too.** A probe stores a `colorIndex` — a slot in the
     active theme's trace palette — not a hex. Storing the resolved colour is
     the same mistake as storing a column index: it freezes a decision that
     depends on state which changes underneath it, so a probe assigned
     `#58a6ff` under the dark theme keeps that washed-out blue on white
     forever. An EXPLICIT user-chosen colour is stored as a hex and is not
     repainted; documents saved before `colorIndex` existed keep working
     because a stored `color` still wins. `probeColor()` in `probe.js` is the
     one place that decides.
   - `resolve` returns `read(row, base, stride, offset)`. The stride/offset
     exist because a transient row is one f64 per unknown while an AC row
     interleaves re/im — putting that arithmetic in the probe rather than in
     each instrument means one resolution path serves every analysis.

   Routing lives in the `ProbeSet`, not on either side, so deleting a probe
   cannot leave an instrument holding a dangling reference. One probe can feed
   the scope, the Bode plotter and the meter simultaneously. Probes persist in
   the saved document, so a design keeps its instrumentation.

   **Themes: dark AND light, dark by default.** `THEMES` in `render.js` carries
   the canvas palette (canvas colours cannot inherit from CSS) and the CSS
   custom properties under `:root` / `:root[data-theme="light"]` in
   `demo/editor.html` mirror it. The toggle is in the palette under View and
   persists to `localStorage`. **Do not ship a light default**, and do not wire
   it to `prefers-color-scheme` — light is chosen deliberately.

   Three things this had to get right, all of which were wrong at first:

   - **`COLORS` and `SERIES` are mutated IN PLACE, never rebound.** Instruments
     capture them at import time and a probe stores the colour it was given when
     created, so reassigning the export would leave every existing instrument
     holding the old array.
   - **Instrument palettes are getters, not constructor copies.** They are built
     once at startup; a copied palette silently keeps the old theme forever. The
     first version of this change themed the schematic and the CSS but not the
     instruments, and the result was a light page with two black canvases on it.
   - **Trace colours are a separate palette per theme, not one palette dimmed.**
     The dark set is chosen to glow against near-black; on white the yellow and
     green are close to illegible.

   The theme attribute is applied by an inline script in `<head>`, before the
   stylesheet, or the page visibly flips on every reload.
7. ~~**WebGPU waveform renderer**, then batch compute for sweeps and Monte
   Carlo.~~ **Done.** `src/instruments/gpu-scope.js` and `src/worker/batch*.js`,
   with `tests/batch.test.mjs` (45 checks). Verified in-browser at 200k points.

   **Renderer.** One instanced quad per line segment; the vertex shader reads
   endpoints from a storage buffer and offsets by the half-width along the
   segment normal. No vertex buffer and no per-frame CPU work, so pan/zoom is a
   64-byte uniform write regardless of dataset size — 400k segments encode in
   0.02 ms. Samples upload incrementally (re-sending the whole waveform each
   batch would make streaming O(n^2) in bytes). Axes are a Canvas2D overlay
   sharing the padding, since text is the one thing Canvas2D does better.
   Canvas2D `Oscilloscope` remains a real fallback when WebGPU is absent.

   x uploads as `t - t0` in f32. That is ~7 digits over the run's span — ample
   for pixels, but it bounds deep zoom (a 1 s run resolves to ~100 ns). The f64
   samples stay on the CPU, so re-uploading a re-normalized window is the fix if
   that ever matters.

   **Batch is a CPU worker pool, deliberately.** "Batch on the GPU" means
   hundreds of INDEPENDENT circuits in parallel — the parallelism is across
   cases, never inside one solve. The pool reuses the Rust core exactly as
   validated, so a sweep cannot disagree with a single run; 200 op cases across
   4 workers run in 11 ms and match the analytic curve to 3.6e-15. A WGSL batch
   factoriser would mean reimplementing the numerics where they cannot be
   diffed against the JS oracle, and should not start until this pool is
   measurably the bottleneck.

   Parameter overrides are appended as `.param` (later definitions win) rather
   than substituted textually — a regex loose enough to match a value also
   matches comments and model cards. Monte Carlo is seeded and reproducible,
   and `tol` is read as 3 sigma, which is how component tolerances are meant.

## Analyses are placeable objects

An analysis is an ordinary component with **no pins** — `tran`, `ac` and `op`
live in `SYMBOLS` beside the resistor. This is the Qucs idiom (its file format
stores a `.TR` with the same tuple as an `R`), and the reason to copy it is what
falls out for free rather than the placement itself:

- **Analyses inherit `enabled`.** Switching off a `.tran` is the same operation
  as switching off R3, so there is no separate "which analyses are on" state to
  keep in sync with the canvas. `enabled` therefore lives on EVERY component,
  not just directives.
- **One declaration drives everything.** `SYMBOLS[type].params` is read by the
  property editor, the ERC parameter check and `card()`, so the dialog and the
  emitted card cannot drift apart.
- **A placed block is the source of truth when present**, with the Simulate
  panel as the fallback for schematics that carry no analysis. Which one
  supplied the parameters is REPORTED in the status line — silently preferring
  one is how a user ends up editing a number that has no effect.

Disabled blocks are drawn dimmed, dashed and struck through rather than hidden:
hiding them makes "why is nothing running?" unanswerable from the canvas, which
is the exact question the visible enable state exists to answer.

Two traps, both already sprung once:

- **ERC must exempt directives from `missing-value`.** They carry named
  parameters in `props` and have no value field, so the check that once made
  every transistor a hard error would have made every placed `.tran` one.
- **`toJSON` enumerates fields rather than spreading**, so a new one is silently
  dropped. `enabled` was, and a disabled part came back enabled after
  save/reload — and because `clone()` round-trips through `toJSON` and undo is
  snapshot-based, **undo silently re-enabled things too**. If you add a field to
  a component, add it to `toJSON` in the same edit.

## Subcircuits and raw text, from the canvas

`subckt` and `spice` are the two blocks that make REAL parts reachable without
typing a netlist. Vendor op-amps, regulators and power FETs ship as `.subckt`
macromodels, and the parser has handled those since item 3 — but nothing could
instantiate one from the editor, so all of it was reachable only by hand.

- **`subckt` derives its pins per INSTANCE**, from a user-typed list, because
  they come from the macromodel rather than the symbol. Everything walking pins
  must go through `pinsOf(c)`; reading `SYMBOLS[type].pins` works for the ten
  fixed symbols and silently gives a subcircuit none. **Pin ORDER is the netlist
  contract**, exactly as terminal order is for a transistor: it must match the
  `.subckt` line, and getting it wrong wires the part differently while
  simulating perfectly happily.
- **`spice` emits raw text verbatim.** This is what makes a macromodel usable in
  a browser at all — there is no filesystem, so `.include` cannot reach a vendor
  file; you paste the `.subckt ... .ends` block instead. It generalises the
  project's existing rule that anything drawable is also typeable to *anything
  typeable is also placeable*.

Validated with a three-stage op-amp macromodel of vendor shape: open-loop gain
99,990 against a designed 100,000 (the 0.01% is the 50 ohm output resistance
into the 1 Meg load), **-3.010 dB at the 10 Hz dominant pole** against an exact
-3.010, and a closed-loop inverting gain of 10.00 flat to 10 kHz.

**That still does not close the item-3 validation.** The macromodel was written
here, so it exercises the machinery and cannot catch syntax that only appears in
a real vendor `.lib`. What it does close is the editor-side gap that made the
validation impossible to attempt from the canvas.

## Model libraries: links, not a bundle

`src/schematic/libraries.js` lists where to get models and circuits, and the
editor renders it under **Model libraries**. It is a list of LINKS on purpose.

Almost every large collection is aggregated vendor material. A manufacturer
publishes a `.lib` so you can simulate their part — downloading and using one is
the intended use; redistributing it inside someone else's product generally is
not. **Accepting copyleft does not change this**: a repository that collects
vendor models grants nothing its author never held. So each entry records a
`licence` (`permissive` / `download` / `mixed`) and a `verified` flag saying
whether that was read from the source or is only what the site claims. Do not
upgrade `verified` without reading an actual LICENSE file.

**Import model file…** reads a local `.lib`/`.sub` with `FileReader` and drops
it on the canvas as a SPICE text block — never uploaded, so the vendor's file
stays the user's copy. It reports which `.subckt` names the file defines,
because that is what you must type into a `subckt` block next.

## Parser conformance: two third-party corpora

`tests/corpus.test.mjs` runs real SPICE from other projects through
`checkNetlist`. Different evidence from the analytic suite: those prove the
numbers are right, this proves we can READ what people actually write. Neither
corpus is vendored; each is fetched separately and skipped when absent.

| Corpus | Files | Budget | Strength |
|---|---|---|---|
| ngspice regression suite | 623 | **0** | Broad, decades of hands |
| Xyce_Regression (< 3 KB) | 3,726 | 168 | Directives — `.measure` 446, `.step` 480, `.sens` 241 |

The Xyce budget is a list of KNOWN GAPS, not an acceptance of them: the test
prints the top causes even when passing, so they stay visible. Ratchet both
down; never up.

Xyce_Regression grants GPLv3-or-later **in its README text**, though the
`COPYING` file it links does not exist in the repository. The grant is the
licence statement, not the file.

The budget for `invalid` is **zero**, and getting there fixed four defects:

- **Commas separate parameters in SPICE.** `.MODEL DEN D(IS=1E-12, RS=14.61K)`
  is a stock Analog Devices macromodel; the tokenizer split on whitespace only,
  so the value came out as `1E-12,` and a perfectly ordinary vendor model was
  rejected as malformed.
- **`POLY()` sources, `AGAUSS()` statistical parameters and semiconductor
  resistors were reported as INVALID.** All three are ordinary SPICE that this
  core does not implement — and `invalid` stops engine selection, so each one
  both blamed the user's netlist and blocked it from routing to ngspice, which
  implements all three. They are `unsupported` now.

That last point generalises: **a refusal classified as `invalid` when it should
be `unsupported` is not a cosmetic error.** It changes what the app does.

Two further defects came out of the Xyce corpus:

- **`PARAMS:` was not understood.** It is the PSpice-family keyword introducing
  a subcircuit parameter list, on the definition, the instance or both, and
  vendor `.lib` files use it constantly. Leaving it in the token stream made the
  token after the subcircuit name look positional, so the name did not resolve
  and an ordinary macromodel was reported as referencing an undefined
  subcircuit. Dropped in `pair_up`; 28 more netlists parse.
- **Expression failures were all `invalid`.** An unknown FUNCTION is nearly
  always a feature gap — this evaluator has about a dozen built-ins where
  ngspice and Xyce have many more, and `.func` is not implemented at all — as is
  a reference to a built-in VARIABLE like `{freq}` or `temper`. Both are
  `unsupported` now. An unknown IDENT is deliberately still `invalid`: a
  misspelled parameter is a real and common mistake, and reporting it precisely
  is worth more than routing it onward.

**`ErrorKind` has a third value, `unresolved`**, for a netlist referencing a
file that could not be fetched. 126 corpus netlists were being called malformed
purely because their `.include` could not be resolved. The netlist is fine, and
no other engine can help — a browser has no filesystem — so it stops the search
like `invalid` but says the actionable thing instead: paste the contents into a
SPICE text block.

## Two engines

The Rust core is not the only planned engine. ngspice 46 compiles to wasm (see
`docs/ngspice-wasm-build.md`, verified working) and will run beside it, covering
the devices and analyses the Rust core does not implement — BSIM3/4, VDMOS,
JFET, transmission lines, `.noise`, `.tf`, `.sens`.

They are **not interchangeable, and that is the design**:

| | Rust core | ngspice |
|---|---|---|
| Role | interactive | coverage |
| Value change re-solves in a frame | yes — symbolic/numeric split | no |
| Back-pressure reaches the solver | yes, via a row budget | yes, by BLOCKING in `SendData` |
| Devices | 13 kinds, MOS levels 1 and 3 | everything ngspice has |

Because the difference is user-visible, which engine ran a design is REPORTED,
not hidden. `select()` returns its reason.

**Back-pressure works for ngspice too, and the first analysis here said it could
not.** `SendData` has no return value meaning "wait", so the obvious reading is
that flow control is impossible without `bg_run` and threads. But it is called
SYNCHRONOUSLY from inside ngspice's timestep loop, on a worker thread that is
allowed to block — so blocking in the callback stalls the solver.
`RingWriter.waitForSpace` does exactly that, and
`tests/ngspice-engine.test.mjs` streams ~500 rows through a **2-row** ring to
prove it. A limitation inferred from an API signature rather than from how the
API is actually called; the same shape of mistake as the numerical ones above.

**The selection rule, in `src/worker/engines.js`:**

> `canRun` returns three values, not two. **`invalid` stops the search;
> `unsupported` continues it.**

A netlist the preferred engine calls *invalid* is broken, and handing it to a
second engine is wrong twice over: the fallback may reject it with a worse
message, or it may ACCEPT it — two parsers never agree exactly — and then a typo
silently simulates a different circuit. Only "valid SPICE this engine does not
implement" justifies falling through. `tests/engines.test.mjs` mutation-tests
this: making `invalid` fall through routes a malformed netlist to the fallback,
and three checks fail.

**Routing is per design, and happens in `sim-worker.js` on every `load`.** The
Rust core is created at startup; `NgspiceEngine` is imported and instantiated
**on first need only** — it is ~4.9 MB of wasm against 415 KB, so eager loading
would tax every page view for a capability most designs never use. Routing is
not sticky: a design that needs coverage does not move later designs off the
interactive engine.

**The seam is visible.** `SimClient.engine` carries `{id, label, interactive}`
and `engineReason`; the editor shows a badge next to Simulate that reads
"ngspice 46 — not interactive" in the warning colour when a design lands on the
coverage engine. This is not cosmetic — that engine cannot re-solve within a
frame and cannot be paused mid-run, so leaving it invisible makes the app feel
intermittently broken.

**`canRun` asks the parser; it does not re-implement it.**
`Session.checkNetlist` returns `{ok}` or `{ok:false, kind, line, message}`, and
`kind` is set at the three sites that mean "not implemented here" — an unknown
element letter, an unknown `.directive`, and a MOSFET `LEVEL` outside {1,3}.
A capability list maintained in JS would be a second opinion about what the
parser accepts, and it drifts silently in both directions. Structured JSON
rather than a formatted string, so nothing regex-matches error text.

**Probes resolve on either engine, and that needed two changes.** ngspice names
a branch current `v1#branch` where the Rust core says `I(V1)`, and it lowercases
everything while the Rust core preserves what the netlist wrote. So
`normalizeVectorName` rewrites the FORM at the engine boundary, and
`Probe.resolve` compares CASE-INSENSITIVELY — which is not a workaround but the
correct rule, since SPICE identifiers are case-insensitive and `X1.m` and `x1.m`
are the same net. Without both, re-routing a design to the coverage engine broke
its instrumentation while reporting "net no longer exists" about a net that was
plainly there.

**Both engines emit the SAME row shape** — `[x, v0, v1, ...]` for real analyses
and `[x, re0, im0, ...]` for AC — so the ring, the probe system and the
renderer never learn which engine ran. Getting ngspice into that shape needed
two fixes, both silent failures, both written up in
`docs/ngspice-wasm-build.md`: the AC imaginary part was dropped (leaving the
real part masquerading as a magnitude), and the independent variable could not
be identified by name OR by pointer, because an operating point has no scale and
ngspice points every `pdvecscale` at the last ordinary signal — structurally
identical to a transient pointing them all at `time`. The plot `type` string is
the only discriminator.

Qucs-S was studied for prior art here (it drives ngspice, Xyce and SpiceOpus
from one GUI). Two conclusions: its lifecycle — generator declares the outputs
it expects, parser is driven by that list — is worth copying; its dispatch is
not, being a `switch` on the default simulator in four separate places. It also
does NOT solve streaming: it spawns a subprocess, runs to completion, and
implements interactive tuning by killing and restarting the run on a 1 s
debounce. Driving ngspice through the shared library gives us a per-timepoint
callback it structurally cannot have.

## Known gaps: parameters read but not stamped

Five bugs so far have had the same shape — a parameter parsed into a model
struct and used by nothing. It is worth auditing for directly, because the
symptom is always a slightly-wrong answer rather than an error:

```
python3 - <<'EOF'
import re
src = open('crates/spicelab-core/src/devices/mosfet.rs').read()
fields = re.findall(r'pub (\w+): f64,',
                    src[src.index('pub struct MosModel'):src.index('impl Default for MosModel')])
body = src[src.index('pub struct Mosfet'):]
print([f for f in fields if not re.search(rf'\bm\.{f}\b|\bself\.m\.{f}\b', body)])
EOF
```

As of the bulk-charge work, what that audit still reports:

| Device | Unstamped | Effect |
|---|---|---|
| MOSFET, BJT | `kf af` | Flicker noise. No noise analysis is wired up at all. |

Nothing else. **Both devices are complete at DC, AC and transient**, apart from
noise. What that table used to list — the bulk junction capacitance
(`cbd cbs pb cj mj cjsw mjsw fc pd ps`) and the sheet-resistance form of the
diffusion resistance (`nrd nrs`, which also needed `rsh` added to the model) —
is implemented and diffed against ngspice.

## Validation discipline

Keep both suites green at every commit. Add a case for every new device with a
closed-form answer attached: known bias points, known corner frequencies, known
damping ratios. The LC tank energy-conservation check is the most load-bearing
test in the suite — it catches integration errors immediately and nothing else
does. Where no closed form exists, compare against ngspice and record the
reference values rather than eyeballing a plot.
