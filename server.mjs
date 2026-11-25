// Express replacement for the deprecated python server in startupScript.sh.
// Serves dist/ with per-subdomain vhost mapping and CSP:
//   - Host header `<labels>.localhost:8000` maps to dist/<labels...> when that dir exists.
//   - Any first label starting with "iso" gets SANDBOX_CSP (+ ACAO *, X-DNS-Prefetch-Control off);
//     everything else gets HOST_CSP.
//   - POST /__ping_probe__ logs <a ping> hyperlink-auditing probes.
// Dev mode (`node server.mjs --dev`): builds, watches src/, and live-reloads the host page
// via SSE (/__dev_events__ + a data:-URL client injected into host-origin HTML at response time).

import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const DIST = path.resolve('dist');
const PORT = 8000;
const HOST = '127.0.0.1';
const DEV = process.argv.includes('--dev');

const SANDBOX_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src data:",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'none'",
  "img-src 'none'",
  "font-src 'none'",
  "media-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "webrtc 'block'",
  "frame-ancestors 'self' http://localhost:8000 http://*.localhost:8000",
].join('; ');

const HOST_CSP = [
  "default-src 'self'",
  // No script files are served on the host origin — all JS is inlined as data: URLs at build time.
  "script-src data:",
  "style-src 'self' 'unsafe-inline'",
  "frame-src http://*.localhost:8000",
].join('; ');

function subdomainLabels(req) {
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  if (!host.endsWith('.localhost')) return [];
  const labels = host.slice(0, -'.localhost'.length).split('.').filter(Boolean);
  if (!labels.length || !labels.every((l) => /^[a-z0-9_-]+$/.test(l))) return [];
  return labels;
}

function vhostDir(labels) {
  if (!labels.length) return DIST;
  const candidate = path.resolve(DIST, ...labels);
  if (!candidate.startsWith(DIST + path.sep)) return DIST;
  try {
    if (fs.statSync(candidate).isDirectory()) return candidate;
  } catch {
    /* fall through to DIST */
  }
  return DIST;
}

const app = express();
app.disable('x-powered-by');

// --- security headers / vhost resolution ---
app.use((req, res, next) => {
  const labels = subdomainLabels(req);
  req.isIso = labels.length > 0 && labels[0].startsWith('iso');
  req.vhostDir = vhostDir(labels);
  if (req.isIso) {
    res.set('Content-Security-Policy', SANDBOX_CSP);
    // DNS lookups are not fetches, so CSP cannot govern them; this blocks
    // dns-prefetch exfil (data encoded into looked-up hostnames).
    res.set('X-DNS-Prefetch-Control', 'off');
    res.set('Access-Control-Allow-Origin', '*');
  } else {
    res.set('Content-Security-Policy', HOST_CSP);
  }
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});

// --- <a ping> exfil probe (hyperlink-auditing pings are POSTs) ---
app.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  if (new URL(req.url, 'http://x').pathname === '/__ping_probe__') {
    req.resume(); // drain body
    console.log(">>> <a ping> PROBE RECEIVED -- hyperlink auditing bypassed the sandbox CSP <<<");
    return res.status(204).end();
  }
  return res.status(404).end();
});

// --- dev live-reload (SSE) ---
const sseClients = new Set();
// Injected as a data: URL (host CSP allows script-src data: only); EventSource is
// covered by default-src 'self'.
const DEV_RELOAD_TAG = `<script type="module" src="data:text/javascript;base64,${Buffer.from(
  "new EventSource(location.origin + '/__dev_events__').addEventListener('message', () => location.reload());\n",
  'utf8',
).toString('base64')}"></script>`;
if (DEV) {
  app.get('/__dev_events__', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });
}

function broadcastReload() {
  for (const client of sseClients) client.write('data: reload\n\n');
}

// --- static serving from the vhost dir (sendFile root option prevents traversal) ---
app.use(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).end();

  let rel = path.posix.normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  rel = rel.replace(/^\/+/, '');
  let target = rel === '' ? 'index.html' : rel;

  const abs = path.resolve(req.vhostDir, target);
  if (!abs.startsWith(req.vhostDir + path.sep) && abs !== req.vhostDir) return res.status(404).end();
  try {
    if ((await fsp.stat(abs)).isDirectory()) target = path.posix.join(target, 'index.html');
  } catch {
    return res.status(404).end();
  }

  // Dev-only: inject the live-reload client into host-origin HTML responses
  // (never into iso* pages — untrusted frames get no dev plumbing, and their
  // connect-src 'none' would block the EventSource anyway).
  if (DEV && !req.isIso && target.endsWith('.html')) {
    try {
      const html = await fsp.readFile(path.resolve(req.vhostDir, target), 'utf8');
      return res
        .type('html')
        .send(html.replace('</body>', `${DEV_RELOAD_TAG}\n</body>`));
    } catch {
      return res.status(404).end();
    }
  }

  res.sendFile(target, { root: req.vhostDir }, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

if (DEV) {
  const { buildAll, watch } = await import('./build.mjs');
  await buildAll();
  watch(broadcastReload);
}

app.listen(PORT, HOST, () => {
  console.log(
    `Serving ${DEV ? '(dev, live-reload)' : ''} on http://localhost:${PORT} ` +
      '(sandbox CSP only for *.localhost starting with "iso")',
  );
});
