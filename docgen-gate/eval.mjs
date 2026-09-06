#!/usr/bin/env node
/**
 * eval.mjs — the `docs-wiki-eval` gate, run inside the repository being documented.
 *
 * Task 1.4. Every hard gate is recomputed here from the pull request diff and
 * from the repository's own git objects. Nothing the daemon reported is read:
 * not its cycle record, not its gate output, not a status it set. The daemon
 * can be wrong, compromised, or running an older bundle, and a checker that
 * reads its verdict checks nothing.
 *
 * WHERE THE INPUTS COME FROM
 * --------------------------
 * The plan is reconstructed, not supplied. Each page in `docs/wiki/` carries
 * its identity in front matter (`page_id`, `page_title`, `page_purpose`), so
 * the page set, its order and the AGENTS.md block that should describe it are
 * all derived from files in the head commit. A plan passed in by the thing
 * being checked would let a bad page vouch for itself.
 *
 * Citations resolve against `source_sha` — the commit the page says it was
 * written from — read out of git rather than off the working tree, so a page
 * cannot be validated against a checkout someone edited.
 *
 * ABSENT IS NOT PASSING
 * ---------------------
 * `measurePage` omits a measurement it could not take, and `evaluateHardGates`
 * fails on an absent key. So a runner missing lychee, markdownlint-cli2 or the
 * mermaid parser blocks the pull request instead of passing it unchecked. The
 * workflow installs all three before calling this; if one of them is gone the
 * right outcome is a red job, not a green one.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { byCodeUnit, evaluateHardGates, parseFrontMatter, sortPages } from './scripts/docgen/core.mjs';
import {
  externalLinkFailures,
  markdownlintErrorCount,
  measurePage,
  mermaidParseImpl,
  proseErrorCount,
} from './scripts/docgen/gate.mjs';

const BUNDLE = dirname(fileURLToPath(import.meta.url));

/** Identical to the generator's. A different digest would fail every citation. */
const hashOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);

const WIKI_PREFIX = 'docs/wiki/';

// ─── git ─────────────────────────────────────────────────────────────────────

/**
 * `git`, resolved once to an absolute path.
 *
 * Spawning it as a bare name resolves it through `$PATH` on every call, which
 * hands the choice of what this gate runs to whoever can write a directory on
 * that path. The gate's whole job is to be the thing a pull request cannot talk
 * its way past, so the binary it reads history with is pinned to the fixed
 * locations git occupies on the two hosts this bundle runs on rather than
 * looked up. A host that keeps git elsewhere gets a red job with a clear
 * reason, which is the correct outcome: an unmeasured gate fails.
 */
const GIT_CANDIDATES = Object.freeze(['/usr/bin/git', '/bin/git', '/usr/local/bin/git']);
const GIT = GIT_CANDIDATES.find((candidate) => existsSync(candidate));

