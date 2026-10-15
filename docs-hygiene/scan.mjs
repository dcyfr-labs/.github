#!/usr/bin/env node
// docs-hygiene: checks a repository's tracked files for the problems the
// 2026-10 documentation audit kept finding by hand.
//
//   attribution.bare-dcyfr        copyright, maintainer, author or "built by"
//                                 lines that name bare "DCYFR" as the entity
//   attribution.person-copyright  a copyright line naming a person instead of
//                                 DCYFR Labs (names from --person)
//   exposure.home-path            /Users/<name>/ or /home/<name>/ paths
//   exposure.op-ref               1Password op:// references with real IDs
//   exposure.tlp                  TLP:AMBER or TLP:RED markers in docs
//   exposure.tracked-file         tracked logs, .env.ci, .env or .mcp.json
//   links.relative-missing        a relative Markdown link to a missing file
//   links.repo-unreachable        a GitHub repo link the public cannot open
//                                 (private, renamed or deleted); --remote only
//   links.repo-archived           a link to an archived repo on a line that
//                                 does not say so; --remote only
//
// A line containing the marker `docs-hygiene-allow` is skipped by every rule;
// use it for fixtures and for deliberate, documented exceptions.
//
// `.docs-hygiene-history` at the repository root lists path prefixes, one per
// line, that hold point-in-time records (archives, dated reports). The link
// rules skip them: their links are allowed to rot. Exposure and attribution
// rules still apply. `--history <prefix>` adds prefixes from the command line.
//
// Uses only Node built-ins so it runs from a bare checkout. A baseline file
// turns it into a ratchet: findings already in the baseline are reported as
// known and do not fail the run.
//
// Usage:
//   node scan.mjs [--root <dir>] [--remote] [--fail] [--json <out>]
//                 [--baseline <file>] [--write-baseline <file>]
//                 [--person "Full Name"]... [--skip <rule>]...
//                 [--history <path-prefix>]...

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, posix, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RULES = [
  'attribution.bare-dcyfr',
  'attribution.person-copyright',
  'exposure.home-path',
  'exposure.op-ref',
  'exposure.tlp',
  'exposure.tracked-file',
  'links.relative-missing',
  'links.repo-unreachable',
  'links.repo-archived',
];

const TEXT_EXT = /\.(md|mdx|markdown|txt|json|jsonc|ya?ml|toml|js|mjs|cjs|ts|tsx|jsx|sh|py|env|example|html|css)$/i;
const DOC_EXT = /\.(md|mdx|markdown)$/i;
const SKIP_PATH = /(^|\/)(node_modules|\.git|dist|build|coverage|\.next|vendor)\//;
const LOCKFILE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock)$/;
// A committed baseline quotes every finding it holds, so scanning it would
// report each one a second time.
const BASELINE = /(^|\/)\.docs-hygiene-baseline\.json$/;
const MAX_BYTES = 1_000_000;

