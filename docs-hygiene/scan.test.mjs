// Run: node --test docs-hygiene/
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkAttribution,
  checkExposure,
  checkTrackedFile,
  linkTargets,
  proseLines,
  repoState,
  scan,
  splitByBaseline,
} from './scan.mjs';

const lines = (...texts) => texts.map((text, i) => ({ n: i + 1, text }));
const rules = (findings) => findings.map((f) => f.rule);

test('bare DCYFR right after an attribution cue is flagged', () => {
  const hits = checkAttribution('README.md', lines(
    'Copyright (c) 2026 DCYFR',
    '**Maintained By:** DCYFR Security Team',
    '"author": "dcyfr",',
  ), ['Drew Gowan']);
  assert.deepEqual(rules(hits), ['attribution.bare-dcyfr', 'attribution.bare-dcyfr', 'attribution.bare-dcyfr']);
});

test('DCYFR Labs, brand names, packages and trademark lines pass', () => {
  const hits = checkAttribution('README.md', lines(
    'Copyright (c) 2026 DCYFR Labs',
    '`@dcyfr/ai` is maintained by **DCYFR Labs** as part of the DCYFR AI tooling portfolio.',
    'Built by dcyfr-labs contributors.',
    'DCYFR is a trademark of Drew Gowan.',
    'Use the DCYFR™ notation in titles.',
  ), ['Drew Gowan']);
  assert.deepEqual(hits, []);
});

test('a copyright line naming a person is flagged, a trademark line is not', () => {
  const hits = checkAttribution('LICENSE', lines('Copyright © 2026 Drew Gowan', 'The DCYFR trademark belongs to Drew Gowan.'), ['Drew Gowan']);
  assert.deepEqual(rules(hits), ['attribution.person-copyright']);
});

test('home paths: real users flagged, placeholders and container paths pass', () => {
  const hits = checkExposure('a.md', lines(
    'cd /Users/drew/Code/x', // docs-hygiene-allow
    'see /home/ubuntu/repo/', // docs-hygiene-allow
    'cd /Users/you/Code/x',
    'cd /Users/<name>/Code',
    'WORKDIR /home/app/project',
    'runner at /home/runner/work/',
  ));
  assert.deepEqual(hits.map((f) => f.detail), ['/Users/drew/', '/home/ubuntu/']); // docs-hygiene-allow
});

test('op:// with real-looking IDs is flagged; templated references pass', () => {
  const hits = checkExposure('.env.example', lines(
    'SONAR_TOKEN=op://abc123/def456/credential', // docs-hygiene-allow
    'KEY=op://<vault>/<item>/field',
    'KEY=op://${VAULT}/item/field',
    'never touch: `op://**`',
  ));
  assert.deepEqual(rules(hits), ['exposure.op-ref']);
});

test('TLP markers are flagged in docs only, and a table explaining TLP is not', () => {
  assert.deepEqual(rules(checkExposure('a.md', lines('<!-- TLP:AMBER -->', '**TLP:RED**', 'tlp: amber'))), ['exposure.tlp', 'exposure.tlp', 'exposure.tlp']);
  assert.deepEqual(checkExposure('a.md', lines('| TLP:AMBER | Sensitive data handlers |')), []);
  assert.deepEqual(checkExposure('a.mjs', lines('<!-- TLP:AMBER -->'), false), []);
});

test('tracked logs, .env, .env.ci and .mcp.json are flagged; examples are not', () => {
  for (const f of ['logs/rei/gateway/audit.ndjson', '.env', 'k8s/.env.ci', '.mcp.json']) assert.equal(checkTrackedFile(f).length, 1, f);
  for (const f of ['.env.example', '.mcp.json.example', 'docs/logs.md', 'src/logs/index.ts']) assert.deepEqual(checkTrackedFile(f), [], f);
});

test('fenced code is skipped and inline code hides links', () => {
  const body = 'a [x](one.md)\n```\n[y](two.md)\n```\nb `[z](three.md)` [w](four.md)\n';
  const targets = proseLines(body).flatMap((l) => linkTargets(l.text));
  assert.deepEqual(targets, ['one.md', 'four.md']);
});

test('a longer fence holds shorter fences, and only a bare run closes it', () => {
  const body = '````mdx\n```bash\n[a](one.md)\n```\n[b](two.md)\n````\n[c](three.md)\n```js\n```ts\n[d](four.md)\n```\n[e](five.md)\n';
  const targets = proseLines(body).flatMap((l) => linkTargets(l.text));
  assert.deepEqual(targets, ['three.md', 'five.md']);
});

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'docs-hygiene-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'add', '-A']);
  return root;
}