function makeGit(repo) {
  if (!GIT) throw new Error(`git not found at any of ${GIT_CANDIDATES.join(', ')}`);
  const run = (args, { allowFail = false } = {}) => {
    try {
      return execFileSync(GIT, ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
      if (allowFail) return null;
      throw new Error(`git ${args.join(' ')} failed: ${e.stderr || e.message}`);
    }
  };
  return {
    run,
    /** File content at a commit, or null when the path is not in that tree. */
    show: (ref, path) => run(['show', `${ref}:${path}`], { allowFail: true }),
    exists: (ref) => run(['cat-file', '-e', `${ref}^{commit}`], { allowFail: true }) !== null,
    lsTree: (ref) => new Set((run(['ls-tree', '-r', '--name-only', ref]) || '').split('\n').filter(Boolean)),
    /**
     * Paths the pull request touches.
     *
     * Three-dot against the merge base, because two-dot would report every
     * path that moved on the base branch since the head branch forked and
     * H7 would then fail an honest pull request for a diff it did not make.
     */
    changed: (base, head) => {
      const mergeBase = run(['merge-base', base, head], { allowFail: true })?.trim();
      const range = mergeBase ? `${mergeBase}..${head}` : `${base}..${head}`;
      return (run(['diff', '--name-only', range]) || '').split('\n').filter(Boolean);
    },
  };
}

// ─── Bundle integrity ────────────────────────────────────────────────────────

/**
 * Re-hash every file against MANIFEST.json.
 *
 * The bundle is checked out from a public repository by SHA, so this is not
 * the primary control. It is the one that catches the case the SHA cannot: a
 * step earlier in the job, or an action it called, having written into the
 * runner's own tree before the runner measured anything.
 */
export function verifyBundle(root = BUNDLE) {
  const manifest = JSON.parse(readFileSync(join(root, 'MANIFEST.json'), 'utf8'));
  const problems = [];
  for (const [rel, expected] of Object.entries(manifest.files)) {
    const abs = join(root, rel);
    if (!existsSync(abs)) { problems.push(`${rel} is missing`); continue; }
    const actual = createHash('sha256').update(readFileSync(abs)).digest('hex');
    if (actual !== expected.sha256) problems.push(`${rel} does not match the manifest digest`);
  }
  return { manifest, problems };
}

// ─── Page reconstruction ─────────────────────────────────────────────────────

/**
 * Every wiki page in the head commit, with its front matter read back.
 *
 * A page whose front matter will not parse is kept rather than skipped: it
 * still has to fail H7, and dropping it here would turn an unparseable page
 * into an absent one, which is a pass.
 */
export function readPages(git, head) {
  const paths = [...git.lsTree(head)]
    .filter((p) => p.startsWith(WIKI_PREFIX) && p.endsWith('.md') && !p.slice(WIKI_PREFIX.length).includes('/'))
    .sort(byCodeUnit);
  return paths.map((path) => {
    const markdown = git.show(head, path) ?? '';
    const parsed = parseFrontMatter(markdown);
    return { path, markdown, fields: parsed?.fields ?? null };
  });
}

/**
 * The plan the pages imply.
 *
 * `source_repo` and `source_sha` have to agree across the whole set. A pull
 * request mixing two extraction commits is not a regeneration, it is two
 * regenerations that collided, and the citations in one half would be checked
 * against the other half's tree.
 */
export function reconstructPlan(pages) {
  const problems = [];
  const repos = new Set();
  const shas = new Set();
  const planPages = [];
  for (const { path, fields } of pages) {
    if (!fields) { problems.push(`${path}: front matter is missing or unparseable`); continue; }
    if (fields.source_repo) repos.add(String(fields.source_repo));
    if (fields.source_sha) shas.add(String(fields.source_sha));
    if (fields.page_id === undefined || fields.page_title === undefined) {
      problems.push(`${path}: front matter carries no page_id or page_title`);
      continue;
    }
    planPages.push({ id: String(fields.page_id), title: fields.page_title, purpose: fields.page_purpose ?? '' });
  }
  if (repos.size > 1) problems.push(`pages disagree on source_repo: ${[...repos].sort(byCodeUnit).join(', ')}`);
  if (shas.size > 1) problems.push(`pages disagree on source_sha: ${[...shas].sort(byCodeUnit).join(', ')}`);
  return {
    problems,
    sourceSha: shas.size === 1 ? [...shas][0] : null,
    plan: { repo: [...repos][0] ?? null, pages: sortPages(planPages) },
  };
}

/**
 * The cited files, read at the commit the pages were written from.
 *
 * A path that is not in that tree is simply absent from the map, which
 * `resolveCitation` reports as "cited file is not in the extract" — the same
 * outcome as a fabricated path, which is what it usually is.
 */
export function collectCitedContents(git, sourceSha, pages) {
  const contents = new Map();
  if (!sourceSha) return contents;
  const wanted = new Set();
  for (const { markdown } of pages) {
    for (const m of markdown.matchAll(/\[([^\]\s:]+):(\d+)-(\d+)\]\(\)/g)) wanted.add(m[1]);
  }
  for (const path of [...wanted].sort(byCodeUnit)) {
    const body = git.show(sourceSha, path);
    if (body !== null) contents.set(path, body);
  }
  return contents;
}

// ─── Reporting ───────────────────────────────────────────────────────────────

