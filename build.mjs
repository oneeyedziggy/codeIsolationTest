// Build pipeline: src/ -> dist/
// - <script ... src="./x.js" data-inline="data-url"></script> in HTML gets its referenced
//   file bundled by esbuild and the src replaced with a base64 data: URL (the sandbox CSP
//   only permits script-src data:).
// - Other .js files are bundled to plain files at the same relative path.
// - Everything else is copied verbatim.
// CLI: `node build.mjs` (one-shot). server.mjs imports { buildAll, watch } for dev mode.

import { build } from 'esbuild';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SRC = path.resolve('src');
const DIST = path.resolve('dist');

const MARKER_TAG_RE = /<script\b[^>]*\bdata-inline="data-url"[^>]*><\/script>/g;
const SRC_ATTR_RE = /\bsrc="([^"]+)"/;

async function bundleToText(entryFile) {
  const result = await build({
    entryPoints: [entryFile],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    minify: false,
  });
  return result.outputFiles[0].text;
}

async function transformHtml(srcFile) {
  const html = await fsp.readFile(srcFile, 'utf8');
  const tags = html.match(MARKER_TAG_RE) || [];
  let out = html;
  for (const tag of tags) {
    const srcMatch = tag.match(SRC_ATTR_RE);
    if (!srcMatch) throw new Error(`data-inline script without src in ${srcFile}: ${tag}`);
    const entry = path.resolve(path.dirname(srcFile), srcMatch[1]);
    const code = await bundleToText(entry);
    const b64 = Buffer.from(code, 'utf8').toString('base64');
    const newTag = `<script type="module" src="data:text/javascript;base64,${b64}"></script>`;
    out = out.replace(tag, newTag);
  }
  return out;
}

async function* walk(dir) {
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

export async function buildAll() {
  const started = Date.now();
  await fsp.rm(DIST, { recursive: true, force: true });
  for await (const file of walk(SRC)) {
    const ext = path.extname(file).toLowerCase();
    // JS ships only inlined as data: URLs inside HTML — never as files in dist.
    if (ext === '.js' || ext === '.mjs') continue;
    const rel = path.relative(SRC, file);
    const dest = path.join(DIST, rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    if (ext === '.html') {
      await fsp.writeFile(dest, await transformHtml(file));
    } else {
      await fsp.copyFile(file, dest);
    }
  }
  console.log(`[build] src -> dist in ${Date.now() - started}ms`);
}

export function watch(onRebuilt) {
  let timer = null;
  let building = false;
  let dirty = false;

  async function rebuild() {
    if (building) {
      dirty = true;
      return;
    }
    building = true;
    try {
      await buildAll();
      onRebuilt?.();
    } catch (err) {
      console.error('[build] failed:', err.message);
    } finally {
      building = false;
      if (dirty) {
        dirty = false;
        rebuild();
      }
    }
  }

  fs.watch(SRC, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(rebuild, 100);
  });
  console.log('[build] watching src/ for changes');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await buildAll();
}