// The entity name has to follow the cue directly ("Copyright 2026 DCYFR",
// "Maintained By: DCYFR Team"); brand uses later in the line are allowed.
const BARE_DCYFR_ENTITY = /(copyright|©|\(c\)|\bby\b|maintainers?|authors?|owners?|"author"\s*:)[\s*_:,()"\d–-]*(?:the\s+)?DCYFR\b(?![ \t]+Labs\b)(?![-./™\w])/i;
const COPYRIGHT_CUE = /(copyright|©|\(c\)\s*\d{4})/i;
const PLACEHOLDER_USER = /^(you|your-?name|user|username|name|me|example|someone|runner|node|app|<.*>|\$\{?\w+\}?|\.\.\.)$/i;
const HOME_PATH = /(?:^|[^\w.])\/(Users|home)\/([^/\s"'`)<>]+)\//g;
const OP_REF = /op:\/\/[^\s"'`)<>\]]+/g;
// The marker form only (an HTML comment, a leading label or front matter), so a
// table that explains the TLP levels is not a finding.
const TLP = /^\s*(?:<!--\s*|[*_>#\s]*)TLP:(AMBER|RED)\b|^\s*tlp:\s*["']?(amber|red)\b/i;

/** One finding. `text` is the trimmed line, used for the baseline fingerprint. */
function finding(rule, file, line, text, detail) {
  return { rule, file, line, text: text.trim().slice(0, 240), detail };
}

export function fingerprint(f) {
  return `${f.rule}\u0000${f.file}\u0000${f.text}`;
}

/** Lines outside fenced code blocks, with 1-based numbers. Docs only. */
export function proseLines(body) {
  const out = [];
  let fence = null;
  body.split('\n').forEach((raw, i) => {
    const m = raw.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (m) {
      // CommonMark: only a run of the same character, at least as long and
      // with no info string, closes a fence. A ```` block can hold ``` blocks.
      if (!fence) {
        fence = m[1];
        return;
      }
      if (m[1][0] === fence[0] && m[1].length >= fence.length && !m[2].trim()) {
        fence = null;
        return;
      }
    }
    if (!fence) out.push({ n: i + 1, text: raw });
  });
  return out;
}

/** Markdown link targets on one line, inline code removed. */
export function linkTargets(line) {
  const clean = line.replace(/`[^`]*`/g, '');
  const out = [];
  for (const m of clean.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.push(m[1]);
  for (const m of clean.matchAll(/^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+"[^"]*")?\s*$/g)) out.push(m[1]);
  return out;
}

export function checkAttribution(file, lines, people) {
  const out = [];
  for (const { n, text } of lines) {
    if (BARE_DCYFR_ENTITY.test(text) && !/trademark/i.test(text)) {
      out.push(finding('attribution.bare-dcyfr', file, n, text, 'name the entity "DCYFR Labs"'));
    }
    if (COPYRIGHT_CUE.test(text) && !/trademark/i.test(text)) {
      for (const p of people) {
        if (text.includes(p)) out.push(finding('attribution.person-copyright', file, n, text, `copyright names ${p}; use DCYFR Labs`));
      }
    }
  }
  return out;
}

export function checkExposure(file, lines, isDoc = true) {
  const out = [];
  for (const { n, text } of lines) {
    for (const m of text.matchAll(HOME_PATH)) {
      if (!PLACEHOLDER_USER.test(m[2])) out.push(finding('exposure.home-path', file, n, text, `/${m[1]}/${m[2]}/`));
    }
    for (const m of text.matchAll(OP_REF)) {
      if (!/[<{$*]|\.\.\.|VAULT|ITEM|example/i.test(m[0])) out.push(finding('exposure.op-ref', file, n, text, m[0]));
    }
    if (isDoc && TLP.test(text)) out.push(finding('exposure.tlp', file, n, text, text.trim().slice(0, 40)));
  }
  return out;
}

export function checkTrackedFile(file) {
  const base = posix.basename(file);
  if (/(^|\/)logs\/.+\.(ndjson|jsonl|log)$/.test(file)) return [finding('exposure.tracked-file', file, 0, file, 'tracked log file')];
  if (base === '.env.ci' || base === '.env' || base === '.mcp.json') return [finding('exposure.tracked-file', file, 0, file, `tracked ${base}`)];
  return [];
}

/** `gitlinks` are submodule paths: a link into one cannot be checked when the submodule is not checked out. */
export function checkRelativeLinks(root, file, lines, exists = existsSync, gitlinks = []) {
  const out = [];
  const rootNorm = normalize(root);
  for (const { n, text } of lines) {
    for (const target of linkTargets(text)) {
      if (/^([a-z][a-z0-9+.-]*:|#|\/|\{|<|%7B)/i.test(target)) continue;
      let path = target.split('#')[0].split('?')[0];
      if (!path) continue;
      try { path = decodeURIComponent(path); } catch { /* keep raw */ }
      const abs = normalize(join(root, dirname(file), path));
      if (!abs.startsWith(rootNorm)) continue;
      const rel = abs.slice(rootNorm.length).replace(/^[\\/]+/, '').split(sep).join('/');
      if (gitlinks.some((g) => rel === g || rel.startsWith(`${g}/`))) continue;
      if (!exists(abs)) out.push(finding('links.relative-missing', file, n, text, target));
    }
  }
  return out;
}

const GH_REPO_LINK = /https?:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?=[/#?)\s"'`>\]]|$)/g;

export function repoLinks(lines, owners) {
  const out = [];
  for (const { n, text } of lines) {
    for (const m of text.matchAll(GH_REPO_LINK)) {
      if (!owners.includes(m[1].toLowerCase())) continue;
      out.push({ n, text, owner: m[1], repo: m[2] });
    }
  }
  return out;
}

/** Looks a repo up the way the public sees it. Returns 'ok' | 'archived' | 'unreachable'. */
export async function repoState(owner, repo, fetchImpl = fetch, token = process.env.GITHUB_TOKEN) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'dcyfr-labs-docs-hygiene' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}`, { headers, redirect: 'manual' });
  if (res.status === 404) return 'unreachable';
  if (res.status === 301 || res.status === 302) return 'ok';
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${owner}/${repo}`);
  const body = await res.json();
  if (body.private) return 'unreachable';
  return body.archived ? 'archived' : 'ok';
}

/** Submodule paths (mode 160000 entries in the index). */
function gitlinkPaths(root) {
  return execFileSync('git', ['-C', root, 'ls-files', '-s', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter((l) => l.startsWith('160000 '))
    .map((l) => l.slice(l.indexOf('\t') + 1));
}

/** Path prefixes from `<root>/.docs-hygiene-history`; blank lines and `#` comments are ignored. */
export function historyPrefixes(root) {
  const file = join(root, '.docs-hygiene-history');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean)
    .map((l) => l.replace(/^\.?\//, ''));
}

function trackedFiles(root) {
  return execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean);
}

export async function scan({ root, people = ['Drew Gowan'], remote = false, skip = [], owners = ['dcyfr-labs', 'dcyfr'], files, gitlinks, history = [], fetchImpl, token } = {}) {
  const rootAbs = resolve(root);
  const all = files ?? trackedFiles(rootAbs);
  const submodules = gitlinks ?? (files ? [] : gitlinkPaths(rootAbs));
  const historical = [...history, ...historyPrefixes(rootAbs)].map((h) => h.replace(/^\.?\//, ''));
  const inHistory = (file) => historical.some((h) => file === h || file.startsWith(h.endsWith('/') ? h : `${h}/`));
  const findings = [];
  const links = [];
  for (const file of all) {
    findings.push(...checkTrackedFile(file));
    if (SKIP_PATH.test(file) || LOCKFILE.test(file) || BASELINE.test(file)) continue;
    const isDoc = DOC_EXT.test(file);
    const isLicense = /(^|\/)LICENSE(\.\w+)?$/i.test(file);
    if (!isDoc && !isLicense && !TEXT_EXT.test(file)) continue;
    const abs = join(rootAbs, file);
    let body;
    try {
      if (statSync(abs).size > MAX_BYTES) continue;
      body = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (body.includes('\0')) continue;
    const lines = (isDoc ? proseLines(body) : body.split('\n').map((text, i) => ({ n: i + 1, text })))
      .filter((l) => !l.text.includes('docs-hygiene-allow'));
    if (isDoc || isLicense || posix.basename(file) === 'package.json') findings.push(...checkAttribution(file, lines, people));
    findings.push(...checkExposure(file, lines, isDoc));
    if (isDoc && !inHistory(file)) {
      findings.push(...checkRelativeLinks(rootAbs, file, lines, existsSync, submodules));
      for (const l of repoLinks(lines, owners)) links.push({ file, ...l });
    }
  }
  if (remote) {
    const state = new Map();
    for (const l of links) {
      const key = `${l.owner}/${l.repo}`.toLowerCase();
      if (!state.has(key)) state.set(key, await repoState(l.owner, l.repo, fetchImpl, token));
      const s = state.get(key);
      if (s === 'unreachable') findings.push(finding('links.repo-unreachable', l.file, l.n, l.text, `${l.owner}/${l.repo} is private, renamed or gone`));
      if (s === 'archived' && !/archiv/i.test(l.text)) findings.push(finding('links.repo-archived', l.file, l.n, l.text, `${l.owner}/${l.repo} is archived`));
    }
  }
  return findings.filter((f) => !skip.includes(f.rule));
}

export function splitByBaseline(findings, baseline) {
  const known = new Set(baseline.map(fingerprint));
  return {
    fresh: findings.filter((f) => !known.has(fingerprint(f))),
    known: findings.filter((f) => known.has(fingerprint(f))),
  };
}

export function summarize(findings) {
  const counts = {};
  for (const f of findings) counts[f.rule] = (counts[f.rule] ?? 0) + 1;
  return counts;
}

function parseArgs(argv) {
  const opts = { root: '.', people: [], skip: [], history: [], remote: false, fail: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--root') opts.root = next();
    else if (a === '--remote') opts.remote = true;
    else if (a === '--fail') opts.fail = true;
    else if (a === '--json') opts.json = next();
    else if (a === '--baseline') opts.baseline = next();
    else if (a === '--write-baseline') opts.writeBaseline = next();
    else if (a === '--person') opts.people.push(next());
    else if (a === '--skip') opts.skip.push(next());
    else if (a === '--history') opts.history.push(next());
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!opts.people.length) opts.people = ['Drew Gowan'];
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const findings = await scan(opts);
  if (opts.writeBaseline) {
    writeFileSync(opts.writeBaseline, JSON.stringify(findings, null, 2) + '\n');
    console.log(`wrote ${findings.length} findings to ${opts.writeBaseline}`);
    return;
  }
  const baseline = opts.baseline && existsSync(opts.baseline) ? JSON.parse(readFileSync(opts.baseline, 'utf8')) : [];
  const { fresh, known } = splitByBaseline(findings, baseline);
  for (const f of fresh) {
    const loc = f.line ? `${f.file}:${f.line}` : f.file;
    console.log(`::${opts.fail ? 'error' : 'warning'} file=${f.file}${f.line ? `,line=${f.line}` : ''}::${f.rule}: ${f.detail}`);
    console.log(`  ${loc}  ${f.rule}  ${f.detail}`);
  }
  if (opts.json) writeFileSync(opts.json, JSON.stringify({ fresh, known, counts: summarize(findings) }, null, 2) + '\n');
  console.log(`docs-hygiene: ${fresh.length} new, ${known.length} in baseline`);
  if (opts.fail && fresh.length) process.exit(1);
}

// realpath both sides: macOS /tmp is a symlink to /private/tmp, so a plain
// path compare silently skips main() when the script is invoked through it.
function isEntry() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(2);
  });
}
