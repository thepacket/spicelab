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
# XSPICE and OSDI are off because both dlopen native objects at runtime.
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
if [ ! -f config.status ]; then
  echo "==> configure"
  emconfigure ./configure \
    --host=wasm32-unknown-emscripten \
    --with-ngshared \
    --enable-shared=no --enable-static=yes \
    --disable-xspice --disable-osdi --disable-openmp \
    --with-readline=no --with-editline=no --with-fftw3=no \
    CFLAGS="-O2" >/dev/null
fi

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