test('scan: relative links resolve from the file; URLs, anchors and root paths are skipped', async () => {
  const root = repo({
    'README.md': '[ok](docs/a.md) [gone](docs/b.md) [anchor](#x) [web](https://x.dev) [route](/blog) [dir](docs/)\n',
    'docs/a.md': '[up](../README.md) [deep](../../outside.md)\n',
  });
  try {
    const hits = await scan({ root });
    assert.deepEqual(hits.map((f) => `${f.file} ${f.detail}`), ['README.md docs/b.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scan: links into a submodule that is not checked out are skipped', async () => {
  const root = repo({ 'README.md': '[sub](vendor/lib/README.md) [file](vendor/lib) [near](vendor/library.md)\n' });
  execFileSync('git', ['-C', root, 'update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},vendor/lib`]);
  try {
    const hits = await scan({ root });
    assert.deepEqual(hits.map((f) => f.detail), ['vendor/library.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the CLI runs when invoked through a symlinked path', () => {
  const root = repo({ 'README.md': '[gone](missing.md)\n' });
  const link = join(mkdtempSync(join(tmpdir(), 'docs-hygiene-link-')), 'scan.mjs');
  symlinkSync(fileURLToPath(new URL('./scan.mjs', import.meta.url)), link);
  try {
    const out = execFileSync(process.execPath, [link, '--root', root], { encoding: 'utf8' });
    assert.match(out, /docs-hygiene: 1 new, 0 in baseline/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dirname(link), { recursive: true, force: true });
  }
});

test('scan: link rules skip .docs-hygiene-history paths; other rules still apply', async () => {
  const root = repo({
    '.docs-hygiene-history': '# point-in-time records\ndocs/archive/\n./docs/reports\n',
    'docs/archive/2026-02.md': '[gone](missing.md) [repo](https://github.com/dcyfr-labs/secret-repo)\n',
    'docs/reports/q1.md': '[gone](missing.md)\nCopyright (c) 2026 DCYFR\n',
    'docs/reports-live.md': '[gone](missing.md)\n',
    'docs/guide.md': '[gone](missing.md)\n',
  });
  const fetchImpl = async () => ({ status: 404 });
  try {
    const hits = await scan({ root, remote: true, fetchImpl });
    assert.deepEqual(hits.map((f) => `${f.rule} ${f.file}`).sort(), [
      'attribution.bare-dcyfr docs/reports/q1.md',
      'links.relative-missing docs/guide.md',
      'links.relative-missing docs/reports-live.md',
    ]);
    const cli = await scan({ root, history: ['docs/guide.md'] });
    assert.ok(!cli.some((f) => f.file === 'docs/guide.md'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scan --remote: private and archived repo links, archived allowed when the line says so', async () => {
  const root = repo({
    'README.md': [
      '[a](https://github.com/dcyfr-labs/secret-repo)',
      '[b](https://github.com/dcyfr-labs/old-repo/blob/main/x.md)',
      '[c](https://github.com/dcyfr-labs/old-repo) (archived)',
      '[d](https://github.com/dcyfr-labs/live-repo)',
      '[e](https://github.com/someone-else/secret-repo)',
      '',
    ].join('\n'),
  });
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const name = url.split('/').pop();
    if (name === 'secret-repo') return { status: 404, ok: false };
    return { status: 200, ok: true, json: async () => ({ private: false, archived: name === 'old-repo' }) };
  };
  try {
    const hits = await scan({ root, remote: true, fetchImpl, token: '' });
    assert.deepEqual(hits.map((f) => `${f.rule} ${f.line}`), ['links.repo-unreachable 1', 'links.repo-archived 2']);
    assert.equal(calls.length, 3, 'one lookup per repo, other owners ignored');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repoState treats a private payload as unreachable and a redirect as fine', async () => {
  assert.equal(await repoState('o', 'r', async () => ({ status: 200, ok: true, json: async () => ({ private: true }) }), ''), 'unreachable');
  assert.equal(await repoState('o', 'r', async () => ({ status: 301, ok: false }), ''), 'ok');
  await assert.rejects(repoState('o', 'r', async () => ({ status: 403, ok: false }), ''));
});

test('the allow marker skips a line', async () => {
  const root = repo({ 'a.md': 'path /Users/drew/x/ <!-- docs-hygiene-allow -->\n' });
  try {
    assert.deepEqual(await scan({ root }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('baseline: known findings do not count as new', () => {
  const a = { rule: 'exposure.tlp', file: 'a.md', line: 3, text: '<!-- TLP:AMBER -->' };
  const b = { rule: 'exposure.tlp', file: 'b.md', line: 1, text: '<!-- TLP:AMBER -->' };
  const moved = { ...a, line: 9 };
  const { fresh, known } = splitByBaseline([moved, b], [a]);
  assert.deepEqual(fresh, [b]);
  assert.deepEqual(known, [moved]);
});