function renderSummary(result) {
  const lines = [
    '## docs-wiki-eval',
    '',
    `Gate runner \`${result.bundle_version}\` · ${result.pages.length} page(s) · `
      + `${result.ok ? '**all hard gates pass**' : `**${result.failure_count} hard-gate failure(s)**`}`,
    '',
  ];
  if (result.faults.length) {
    lines.push('### Faults', '');
    for (const fault of result.faults) lines.push(`- ${fault}`);
    lines.push('');
  }
  lines.push('| Page | Verdict | Failing gates |', '| --- | --- | --- |');
  for (const page of result.pages) {
    const gates = page.failures.length
      ? [...new Set(page.failures.map((f) => f.gate))].sort(byCodeUnit).join(', ')
      : '—';
    lines.push(`| \`${page.path}\` | ${page.ok ? 'pass' : 'fail'} | ${gates} |`);
  }
  lines.push('');
  for (const page of result.pages.filter((p) => !p.ok)) {
    lines.push(`### \`${page.path}\``, '');
    for (const f of page.failures) lines.push(`- **${f.gate} ${f.key}** — ${f.reason}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ─── Entry point ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { repo: process.cwd(), base: null, head: 'HEAD', json: null, summary: process.env.GITHUB_STEP_SUMMARY ?? null, verifyOnly: false, expectVersion: null };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].includes('=') ? [argv[i].slice(0, argv[i].indexOf('=')), argv[i].slice(argv[i].indexOf('=') + 1)] : [argv[i], null];
    const value = () => inline ?? argv[++i];
    switch (flag) {
      case '--repo': opts.repo = resolve(value()); break;
      case '--base': opts.base = value(); break;
      case '--head': opts.head = value(); break;
      case '--json': opts.json = resolve(value()); break;
      case '--summary': opts.summary = resolve(value()); break;
      case '--expect-version': opts.expectVersion = value(); break;
      case '--verify-bundle': opts.verifyOnly = true; break;
      default: throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return opts;
}

export function evaluate(opts) {
  const { manifest, problems: bundleProblems } = verifyBundle(BUNDLE);
  const faults = bundleProblems.map((p) => `bundle integrity: ${p}`);
  if (opts.expectVersion && manifest.bundle_version !== opts.expectVersion) {
    faults.push(`bundle version is ${manifest.bundle_version}, the caller pinned ${opts.expectVersion}`);
  }

  const git = makeGit(opts.repo);
  const thresholds = JSON.parse(readFileSync(join(BUNDLE, 'usr/docgen/thresholds.json'), 'utf8'));
  const head = git.run(['rev-parse', opts.head]).trim();
  const changedPaths = opts.base ? git.changed(opts.base, head) : null;
  if (changedPaths === null) faults.push('no base ref was given, so the diff could not be read');

  const pages = readPages(git, head);
  const { problems, sourceSha, plan } = reconstructPlan(pages);
  faults.push(...problems);
  if (!pages.length) faults.push('the head commit contains no docs/wiki pages to evaluate');
  if (sourceSha && !git.exists(sourceSha)) {
    faults.push(`source_sha ${sourceSha} is not in this checkout; citations cannot be resolved `
      + '(the workflow needs fetch-depth: 0)');
  }

  const contents = collectCitedContents(git, sourceSha && git.exists(sourceSha) ? sourceSha : null, pages);
  const repoFiles = git.lsTree(head);
  const pagePaths = new Set(pages.map((p) => p.path));
  const agentsDocument = git.show(head, 'AGENTS.md') ?? undefined;
  const llmsFull = git.show(head, 'llms-full.txt');
  const llmsFullBytes = llmsFull === null ? undefined : Buffer.byteLength(llmsFull, 'utf8');

  const reports = pages.map(({ path, markdown, fields }) => {
    const page = { id: String(fields?.page_id ?? path) };
    const { measurements, detail } = measurePage({
      markdown,
      page,
      plan,
      contents,
      changedPaths: changedPaths ?? undefined,
      agentsDocument,
      pagePaths,
      repoFiles,
      llmsFullBytes,
      hashOf,
      parseImpl: mermaidParseImpl(markdown, { root: BUNDLE }),
      proseErrors: proseErrorCount(BUNDLE, markdown),
      markdownlintErrors: markdownlintErrorCount(markdown, { root: BUNDLE }),
      externalBrokenLinks: externalLinkFailures(markdown),
    });
    const verdict = evaluateHardGates(measurements, thresholds);
    return { path, ok: verdict.ok, failures: verdict.failures, measurements, detail };
  });

  const failureCount = reports.reduce((n, r) => n + r.failures.length, 0);
  return {
    ok: faults.length === 0 && reports.length > 0 && reports.every((r) => r.ok),
    bundle_version: manifest.bundle_version,
    deny_list_id: manifest.deny_list_id,
    repo: plan.repo,
    head,
    base: opts.base,
    source_sha: sourceSha,
    changed_paths: changedPaths,
    faults,
    failure_count: failureCount,
    pages: reports,
  };
}

function main(argv) {
  const opts = parseArgs(argv);

  if (opts.verifyOnly) {
    const { manifest, problems } = verifyBundle(BUNDLE);
    if (opts.expectVersion && manifest.bundle_version !== opts.expectVersion) {
      problems.push(`bundle version is ${manifest.bundle_version}, the caller pinned ${opts.expectVersion}`);
    }
    for (const p of problems) console.error(`✗ ${p}`);
    if (!problems.length) console.log(`✓ gate runner ${manifest.bundle_version} intact (${Object.keys(manifest.files).length} files)`);
    return problems.length ? 1 : 0;
  }

  const result = evaluate(opts);
  if (opts.json) writeFileSync(opts.json, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  const summary = renderSummary(result);
  if (opts.summary) appendFileSync(opts.summary, `${summary}\n`, 'utf8');
  console.log(summary);
  return result.ok ? 0 : 1;
}

/**
 * Run only when invoked directly.
 *
 * Compared against the real path rather than `process.argv[1]` verbatim. Node
 * resolves symlinks when it loads a module but not when it records the argv
 * entry, so on a host where the checkout sits under a symlinked directory the
 * two strings differ, this guard is false, and the gate exits 0 having measured
 * nothing. A gate that passes because it never ran is the same failure as a
 * gate that passes because its tool was missing.
 */
const invokedDirectly = (() => {
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1] ?? '');
  } catch {
    return false;
  }
})();

if (invokedDirectly) process.exit(main(process.argv.slice(2)));
