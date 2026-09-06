#!/usr/bin/env node
/**
 * mermaid-check.mjs — parse a page's mermaid fences, one process per page.
 *
 * Hard gate H3 needs a real parser, and mermaid's is asynchronous and wants a
 * DOM. Neither fits `mermaidParseRate`, which is synchronous on purpose: every
 * measurement in `gate.mjs` is, so that `measurePage` stays a plain function
 * the CI job can call the same way the daemon does. Handing that function an
 * async parser would be worse than having none — a rejected promise escapes the
 * `try` around the call, the fence counts as parsed, and H3 passes everything.
 *
 * So the async half lives out here. The caller writes the fences to a JSON
 * file, this runs once for the whole page, and the verdicts go back as JSON.
 * One process per page rather than per fence: importing mermaid costs about a
 * second, and a page has several fences.
 *
 * Usage: node mermaid-check.mjs <fences.json>   →   [{ "index", "ok", "reason" }]
 *
 * Exits 2 when the parser itself is unavailable, which the caller reads as
 * "unmeasured" rather than "no failures".
 */

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';

const arg = process.argv[2];
if (!arg) {
  console.error('usage: mermaid-check.mjs <fences.json>');
  process.exit(2);
}

/**
 * The one place this process is allowed to read from.
 *
 * `mermaidParseImpl` always writes the fence list into a fresh `mkdtemp`
 * directory under the OS temp root, so that root is the whole contract. This
 * runs with a path off the command line, in a job whose input is a pull request
 * a model wrote; confining the read is what keeps a crafted argument from
 * turning an H3 measurement into a file read somewhere else.
 *
 * Both sides go through `realpathSync` because a prefix test on unresolved
 * paths gets it wrong in both directions: on macOS `tmpdir()` is a symlink, so
 * every legitimate call would be rejected, and a `..` segment or a symlink out
 * of the temp directory would be accepted.
 */
let file;
try {
  const root = realpathSync(tmpdir());
  file = realpathSync(resolve(arg));
  if (file !== root && !file.startsWith(root + sep)) throw new Error(`outside ${root}`);
  if (!statSync(file).isFile()) throw new Error('not a regular file');
} catch (e) {
  console.error(`✗ refusing fence list: ${e?.message ?? e}`);
  process.exit(2);
}

let sources;
try {
  sources = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(sources)) throw new Error('expected a JSON array of fence sources');
} catch (e) {
  console.error(`✗ unreadable fence list: ${e?.message ?? e}`);
  process.exit(2);
}

let mermaid;
try {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const w = dom.window;
  globalThis.window = w;
  globalThis.document = w.document;
  // `navigator` is a getter-only property on globalThis in node 21+, so the
  // plain assignment used for the rest throws rather than shadowing it.
  Object.defineProperty(globalThis, 'navigator', { value: w.navigator, configurable: true });
  for (const key of ['HTMLElement', 'SVGElement', 'Element', 'Node', 'DOMParser', 'XMLSerializer', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame']) {
    if (w[key] !== undefined && globalThis[key] === undefined) globalThis[key] = w[key];
  }
  mermaid = (await import('mermaid')).default;
  // `strict` keeps the parser from following anything a diagram declares; this
  // process parses text a model wrote and renders nothing.
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
} catch (e) {
  console.error(`✗ mermaid parser unavailable: ${e?.message ?? e}`);
  process.exit(2);
}

const verdicts = [];
for (const [index, source] of sources.entries()) {
  try {
    await mermaid.parse(String(source));
    verdicts.push({ index, ok: true });
  } catch (e) {
    verdicts.push({ index, ok: false, reason: String(e?.message ?? e).replace(/\s+/g, ' ').trim().slice(0, 200) });
  }
}

process.stdout.write(`${JSON.stringify(verdicts)}\n`);
