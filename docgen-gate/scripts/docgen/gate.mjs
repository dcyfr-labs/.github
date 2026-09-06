/**
 * gate.mjs — stage 4: measure a candidate page, then let the core judge it.
 *
 * Design section 5. The split is deliberate and load-bearing: this module
 * MEASURES and `core.mjs` DECIDES. `docs-wiki-eval` in CI recomputes the same
 * hard gates from the PR diff without trusting anything the daemon reports, so
 * the two have to agree — and they can only agree if the comparison is a pure
 * function of the measurements. Every rule here therefore produces a number or
 * a list, never a verdict.
 *
 * ABSENT IS NOT PASSING
 * ---------------------
 * The failure this module exists to avoid is a gate that passes because its
 * tool was missing. lychee and markdownlint-cli2 are external binaries that are
 * present in CI and may not be on a daemon host; a measurement function that
 * returned 0 broken links when lychee is absent would turn "we did not check"
 * into "we checked and it was fine", permanently and invisibly. So every
 * measurement here omits its key when it could not run, and
 * `evaluateHardGates` treats an absent key as a failure with the reason "was
 * not measured". A host without the tools blocks pages instead of shipping
 * unchecked ones.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractManagedBlock,
  isGeneratorOwned,
  parseCitations,
  parseFrontMatter,
  provenanceProblems,
  renderAgentsBlock,
  stripCitations,
} from './core.mjs';
import { isRestrictedPath } from './extract.mjs';
import { MARKDOWNLINT_CONFIG_REL, PAGE_PROSE_VOICE, byCodeUnit } from './core.mjs';

// ─── H1 secrets ──────────────────────────────────────────────────────────────

/**
 * House credential patterns, run alongside gitleaks rather than instead of it.
 *
 * Two of these are workspace-specific and gitleaks would not know them: an
 * `op://` reference is not a secret but naming one in public documentation
 * tells a reader exactly which vault item to go after, and a Keychain service
 * name does the same. The rest are the shapes that have actually appeared in
 * this fleet's incidents.
 */
export const SECRET_PATTERNS = Object.freeze([
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  { id: 'openai-key', re: /\bsk-[A-Za-z0-9]{32,}/ },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { id: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: 'op-reference', re: /\bop:\/\/[A-Za-z0-9 _-]+\/[A-Za-z0-9 _-]+/ },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
]);

/**
 * Credential-shaped strings and restricted path names in a page.
 *
 * Restricted paths are counted separately from credentials because they are a
 * different incident: a page that names `knowledge-base/` has not leaked a
 * secret, it has published the existence and location of a sensitive tree. The
 * check runs over every path-shaped token in the page rather than over
 * citations alone, since prose can name a path without citing it.
 */
export function scanSecrets(text) {
  const body = String(text ?? '');
  const findings = [];
  for (const { id, re } of SECRET_PATTERNS) {
    const global = new RegExp(re.source, 'g');
    for (const m of body.matchAll(global)) findings.push({ rule: id, match: m[0].slice(0, 12) });
  }
  const restricted = new Set();
  for (const m of body.matchAll(/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\/?/g)) {
    // A path at the end of a sentence carries the full stop into the match, and
    // the trailing dot has to come off before the deny check: it would otherwise
    // report `knowledge-base/notes.md.` as the restricted path, and the same file
    // named twice in one page would land in the set as two different findings.
    const path = m[0].replace(/\.+$/, '');
    if (path && isRestrictedPath(path)) restricted.add(path);
  }
  return { findings, restricted: [...restricted].sort(byCodeUnit) };
}

// ─── H2 citations ────────────────────────────────────────────────────────────

/**
 * Does this citation resolve at the extracted commit?
 *
 * Four ways it can fail, reported distinctly because they mean different
 * things: the file is not in the extract (the model cited something it never
 * saw, or invented a path), the range runs past the end of the file, the range
 * is inverted, or the content hash no longer matches. The last one is the
 * interesting failure — the citation still points at real lines, and the lines
 * are no longer the ones it was written about, which a range check alone can
 * never see.
 */
