#!/usr/bin/env bash
#
# Build the wasm core and generate JS bindings for both targets.
#
#   src/wasm/       --target web     browser / worker
#   src/wasm-node/  --target nodejs  test harness
#
# Two things here are not optional:
#
#  * simd128 is enabled, per the architecture notes.
#  * The nodejs bindings do not re-export the module's `memory`, but the
#    streaming path needs it to build Float64Array views over the staging
#    buffer. This script appends that export, so regenerating the bindings by
#    hand and forgetting it cannot silently break the tests.
#
# Homebrew's rustup does not install shims on PATH, hence the explicit prepend.
set -euo pipefail

cd "$(dirname "$0")/.."

TOOLCHAIN="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin"
if [ -d "$TOOLCHAIN" ]; then
  export PATH="$TOOLCHAIN:$PATH"
fi
export PATH="$HOME/.cargo/bin:$PATH"

if ! command -v cargo >/dev/null; then
  echo "cargo not found. If rustup is installed via Homebrew its shims are not" >&2
  echo "on PATH; add \$HOME/.rustup/toolchains/<triple>/bin to PATH." >&2
  exit 1
fi
if ! command -v wasm-bindgen >/dev/null; then
  echo "wasm-bindgen CLI not found. Install a version matching the crate:" >&2
  echo "  cargo install wasm-bindgen-cli --version \
$(grep -A1 'name = "wasm-bindgen"' Cargo.lock | grep version | head -1 | cut -d'"' -f2)" >&2
  exit 1
fi

echo "==> building spicelab-wasm (release, simd128)"
RUSTFLAGS="-C target-feature=+simd128" \
  cargo build -p spicelab-wasm --target wasm32-unknown-unknown --release

WASM=target/wasm32-unknown-unknown/release/spicelab_wasm.wasm

echo "==> bindings: web -> src/wasm/"
wasm-bindgen --target web --out-dir src/wasm --no-typescript "$WASM"

echo "==> bindings: nodejs -> src/wasm-node/"
wasm-bindgen --target nodejs --out-dir src/wasm-node --no-typescript "$WASM"

# The generated nodejs file is CommonJS, but the repo root declares
# "type": "module", so it needs its own package scope or __dirname is undefined.
echo '{"type":"commonjs"}' > src/wasm-node/package.json

# See the header: re-export memory for the streaming views.
cat >> src/wasm-node/spicelab_wasm.js <<'EOF'

// Appended by scripts/build-wasm.sh: the nodejs target does not re-export the
// module's memory, but the streaming path needs it to build Float64Array views
// over the staging buffer.
module.exports.memory = wasm.memory;
EOF

echo "==> done"
ls -la src/wasm/*.wasm src/wasm-node/*.wasm | awk '{print "   ", $NF, $5" bytes"}'
