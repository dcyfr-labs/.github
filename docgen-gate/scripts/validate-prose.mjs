#!/usr/bin/env node
// validate-prose.mjs — enforce the workspace prose rules (usr/prose/prose-rules.json).
//
// WHY THIS EXISTS: six separate voice systems already lived in this workspace
// (gameshark-labs/brand/voice.rules.json, the sharkvault voice judge, two
// validate-voice-compliance scripts, openspec/specs/brand-voice, the DCYFR
// brand_voice block). Measurement on 2026-07-31 showed every one of them had
// successfully driven the BANNED LEXICON to ~0.02/1k words while em-dashes ran
// 5.7-7.5/1k across every surface — against a human baseline of 0.00/1k in
// Drew's own writing samples. They banned words. The tell is cadence.
//
// Two other reasons they failed, both fixed here:
//   1. None of them ran. No npm script, no CI workflow, no hook. Detection
//      without disposition (see memory: workspace-detection-without-disposition).
//   2. All of them were post-hoc. This one also feeds the model in-turn via
//      scripts/hooks/posttool-prose-check.sh, so violations get fixed before
//      they ever reach a commit.
//
// Usage:
//   node scripts/validate-prose.mjs                  # whole workspace
//   node scripts/validate-prose.mjs --changed        # git-changed files only
//   node scripts/validate-prose.mjs <path> [...]     # explicit paths
//   node scripts/validate-prose.mjs --json           # machine-readable
//   node scripts/validate-prose.mjs --stats          # density report, never fails
//   node scripts/validate-prose.mjs --warn-only      # never exit non-zero
//
// Exit: 0 clean (or warn-only), 1 errors found, 2 bad invocation.

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const RULES_PATH = resolve(ROOT, 'usr/prose/prose-rules.json');

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const OPT = {
  changed: flag('--changed'),
  json: flag('--json'),
  stats: flag('--stats'),
  warnOnly: flag('--warn-only'),
  quiet: flag('--quiet'),
  ratchet: flag('--ratchet'),
  writeBaseline: flag('--write-baseline'),
};
const BASELINE_PATH = resolve(ROOT, 'usr/prose/baseline.json');

/**
 * `--voice <id>` forces the voice for explicitly named paths.
 *
 * Added for the documentation specialist's H4 gate. That gate writes a
 * candidate page to a temp file and asks this script to score it, and a temp
 * path resolves to no surface: the file was skipped, the run reported zero
 * errors over zero files, and the gate read that as a pass. A prose gate that
 * silently passes everything is worse than no prose gate, so the caller now
 * names the voice it wants the text held to, and this script checks the file
 * whatever its path.
 *
 * Only explicit paths are affected. A forced voice with no paths would hold
 * every surface in the workspace to one voice, which is never what anyone
 * means, so that combination is rejected rather than obeyed.
 */
const voiceIndex = argv.findIndex((a) => a === '--voice' || a.startsWith('--voice='));
const FORCED_VOICE = voiceIndex === -1
  ? null
  : (argv[voiceIndex].includes('=') ? argv[voiceIndex].split('=').slice(1).join('=') : argv[voiceIndex + 1]) ?? '';
const voiceValueIndex = voiceIndex !== -1 && !argv[voiceIndex].includes('=') ? voiceIndex + 1 : -1;
const explicitPaths = argv.filter((a, i) => !a.startsWith('--') && i !== voiceValueIndex);

if (!existsSync(RULES_PATH)) {
  console.error(`✗ prose rules not found: ${relative(ROOT, RULES_PATH)}`);
  process.exit(2);
}
const RULES = JSON.parse(readFileSync(RULES_PATH, 'utf8'));

if (FORCED_VOICE !== null) {
  if (!RULES.voices?.[FORCED_VOICE]) {
    console.error(`✗ unknown voice: ${FORCED_VOICE || '(empty)'}. Known: ${Object.keys(RULES.voices || {}).join(', ')}`);
    process.exit(2);
  }
  if (!explicitPaths.length) {
    console.error('✗ --voice applies to explicitly named paths; name at least one file');
    process.exit(2);
  }
}

// ---------------------------------------------------------------- globs

