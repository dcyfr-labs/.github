/**
 * core.mjs — the decision core of the documentation specialist (Scribe).
 *
 * Task 1.2 of openspec/changes/deepwiki-replacement-doc-specialist.
 *
 * WHY THIS FILE HAS NO IO
 * -----------------------
 * Every decision that can block a page, open a PR, or merge one lives here,
 * and none of them may depend on the machine they run on. Three reasons, in
 * increasing order of how badly the alternative bites:
 *
 *   1. The `docs-wiki-eval` CI job recomputes every hard gate from the PR diff
 *      without trusting the daemon's report (design section 5). Two callers
 *      running the same rule can only agree if the rule is a function of its
 *      arguments. A gate that reads Redis, the clock or the filesystem is a
 *      gate CI cannot reproduce, and an irreproducible gate is decoration.
 *
 *   2. The auto-merge rule is the first non-session actor in the fleet that
 *      merges. The session pretool guard that denies `gh pr merge` cannot see
 *      a launchd job, so this rule is most of what stands between a bad page
 *      and main. It has to be testable without a network, a repo or a clock.
 *
 *   3. `no IO` is checkable. `scripts/docgen/run.mjs` is the only entrypoint,
 *      and a test asserts this module imports nothing from `node:fs`,
 *      `node:child_process` or `node:net`. A rule that drifts back into doing
 *      its own IO fails that test rather than quietly becoming untestable.
 *
 * Nothing here throws for a policy failure. A gate that fails returns a
 * structured reason, because the reason is what feeds the repair pass, the
 * cycle record and the PR status — an exception would only be caught and
 * turned back into one, less carefully.
 *
 * Pure exports only. No default export, no side effects at import time.
 */

/**
 * Written into every page's front matter and compared by the freshness loop.
 * Bumped when the page contract changes shape, not when prose improves: a
 * reader of an old page needs to know which contract it was written against.
 */
export const GENERATOR_VERSION = '0.1.0';

export const GENERATED_BY = 'rei-doc-specialist';

/** The label every Scribe PR carries. `auto-pr-review.sh` skips it (design section 14). */
export const PR_LABEL = 'docs:auto';

/** Applied when a clause of the auto-merge rule fails. The PR stays open. */
export const NEEDS_HUMAN_LABEL = 'needs-human';

/** One branch per repo, reused across cycles so the PR is upserted rather than churned. */
export const BRANCH = 'docs/wiki-regen';

/**
 * The house voice a generated page is held to by H4.
 *
 * Named here rather than resolved from the page's path, because the page is
 * gated before it is written anywhere and a path that does not exist yet
 * resolves to no voice. Pages land in `dcyfr-labs` repositories, so `dcyfr` is
 * the surface they would resolve to once written.
 */
export const PAGE_PROSE_VOICE = 'dcyfr';

/** markdownlint rules for a candidate page, relative to the runner's root. */
export const MARKDOWNLINT_CONFIG_REL = 'usr/docgen/docgen.markdownlint-cli2.jsonc';

// ─── The page contract (design section 3, spec: provenance) ──────────────────

/**
 * Front matter keys a page must carry to be publishable. This is the list from
 * the spec requirement, not the design's example block: `page_parent` appears
 * in the example and is legitimately null on a root page, so requiring it would
 * reject every tree root.
 *
 * Order is load-bearing. The block is rendered in this order and the ownership
 * gate compares rendered bytes, so a stable order is what makes an unchanged
 * page produce an empty diff.
 */
export const FRONT_MATTER_REQUIRED = Object.freeze([
  'generated_by',
  'generator_version',
  'source_repo',
  'source_ref',
  'source_sha',
  'generated_at',
  'max_age_days',
  'confidence',
  'page_id',
  'page_title',
  'page_purpose',
  'voice',
  'visibility',
]);

/** Permitted alongside the required keys. Anything else is a page inventing a field. */
export const FRONT_MATTER_OPTIONAL = Object.freeze(['page_parent']);

const FRONT_MATTER_ORDER = Object.freeze([
  ...FRONT_MATTER_REQUIRED.slice(0, FRONT_MATTER_REQUIRED.indexOf('page_purpose') + 1),
  'page_parent',
  ...FRONT_MATTER_REQUIRED.slice(FRONT_MATTER_REQUIRED.indexOf('page_purpose') + 1),
]);

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const SHA = /^[0-9a-f]{7,40}$/;

/**
 * A YAML scalar, quoted only where leaving it bare would change its type.
 *
 * `page_id` is the case that forces this: the ids are "1", "2.1", "10" and a
 * bare `2.1` is a float while a bare `10` is an integer, so the same field
 * round-trips as three different types depending on which page you are reading.
 * Quoting every string and leaving numbers and null bare keeps the type stable
 * across the whole corpus.
 */
function yamlScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const s = String(value);
  // Double quotes, with the two characters that would terminate or escape the
  // string escaped. Page purposes are prose and do contain colons and quotes.
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Render the front-matter block for a page. Deterministic: same input, same
 * bytes, which is what lets an unchanged page produce an empty diff and what
 * the ownership gate compares against.
 */