export function resolveCitation(citation, contents, { hashOf }) {
  if (!citation.wellFormed) return { ok: false, reason: 'inverted or zero-length range' };
  const body = contents.get(citation.path);
  if (body === undefined) return { ok: false, reason: 'cited file is not in the extract' };
  const lines = body.split('\n');
  if (citation.end > lines.length) return { ok: false, reason: `range ends at ${citation.end}, file has ${lines.length} lines` };
  if (!citation.hash) return { ok: true, reason: 'resolves; no content hash to check' };
  const actual = hashOf(lines.slice(citation.start - 1, citation.end).join('\n'));
  if (actual !== citation.hash) return { ok: false, reason: 'content hash does not match the cited span' };
  return { ok: true, reason: 'resolves' };
}

export function citationReport(body, contents, { hashOf }) {
  const citations = parseCitations(body);
  const results = citations.map((c) => ({ ...c, ...resolveCitation(c, contents, { hashOf }) }));
  const resolved = results.filter((r) => r.ok).length;
  return {
    total: citations.length,
    resolved,
    // A page with no citations resolves nothing, and reporting 1.0 for it would
    // let an uncited page — the worst kind — pass the strictest hard gate in
    // the set. 0 is the honest answer and the soft gates say the rest.
    rate: citations.length === 0 ? 0 : Number((resolved / citations.length).toFixed(4)),
    failures: results.filter((r) => !r.ok).map((r) => ({ raw: r.raw, reason: r.reason })),
  };
}

// ─── H3 mermaid ──────────────────────────────────────────────────────────────

export function extractMermaid(body) {
  return [...String(body ?? '').matchAll(/^```mermaid\n([\s\S]*?)^```$/gm)].map((m) => m[1]);
}

/**
 * Structural problems a parser would not report as errors.
 *
 * The parser answers "does this parse". This answers "is it a diagram" — a
 * fence declaring a diagram type and containing nothing is valid mermaid and
 * renders an empty box, and the DeepWiki baseline had three of those among 39.
 * Both checks run; a fence failing either one counts against the gate.
 */
export function mermaidStructureProblems(source) {
  const lines = String(source).split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return ['empty mermaid fence'];
  const header = /^(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|quadrantChart|C4Context)\b/;
  const problems = [];
  if (!header.test(lines[0])) problems.push(`first line is not a diagram type: ${lines[0].slice(0, 40)}`);
  if (lines.length < 2) problems.push('diagram declares a type and has no nodes');
  return problems;
}

/**
 * Parse rate over a page's mermaid fences.
 *
 * `parseImpl` is injected and there is no default: a gate whose tool defaults
 * to "assume it parsed" is the failure described at the top of this file.
 * Returns null when no parser was supplied, which the hard-gate evaluator reads
 * as unmeasured and therefore failing.
 */
export function mermaidParseRate(body, { parseImpl } = {}) {
  const fences = extractMermaid(body);
  if (!fences.length) return { rate: 1, total: 0, failures: [] };
  if (typeof parseImpl !== 'function') return { rate: null, total: fences.length, failures: [], reason: 'no mermaid parser available' };
  const failures = [];
  for (const [i, source] of fences.entries()) {
    const structural = mermaidStructureProblems(source);
    if (structural.length) { failures.push({ index: i, reason: structural.join('; ') }); continue; }
    try {
      parseImpl(source);
    } catch (e) {
      failures.push({ index: i, reason: String(e?.message ?? e).slice(0, 200) });
    }
  }
  return { rate: Number(((fences.length - failures.length) / fences.length).toFixed(4)), total: fences.length, failures };
}

// ─── H5 links ────────────────────────────────────────────────────────────────

/**
 * Internal links that point at nothing.
 *
 * Checked here rather than left to lychee because these are the ones that
 * matter most and the ones lychee is worst at: a relative link to another wiki
 * page is resolvable only against the plan, which lychee has never heard of.
 * The DeepWiki baseline had seventeen dead numeric cross-links for exactly this
 * reason — nobody was checking the links the generator itself produced.
 */