// Minimal glob -> RegExp. Supports **, *, ?, {a,b} and [a-z] character classes.
//
// Character classes were previously escaped along with the other regex
// metacharacters, so `[0-9]` compiled to a literal five-character sequence and
// the pattern
//
//     **/*-20[0-9][0-9]-[0-9][0-9]-[0-9][0-9].md
//
// in usr/prose/prose-rules.json matched nothing at all. 24 dated report files
// were being linted as house prose against an exclude rule that had never once
// fired. Silent, and in the direction that looks like the rule is working.
function globToRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // '**/' should also match zero directories
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      // Pass a character class through as-is. An unclosed '[' is not a class,
      // so it falls back to a literal rather than producing an invalid RegExp.
      const end = glob.indexOf(']', i + 1);
      if (end === -1) { re += '\\['; continue; }
      const body = glob.slice(i + 1, end);
      // Only leading '!' needs translating to regex negation; the rest of the
      // class body (ranges, literals) is already regex-compatible.
      re += '[' + (body.startsWith('!') ? '^' + body.slice(1) : body) + ']';
      i = end;
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      re += '(?:' + glob.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|') + ')';
      i = end;
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  try {
    return new RegExp('^' + re + '$');
  } catch {
    // A class body can still be invalid regex (`[\]]` leaves an unterminated
    // class). The old fully-escaped form could never throw, so failing open to
    // a literal match keeps a malformed pattern from taking the whole validator
    // down — it matches nothing, which for an exclude means "lints more", the
    // safe direction.
    return new RegExp('^' + glob.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
  }
}
const reCache = new Map();
const matches = (path, glob) => {
  let r = reCache.get(glob);
  if (!r) { r = globToRe(glob); reCache.set(glob, r); }
  return r.test(path);
};
const matchesAny = (path, globs) => globs.some((g) => matches(path, g));

// ---------------------------------------------------------------- voice resolution

// Most specific surface wins: longest matching glob pattern.
function resolveVoice(relPath) {
  if (FORCED_VOICE !== null) return FORCED_VOICE;
  let best = null, bestLen = -1;
  for (const s of RULES.surfaces || []) {
    for (const g of s.match) {
      if (matches(relPath, g) && g.length > bestLen) { best = s.voice; bestLen = g.length; }
    }
  }
  return best;
}

/**
 * Load a project's own rule file: `delegateTo: "path/to/voice.rules.json#register"`.
 *
 * This field was decorative until now, which meant GameShark's mature rule set
 * (traits, registers, lexicon, naming policy — the thing that already drove its
 * banned words to ~0.02/1k) was documented here but unenforced, and only the
 * cadence layer actually ran. Delegating makes the source of truth the project's
 * own file rather than a copy that drifts.
 */
const delegateCache = new Map();
function delegatedRules(spec) {
  if (delegateCache.has(spec)) return delegateCache.get(spec);
  let rules = [];
  const [relPath, register] = String(spec).split('#');
  const abs = resolve(ROOT, relPath);
  try {
    if (existsSync(abs)) {
      const doc = JSON.parse(readFileSync(abs, 'utf8'));
      rules = (doc.lint || [])
        .filter((r) => !register || !r.appliesTo || r.appliesTo.includes(register))
        .map((r) => ({ ...r, id: `${r.id}`, rewrite: r.rewrite || r.message }));
    }
  } catch { /* a malformed sibling rule file must not break the whole run */ }
  delegateCache.set(spec, rules);
  return rules;
}

// Layer global <- inherits <- voice. A voice may loosen a budget, turn one off
// (severity:"off"), waive a global rule by id, delegate to a project's own rule
// file, or add its own rules.
function effectiveConfig(voiceId) {
  const chain = [];
  let cur = voiceId;
  const seen = new Set();
  while (cur && RULES.voices?.[cur] && !seen.has(cur)) {
    seen.add(cur);
    chain.unshift(RULES.voices[cur]);
    cur = RULES.voices[cur].inherits;
  }

  const budgets = structuredClone(RULES.global.budgets);
  const waived = new Set();
  let rhythm = [...RULES.global.rhythm];

  for (const v of chain) {
    for (const [k, over] of Object.entries(v.budgets || {})) {
      budgets[k] = { ...(budgets[k] || {}), ...over };
    }
    for (const id of v.waive || []) waived.add(id);
    if (v.rhythm) rhythm = rhythm.concat(v.rhythm);
    if (v.delegateTo) rhythm = rhythm.concat(delegatedRules(v.delegateTo));
  }
  // Two rule sets can express the same shape. Dedupe on the pattern so a
  // delegated rule does not double-report against a global one.
  const seenPattern = new Set();
  rhythm = rhythm.filter((r) => {
    const k = `${r.pattern}::${r.flags || ''}`;
    if (seenPattern.has(k)) return false;
    seenPattern.add(k); return true;
  });
  rhythm = rhythm.filter((r) => !waived.has(r.id));
  return { budgets, rhythm, voice: chain.at(-1) || null, voiceId };
}

// ---------------------------------------------------------------- prose extraction
//
// We MASK non-prose regions with spaces rather than deleting them, so every
// match offset still maps to the correct line in the original file.

// Extraction returns [{text, offset}] segments rather than a masked copy of the
// file: masking allocated two char arrays per file, which at 9k files is most of
// the runtime. Offsets let every finding still resolve to a real line number.