export function renderFrontMatter(fields) {
  const lines = ['---'];
  for (const key of FRONT_MATTER_ORDER) {
    if (key === 'page_parent' && !(key in fields)) continue;
    lines.push(`${key}: ${yamlScalar(fields[key])}`);
  }
  lines.push('---');
  return `${lines.join('\n')}\n`;
}

/**
 * Read a page's front matter back.
 *
 * A deliberately small reader rather than a YAML parser: the block is one this
 * module rendered, the value space is scalars, and pulling a YAML dependency in
 * would mean the gate that decides whether a page may be published depends on
 * an anchor-and-alias implementation nobody here reviewed. An unparseable block
 * returns `null` and the caller reports a hard-gate failure — the same outcome
 * as a missing field, which is what a malformed block is.
 */
export function parseFrontMatter(markdown) {
  const text = String(markdown ?? '');
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---\n', 3);
  if (end === -1) return null;
  const fields = {};
  for (const line of text.slice(4, end + 1).split('\n')) {
    if (!line.trim()) continue;
    const at = line.indexOf(':');
    if (at === -1) return null;
    const key = line.slice(0, at).trim();
    const raw = line.slice(at + 1).trim();
    if (!key) return null;
    if (raw === 'null') fields[key] = null;
    else if (raw === 'true') fields[key] = true;
    else if (raw === 'false') fields[key] = false;
    else if (/^-?\d+(?:\.\d+)?$/.test(raw)) fields[key] = Number(raw);
    else if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      fields[key] = raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else fields[key] = raw;
  }
  return { fields, body: text.slice(end + 5) };
}

/**
 * Why the page's provenance is unacceptable, or an empty list.
 *
 * Missing keys and present-but-wrong keys are both reported, because the
 * failure the spec scenario describes (front matter lacking `source_sha`) and
 * the failure that actually happens more often (a `source_sha` of `unknown`
 * because the extractor could not resolve one) have the same consequence: a
 * page nobody can trace back to a commit.
 */
export function provenanceProblems(fields) {
  const problems = [];
  if (!fields || typeof fields !== 'object') return ['front matter is missing or unparseable'];
  for (const key of FRONT_MATTER_REQUIRED) {
    if (!(key in fields)) problems.push(`missing ${key}`);
  }
  for (const key of Object.keys(fields)) {
    if (!FRONT_MATTER_REQUIRED.includes(key) && !FRONT_MATTER_OPTIONAL.includes(key)) {
      problems.push(`unknown front-matter key ${key}`);
    }
  }
  if (fields.generated_by !== undefined && fields.generated_by !== GENERATED_BY) {
    problems.push(`generated_by is ${fields.generated_by}, expected ${GENERATED_BY}`);
  }
  if (fields.source_sha !== undefined && !SHA.test(String(fields.source_sha))) {
    problems.push(`source_sha is not a commit sha: ${fields.source_sha}`);
  }
  if (fields.generated_at !== undefined && !ISO_INSTANT.test(String(fields.generated_at))) {
    problems.push(`generated_at is not an ISO instant: ${fields.generated_at}`);
  }
  if (fields.confidence !== undefined) {
    const c = Number(fields.confidence);
    if (!Number.isFinite(c) || c < 0 || c > 1) problems.push(`confidence out of [0,1]: ${fields.confidence}`);
  }
  if (fields.max_age_days !== undefined) {
    const d = Number(fields.max_age_days);
    if (!Number.isInteger(d) || d < 1) problems.push(`max_age_days must be a positive integer: ${fields.max_age_days}`);
  }
  return problems;
}

// ─── Page identity ───────────────────────────────────────────────────────────

/**
 * The slug half of a page filename.
 *
 * Folded to ASCII lowercase with runs of anything else collapsed to a single
 * hyphen, because these become paths in fourteen repositories on two operating
 * systems and a filename that differs only by case is the same file on one of
 * them. An empty result is refused by `pagePath` rather than silently producing
 * `docs/wiki/3-.md`.
 */
