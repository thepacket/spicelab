# SpiceLab, built from source and served cross-origin isolated.
#
# THE CONSTRAINT THAT SHAPES THIS FILE: the app requires SharedArrayBuffer, so
# the page must be cross-origin isolated, so the server must send
#
#     Cross-Origin-Opener-Policy:   same-origin
#     Cross-Origin-Embedder-Policy: require-corp
#
# That is not an optimisation. Without it the worker streams into memory the
# main thread cannot see, and `SimClient.load` throws rather than silently
# drawing an empty plot. Headers live in Caddyfile; see docs/deploy-fly.md.
#
# Nothing in src/wasm, src/wasm-node or src/ngspice is committed (they are
# gitignored build artifacts), so this image builds them. The wasm-bindgen JS
# must match the wasm-bindgen CRATE version, which is why the CLI version below
# is pinned to Cargo.lock rather than floating.

# Declared before the first FROM so it is in the global scope a later FROM can
# interpolate. Set to `ngspice-skip` to build without the coverage engine.
ARG NGSPICE=ngspice-build

# --------------------------------------------------------------- the Rust core
FROM rust:1-slim AS core
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config \
 && rm -rf /var/lib/apt/lists/*
RUN rustup target add wasm32-unknown-unknown

WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY crates crates

# Pinned to the crate version in Cargo.lock. A mismatch here produces bindings
# that load and then fail at instantiate with an unhelpful message.
RUN VER="$(grep -A1 'name = "wasm-bindgen"' Cargo.lock | grep '^version' | head -1 | cut -d'"' -f2)" \
 && echo "wasm-bindgen-cli $VER (from Cargo.lock)" \
 && cargo install wasm-bindgen-cli --version "$VER" --locked

# simd128 is required by the architecture notes, not optional.
RUN RUSTFLAGS="-C target-feature=+simd128" \
      cargo build -p spicelab-wasm --target wasm32-unknown-unknown --release \
 && wasm-bindgen --target web --out-dir /out --no-typescript \
      target/wasm32-unknown-unknown/release/spicelab_wasm.wasm \
 && ls -l /out

# ------------------------------------------------------- ngspice, the coverage
# engine. ~4.9 MB of wasm, and the slowest thing in this file.
#
# `emscripten/emsdk` publishes a SINGLE-ARCH amd64 image — there is no arm64
# variant. The platform is pinned so that is explicit: on an arm64 host this
# stage runs under QEMU emulation and takes tens of minutes rather than ~5,
# while on Fly's amd64 builders (and in CI) it is native. Without the pin the
# behaviour depends on the host's Docker configuration, which is exactly the
# kind of thing that should not be discovered during a deploy.
#
# The output is wasm either way, so the emulation costs build time only — it
# has no effect on what is produced.
FROM --platform=linux/amd64 emscripten/emsdk:3.1.74 AS ngspice-build
RUN apt-get update && apt-get install -y --no-install-recommends \
      autoconf automake libtool bison flex curl ca-certificates make \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY scripts scripts
# Writes to /app/src/ngspice; emcc is already on PATH in this image.
RUN bash scripts/build-ngspice.sh && ls -l /app/src/ngspice

# The "skip it" alternative, so a fast deploy is one build arg away. The
# directory is created empty on purpose: the COPY below must succeed either way.
FROM alpine:3 AS ngspice-skip
RUN mkdir -p /app/src/ngspice

# `docker build --build-arg NGSPICE=ngspice-skip` drops the coverage engine.
# The app still runs everything the interactive Rust core implements; designs
# that need ngspice report that it is unavailable.
FROM ${NGSPICE} AS ngspice

# ------------------------------------------------------------------- runtime
FROM caddy:2-alpine

# Application sources. These are plain ES modules served as-is — the JS side of
# this project deliberately has no build step.
COPY demo /srv/demo
COPY src /srv/src

# Built artifacts overlaid on top.
COPY --from=core /out /srv/src/wasm
COPY --from=ngspice /app/src/ngspice /srv/src/ngspice

# Neither of these belongs on a web server. `wasm-node` is the Node test
# binding (already excluded by .dockerignore; removed again here so the runtime
# image does not depend on that staying true). `core` is the JS reference
# oracle — deliberately NOT the production path, and nothing served imports it.
RUN rm -rf /srv/src/wasm-node /srv/src/core

COPY Caddyfile /etc/caddy/Caddyfile
RUN caddy validate --config /etc/caddy/Caddyfile

EXPOSE 8080
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile"]
