# Deploying SpiceLab to Fly.io

```bash
fly apps create spicelab      # once; or `fly launch --no-deploy`
fly deploy
```

That is the whole procedure. The rest of this document is why it is shaped the
way it is, and what will break if pieces of it are "simplified".

---

## The one constraint that decides everything

SpiceLab requires **cross-origin isolation in production**, not just in
development. The solver runs in a worker and streams results back through a
`SharedArrayBuffer` ring, and `SharedArrayBuffer` is only available to a page
that is cross-origin isolated. That requires two response headers on the
document:

```
Cross-Origin-Opener-Policy:   same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without them a plain `ArrayBuffer` sent to the worker is copied or detached, so
the worker streams into memory the main thread cannot see. `SimClient.load`
throws rather than degrading, because the alternative is a simulator that runs
and silently draws nothing.

They are set in `Caddyfile`. **Any host that can set response headers works** —
Fly, Netlify `_headers`, Cloudflare Pages, CloudFront response-headers policy,
nginx. Raw GitHub Pages cannot, which is why this is not a static-host deploy.

Verify after any change to serving:

```bash
curl -sI https://spicelab.fly.dev/demo/editor.html | grep -i cross-origin
```

and in the page console, `crossOriginIsolated` must be `true`.

The standing cost of isolation is that **every cross-origin subresource must
opt in** via CORP or CORS. Keep fonts, images and scripts same-origin. The one
deliberate cross-origin fetch is the model-library download, which goes to
`raw.githubusercontent.com` — verified to send both
`access-control-allow-origin: *` and `cross-origin-resource-policy:
cross-origin`, which is exactly why that host was chosen over the GitHub
archive endpoint. See the header of `src/schematic/model-library.js`.

---

## Why there is a Dockerfile at all

The JS in this project has no build step and never will — that is what makes
the oracle cheap to run. But three directories are **gitignored build
artifacts** and do not exist in a fresh clone:

| Directory | Built by | Needed at runtime |
|---|---|---|
| `src/wasm/` | `scripts/build-wasm.sh` (Rust → wasm-bindgen) | yes |
| `src/wasm-node/` | the same script, `--target nodejs` | no, tests only |
| `src/ngspice/` | `scripts/build-ngspice.sh` (emsdk, ~5 min) | only for coverage designs |

So the image builds them. Two things there are not negotiable:

- **`simd128`**, per the architecture notes.
- **The wasm-bindgen CLI version must match the `wasm-bindgen` crate version in
  `Cargo.lock`.** The Dockerfile reads it out of the lockfile rather than
  pinning a literal, because a mismatch produces bindings that load and then
  fail at instantiate with an unhelpful message.

`src/wasm-node/` is deleted from the runtime image — it is the Node test
binding and has no business being served.

## Skipping ngspice for a fast build

The ngspice stage compiles ngspice 46 to wasm and takes several minutes. To
build without it:

```bash
fly deploy --build-arg NGSPICE=ngspice-skip
```

The app still runs everything the interactive Rust core implements — 13 device
kinds, MOSFET levels 1 and 3, `.op` / `.dc` / `.ac` / `.tran`. What stops
working is the **coverage** engine: a design using BSIM3/4, JFETs, VDMOS,
transmission lines, `.noise`, `.tf` or `.sens` is correctly identified as
`unsupported`, routed to ngspice, and then reports that ngspice is not
available in this build. Full builds are the default for that reason.

### Build it on amd64

`emscripten/emsdk` ships **amd64 only** — there is no arm64 image — so the
Dockerfile pins `--platform=linux/amd64` on that stage. Consequences:

- On Fly's remote builder (amd64, and the default for `fly deploy`) it is
  native and takes a few minutes.
- On an Apple Silicon machine building locally it runs under QEMU emulation.
  Measured on an M-series Mac: **13 minutes** for that stage — 5 min of
  `configure`, 8 min of `make`, both silent because the build script sends
  their output to `/dev/null`. A long silence there is normal, not a hang.

Use `fly deploy --remote-only`, or `--build-arg NGSPICE=ngspice-skip`, when you
are iterating on the serving layer rather than on ngspice. Note that editing
the `FROM --platform=…` line invalidates that stage's build cache and costs the
full rebuild.

The emulation affects build time only. The output is wasm regardless of the
host architecture.

## Caching

`/src/wasm/*` and `/src/ngspice/*` are served `immutable` with a one-year
max-age: they change only when the image is rebuilt, and every deploy rebuilds
the image. Everything else is hand-written source with no content hash in its
URL, so it is served `no-cache` — it revalidates, and a deploy is visible
immediately. Getting this backwards would either serve a stale app forever or
re-download 5 MB of wasm on every visit.

`application/wasm` is **not** in Caddy's default compression list and is named
explicitly in `Caddyfile`. Omitting it silently ships ~4.9 MB instead of
~1.6 MB. `.wasm` also gets an explicit `Content-Type`, because a wasm file
served as `application/octet-stream` makes `WebAssembly.instantiateStreaming`
fail.

## Machines and state

`auto_stop_machines` is on with `min_machines_running = 0`. The server holds no
state — it serves files. A user's downloaded model library lives in **their**
browser's IndexedDB, not on the server, so a machine stopping loses nothing and
a cold start costs one boot.

256 MB is ample for static serving. The simulator runs entirely in the
visitor's browser; the server never solves anything.

## Root path

`/` redirects to `/demo/editor.html`, which is the application. A redirect
rather than a rewrite on purpose: `editor.html` imports its modules as
`../src/…`, which only resolves correctly when the document really is served
from `/demo/`.

## Checklist after deploying

```bash
curl -sI https://<app>.fly.dev/demo/editor.html | grep -i cross-origin
curl -sI https://<app>.fly.dev/src/wasm/spicelab_wasm_bg.wasm | grep -iE 'content-type|content-encoding'
```

Then open the app and run the default RC transient. If the waveform draws, the
whole path — headers, `SharedArrayBuffer`, worker, wasm, ring buffer — is
working. If the run reports points but nothing appears, suspect isolation
first.
