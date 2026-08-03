# Building ngspice 46 for WebAssembly

Phase 0 of the hybrid-engine plan: `libngspice` compiled to wasm, to run beside
the Rust core as a second engine covering the devices and analyses the Rust core
does not implement.

**Status: working.** Verified with emsdk 6.0.1 on macOS (arm64 host), ngspice 46.

---

## The recipe

Needs Emscripten (verified with emsdk 6.0.1). Either have `emcc` on `PATH`, or
point `EMSDK_DIR` at an emsdk checkout:

```
source /path/to/emsdk/emsdk_env.sh    # or: export EMSDK_DIR=/path/to/emsdk
```

`npm run build:ngspice` does everything below and searches the usual emsdk
locations on its own.

Then, from an unpacked `ngspice-46`:

```
emconfigure ./configure \
  --host=wasm32-unknown-emscripten \
  --with-ngshared \
  --enable-shared=no --enable-static=yes \
  --disable-xspice --disable-osdi --disable-openmp \
  --with-readline=no --with-editline=no --with-fftw3=no \
  CFLAGS="-O2"

emmake make STATIC=-static libngspice_la_CFLAGS=-static libngspice_la_LDFLAGS= -j8
```

Produces `src/.libs/libngspice.a` (~10 MB of wasm objects). Link it into an
application with:

```
emcc app.c \
  -I ngspice-46/src/include -I ngspice-46/src/include/ngspice \
  ngspice-46/src/.libs/libngspice.a \
  -O2 -sSUPPORT_LONGJMP=emscripten -sALLOW_MEMORY_GROWTH=1 \
  -sEXIT_RUNTIME=0 -sINITIAL_MEMORY=64MB -sSTACK_SIZE=1MB \
  -o app.js
```

## The three flags that are not obvious

Each of these is a build failure, not a preference.

**`STATIC=-static` and `libngspice_la_CFLAGS=-static`.** `--with-ngshared` makes
`configure` emit `AC_SUBST([STATIC], [-shared])`, and `src/Makefile.am:591`
additionally hard-codes `libngspice_la_CFLAGS = -shared`. Both land in compile
lines. libtool has already decided `build_libtool_libs=no`, because
`wasm32-unknown-emscripten` is not a host it knows how to build shared libraries
for, so it rejects `-shared` at COMPILE time with

```
libtool: error: cannot build a shared library ... Fatal configuration error.
```

Overriding both on the make command line is enough; no patching. Note that
`--with-ngshared` is still required — it defines `SHARED_MODULE`, which is what
turns ngspice into a callback-driven library instead of a program with a `main`.

**`-sSUPPORT_LONGJMP=emscripten` at link.** ngspice uses `setjmp`/`longjmp` for
error recovery. The library objects are built with emsdk's default (JS-based)
SjLj, so they reference `emscripten_longjmp`. Linking with
`-sSUPPORT_LONGJMP=wasm` instead produces:

```
wasm-ld: error: libngspice.a(sharedspice.o): undefined symbol: emscripten_longjmp
```

The link mode must match what the objects were compiled with. Rebuilding the
library with `CFLAGS="-O2 -sSUPPORT_LONGJMP=wasm"` and linking the same way is
the faster option and worth doing later — wasm-native SjLj avoids the JS glue —
but the two must agree.

**`#include <stdbool.h>` before `sharedspice.h`.** The header does
`typedef bool NG_BOOL;` without including `stdbool.h` itself.

## What is deliberately left out

- **XSPICE code models** and **OSDI/Verilog-A**. Both `dlopen` native shared
  objects at runtime (confirmed: a stock build ships `analog.cm`, `digital.cm`,
  `xtradev.cm`, `tlines.cm`, `table.cm` as separate files). Emscripten can do
  this only via wasm side modules, which forces `-sMAIN_MODULE` on the main
  binary and defeats dead-code elimination. Not worth it for Phase 0.
- **OpenMP** and any use of `bg_run`. See the threading note below.
- **readline/editline/fftw3.** Interactive CLI and an external FFT, neither
  needed.

**KLU is ENABLED** (`--disable-klu` NOT passed). It is LGPLv2 where the rest of
ngspice is Modified BSD; that is acceptable here because this project accepts
copyleft. If that ever changes, drop it and the MIT-compatible
`src/maths/sparse` solver takes over.

## Threading: a constraint, not a preference

`configure` detects libpthread and sets `HAVE_LIBPTHREAD`, because ngspice uses
threads for `bg_run`. This build does **not** enable Emscripten pthreads, so
`bg_run` must never be called. Instead, call `ngSpice_Command("tran ...")`
synchronously and let it block — which is fine, because in spicelab it runs
inside a Web Worker that is allowed to block.

This is what lets the hardest Emscripten problem be skipped entirely. Calling
`bg_run` would drag pthreads, `-pthread`, and a SharedArrayBuffer-backed memory
back into the build.

Symbol visibility is a non-issue despite `-fvisibility=hidden` being added by
the shared build: `sharedspice.h` marks the API
`__attribute__((visibility("default")))`.

## Verified behaviour

From `spike.c`:

| Question | Result |
|---|---|
| `ngSpice_Init` under wasm | ok |
| Netlist as strings via `ngSpice_Circ` — no filesystem | ok |
| `.op` on a divider | V(mid) = 7.5000000000, error 0.00e+00 |
| `SendData` fires per timepoint | 526 calls for a 5 ms / 10 us transient |
| Malformed netlist | reported as an error and execution continued; `ControlledExit` never fired and the runtime did not unwind |

The only startup complaint is `Warning: can't find the initialization file
spinit`, which is benign — `spinit` only sets defaults and loads code models,
and there are none here.

From `payoff.c` — things the Rust core cannot do, all working:

| | |
|---|---|
| BSIM3v3 (level 8) | runs |
| BSIM4 (level 14) | runs |
| VDMOS power FET | runs |
| JFET | runs |
| LTRA lossy transmission line | runs |
| `.noise` | total output noise 3.95e-5 V |
| `.tf` | vectors are `Transfer_function`, `vin#Input_impedance`, `output_impedance_at_V(c)` |
| `.sens` | runs |
| `.pz` | **aborted** on a passive RC test circuit. Not diagnosed — could be the test netlist, or ngspice's pz algorithm, which is documented as fragile. Not a blocker. |

## Size

| | Raw | gzip |
|---|---|---|
| spicelab Rust core | 415 KB | 155 KB |
| ngspice + spike harness | 4.86 MB | 1.56 MB |

About 10x. Acceptable for a second engine **if it is lazy-loaded** — fetched
only when a design needs a device or analysis the Rust core does not have. It
should not be in the initial page load.

## Streaming and back-pressure: RESOLVED, and better than expected

This section previously recorded back-pressure as an open problem, on the
reasoning that `SendData` has no return value meaning "wait" and that reaching
for `bg_run`/`bg_halt` would drag pthreads back in. **That reasoning was wrong**,
and the mistake is worth keeping written down because it is the same shape as
several numerical ones in this project: a limitation assumed from an API's
signature rather than from how it is actually called.

`SendData` is invoked **synchronously, from inside ngspice's timestep loop**, on
whatever thread called `ngSpice_Command`. That thread is a Web Worker, which is
allowed to block. So a callback that blocks stalls ngspice's solver — which is
precisely back-pressure, reached by a different route than the Rust core's row
budget.

`RingWriter.waitForSpace()` does this with `Atomics.wait` on the read counter;
the consumer already notifies it on every drain. `tests/ngspice-engine.test.mjs`
proves it by streaming a ~500-row transient through a ring with a capacity of
**two rows**: if flow control did not work the run would drop or overwrite data,
and the test asserts monotonic time and closed-form RC values, so it cannot pass
by accident.

The consequence is worth stating plainly: **this is a capability every
subprocess-based frontend lacks**, Qucs-S included. Linking the library rather
than spawning a binary is what buys it.

The remaining limitation is different and real: ngspice has no resumable
stepper, so `pause`/`resume` cannot be honoured mid-run. `NgspiceEngine` reports
that rather than pretending.

## Two bugs in the shim, both silent

Recorded because they are the same shape as the numerical ones this project
keeps finding: plausible output, no error.

**The AC imaginary part was dropped.** `cb_data` read only `vecvalues.creal`, so
an AC sweep returned the REAL part of the transfer function. That still falls
off with frequency and still looks like a filter response — it is simply wrong
everywhere except DC. A `1k`/`1u` low-pass reported 0.99607 at 10 Hz where |H|
is 0.99803. Now emits `creal` and `cimag` when the plot is complex, giving rows
of `[f, re0, im0, ...]` — the same shape the Rust engine returns, so
`Probe.resolve` needs no special case. Verified against the closed form to
1e-16.

**The independent variable was found by name, then by pointer, and both were
wrong.** Matching `"time"` left `frequency` sitting in an ordinary column with
slot 0 empty, so every AC row had its x axis in the wrong place. Switching to
the structural signal — the vector whose `pdvec` equals the common
`pdvecscale` — fixed tran and ac and broke `op`, because **an operating point
has no independent variable and ngspice points every `pdvecscale` at the last
ordinary signal**. That is structurally identical to `tran` pointing them all at
`time`, so the pointers cannot distinguish the two. The result was that `in`
silently vanished from every op, and the shortened vector list changed the
stride, so a later transient could not attach to the ring at all.

The plot `type` string is the only discriminator: `"op1"` versus `"tran1"`,
`"ac1"`, `"dc1"`. `g_has_scale` gates the whole thing.

The second failure also exposed a test defect worth noting: the producer threw
inside the worker before setting a terminal ring state, and the consumer loop
had no deadline, so the test HUNG instead of failing. A hanging test reports
nothing. It now has a 30 s deadline and a check that names the cause.

## Still open

- **`.pz` aborted** on a passive RC test circuit. Not diagnosed — could be the
  test netlist, or ngspice's pz algorithm, which is documented as fragile.
- **Analyses beyond op/tran/ac are not surfaced** through the engine contract at
  all. `.noise`, `.tf` and `.sens` work (proven in the spike) but have result
  shapes the ring row format cannot carry.