export function brokenInternalLinks(body, { pagePaths, repoFiles }) {
  const broken = [];
  for (const m of String(body ?? '').matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
    const path = target.split('#')[0].replace(/^\.\//, '');
    if (!path) continue;
    if (pagePaths.has(path) || repoFiles.has(path)) continue;
    broken.push(target);
  }
  return broken;
}

// ─── The composed measurement ────────────────────────────────────────────────

/**
 * Every hard-gate measurement for one candidate page.
 *
 * Returns the object `evaluateHardGates` consumes. Keys are omitted, never
 * defaulted, when a tool could not run — see the note at the top.
 */
export function measurePage({
  markdown,
  page,
  plan,
  contents,
  changedPaths,
  agentsDocument,
  pagePaths,
  repoFiles,
  llmsFullBytes,
  hashOf,
  parseImpl,
  proseErrors,
  markdownlintErrors,
  externalBrokenLinks,
}) {
  const parsed = parseFrontMatter(markdown);
  const body = parsed?.body ?? markdown;
  const secrets = scanSecrets(markdown);
  const citations = citationReport(body, contents, { hashOf });
  const mermaid = mermaidParseRate(body, { parseImpl });
  const internalBroken = brokenInternalLinks(body, { pagePaths, repoFiles });

  const expectedBlock = renderAgentsBlock(plan, { repo: plan.repo });
  const actualBlock = agentsDocument === undefined ? undefined : extractManagedBlock(agentsDocument);

  const measurements = {
    secret_findings: secrets.findings.length,
    restricted_paths: secrets.restricted,
    citation_resolvability: citations.rate,
    page_bytes: Buffer.byteLength(markdown, 'utf8'),
    plan_pages: (plan.pages ?? []).length,
    changed_paths: changedPaths,
    provenance_problems: parsed ? provenanceProblems(parsed.fields) : ['front matter is missing or unparseable'],
    agents_block_matches: actualBlock === undefined ? undefined : actualBlock === expectedBlock,
  };
  if (mermaid.rate !== null) measurements.mermaid_parse_rate = mermaid.rate;
  if (Number.isFinite(proseErrors)) measurements.prose_errors = proseErrors;
  if (Number.isFinite(markdownlintErrors)) measurements.markdownlint_errors = markdownlintErrors;
  if (Number.isFinite(externalBrokenLinks)) measurements.broken_links = internalBroken.length + externalBrokenLinks;
  if (Number.isFinite(llmsFullBytes)) measurements.llms_full_bytes = llmsFullBytes;

  return {
    measurements,
    detail: {
      page_id: String(page.id),
      secrets: secrets.findings,
      citations,
      mermaid,
      internal_broken_links: internalBroken,
      foreign_paths: (changedPaths ?? []).filter((p) => !isGeneratorOwned(p)),
    },
  };
}

// ─── Tool adapters ───────────────────────────────────────────────────────────

const runQuiet = (cmd, args, opts = {}) => {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts }) };
  } catch (e) {
    // A non-zero exit is normal for a linter with findings, so stdout is kept:
    // discarding it here would turn "12 errors" into "the tool failed".
    return { ok: false, status: e?.status ?? null, out: String(e?.stdout ?? ''), error: String(e?.message ?? '') };
  }
};

/**
 * Is this binary on PATH? `/bin/sh -c 'command -v'` rather than a bare spawn:
 * spawning the tool to see whether it exists would run it, and lychee with no
 * arguments is a network call.
 */
const have = (bin) => runQuiet('/bin/sh', ['-c', `command -v ${bin}`]).ok;

/**
 * Resolve a project-local CLI, falling back to PATH, or null when neither has it.
 *
 * `node_modules/.bin` is only on PATH inside an `npm run` script, and the
 * daemon runs `run.mjs` with plain node. A `command -v` alone therefore
 * reported markdownlint-cli2 as absent on a host that had just installed it,
 * which under the rule at the top of this file blocks every page rather than
 * shipping an unchecked one — safe, but wrong, and invisible until someone
 * asks why nothing has published.
 */
function resolveBin(root, bin) {
  const local = join(root, 'node_modules', '.bin', bin);
  if (existsSync(local)) return local;
  return have(bin) ? bin : null;
}

/**
 * Count `validate-prose.mjs` errors for one candidate.
 *
 * The candidate is written to a temp file because the validator takes paths,
 * and the page is not on disk yet — gating before writing is the point. Its
 * `--json` output is read rather than its exit code, so a page with warnings
 * and no errors is not counted as a failure.
 *
 * `--voice` is not optional here, and the count is rejected unless the
 * validator says it checked exactly one file. A temp path matches no surface
 * in the prose rules, so without the flag the validator skipped the file and
 * reported zero errors over zero files, which this function returned as a
 * clean page. Every candidate passed H4's prose half from the day it was
 * written. Asserting the file count is what stops that returning quietly if
 * the flag or the rules ever move again.
 */
