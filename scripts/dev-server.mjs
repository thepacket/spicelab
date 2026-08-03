/**
 * Development server.
 *
 * Exists for one reason: SharedArrayBuffer requires the page to be cross-origin
 * isolated, which requires two response headers that no plain static server
 * sends by default. Without them the ring buffer cannot be shared with the
 * worker and the simulator produces no waveform at all (see ring.js).
 *
 *   Cross-Origin-Opener-Policy:   same-origin
 *   Cross-Origin-Embedder-Policy: require-corp
 *
 * THE HOSTING DECISION, recorded here because CLAUDE.md asks for it to be made
 * up front rather than retrofitted:
 *
 *   SpiceLab requires cross-origin isolation in production too. Any host will
 *   do as long as it can set these two headers on the document — a static host
 *   with header configuration (Netlify `_headers`, Cloudflare Pages, S3 +
 *   CloudFront response-headers policy, nginx `add_header`) or any origin
 *   server. What will NOT work is a host that cannot set response headers, such
 *   as raw GitHub Pages.
 *
 *   The cost of isolation is that every cross-origin subresource must opt in
 *   via CORP/CORS. Practically this means: serve fonts, images and any
 *   third-party script from the same origin, or make sure they send
 *   `Cross-Origin-Resource-Policy: cross-origin`. Deciding this now is what
 *   keeps that constraint cheap — retrofitting it means auditing every asset
 *   the UI has accumulated.
 *
 * Usage: node scripts/dev-server.mjs [port]
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const PORT = Number(process.argv[2] ?? 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  // These two are the whole point of this file.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  // Lets same-origin subresources load under require-corp.
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let path = decodeURIComponent(url.pathname);
    if (path === '/') path = '/demo/index.html';

    // Contain path traversal: resolve, then require the result to stay inside.
    const full = resolve(join(ROOT, normalize(path)));
    if (!full.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    const info = await stat(full);
    if (info.isDirectory()) {
      res.writeHead(403).end('directory listing disabled');
      return;
    }
    const body = await readFile(full);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(full)] ?? 'application/octet-stream',
    });
    res.end(body);
  } catch (e) {
    if (e?.code === 'ENOENT') res.writeHead(404).end('not found');
    else res.writeHead(500).end(String(e?.message ?? e));
  }
});

server.listen(PORT, () => {
  console.log(`spicelab dev server -> http://localhost:${PORT}/`);
  console.log('COOP/COEP set; crossOriginIsolated should be true in the page.');
});