export function pageSlug(title) {
  return String(title ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Order two dotted page ids the way a reader expects: 2 before 10, 2.2 before 2.10.
 *
 * Every rendered index sorts with this rather than trusting the order the plan
 * happens to be written in, because `docs-wiki-eval` reconstructs the page set
 * from the files in `docs/wiki/` and compares the AGENTS.md block byte for
 * byte. A block whose line order depended on an array the CI job cannot see
 * would fail H7 for every repository whose plan was not already sorted.
 */
export function comparePageIds(a, b) {
  const left = String(a ?? '').split('.').map(Number);
  const right = String(b ?? '').split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i] ?? -1;
    const y = right[i] ?? -1;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * Order two strings by UTF-16 code unit, which is what a bare `.sort()` already
 * does to an array of strings.
 *
 * Spelled out rather than left implicit because these orderings are part of the
 * contract: manifest key order, the deny-list identity two actors compare, the
 * restricted paths a finding lists. `localeCompare` would be the idiomatic
 * comparator for text meant to be read, and it is the wrong one here — it
 * varies with locale and with the host's ICU build, so the same deny list would
 * hash differently on the daemon's Mac and the runner's Ubuntu, which is
 * exactly the disagreement `denyListId` exists to detect.
 */
export const byCodeUnit = (a, b) => (a < b ? -1 : Number(a > b));

/** Pages in canonical order. Non-mutating: the caller's plan is left alone. */
export const sortPages = (pages) =>
  [...(Array.isArray(pages) ? pages : [])].sort((a, b) => comparePageIds(a?.id, b?.id));

/** `docs/wiki/<page_id>-<slug>.md` (design section 2, generator-owned paths). */
export function pagePath(page) {
  const id = String(page?.id ?? '').trim();
  const slug = pageSlug(page?.title);
  if (!id || !slug) return null;
  return `docs/wiki/${id}-${slug}.md`;
}

/**
 * Paths Scribe is allowed to write, as predicates rather than globs.
 *
 * This list is the ownership gate and clause 3 of the auto-merge rule. It is
 * deliberately literal: a glob library would let `docs/wiki/**` be widened to
 * `docs/**` by one careless character, and the whole point of the check is that
 * the set cannot grow without someone editing this array in a reviewed PR.
 */
export const GENERATOR_OWNED = Object.freeze([
  { id: 'wiki-page', test: (p) => /^docs\/wiki\/[^/]+\.md$/.test(p) },
  { id: 'llms-txt', test: (p) => p === 'llms.txt' },
  { id: 'llms-full-txt', test: (p) => p === 'llms-full.txt' },
  { id: 'agents-md', test: (p) => p === 'AGENTS.md' },
  { id: 'devin-wiki-json', test: (p) => p === '.devin/wiki.json' },
]);

export function isGeneratorOwned(path) {
  return GENERATOR_OWNED.some((rule) => rule.test(String(path ?? '')));
}

// ─── Citations (design section 3) ────────────────────────────────────────────

/**
 * The DeepWiki citation form, kept so existing readers and the ask oracle keep
 * working after the vendor is gone: `[path:start-end]()`.
 *
 * The optional trailing `<!-- cite:<12 hex> -->` is ours. A citation that still
 * resolves to a line range but no longer to the same text is drift, and a line
 * range alone cannot see that: inserting a function above a cited span moves
 * every line below it, so the range resolves happily to the wrong lines. The
 * hash is what turns that from a silent wrong citation into a gate failure.
 */
const CITATION_RE = /\[([^\]\s:]+):(\d+)-(\d+)\]\(\)(?:\s*<!--\s*cite:([0-9a-f]{12})\s*-->)?/g;

export function parseCitations(body) {
  const out = [];
  for (const m of String(body ?? '').matchAll(CITATION_RE)) {
    const start = Number(m[2]);
    const end = Number(m[3]);
    out.push({
      raw: m[0],
      path: m[1],
      start,
      end,
      hash: m[4] ?? null,
      // An inverted range is not a resolvable citation whatever the file says,
      // so it is caught here rather than by every consumer separately.
      wellFormed: start >= 1 && end >= start,
    });
  }
  return out;
}

/** The trailing comment form, so writer, gate and CI all emit the same bytes. */
export const citationHashComment = (hash) => `<!-- cite:${String(hash).slice(0, 12)} -->`;

/**
 * The page with its citations reduced to plain text.
 *
 * A citation is `[path:start-end]()` with an EMPTY link target. That is what
 * makes it resolvable by H2 and it is why markdownlint's MD042 is switched off
 * for these pages. A link checker reads the same empty target as a malformed
 * link and reports one failure per citation, so H5 could never pass on a page
 * that carried any, which is every page.
 *
 * Stripping is preferred to filtering the checker's report. A genuinely empty
 * link elsewhere in a page is a broken link and has to stay a broken link; a
 * filter written against the checker's error text would hide that one too.
 */
export function stripCitations(body) {
  return String(body ?? '').replace(CITATION_RE, (_match, path, start, end) => `\`${path}:${start}-${end}\``);
}

// ─── The AGENTS.md managed block (design section 14) ─────────────────────────

export const MANAGED_BEGIN = '<!-- docgen:begin -->';
export const MANAGED_END = '<!-- docgen:end -->';

/**
 * The managed block, rendered from the plan with no model in the loop.
 *
 * This is the prompt-injection path that disqualified OpenWiki: AGENTS.md and
 * CLAUDE.md are read as instructions by every agent that opens the repository,
 * so a model that can write into them can write instructions for its own
 * successors. Scribe's writer never sees this function's output and never
 * produces it. The block is a deterministic list of links derived from the plan,
 * hard gate H7 asserts byte equality between what this renders and what landed,
 * and CI recomputes it from the diff.
 *
 * Nothing outside the two markers is ever touched, so a repository's own
 * AGENTS.md prose survives regeneration untouched.
 */
export function renderAgentsBlock(plan, { repo = plan?.repo } = {}) {
  const lines = [
    MANAGED_BEGIN,
    '<!-- Generated by rei-doc-specialist. Edits between these markers are overwritten. -->',
    '',
    '## Documentation map',
    '',
    `Generated pages for \`${repo ?? 'this repository'}\`. Each is written from the source at a`,
    'recorded commit and carries its provenance in front matter.',
    '',
  ];
  for (const page of sortPages(plan?.pages)) {
    const path = pagePath(page);
    if (!path) continue;
    // Two spaces of indent per level of the tree, derived from the page id's
    // dotted depth rather than from `parent`: the id is what the plan validator
    // already guarantees is well formed, and a parent pointer that has drifted
    // would otherwise render a list whose nesting contradicts the page tree.
    const depth = String(page.id).split('.').length - 1;
    const indent = '  '.repeat(depth);
    lines.push(`${indent}- [${page.title}](${path}) — ${page.purpose ?? ''}`.trimEnd());
  }
  lines.push('', MANAGED_END);
  return lines.join('\n');
}

/** The managed block currently in a document, or null when there is not exactly one. */
export function extractManagedBlock(document) {
  const text = String(document ?? '');
  const begin = text.indexOf(MANAGED_BEGIN);
  const end = text.indexOf(MANAGED_END);
  if (begin === -1 || end === -1 || end < begin) return null;
  // A second copy of either marker means the document has been edited into a
  // shape where "the managed block" is ambiguous. Splicing one of them would
  // silently orphan the other, so both are refused.
  if (text.indexOf(MANAGED_BEGIN, begin + 1) !== -1) return null;
  if (text.indexOf(MANAGED_END, end + 1) !== -1) return null;
  return text.slice(begin, end + MANAGED_END.length);
}

/**
 * Replace the managed block, or append one when the document has none.
 *
 * Returns the whole document. A document with malformed markers is returned
 * unchanged with `ok: false`, so the caller reports a gate failure rather than
 * writing a file whose second marker set is now unreachable.
 */
export function spliceManagedBlock(document, block) {
  const text = String(document ?? '');
  const existing = extractManagedBlock(text);
  if (existing === null) {
    if (text.includes(MANAGED_BEGIN) || text.includes(MANAGED_END)) {
      return { ok: false, document: text, reason: 'AGENTS.md has malformed or duplicated docgen markers' };
    }
    const separator = text.length === 0 || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
    return { ok: true, document: `${text}${separator}${block}\n`, changed: true };
  }
  if (existing === block) return { ok: true, document: text, changed: false };
  return { ok: true, document: text.replace(existing, block), changed: true };
}

// ─── Index files (design section 2) ──────────────────────────────────────────

export function renderLlmsTxt(plan, { repo = plan?.repo, summary = plan?.summary } = {}) {
  const lines = [`# ${repo ?? 'repository'}`, ''];
  if (summary) lines.push(summary, '');
  lines.push('## Documentation', '');
  for (const page of sortPages(plan?.pages)) {
    const path = pagePath(page);
    if (!path) continue;
    lines.push(`- [${page.title}](${path}): ${page.purpose ?? ''}`.trimEnd());
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The concatenated corpus, capped.
 *
 * The cap is a hard gate (`llms_full_bytes_max`), and the reason it is enforced
 * here rather than only checked later is that the file is assembled from pages
 * that individually passed: by the time a checker says "1.1 MB" there is no
 * useful repair, only a truncation someone has to choose. Choosing it here, in
 * page order, means the file that ships is a prefix of the corpus rather than
 * an arbitrary byte slice, and the caller is told what was dropped.
 */
export function renderLlmsFull(pages, { maxBytes }) {
  const encoder = new TextEncoder();
  const parts = [];
  const included = [];
  const dropped = [];
  let bytes = 0;
  for (const page of pages) {
    const chunk = `${page.body}\n`;
    const size = encoder.encode(chunk).length;
    if (maxBytes !== undefined && bytes + size > maxBytes) {
      dropped.push(page.path);
      continue;
    }
    parts.push(chunk);
    included.push(page.path);
    bytes += size;
  }
  return { text: parts.join('\n'), bytes, included, dropped };
}

// ─── Plan diffing (design section 4, stage 2) ────────────────────────────────

/**
 * What changed between two plans, keyed by page id.
 *
 * `changed` carries the fields that moved, because the freshness loop
 * regenerates only affected pages and "this page changed" is not enough to
 * decide that: a purpose rewrite needs a new page, a title fix needs a rename,
 * and a sources edit needs a fresh extract. Reporting which is what lets the
 * caller do the cheapest correct thing.
 */
export function diffPlans(previous, next) {
  const before = new Map((previous?.pages ?? []).map((p) => [String(p.id), p]));
  const after = new Map((next?.pages ?? []).map((p) => [String(p.id), p]));
  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];
  for (const [id, page] of after) {
    const prior = before.get(id);
    if (!prior) {
      added.push(id);
      continue;
    }
    const fields = ['title', 'purpose', 'parent', 'sources'].filter(
      (f) => JSON.stringify(prior[f] ?? null) !== JSON.stringify(page[f] ?? null),
    );
    if (fields.length) changed.push({ id, fields });
    else unchanged.push(id);
  }
  for (const id of before.keys()) if (!after.has(id)) removed.push(id);
  return {
    added,
    removed,
    changed,
    unchanged,
    // Renames are the reason this is not just `added + changed`: a page whose
    // title moved lands at a new path, so the old file has to be deleted or the
    // repository accumulates orphans that still resolve and still look current.
    renamed: changed
      .filter((c) => c.fields.includes('title'))
      .map((c) => ({ id: c.id, from: pagePath(before.get(c.id)), to: pagePath(after.get(c.id)) }))
      .filter((r) => r.from && r.to && r.from !== r.to),
    dirty: added.length + removed.length + changed.length > 0,
  };
}

/**
 * Whether the plan itself should be regenerated this cycle.
 *
 * Weekly, or when more than `replan_symbol_change_fraction` of the symbol table
 * moved. Both are needed: a repository can churn heavily without the page tree
 * needing to change, and a repository can sit still for a month while the plan
 * drifts out of date against a DeepWiki baseline that did change.
 */
export function shouldReplan({ daysSinceLastPlan, symbolChangeFraction, hasPlan = true }, thresholds) {
  if (!hasPlan) return { replan: true, reason: 'no previous plan' };
  const fraction = thresholds?.loops?.replan_symbol_change_fraction;
  if (Number.isFinite(symbolChangeFraction) && Number.isFinite(fraction) && symbolChangeFraction > fraction) {
    return { replan: true, reason: `symbol churn ${symbolChangeFraction.toFixed(3)} over ${fraction}` };
  }
  if (Number.isFinite(daysSinceLastPlan) && daysSinceLastPlan >= 7) {
    return { replan: true, reason: `plan is ${daysSinceLastPlan} days old` };
  }
  return { replan: false, reason: 'plan is current' };
}

// ─── Lane selection (design section 7) ───────────────────────────────────────

/**
 * Which model writes this page.
 *
 * `local-only` never reaches a paid model — that set is every private
 * repository and every gameshark-labs repository, and the registry validator
 * already refuses a private repository on `paid-ok` because a request body
 * cannot be taken back. This function must therefore never be able to promote
 * one: the `local-only` branch returns before any up-tier logic runs, rather
 * than falling through to a condition that happens to be false today.
 *
 * A `paid-ok` repository still runs locally first. The paid writer is reached
 * only when the local lane is pinned by the canary or the local writer has
 * already failed the soft gates twice on this page, which is the up-tier rule
 * from design section 7 and the reason the cost model holds.
 */
export function selectLane({ entry, localPinned = false, paidPinned = false, localSoftFailures = 0, budgetPaused = false }) {
  const lane = entry?.lane;
  if (lane === 'local-only') {
    if (localPinned) return { lane: null, writer: null, reason: 'local lane pinned and the repo may not use a paid model' };
    return { lane: 'local-only', writer: 'local', reason: 'registry lane is local-only' };
  }
  if (lane !== 'paid-ok') return { lane: null, writer: null, reason: `unknown lane: ${lane}` };
  const wantsPaid = localPinned || localSoftFailures >= 2;
  if (!wantsPaid) return { lane: 'paid-ok', writer: 'local', reason: 'local lane runs first on paid-ok repos' };
  if (budgetPaused) return { lane: null, writer: null, reason: 'up-tier wanted but spend is paused' };
  if (paidPinned) return { lane: null, writer: null, reason: 'up-tier wanted but the paid lane is pinned' };
  return {
    lane: 'paid-ok',
    writer: 'paid',
    reason: localPinned ? 'local lane pinned' : `local writer failed soft gates ${localSoftFailures} times`,
  };
}

// ─── Gates (design section 5) ────────────────────────────────────────────────

/**
 * The seven hard gates, in the order the spec lists them. Ids are stable and
 * appear in cycle records, PR statuses and the CI job's output, so they are
 * part of the contract rather than internal labels.
 */
export const HARD_GATES = Object.freeze([
  { id: 'H1', name: 'secrets' },
  { id: 'H2', name: 'citations' },
  { id: 'H3', name: 'mermaid' },
  { id: 'H4', name: 'prose-and-lint' },
  { id: 'H5', name: 'links' },
  { id: 'H6', name: 'size-and-plan' },
  { id: 'H7', name: 'ownership' },
]);

/**
 * Evaluate the hard gates from a measurement record.
 *
 * Every comparison is written so that a missing measurement fails. That is the
 * opposite of the usual defensive default and it is deliberate: the failure
 * mode this shape exists to prevent is a gate silently passing because the
 * thing it measures was never measured. `citation_resolvability >= 0.99` with
 * an undefined left side is false, which is right; but a checker written as
 * `!(x < min)` would pass, which is why none of these are written that way and
 * why `missing` is reported as its own failure rather than folded into the
 * comparison.
 */
export function evaluateHardGates(measurements, thresholds) {
  const t = thresholds?.hard ?? {};
  const m = measurements ?? {};
  const failures = [];

  const num = (key) => (Number.isFinite(m[key]) ? m[key] : null);
  const need = (gate, key, value, ok, detail) => {
    if (value === null) failures.push({ gate, key, reason: `${key} was not measured` });
    else if (!ok) failures.push({ gate, key, value, reason: detail });
  };

  // H1 secrets: a count, and the restricted-path names the scanner saw. Both
  // are fatal; the second is the P0 shape (a private path named in a public page).
  const secrets = num('secret_findings');
  need('H1', 'secret_findings', secrets, secrets === 0, `${secrets} credential-shaped strings`);
  const restricted = Array.isArray(m.restricted_paths) ? m.restricted_paths : null;
  if (restricted === null) failures.push({ gate: 'H1', key: 'restricted_paths', reason: 'restricted-path scan did not run' });
  else if (restricted.length) {
    failures.push({ gate: 'H1', key: 'restricted_paths', value: restricted, reason: `page names restricted paths: ${restricted.join(', ')}` });
  }

  const resolvability = num('citation_resolvability');
  need('H2', 'citation_resolvability', resolvability, resolvability >= t.citation_resolvability_min,
    `${resolvability} below ${t.citation_resolvability_min}`);

  const mermaid = num('mermaid_parse_rate');
  need('H3', 'mermaid_parse_rate', mermaid, mermaid >= t.mermaid_parse_rate_min,
    `${mermaid} below ${t.mermaid_parse_rate_min}`);

  const prose = num('prose_errors');
  need('H4', 'prose_errors', prose, prose <= t.prose_errors_max, `${prose} over ${t.prose_errors_max}`);
  const lint = num('markdownlint_errors');
  need('H4', 'markdownlint_errors', lint, lint <= t.markdownlint_errors_max, `${lint} over ${t.markdownlint_errors_max}`);

  const links = num('broken_links');
  need('H5', 'broken_links', links, links <= t.broken_links_max, `${links} over ${t.broken_links_max}`);

  const bytes = num('page_bytes');
  need('H6', 'page_bytes', bytes, bytes <= t.page_bytes_max, `${bytes} over ${t.page_bytes_max}`);
  const planPages = num('plan_pages');
  need('H6', 'plan_pages', planPages, planPages <= t.plan_pages_max, `${planPages} over ${t.plan_pages_max}`);
  if (m.llms_full_bytes !== undefined) {
    const full = num('llms_full_bytes');
    need('H6', 'llms_full_bytes', full, full <= t.llms_full_bytes_max, `${full} over ${t.llms_full_bytes_max}`);
  }

  // H7 ownership: paths, plus the AGENTS.md byte equality that keeps
  // model-authored text out of the file every agent reads as instructions.
  const paths = Array.isArray(m.changed_paths) ? m.changed_paths : null;
  if (paths === null) failures.push({ gate: 'H7', key: 'changed_paths', reason: 'the diff was not read' });
  else {
    const foreign = paths.filter((p) => !isGeneratorOwned(p));
    if (foreign.length) {
      failures.push({ gate: 'H7', key: 'changed_paths', value: foreign, reason: `diff touches paths Scribe does not own: ${foreign.join(', ')}` });
    }
  }
  if (m.agents_block_matches === undefined) {
    failures.push({ gate: 'H7', key: 'agents_block_matches', reason: 'the AGENTS.md managed block was not compared' });
  } else if (m.agents_block_matches !== true) {
    failures.push({ gate: 'H7', key: 'agents_block_matches', reason: 'the AGENTS.md managed block does not match the rendered template byte for byte' });
  }

  const provenance = Array.isArray(m.provenance_problems) ? m.provenance_problems : null;
  if (provenance === null) failures.push({ gate: 'H7', key: 'provenance_problems', reason: 'front matter was not checked' });
  else if (provenance.length) failures.push({ gate: 'H7', key: 'provenance_problems', value: provenance, reason: provenance.join('; ') });

  return { ok: failures.length === 0, failures, gates: HARD_GATES.map((g) => g.id) };
}

/**
 * Score the soft gates. A page below one of these still opens a PR; it just
 * does not merge itself, which is why this returns scores alongside the verdict
 * rather than a boolean — the numbers go on the `rei/docs-wiki-quality` status
 * and into the regression comparison against the last merge.
 */
export function evaluateSoftGates(scores, thresholds) {
  const t = thresholds?.soft ?? {};
  const s = scores ?? {};
  const failures = [];
  const check = (key, value, ok, detail) => {
    if (!Number.isFinite(value)) failures.push({ key, reason: `${key} was not scored` });
    else if (!ok) failures.push({ key, value, reason: detail });
  };

  check('citation_support', s.citation_support, s.citation_support >= t.citation_support_min,
    `${s.citation_support} below ${t.citation_support_min}`);
  check('judge_page', s.judge_page, s.judge_page >= t.judge_page_min, `${s.judge_page} below ${t.judge_page_min}`);
  check('symbol_coverage', s.symbol_coverage, s.symbol_coverage >= t.symbol_coverage_min,
    `${s.symbol_coverage} below ${t.symbol_coverage_min}`);

  // Similarity is a band, not a floor. Below it the page has drifted from what
  // was last merged; above it the page says the same thing and the cycle did no
  // work worth a PR. Both ends matter, so both are checked.
  if (s.embedding_similarity !== undefined) {
    check('embedding_similarity', s.embedding_similarity,
      s.embedding_similarity >= t.embedding_similarity_min && s.embedding_similarity <= t.embedding_similarity_max,
      `${s.embedding_similarity} outside [${t.embedding_similarity_min}, ${t.embedding_similarity_max}]`);
  }
  if (s.judge_mean !== undefined) {
    check('judge_mean', s.judge_mean, s.judge_mean >= t.judge_mean_min, `${s.judge_mean} below ${t.judge_mean_min}`);
  }
  if (s.ask_regression_mean !== undefined) {
    check('ask_regression_mean', s.ask_regression_mean, s.ask_regression_mean >= t.ask_regression_mean_min,
      `${s.ask_regression_mean} below ${t.ask_regression_mean_min}`);
  }
  if (s.ask_regression_page !== undefined) {
    check('ask_regression_page', s.ask_regression_page, s.ask_regression_page >= t.ask_regression_page_min,
      `${s.ask_regression_page} below ${t.ask_regression_page_min}`);
  }
  return { ok: failures.length === 0, failures, scores: { ...s } };
}

/**
 * Whether any soft score regressed against the last merge by more than the
 * allowed drop. This blocks auto-merge, not the PR (design section 5), so it is
 * reported separately from `evaluateSoftGates` rather than folded into it.
 */
export function evaluateRegression(current, previous, thresholds) {
  const max = thresholds?.soft?.regression_drop_max;
  const regressions = [];
  if (!previous || !Number.isFinite(max)) return { ok: true, regressions, reason: 'no previous merge to compare against' };
  for (const [key, value] of Object.entries(current ?? {})) {
    const before = previous[key];
    if (!Number.isFinite(value) || !Number.isFinite(before)) continue;
    const drop = before - value;
    if (drop > max) regressions.push({ key, before, value, drop: Number(drop.toFixed(6)) });
  }
  return { ok: regressions.length === 0, regressions };
}

// ─── The auto-merge rule (design section 6, all eight must hold) ─────────────

export const AUTOMERGE_CLAUSES = Object.freeze([
  'ci-green',
  'soft-gates',
  'diff-scope',
  'written-approval',
  'kill-switches',
  'required-check',
  'ledger',
  'blast-radius',
]);

/**
 * Evaluate the eight-condition merge rule.
 *
 * Every clause is evaluated even after one fails. A rule that short-circuits
 * reports the first problem, and the first problem is rarely the interesting
 * one: a PR that is both over the diff cap and missing its written approval
 * needs both facts on the `needs-human` label, not the one that happened to be
 * checked first.
 *
 * Unknown is failure, everywhere. `ciGreen: undefined` means nobody asked CI,
 * and clause 5's `redisAnswered: false` is the spec's fail-closed scenario:
 * Redis unreachable during evaluation means no merge, not "no kill switch was
 * found so presumably none is set".
 */
export function evaluateAutoMerge(facts, thresholds) {
  const f = facts ?? {};
  const t = thresholds?.automerge ?? {};
  const failed = [];
  const fail = (clause, reason) => failed.push({ clause, reason });

  if (f.ciGreen !== true) fail('ci-green', f.ciGreen === undefined ? 'docs-wiki-eval result unknown' : 'docs-wiki-eval is not green on the PR head');

  if (f.softGatesOk !== true) fail('soft-gates', 'a soft gate is below threshold');
  if (f.regressionOk !== true) fail('soft-gates', 'a soft score regressed past the allowed drop');

  // Clause 3: only generator-owned paths, and small. "Whichever is smaller" is
  // the point — a repo with twenty pages caps at six, not eight.
  const foreign = Array.isArray(f.changedPaths) ? f.changedPaths.filter((p) => !isGeneratorOwned(p)) : null;
  if (foreign === null) fail('diff-scope', 'the diff was not read');
  else if (foreign.length) fail('diff-scope', `diff touches paths Scribe does not own: ${foreign.join(', ')}`);
  const pagesInPr = Number(f.pagesInPr);
  const repoPages = Number(f.repoPages);
  if (!Number.isFinite(pagesInPr) || !Number.isFinite(repoPages)) fail('diff-scope', 'page counts unknown');
  else {
    const cap = Math.min(t.max_pages_per_pr ?? Infinity, Math.floor(repoPages * (t.max_fraction_of_repo_pages ?? 1)));
    if (pagesInPr > cap) fail('diff-scope', `${pagesInPr} pages over the cap of ${cap}`);
  }

  // Clause 4: Drew's written approval, and the private-repo carve-out.
  const approval = f.entry?.automerge;
  if (!approval || !approval.approved_by || !approval.approved_at || !approval.pr_comment_url) {
    fail('written-approval', 'the registry entry carries no approval with approver, date and PR comment URL');
  }
  if (f.entry?.visibility === 'private' && f.entry?.automerge_private !== true) {
    fail('written-approval', 'private repository without automerge_private');
  }

  // Clause 5: kill switches and the ledger pause, fail-closed.
  if (f.redisAnswered !== true) fail('kill-switches', 'Redis did not answer; failing closed');
  else {
    if (f.docgenDisabled !== false) fail('kill-switches', 'rei:docgen:disabled is set');
    if (f.automergeDisabled !== false) fail('kill-switches', 'rei:docgen:automerge:disabled is set');
    if (f.budgetPaused !== false) fail('kill-switches', 'a rei:budget:paused key exists');
  }

  // Clause 6: the branch ruleset, read at run time. A 403 is the Free-plan
  // private-repo case from the spec — it is not an error to retry, it is a
  // repository that cannot require a check, so the PR is for a human.
  if (f.requiredCheckStatus === 403) fail('required-check', 'branch protection returned 403; the plan cannot require checks');
  else if (f.requiredCheckPresent !== true) fail('required-check', 'docs-wiki-eval is not a required status check on the base branch');

  if (f.ledgerPaused !== false) fail('ledger', 'the cost ledger is paused');
  const runCost = Number(f.runCostUsd);
  const runCap = Number(f.runCostCapUsd);
  if (!Number.isFinite(runCost) || !Number.isFinite(runCap)) fail('ledger', 'run cost or cap unknown');
  else if (runCost > runCap) fail('ledger', `run cost ${runCost} over the cap ${runCap}`);

  // Clause 8: blast radius. The eleventh merge of the day waits for tomorrow.
  const repoMerges = Number(f.mergesForRepoToday);
  const fleetMerges = Number(f.mergesForFleetToday);
  if (!Number.isFinite(repoMerges) || !Number.isFinite(fleetMerges)) fail('blast-radius', 'merge counters unreadable');
  else {
    if (repoMerges >= (t.merges_per_repo_per_day ?? 1)) fail('blast-radius', `${repoMerges} merges already today for this repo`);
    if (fleetMerges >= (t.merges_per_fleet_per_day ?? 10)) fail('blast-radius', `${fleetMerges} merges already today across the fleet`);
  }

  return {
    merge: failed.length === 0,
    failed,
    // The label is the whole outcome for a PR that does not merge: it is what
    // the PR-age alert and the weekly human batch key off.
    label: failed.length === 0 ? null : NEEDS_HUMAN_LABEL,
    clauses: AUTOMERGE_CLAUSES,
  };
}

// ─── Cycle accounting (design section 8) ─────────────────────────────────────

/**
 * Exit codes, distinct so the watchdog reads a scheduled run correctly.
 * A kill switch is not a fault and must not restart anything, which is why it
 * has its own code rather than sharing 1 with an execution fault.
 */
export const EXIT = Object.freeze({ OK: 0, FAULT: 1, GATED: 3 });

/**
 * The `cycle_end` record the watchdog's four health rules read.
 *
 * `work` is pages written plus PRs opened or merged. Counting it here rather
 * than at each call site is what makes the zero-work rule trustworthy: three
 * consecutive `work: 0` lines while the watched input changed is a stall, and
 * that only holds if every cycle computes `work` the same way.
 *
 * `ok` is derived here for the same reason, and derived from the same fact the
 * entrypoint returns its exit code from: a cycle is fine unless some repository
 * faulted. The watchdog's success-rate rule reads a row's verdict as `ok`
 * (bool) or `status` ("ok"/"failed") and scores neither when both are absent —
 * so a record without this field does not fail the rule, it makes the rule
 * silently unevaluable, which is the worse outcome of the two.
 *
 * The PR-age field is named `oldest_docs_auto_pr_hours` because that is the key
 * `service-watchdog.sh` looks up. It was `oldest_open_pr_hours` until this
 * daemon was registered, and nothing else ever read it.
 */
export function cycleRecord({ startedAt, endedAt, repos = [], disabled = false, ollamaOk = null, reason = '' }) {
  const pages = repos.reduce((n, r) => n + (r.pagesWritten ?? 0), 0);
  const prs = repos.reduce((n, r) => n + (r.prsOpened ?? 0) + (r.prsMerged ?? 0), 0);
  return {
    event: 'cycle_end',
    started_at: startedAt,
    ended_at: endedAt,
    ok: !repos.some((r) => r.fault),
    work: pages + prs,
    pages_written: pages,
    prs_touched: prs,
    disabled,
    ollama_ok: ollamaOk,
    reason,
    repos: repos.map((r) => ({
      slug: r.slug,
      source_sha: r.sourceSha ?? null,
      pages_written: r.pagesWritten ?? 0,
      prs_opened: r.prsOpened ?? 0,
      prs_merged: r.prsMerged ?? 0,
      hard_gate_failures: r.hardGateFailures ?? 0,
      lane: r.lane ?? null,
    })),
    oldest_docs_auto_pr_hours: repos.reduce((max, r) => Math.max(max, r.openPrAgeHours ?? 0), 0),
  };
}

/**
 * A lock is stale when its TTL has passed or its process is gone.
 *
 * The pid half is the fix for the existence-only check that has kept
 * `doc-drift-watch` skipping since 2026-07-13: a lock file left behind by a
 * killed process is indistinguishable from a running one if all you check is
 * whether the file exists, and the daemon then reports a clean skip forever.
 * Liveness is passed in rather than probed, because probing is IO.
 */
export function lockIsStale({ lock, nowMs, ttlHours, pidAlive }) {
  if (!lock || typeof lock !== 'object') return { stale: true, reason: 'no lock' };
  const started = Date.parse(lock.started_at ?? '');
  if (!Number.isFinite(started)) return { stale: true, reason: 'lock has no readable started_at' };
  const ageHours = (nowMs - started) / 3_600_000;
  if (ageHours >= ttlHours) return { stale: true, reason: `lock is ${ageHours.toFixed(1)}h old, past the ${ttlHours}h TTL` };
  if (pidAlive === false) return { stale: true, reason: `lock pid ${lock.pid} is not running` };
  return { stale: false, reason: `held by pid ${lock.pid} for ${ageHours.toFixed(1)}h` };
}
