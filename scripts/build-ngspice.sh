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

# XSPICE needs `cmpp`, its code-model preprocessor, and cmpp is a BUILD-TIME
# tool that has to run on the HOST. Under emmake it gets cross-compiled to
# wasm and the build then tries to execute a wasm module as a program:
#
#   .../src/xspice/cmpp/cmpp:2  var Module=typeof Module!="undefined"...
#
# So build it natively in a throwaway tree and drop it in. This is the standard
# autotools cross-compile workaround, and it is the ACTUAL obstacle XSPICE
# posed — not the dlopen story this file used to tell.
if [ ! -x "$BUILD/native/cmpp" ]; then
  echo "==> native cmpp (build tool, must run on the host)"
  rm -rf "$BUILD/native" && mkdir -p "$BUILD/native"
  cp -r "$BUILD/ngspice-$VER" "$BUILD/native/src-tree"
  ( cd "$BUILD/native/src-tree" && make distclean >/dev/null 2>&1 || true
    ./configure --enable-xspice --with-ngshared --disable-osdi \
      --disable-openmp --with-readline=no --with-editline=no \
      --with-fftw3=no >/dev/null 2>&1
    make -C src/xspice/cmpp -j8 >/dev/null 2>&1 )
  cp "$BUILD/native/src-tree/src/xspice/cmpp/cmpp" "$BUILD/native/cmpp"
  rm -rf "$BUILD/native/src-tree"
fi
cp "$BUILD/native/cmpp" src/xspice/cmpp/cmpp
chmod +x src/xspice/cmpp/cmpp
touch src/xspice/cmpp/cmpp    # newer than its sources, so make leaves it alone

# Only the LIBRARY, not the whole tree.
#
# A full `make` also builds src/xspice/verilog (the Icarus Verilog interface),
# which genuinely requires a shared library and dies under libtool the same way
# --with-ngshared does. Nothing here links it, so building it is pure cost. The
# .cm code-model bundles are skipped for the same reason — see the note about
# POLY in docs/ngspice-wasm-build.md.
echo "==> make"
( cd src && emmake make STATIC=-static libngspice_la_CFLAGS=-static \
    libngspice_la_LDFLAGS= libngspice.la -j8 >/dev/null )

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
