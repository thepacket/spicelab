#!/usr/bin/env bash
#
# Build ngspice 46 for WebAssembly and link it against scripts/ngshim.c.
#
# Output lands in src/ngspice/ and is NOT committed — same policy as the
# wasm-bindgen output in src/wasm/. Full explanation of the three non-obvious
# flags is in docs/ngspice-wasm-build.md; the short version:
#
#   STATIC=-static / libngspice_la_CFLAGS=-static
#       --with-ngshared hard-codes -shared into AM_CFLAGS in two places, and
#       libtool rejects it because it cannot build shared libraries for an
#       unknown host. Overriding at make time avoids patching the tree.
#   -sSUPPORT_LONGJMP=emscripten
#       must match how the library objects were compiled, or wasm-ld reports
#       an undefined `emscripten_longjmp`.
#
# XSPICE is ON. It was off on the assumption that it dlopens native objects at
# runtime — true of its CODE MODELS (`.cm` bundles, which is why the 74xx
# libraries still do not work), but NOT of the rest of it. `POLY()` on E/F/G/H
# sources is gated behind --enable-xspice and needs no dlopen at all, and
# without it ngspice refuses the card outright:
#
#   XSPICE is required to run the 'poly' option in instance egnd 99 0 poly(2)
#
# That is not a corner case. POLY is how every PARTS-generated vendor
# macromodel builds its supply and limiting stages — 361 of the 2,073 files in
# the KiCad Spice Library use it, including TI's own TL072. Disabling XSPICE
# silently made 17% of real vendor models unusable on the coverage engine,
# which is the engine they route to.
#
# OSDI stays off: it genuinely does dlopen at runtime.
# KLU is ON (LGPL, acceptable for this project).
set -euo pipefail

VER=46
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="${NGSPICE_BUILD_DIR:-$ROOT/.ngspice-build}"
# Emscripten. Set EMSDK_DIR if yours lives somewhere else, or just have `emcc`
# on PATH already.
EMSDK="${EMSDK_DIR:-}"
if [ -z "$EMSDK" ] && ! command -v emcc >/dev/null 2>&1; then
  for candidate in "$HOME/emsdk" "$HOME/.emsdk" /usr/local/emsdk /opt/emsdk; do
    [ -f "$candidate/emsdk_env.sh" ] && EMSDK="$candidate" && break
  done
fi
if [ -n "$EMSDK" ]; then
  [ -f "$EMSDK/emsdk_env.sh" ] || { echo "no emsdk_env.sh at $EMSDK"; exit 1; }
fi
if [ -z "$EMSDK" ] && ! command -v emcc >/dev/null 2>&1; then
  echo "Emscripten not found. Install emsdk, or set EMSDK_DIR to its directory." >&2
  exit 1
fi
# shellcheck disable=SC1091
[ -n "$EMSDK" ] && source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1

mkdir -p "$BUILD"
cd "$BUILD"

if [ ! -d "ngspice-$VER" ]; then
  echo "==> fetching ngspice $VER"
  curl -sSL -o "ngspice-$VER.tar.gz" \
    "https://sourceforge.net/projects/ngspice/files/ng-spice-rework/$VER/ngspice-$VER.tar.gz/download"
  tar xzf "ngspice-$VER.tar.gz"
fi

cd "ngspice-$VER"
# Reconfiguring is guarded so a rebuild is fast, which means CHANGING A
# CONFIGURE FLAG ABOVE does nothing until config.status is removed. That cost
# a full silent rebuild once: the flag changed, `make` re-linked the existing
# objects, and the resulting wasm behaved exactly as before. Set
# NGSPICE_RECONFIGURE=1 (or delete .ngspice-build) after touching them.
if [ "${NGSPICE_RECONFIGURE:-0}" = "1" ]; then rm -f config.status; fi
if [ ! -f config.status ]; then
  echo "==> configure"
  emconfigure ./configure \
    --host=wasm32-unknown-emscripten \
    --with-ngshared \
    --enable-shared=no --enable-static=yes \
    --enable-xspice --disable-osdi --disable-openmp \
    --with-readline=no --with-editline=no --with-fftw3=no \
    CFLAGS="-O2" >/dev/null
fi

# Drop the three XSPICE subdirectories nothing here needs, BEFORE building.
#
#   icm      the .cm code-model bundles. They are dlopen-ed at runtime, which
#            Emscripten cannot do without side modules, so they are dead weight
#            — and they are the only thing that EXECUTES cmpp, the code-model
#            preprocessor, which is what made a naive --enable-xspice build try
#            to run a cross-compiled wasm module as a program.
#   verilog  the Icarus Verilog interface. Genuinely needs a shared library and
#            dies under libtool exactly as --with-ngshared does.
#   vhdl     same shape, same reason.
#
# `libngspice.la` links NOTHING from any of them (check `libngspice_la_LIBADD`
# in src/Makefile), so this costs no functionality and removes the only three
# failure points. XSPICE itself — including the POLY handling that is the whole
# reason it is enabled — lives in mif/cm/enh/evt/idn, which still build.
echo "==> trim xspice subdirs"
sed -i.bak 's|^SUBDIRS = mif cm enh evt idn cmpp icm verilog vhdl|SUBDIRS = mif cm enh evt idn|' \
  src/xspice/Makefile
grep -q '^SUBDIRS = mif cm enh evt idn$' src/xspice/Makefile || {
  echo "xspice SUBDIRS not trimmed — ngspice's Makefile layout changed" >&2
  exit 1
}

# The FULL recursive make, not a single target.
#
# `libngspice.la` depends on convenience libraries built by recursing into
# frontend/, spicelib/, maths/ and misc/. Asking for that one target on a clean
# tree fails with "No rule to make target 'frontend/libfte.la'" — which an
# incrementally-built tree hides completely, because those libraries are
# already there from a previous run. That is how this shipped broken: it passed
# locally and failed in Docker on the first clean build.
echo "==> make"
emmake make STATIC=-static libngspice_la_CFLAGS=-static libngspice_la_LDFLAGS= -j8 >/dev/null

echo "==> link shim"
mkdir -p "$ROOT/src/ngspice"
emcc "$ROOT/scripts/ngshim.c" \
  -I src/include -I src/include/ngspice \
  src/.libs/libngspice.a \
  -O2 -sSUPPORT_LONGJMP=emscripten -sALLOW_MEMORY_GROWTH=1 -sEXIT_RUNTIME=0 \
  -sINITIAL_MEMORY=64MB -sSTACK_SIZE=1MB \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node \
  -sEXPORTED_FUNCTIONS='["_ngw_init","_ngw_load","_ngw_command","_ngw_vec","_ngw_running","_malloc","_free"]' \
  -sEXPORTED_RUNTIME_METHODS='["ccall","cwrap","HEAPF64","UTF8ToString","stringToNewUTF8"]' \
  -o "$ROOT/src/ngspice/ngspice.mjs"

echo "==> done"
ls -la "$ROOT/src/ngspice/"