export function proseErrorCount(root, markdown, { dir = tmpdir(), voice = PAGE_PROSE_VOICE } = {}) {
  const tmp = mkdtempSync(join(dir, 'docgen-prose-'));
  const file = join(tmp, 'page.md');
  try {
    writeFileSync(file, markdown, 'utf8');
    const res = runQuiet('node', [join(root, 'scripts/validate-prose.mjs'), '--json', '--voice', voice, file]);
    if (!res.out) return null;
    const parsed = JSON.parse(res.out);
    if (parsed?.files !== 1) return null;
    return Number.isFinite(parsed?.errors) ? parsed.errors : null;
  } catch {
    return null;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * markdownlint-cli2 error count, or null when the binary is absent.
 *
 * Two things here are load-bearing. The config is named rather than
 * discovered: cli2 looks for one beside the file it lints, the file is in a
 * temp directory, and under the defaults MD042 fires on every citation and
 * MD013 on most lines, so H4 could never pass. And the count is read from the
 * `Summary: N error(s)` line on stdout, because cli2 writes its findings to
 * stderr — counting stdout lines returned zero for a page with errors, which
 * is the same silent pass the header of this file warns about.
 */
export function markdownlintErrorCount(markdown, { dir = tmpdir(), root = process.cwd(), config } = {}) {
  const bin = resolveBin(root, 'markdownlint-cli2');
  if (!bin) return null;
  const rules = config ?? join(root, MARKDOWNLINT_CONFIG_REL);
  const tmp = mkdtempSync(join(dir, 'docgen-mdl-'));
  const file = join(tmp, 'page.md');
  try {
    writeFileSync(file, markdown, 'utf8');
    const res = runQuiet(bin, ['--config', rules, file]);
    const summary = String(res.out ?? '').match(/Summary:\s+(\d+)\s+error/);
    if (summary) return Number(summary[1]);
    // No summary line means cli2 did not lint: a bad config path, or a version
    // whose output shape changed. Either way the page was not checked.
    return res.ok && /Linting:\s+1 file/.test(String(res.out ?? '')) ? 0 : null;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * A synchronous mermaid `parseImpl` for one page, or null when unavailable.
 *
 * The parse itself happens in `mermaid-check.mjs`, once per page: mermaid's
 * parser is async and wants a DOM, and `mermaidParseRate` calls its parser
 * inside a plain `try` that an async rejection walks straight past. Every fence
 * would count as parsed and H3 would pass anything. So the verdicts are
 * computed up front and this returns a lookup that throws for the ones that
 * failed, which is the shape the measurement expects.
 *
 * Null when the child could not run at all — no parser installed, or a crash.
 * That leaves `mermaid_parse_rate` unmeasured, which fails H3.
 */
export function mermaidParseImpl(markdown, { root = process.cwd(), dir = tmpdir() } = {}) {
  const fences = extractMermaid(markdown);
  if (!fences.length) return () => {};
  const tmp = mkdtempSync(join(dir, 'docgen-mermaid-'));
  const file = join(tmp, 'fences.json');
  try {
    writeFileSync(file, JSON.stringify(fences), 'utf8');
    const res = runQuiet('node', [join(root, 'scripts/docgen/mermaid-check.mjs'), file]);
    if (!res.ok || !res.out) return null;
    const verdicts = JSON.parse(res.out);
    if (!Array.isArray(verdicts) || verdicts.length !== fences.length) return null;
    const bySource = new Map(fences.map((source, i) => [source, verdicts[i]]));
    return (source) => {
      const verdict = bySource.get(source);
      // A fence the batch never saw is not a fence that parsed. Throwing here
      // rather than returning keeps "we did not check this one" a failure.
      if (!verdict) throw new Error('fence was not parsed');
      if (!verdict.ok) throw new Error(verdict.reason ?? 'did not parse');
    };
  } catch {
    return null;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * External link failures via lychee, or null when it is not installed.
 *
 * Three details are load-bearing, and the first two were wrong from the day
 * this was written — H5 could not pass, which the gate reported honestly as
 * "not measured" rather than as a clean page.
 *
 * Citations are stripped first. lychee reads `[path:start-end]()` as a
 * malformed link and returns one failure per citation, so a page carrying the
 * form H2 requires failed H5 for carrying it.
 *
 * Only http and https are checked. Relative links are resolved by lychee
 * against the temp directory the candidate was written to, where nothing
 * exists; `brokenInternalLinks` already checks those against the plan and the
 * repository tree, which is the only place they can be checked correctly.
 *
 * The count comes from `error_map`. lychee exits non-zero when it finds
 * anything, and the previous reading fell through to `res.ok ? 0 : null`,
 * so a run that found failures reported no measurement at all.
 */
export function externalLinkFailures(markdown, { dir = tmpdir() } = {}) {
  if (!have('lychee')) return null;
  const tmp = mkdtempSync(join(dir, 'docgen-lychee-'));
  const file = join(tmp, 'page.md');
  try {
    writeFileSync(file, stripCitations(markdown), 'utf8');
    const res = runQuiet('lychee', ['--no-progress', '--format', 'json', '--scheme', 'http', '--scheme', 'https', file]);
    const parsed = JSON.parse(res.out || '');
    const map = parsed?.error_map ?? parsed?.fail_map;
    if (map && typeof map === 'object') {
      return Object.values(map).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
    }
    if (Number.isFinite(parsed?.errors)) return parsed.errors;
    if (Number.isFinite(parsed?.error_count)) return parsed.error_count;
    return null;
  } catch {
    return null;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ─── Soft gates ──────────────────────────────────────────────────────────────

/**
 * Fraction of the repository's value exports the page mentions.
 *
 * Computed on word boundaries against the raw page text, including code spans:
 * a symbol named only inside a fenced example is still documented, and the
 * DeepWiki baseline this is measured against (0.40) was counted the same way.
 * Counting only prose mentions would report a number that looks like a
 * regression against the baseline when nothing regressed.
 */
export function symbolCoverage(body, symbols) {
  const names = [...new Set((symbols ?? []).map(String).filter(Boolean))];
  if (!names.length) return null;
  const text = String(body ?? '');
  let hit = 0;
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^A-Za-z0-9_$])${escaped}([^A-Za-z0-9_$]|$)`).test(text)) hit += 1;
  }
  return Number((hit / names.length).toFixed(4));
}

/**
 * The judge turn for one page.
 *
 * Byte-stable given the same page, and it asks for a single number with a
 * fixed rubric rather than a critique. Two reasons: the score is compared
 * across models in the Phase 1 calibration, so anything that varies the shape
 * of the answer varies the thing being calibrated; and a judge asked for prose
 * produces prose whose score has to be extracted by a second heuristic, which
 * is one more place for the number to be wrong.
 */
export function judgePrompt({ page, plan, body }) {
  return [
    'Score one page of generated documentation. Answer with a single JSON object',
    'and nothing else: {"score": <number between 0 and 1>, "reason": "<one sentence>"}.',
    '',
    'Score 1.0 for a page that a competent engineer new to this repository could',
    'act on: accurate, specific, grounded in the cited code, and covering what its',
    'stated purpose promises. Score 0.0 for a page that is vague, generic, or makes',
    'claims the cited code does not support. A page that is merely short but',
    'correct scores above one that is long and padded.',
    '',
    `Repository: ${plan.repo}`,
    `Page: ${page.title}`,
    `Stated purpose: ${page.purpose}`,
    '',
    '--- page begins ---',
    body,
    '--- page ends ---',
  ].join('\n');
}

/**
 * Read a judge's answer.
 *
 * Returns null rather than a default when no score can be read. A judge that
 * returned prose has not scored the page, and a default here would be an
 * unmeasured soft gate reported as a measured one — the same failure the hard
 * gates refuse at the top of this file.
 */
export function parseJudgeScore(text) {
  const raw = String(text ?? '');
  // Models fence JSON often enough that requiring a bare object would fail on
  // well-formed answers; the fence is stripped, not tolerated downstream.
  const unfenced = raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  const match = unfenced.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    const score = Number(parsed?.score);
    if (!Number.isFinite(score) || score < 0 || score > 1) return null;
    return { score: Number(score.toFixed(4)), reason: String(parsed?.reason ?? '').slice(0, 300) };
  } catch {
    return null;
  }
}

/**
 * The citation-support turn: does the cited span actually support the sentence?
 *
 * Sampled, not exhaustive — `citation_sample_per_page` of them — because this
 * is the most expensive soft gate per page and the sample is what the 0.80
 * threshold was set against. The sample is deterministic (evenly spaced through
 * the page) so that re-running a cycle scores the same citations, which is what
 * makes the regression comparison against the last merge meaningful.
 */
export function sampleCitations(citations, sampleSize) {
  const list = (citations ?? []).filter((c) => c.wellFormed);
  if (!Number.isFinite(sampleSize) || list.length <= sampleSize) return list;
  const step = list.length / sampleSize;
  return Array.from({ length: sampleSize }, (_, i) => list[Math.floor(i * step)]);
}

export function citationSupportPrompt({ sentence, path, start, end, snippet }) {
  return [
    'Does the code below support the claim? Answer with a single JSON object and',
    'nothing else: {"supports": true|false, "reason": "<one sentence>"}.',
    '',
    `Claim: ${sentence}`,
    '',
    `Cited: ${path}:${start}-${end}`,
    '--- code begins ---',
    snippet,
    '--- code ends ---',
  ].join('\n');
}

export function parseSupportVerdict(text) {
  const match = String(text ?? '').replace(/^```(?:json)?\s*|\s*```$/g, '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return typeof parsed?.supports === 'boolean' ? { supports: parsed.supports, reason: String(parsed?.reason ?? '').slice(0, 300) } : null;
  } catch {
    return null;
  }
}

/** The sentence a citation sits in, which is what the support judge is asked about. */
export function sentenceAround(body, raw) {
  const text = String(body ?? '');
  const at = text.indexOf(raw);
  if (at === -1) return null;
  const start = Math.max(text.lastIndexOf('.', at), text.lastIndexOf('\n', at)) + 1;
  // The terminator is looked for after the citation, not after its first
  // character: a citation's own path contains dots, so searching from `at` ends
  // the sentence inside `[scripts/a.` and asks the support judge about a claim
  // that was cut in half.
  const after = at + String(raw).length;
  const dot = text.indexOf('.', after);
  const nl = text.indexOf('\n', after);
  const ends = [dot, nl].filter((n) => n !== -1);
  const end = ends.length ? Math.min(...ends) + 1 : text.length;
  return text.slice(start, end).trim();
}

/**
 * Score the soft gates for one page.
 *
 * `askImpl` is injected: the local lane judges with qwen2.5-coder:14b and the
 * paid lane with Haiku 4.5, and the calibration in Phase 1 needs to run both
 * over the same pages through the same code path. A score that cannot be
 * produced is omitted, never defaulted — `evaluateSoftGates` reports it as
 * unscored, which holds auto-merge without pretending the page failed.
 */
export async function scoreSoftGates({ page, plan, body, citations, contents, symbols, samplePerPage, askImpl }) {
  const scores = {};
  const detail = { judge: null, support: [] };

  const coverage = symbolCoverage(body, symbols);
  if (coverage !== null) scores.symbol_coverage = coverage;

  const judged = parseJudgeScore(await askImpl(judgePrompt({ page, plan, body })));
  if (judged) {
    scores.judge_page = judged.score;
    detail.judge = judged;
  }

  const sample = sampleCitations(citations, samplePerPage);
  const verdicts = [];
  for (const citation of sample) {
    const file = contents.get(citation.path);
    if (file === undefined) continue;
    const sentence = sentenceAround(body, citation.raw);
    if (!sentence) continue;
    const snippet = file.split('\n').slice(citation.start - 1, citation.end).join('\n');
    const verdict = parseSupportVerdict(await askImpl(citationSupportPrompt({ sentence, path: citation.path, start: citation.start, end: citation.end, snippet })));
    if (!verdict) continue;
    verdicts.push(verdict.supports);
    detail.support.push({ path: citation.path, start: citation.start, end: citation.end, ...verdict });
  }
  if (verdicts.length) {
    scores.citation_support = Number((verdicts.filter(Boolean).length / verdicts.length).toFixed(4));
  }

  return { scores, detail };
}