/** Subtract masked ranges from a whole-file span, yielding the surviving segments. */
function subtractRanges(src, ranges) {
  if (!ranges.length) return [{ text: src, offset: 0 }];
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  const segs = [];
  let pos = 0;
  for (const [s, e] of merged) {
    if (s > pos) segs.push({ text: src.slice(pos, s), offset: pos });
    pos = Math.max(pos, e);
  }
  if (pos < src.length) segs.push({ text: src.slice(pos), offset: pos });
  return segs.filter((s) => /\S/.test(s.text));
}

/** Does this string literal read as human prose (vs. a className, path, or id)? */
function looksLikeProse(s) {
  const t = s.trim();
  if (t.length < 25) return false;
  if (!/\s/.test(t)) return false;
  if (/^(?:https?:|\/|\.\/|#|@|data:|[A-Za-z]:\\)/.test(t)) return false;
  // Tailwind / CSS class soup
  if (/(?:^|\s)(?:flex|grid|absolute|relative|hidden|w-|h-|p-|m-|px-|py-|mt-|mb-|text-|bg-|border-|rounded|gap-|items-|justify-|max-w-|min-h-|z-|opacity-|hover:|dark:|sm:|md:|lg:)/.test(t)) return false;
  if (/^[\w.-]+(?:\s+[\w.-]+){0,3}$/.test(t) && !/[.!?,;:]/.test(t)) return false; // bare identifiers
  const words = t.split(/\s+/).length;
  return words >= 5 || /[.!?]/.test(t);
}

const MD_MASK = [
  /^---\n[\s\S]*?\n---\n/,  // frontmatter
  /```[\s\S]*?```/g,        // fenced code
  /~~~[\s\S]*?~~~/g,
  /`[^`\n]*`/g,             // inline code
  /<!--[\s\S]*?-->/g,       // html comments
  /^\s{4,}\S.*$/gm,         // indented code
  /\]\([^)]*\)/g,           // link targets (keeps the link text)
  /^\s*\|.*\|\s*$/gm,       // tables — mostly labels, high false-positive rate
  /^\s*(?:[-*+]|\d+\.)\s+\[[ x]\]/gm,
  // Headings are typography, not cadence: "### ASI01 — Agent Goal Hijack" uses
  // the dash as a title separator, which is correct and not a generated-prose
  // tell. Counting them would push authors into worse headings.
  /^#{1,6} .*$/gm,
  // Definition bullets are the same case one level down:
  //   - **Allowlist-only shell** — a fixed set of binaries, no metacharacters
  // The dash separates term from gloss, which is what a dash is for. Only the
  // lead-in and the dash are masked; the gloss after it is still scored.
  // A qualifier may sit between term and dash: "- **A database** (Postgres) — schema access"
  /^\s*(?:[-*+]|\d+[.)])\s+(?:\*\*[^*\n]{1,80}\*\*|`[^`\n]{1,60}`|\[[^\]\n]{1,60}\]\([^)\n]*\)|[A-Z][\w ./-]{1,50})(?:\s*\([^)\n]{1,40}\))?\s+—/gm,
  // Same term–gloss shape at the start of a paragraph rather than a bullet:
  //   **The key — it can spend.** The agent holds a credential...
  /^\*\*[^*\n]{1,40}—[^*\n]{1,60}\*\*/gm,
];

/**
 * MDX expression containers hold data, not prose. A summary-card prop like
 *   items={['ASI01 Goal Hijack — prompt injection is the load-bearing attack']}
 * is a label with a gloss separator; scoring it as a sentence produced 7 bogus
 * findings in one post. Braces nest, so this needs a scanner rather than a regex.
 */
function jsxExpressionRanges(src) {
  const ranges = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '{') continue;
    let depth = 0, j = i;
    for (; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (!depth) break; }
    }
    if (depth === 0 && j > i) { ranges.push([i, j + 1]); i = j; }
  }
  return ranges;
}
const HTML_MASK = [/<script[\s\S]*?<\/script>/gi, /<style[\s\S]*?<\/style>/gi, /<!--[\s\S]*?-->/g, /<[^>]+>/g];

const collect = (src, patterns) => {
  const ranges = [];
  for (const re of patterns) {
    if (re.global) { for (const m of src.matchAll(re)) ranges.push([m.index, m.index + m[0].length]); }
    else { const m = src.match(re); if (m && m.index != null) ranges.push([m.index, m.index + m[0].length]); }
  }
  return ranges;
};

// One alternative per quote type, and within each the two branches are mutually
// exclusive at any position. The obvious /(['"`])(?:\\.|(?!\1)[\s\S])*?\1/ form
// is ambiguous and backtracks catastrophically: 38s on a single 37 KB file.
const STRING_LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

/**
 * Blank out // and /* *\/ comments, preserving offsets and newlines. Without
 * this, a quoted fragment inside a comment is extracted as prose — the comment
 * `// " — SharkVault". Writing the suffix here shipped it twice` was scored as
 * a sentence — and an odd quote count in a comment mis-pairs every literal
 * after it. Code comments are notes to developers, not prose we publish.
 */
function stripComments(src) {
  let out = '', i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      out += ' '.repeat(stop - i); i = stop;
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' '); i = stop;
    } else if (c === '"' || c === "'" || c === '`') {
      // Skip over string bodies so a '//' inside a URL is not treated as a comment.
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      out += src.slice(i, Math.min(j + 1, src.length)); i = j + 1;
    } else { out += c; i++; }
  }
  return out;
}

/** Code files are the inverse: keep only qualifying prose, discard the rest. */
function extractCode(rawSrc) {
  const src = stripComments(rawSrc);
  const segs = [];
  for (const m of src.matchAll(STRING_LITERAL)) {
    let inner = m[0].slice(1, -1), off = m.index + 1;
    // Label-gloss in a UI string is a separator, not a connector, and matches
    // what is already exempt in markdown bullets and JSX text:
    //   title="Draft — visible to admins only"     label={`Get it — ${price}`}
    //   "GameShark Labs — For Investors"           "Code Vault — Top 500 codes"
    // Only the leading `Label — ` is dropped; the gloss after it is still scored.
    const lead = inner.match(/^([A-Z$][\w$&'’ .{}()/-]{1,34}\s—\s)/);
    if (lead) { off += lead[1].length; inner = inner.slice(lead[1].length); }
    // Rule-box headings inside a long prompt template are headings, same as an
    // ATX heading in markdown: `═══ FACTS MODE — SUPERSEDES HARD RULES ═══`.
    // Blank them in place so offsets (and therefore line numbers) still hold.
    inner = inner.replace(/^[ \t]*[═=─—-]{3,}[^\n]*$/gm, (m) => ' '.repeat(m.length));
    if (looksLikeProse(inner)) segs.push({ text: inner, offset: off });
  }
  for (const m of src.matchAll(/>([^<>{}\n][^<>{}]*)</g)) {
    let text = m[1], off = m.index + 1;
    // JSX term-gloss: `<strong>Email address</strong> — required for sign-in.`
    // The text node after the closing tag opens with the separator dash. Same
    // construct as a markdown definition bullet, so drop the leading dash only.
    const lead = text.match(/^(\s*—\s*)/);
    if (lead) { off += lead[1].length; text = text.slice(lead[1].length); }
    if (looksLikeProse(text)) segs.push({ text, offset: off });
  }
  return segs.sort((a, b) => a.offset - b.offset);
}

/**
 * A segment that OPENS with a dash is a gloss whose term sat in the markup just
 * before it (`<strong>true neutral</strong> — #020203`). Same construct as a
 * markdown definition bullet, so drop the separator and score only the gloss.
 * Offsets are advanced so line numbers still resolve.
 */
const dropLeadingGloss = (segs) => segs.map((s) => {
  const lead = s.text.match(/^(\s*—\s*)/);
  return lead ? { text: s.text.slice(lead[1].length), offset: s.offset + lead[1].length } : s;
}).filter((s) => /\S/.test(s.text));

function extract(file, src) {
  const ext = extname(file);
  if (ext === '.mdx') {
    return dropLeadingGloss(subtractRanges(src, [...collect(src, MD_MASK), ...jsxExpressionRanges(src)]));
  }
  if (ext === '.md') return dropLeadingGloss(subtractRanges(src, collect(src, MD_MASK)));
  if (ext === '.html' || ext === '.htm') return dropLeadingGloss(subtractRanges(src, collect(src, HTML_MASK)));
  return extractCode(src);
}

// ---------------------------------------------------------------- analysis

const countWords = (t) => (t.match(/\b[A-Za-z][A-Za-z'’-]*\b/g) || []).length;

/** Line-start offsets, computed once per file; binary search beats slice+split. */
function lineIndex(src) {
  const starts = [0];
  for (let i = src.indexOf('\n'); i !== -1; i = src.indexOf('\n', i + 1)) starts.push(i + 1);
  return (idx) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

// Rule regexes are compiled once, not per file (13 rules x 9k files otherwise).
const reCacheRules = new Map();
function ruleRe(r) {
  let re = reCacheRules.get(r);
  if (!re) {
    const flags = (r.flags || '').includes('g') ? r.flags : (r.flags || '') + 'g';
    re = new RegExp(r.pattern, flags);
    reCacheRules.set(r, re);
  }
  re.lastIndex = 0;
  return re;
}

function analyze(relPath, src) {
  const cfg = effectiveConfig(resolveVoice(relPath));
  const segs = extract(relPath, src);
  if (!segs.length) return { findings: [], words: 0, dashes: 0, voiceId: cfg.voiceId };

  const b = cfg.budgets;
  const findings = [];
  let lineAt = null; // built lazily — most files produce no findings at all
  const lineOf = (idx) => (lineAt ??= lineIndex(src))(idx);
  const add = (severity, rule, idx, message, hint) => {
    if (severity === 'off') return;
    findings.push({ file: relPath, line: lineOf(idx), rule, severity, message, hint });
  };

  let words = 0, dashCount = 0, firstDash = 0;
  for (const seg of segs) {
    words += countWords(seg.text);
    for (const m of seg.text.matchAll(/—/g)) {
      if (!dashCount) firstDash = seg.offset + m.index;
      dashCount++;
    }
    // --- rhythm rules
    for (const r of cfg.rhythm) {
      for (const m of seg.text.matchAll(ruleRe(r))) {
        if (!m[0].trim()) continue;
        add(r.severity, r.id, seg.offset + m.index, r.message, r.rewrite);
      }
    }
    // --- per-sentence dash density
    if (b.emDashPerSentence?.severity !== 'off' && (seg.text.match(/—/g) || []).length > 1) {
      let last = 0;
      const bounds = [];
      for (const m of seg.text.matchAll(/[.!?](?=\s|$)/g)) { bounds.push([last, m.index + 1]); last = m.index + 1; }
      if (last < seg.text.length) bounds.push([last, seg.text.length]);
      for (const [s, e] of bounds) {
        const n = (seg.text.slice(s, e).match(/—/g) || []).length;
        if (n > (b.emDashPerSentence?.value ?? 1)) {
          add(b.emDashPerSentence?.severity ?? 'error', 'em-dash-per-sentence', seg.offset + s,
            `${n} em-dashes in one sentence.`, 'Keep at most one. Split the sentence or use parentheses.');
        }
      }
    }
    // --- per-paragraph dash density
    if (b.emDashPerParagraph?.severity !== 'off' && (seg.text.match(/—/g) || []).length > 1) {
      let off = 0;
      for (const para of seg.text.split(/\n\s*\n/)) {
        const n = (para.match(/—/g) || []).length;
        if (n > (b.emDashPerParagraph?.value ?? 1)) {
          add(b.emDashPerParagraph?.severity ?? 'warn', 'em-dash-per-paragraph', seg.offset + off,
            `${n} em-dashes in one paragraph.`, 'At most one dash per paragraph; vary the connector.');
        }
        off += para.length + 2;
      }
    }
  }

  // --- whole-file em-dash budget
  // 60, not 120: microcopy files are individually tiny (a metadata description
  // repeated across metadata/openGraph/twitter is ~75 prose words), so a 120-word
  // gate let the whole gameshark-console surface skip the budget while its
  // aggregate density sat at 19/1k. The floor of one keeps this from being harsh.
  if (b.emDashPer1kWords?.severity !== 'off' && words >= (b.emDashPer1kWords.minWords ?? 60)) {
    const per1k = dashCount / (words / 1000);
    const limit = b.emDashPer1kWords.value;
    // Floor of one. The rule exists to stop the dash being the DEFAULT connector,
    // not to ban it outright: a single dash in a 600-word post is good writing,
    // and failing it would teach authors the rule is unreasonable and worth muting.
    const allowed = Math.max(1, Math.floor((limit * words) / 1000));
    if (dashCount > allowed) {
      add(b.emDashPer1kWords.severity ?? 'error', 'em-dash-budget', firstDash,
        `${dashCount} em-dashes in ${words} words = ${per1k.toFixed(1)}/1k (budget ${limit}/1k, voice "${cfg.voiceId || 'global'}")`,
        `Remove about ${dashCount - allowed}. Replacements: period (two ideas), colon (the second explains the first), parentheses (true aside), comma (appositive).`);
    }
  }

  // --- structural shape, on substantial prose only
  if (words >= 250) {
    const joined = segs.map((s) => s.text).join('\n\n');
    // Structured markdown (bullets, headings, tables, quotes) is legitimately
    // one-sentence-per-block. Counting it produced 97%-drumbeat readings on
    // ordinary reference docs, so shape rules see narrative paragraphs only.
    const isStructural = (p) => /^\s*(?:[-*+>|#]|\d+[.)]\s)/.test(p) || /\n\s*(?:[-*+]|\d+[.)])\s/.test(p);
    const paras = joined.split(/\n\s*\n/).map((p) => p.trim())
      .filter((p) => countWords(p) >= 8 && !isStructural(p));
    const sentSplit = (t) => t.split(/(?<=[.!?])\s+/).filter((s) => countWords(s) >= 3);

    if (b.singleSentenceParagraphRatio?.severity !== 'off' && paras.length >= 6) {
      const single = paras.filter((p) => sentSplit(p).length === 1).length;
      const ratio = single / paras.length;
      const limit = b.singleSentenceParagraphRatio?.value ?? 0.4;
      if (ratio > limit) {
        add(b.singleSentenceParagraphRatio?.severity ?? 'warn', 'single-sentence-drumbeat', 0,
          `${single}/${paras.length} paragraphs are a single sentence (${(ratio * 100).toFixed(0)}%, limit ${(limit * 100).toFixed(0)}%).`,
          'The one-sentence-paragraph drumbeat is the strongest structural AI tell. Combine related beats.');
      }
    }
    if (b.meanSentenceWords?.severity !== 'off') {
      const all = paras.flatMap(sentSplit);
      if (all.length >= 10) {
        const mean = all.reduce((a, s) => a + countWords(s), 0) / all.length;
        const { min = 9, max = 24 } = b.meanSentenceWords;
        if (mean < min || mean > max) {
          add(b.meanSentenceWords?.severity ?? 'warn', 'sentence-length-uniformity', 0,
            `Mean sentence length ${mean.toFixed(1)} words (target ${min}-${max}).`,
            mean < min ? 'Uniformly clipped sentences read as generated. Let some breathe.'
                       : 'Long-winded. Break the longest sentences.');
        }
      }
    }
  }

  return { findings, words, dashes: dashCount, voiceId: cfg.voiceId };
}

// ---------------------------------------------------------------- file discovery

function listFiles() {
  if (explicitPaths.length) {
    return explicitPaths
      .filter((p) => existsSync(p) && statSync(p).isFile())
      .map((p) => relative(ROOT, resolve(p)));
  }
  if (OPT.changed && !OPT.ratchet && !OPT.writeBaseline) {
    let out = '';
    for (const cmd of [
      'git diff --cached --name-only --diff-filter=ACM',
      'git diff --name-only --diff-filter=ACM',
      // Untracked too: a brand-new doc is exactly the thing worth checking, and
      // it appears in neither diff until it is staged.
      'git ls-files --others --exclude-standard',
    ]) {
      try { out += execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
      catch { /* not a repo / no HEAD / unreadable paths */ }
    }
    return [...new Set(out.split('\n').filter(Boolean))];
  }
  // Scan roots are DERIVED from the surface globs: a file with no voice is not
  // checkable anyway (see eligible()), so there is no reason to walk the rest of
  // the workspace. Without this a full sweep touches 27,759 markdown files
  // across 10 worktrees and dozens of nested repos.
  const bare = [];   // globs with no wildcard at all -> exact files (README.md)
  const rootSet = new Set();
  for (const g of (RULES.surfaces || []).flatMap((s) => s.match)) {
    if (!g.includes('*')) { bare.push(g); continue; }
    // Literal PREFIX only: stop at the first globbed segment. Joining
    // non-adjacent literals would invent paths ('gameshark-labs/content').
    const segs = [];
    for (const seg of g.split('/')) { if (seg.includes('*')) break; segs.push(seg); }
    rootSet.add(segs.length ? segs.join('/') : '.');
  }
  // Drop roots already covered by a shallower root.
  const roots = [...rootSet].filter((r, _i, arr) => !arr.some((o) => o !== r && r.startsWith(o + '/')));

  // -prune, not -not -path: a filtering find still walks every node_modules first.
  const PRUNE = ['node_modules', '.next', '.next-preview', 'out', 'storybook-static', '.git',
                 'dist', 'build', '.turbo', '.vercel', '.backups', 'logs', 'coverage',
                 'knowledge-base', '*.wt-*', 'archive', '.claude'];
  const prune = PRUNE.map((d) => `-name '${d}'`).join(' -o ');
  const inc = (RULES.include || []).map((g) => `-name '${g.replace(/^\*\*\//, '')}'`).join(' -o ');
  const dirs = roots.filter((r) => r !== '.' && existsSync(resolve(ROOT, r)));

  // Linked git worktrees are byte-identical checkouts of a repo already being
  // scanned, so every finding in one is counted again in each sibling. The
  // sharkvault tree alone triple-counted 72 findings this way. The '*.wt-*'
  // name convention misses worktrees named for their branch
  // (sharkvault-supporters-wall), so detect them structurally: a linked
  // worktree's .git is a FILE reading "gitdir: .../worktrees/<name>".
  const worktreeDirs = new Set();
  for (const d of dirs) {
    let entries = [];
    try {
      entries = execSync(`find '${d}' -maxdepth 2 -name .git -type f -print 2>/dev/null || true`,
        { cwd: ROOT, encoding: 'utf8', timeout: 30000 }).split('\n').filter(Boolean);
    } catch { /* ignore */ }
    for (const gitFile of entries) {
      try {
        if (/gitdir:.*\/worktrees\//.test(readFileSync(resolve(ROOT, gitFile), 'utf8'))) {
          worktreeDirs.add(dirname(gitFile).replace(/^\.\//, ''));
        }
      } catch { /* ignore */ }
    }
  }

  const out = [...bare.filter((f) => existsSync(resolve(ROOT, f)))];
  if (dirs.length) {
    try {
      // '|| true': find exits 1 on any unreadable dir (the sandbox denies
      // knowledge-base/ and logs/rei/journal/), which would otherwise throw
      // away every file it *did* find.
      out.push(...execSync(
        `find ${dirs.map((d) => `'${d}'`).join(' ')} \\( ${prune} \\) -prune -o -type f \\( ${inc} \\) -print 2>/dev/null || true`,
        { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 180000 })
        .split('\n').filter(Boolean).map((p) => p.replace(/^\.\//, ''))
        .filter((p) => ![...worktreeDirs].some((w) => p.startsWith(w + '/'))));
    } catch { /* fall through with whatever we have */ }
  }
  return dropIgnored([...new Set(out)]);
}

/**
 * Drop gitignored paths from a full sweep.
 *
 * `find` knows nothing about .gitignore, so the sweep scored generated local
 * state as if it were authored prose. `usr/agents/rei/library/analyze/`
 * (.gitignore:200) is daemon output: it regenerates every cycle, exists in no
 * commit, and differs per checkout. A ratchet regression there can never be
 * committed, reviewed, or fixed in a PR — yet four such files failed
 * /workspace-doctor at CRITICAL, which is how a gate becomes noise people
 * stop reading.
 *
 * The --changed path already gets this right (`git ls-files --exclude-standard`
 * is gitignore-aware), so the two modes disagreed about what counts as prose.
 * This brings the sweep in line with the mode that was already correct.
 *
 * One batched `git check-ignore --stdin` rather than a call per path.
 */
function dropIgnored(paths) {
  if (!paths.length) return paths;
  try {
    const res = spawnSync('git', ['check-ignore', '--stdin'], {
      cwd: ROOT, encoding: 'utf8', input: paths.join('\n'),
      maxBuffer: 256 * 1024 * 1024, timeout: 60000,
    });
    // 0 = some ignored, 1 = none ignored. Anything else (not a repo, git
    // missing) means we cannot tell, and scanning too much beats scanning
    // nothing — a gate that silently empties itself is the worse failure.
    if (res.status !== 0 && res.status !== 1) return paths;
    const ignored = new Set((res.stdout || '').split('\n').filter(Boolean));
    return ignored.size ? paths.filter((p) => !ignored.has(p)) : paths;
  } catch {
    return paths;
  }
}

// A forced voice is the caller saying "hold this text to that standard"; the
// include and exclude globs answer "does this path belong to a voice", which is
// the question the caller has already answered.
const eligible = (p) =>
  FORCED_VOICE !== null ||
  (matchesAny(p, RULES.include || []) &&
    !matchesAny(p, RULES.exclude || []) &&
    resolveVoice(p) !== null);

// ---------------------------------------------------------------- run

const files = listFiles().filter(eligible);
const all = [];
const perVoice = new Map();

for (const f of files) {
  const abs = resolve(ROOT, f);
  if (!existsSync(abs)) continue;
  let src;
  try { src = readFileSync(abs, 'utf8'); } catch { continue; }
  if (src.length > 2 * 1024 * 1024) continue;
  const t0 = process.env.PROSE_DEBUG ? Date.now() : 0;
  const r = analyze(f, src);
  if (t0 && Date.now() - t0 > 200) console.error(`  [slow ${Date.now() - t0}ms] ${f} (${src.length}B)`);
  all.push(...r.findings);
  const agg = perVoice.get(r.voiceId) || { words: 0, dashes: 0, files: 0 };
  agg.words += r.words; agg.dashes += r.dashes; agg.files++;
  perVoice.set(r.voiceId, agg);
}

const errors = all.filter((f) => f.severity === 'error');
const warns = all.filter((f) => f.severity === 'warn');

// NOTE: set process.exitCode and RETURN — never process.exit() here. exit()
// truncates piped stdout mid-write, which silently cut the --json payload off
// at 64 KB. Each branch below is terminal, hence the report() wrapper.
// ---------------------------------------------------------------- ratchet
//
// A 3,233-finding backlog will never be cleared in one sprint, and a warn-only
// gate lets the number grow while everyone agrees it should shrink. The ratchet
// is the disposition: per-file error counts are frozen in usr/prose/baseline.json,
// and only INCREASES fail. Existing debt is grandfathered, new debt is blocked,
// and any improvement is a free re-baseline.

function currentCounts() {
  const counts = {};
  for (const f of all) if (f.severity === 'error') counts[f.file] = (counts[f.file] || 0) + 1;
  return counts;
}

function writeBaseline() {
  const counts = currentCounts();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  writeFileSync(BASELINE_PATH, JSON.stringify({
    _comment: 'Frozen per-file prose error counts. Only increases fail (--ratchet). Regenerate after any improvement: npm run validate:prose:baseline',
    generated: null, // deliberately not a timestamp: it would churn the diff on every run
    totalErrors: total,
    files: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a < b ? -1 : 1)),
  }, null, 2) + '\n');
  console.log(`✓ baseline written — ${total} errors across ${Object.keys(counts).length} files`);
  console.log(`  ${relative(ROOT, BASELINE_PATH)}`);
}

function runRatchet() {
  if (!existsSync(BASELINE_PATH)) {
    console.error(`✗ no baseline at ${relative(ROOT, BASELINE_PATH)} — run: npm run validate:prose:baseline`);
    process.exitCode = 2;
    return;
  }
  const base = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).files || {};
  const now = currentCounts();

  const regressions = [], improvements = [];
  for (const [file, n] of Object.entries(now)) {
    const was = base[file] ?? 0;
    if (n > was) regressions.push({ file, was, now: n });
  }
  for (const [file, was] of Object.entries(base)) {
    const n = now[file] ?? 0;
    if (n < was) improvements.push({ file, was, now: n });
  }

  const netBefore = Object.values(base).reduce((a, b) => a + b, 0);
  const netNow = Object.values(now).reduce((a, b) => a + b, 0);

  if (regressions.length) {
    console.error(`\n✗ prose ratchet — ${regressions.length} file(s) got worse:\n`);
    for (const r of regressions.slice(0, 20)) {
      console.error(`  ${String(r.was).padStart(4)} → ${String(r.now).padEnd(4)}  ${r.file}`);
    }
    if (regressions.length > 20) console.error(`  … ${regressions.length - 20} more`);
    console.error(`\nFix the new violations, or if they are deliberate re-baseline with:`);
    console.error(`  npm run validate:prose:baseline`);
    process.exitCode = OPT.warnOnly ? 0 : 1;
    return;
  }

  console.log(`✓ prose ratchet — no regressions (${netNow} errors, baseline ${netBefore})`);
  if (improvements.length) {
    console.log(`  ${improvements.length} file(s) improved, ${netBefore - netNow} fewer errors.`);
    console.log(`  Lock the gain in: npm run validate:prose:baseline`);
  }
  process.exitCode = 0;
}

function report() {
  if (OPT.writeBaseline) { writeBaseline(); return; }
  if (OPT.ratchet) { runRatchet(); return; }

  if (OPT.json) {
    console.log(JSON.stringify({
      files: files.length, errors: errors.length, warnings: warns.length,
      findings: all,
      density: Object.fromEntries([...perVoice].map(([v, a]) => [v, { ...a, per1k: +(a.dashes / (a.words / 1000 || 1)).toFixed(2) }])),
    }, null, 2));
    process.exitCode = OPT.warnOnly || !errors.length ? 0 : 1;
    return;
  }

  if (OPT.stats) {
    console.log(`\nEm-dash density by voice  (${files.length} prose files)\n`);
    console.log('  voice                 files      words   dashes    per 1k   budget');
    for (const [v, a] of [...perVoice].sort((x, y) => y[1].words - x[1].words)) {
      const budget = effectiveConfig(v).budgets.emDashPer1kWords?.value ?? '-';
      const per1k = a.dashes / (a.words / 1000 || 1);
      const mark = typeof budget === 'number' && per1k > budget ? '  x' : '  ok';
      console.log(`  ${String(v).padEnd(20)} ${String(a.files).padStart(5)} ${String(a.words).padStart(10)} ${String(a.dashes).padStart(8)} ${per1k.toFixed(2).padStart(9)} ${String(budget).padStart(8)}${mark}`);
    }
    console.log(`\n  ${errors.length} errors, ${warns.length} warnings\n`);
    process.exitCode = 0;
    return;
  }

  if (!all.length) {
    if (!OPT.quiet) console.log(`✓ prose clean — ${files.length} files checked`);
    process.exitCode = 0;
    return;
  }

  const byFile = new Map();
  for (const f of all) { if (!byFile.has(f.file)) byFile.set(f.file, []); byFile.get(f.file).push(f); }

  for (const [file, list] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n${file}`);
    const shown = list.sort((a, b) => a.line - b.line).slice(0, 12);
    for (const f of shown) {
      const tag = f.severity === 'error' ? '✗' : '⚠';
      console.log(`  ${tag} ${String(f.line).padStart(4)}  [${f.rule}] ${f.message}`);
      if (f.hint && !OPT.quiet) console.log(`         ↳ ${f.hint}`);
    }
    if (list.length > shown.length) console.log(`    … ${list.length - shown.length} more in this file`);
  }

  console.log(`\n${errors.length} error(s), ${warns.length} warning(s) across ${byFile.size} file(s).`);
  console.log(`Rules: usr/prose/prose-rules.json   Density report: npm run validate:prose:stats`);
  process.exitCode = OPT.warnOnly || !errors.length ? 0 : 1;
}

report();
