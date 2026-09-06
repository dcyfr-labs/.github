/**
 * restricted.mjs — the path deny list, and the one function that applies it.
 *
 * Split out of `extract.mjs` for task 1.4. The `docs-wiki-eval` CI job runs in
 * a PUBLIC repository and recomputes H1 there, so the code that answers "is
 * this path restricted" has to be publishable. The list it answers against
 * does not: half of it names this workspace's private trees, and publishing a
 * list of "directories too sensitive to document" in a public repository is
 * the same disclosure H1 exists to prevent.
 *
 * So the split is code from data. The universal half — credential
 * directories, credential filenames, key extensions, path traversal — is the
 * same everywhere and ships with the public bundle. The workspace half lives
 * in `registry.mjs` and is supplied as an argument by the caller that has it.
 * One implementation, two configurations, and the difference between the
 * daemon's verdict and CI's is a declared input rather than a fork.
 *
 * No imports, by construction. This module is vendored byte-for-byte into the
 * public gate runner (`usr/docgen/gate-runner/`), and a dependency here would
 * have to be vendored too.
 */

/**
 * Credential-bearing directories that mean the same thing in any repository.
 *
 * `.backups/` is here rather than in the workspace half because a backup tree
 * is a copy of everything else's secrets wherever it sits, not because this
 * workspace happens to have one.
 */
export const UNIVERSAL_PREFIXES = Object.freeze(['.backups/', '.ssh/', '.aws/']);

export const RESTRICTED_BASENAMES = Object.freeze([
  'chat.db',
  '.env',
  '.envrc',
  'id_rsa',
  'id_ed25519',
]);

export const RESTRICTED_EXTENSIONS = Object.freeze(['.pem', '.p12', '.key', '.keychain']);

/**
 * Build the deny predicate for a given set of extra prefixes.
 *
 * `extraPrefixes` are anchored at the repository root and are added to the
 * universal list, never substituted for it: a caller cannot narrow the deny by
 * passing a shorter list, only widen it.
 *
 * Checked against the whole path rather than the glob that produced it: a glob
 * is a statement of intent and a path is a fact, and this is the fact check.
 * Any segment matching a restricted basename counts, because `config/.env` is
 * the same secret as `.env` and a prefix test alone would miss it.
 */
export function makeRestrictedPath(extraPrefixes = []) {
  const prefixes = Object.freeze([...UNIVERSAL_PREFIXES, ...extraPrefixes].map(String));
  // Dot-prefixed entries name a credential directory rather than a workspace
  // location, and a credential directory is the same secret wherever it sits in
  // a tree, so those match at any depth as well as at the root.
  const dotDirectories = Object.freeze(
    prefixes.filter((prefix) => prefix.startsWith('.')).map((prefix) => prefix.replace(/\/$/, '')),
  );

  return function isRestrictedPath(path) {
    const p = String(path ?? '').replace(/^\.\//, '');
    if (!p) return true;
    // A path that climbs out of the repository is restricted whatever it names:
    // the extractor's whole safety argument is that it stays inside the mirror.
    if (p.startsWith('/') || p.split('/').includes('..')) return true;
    if (prefixes.some((prefix) => p === prefix.slice(0, -1) || p.startsWith(prefix))) return true;
    const segments = p.split('/');
    if (segments.some((segment) => RESTRICTED_BASENAMES.includes(segment))) return true;
    if (segments.some((segment) => dotDirectories.includes(segment))) return true;
    const dot = p.lastIndexOf('.');
    if (dot !== -1 && RESTRICTED_EXTENSIONS.includes(p.slice(dot))) return true;
    // `.env.production`, `.env.local`: the same file with a suffix, and the
    // basename test above does not see them.
    return /(^|\/)\.env\./.test(p);
  };
}

/**
 * The universal-only predicate. This is what the public gate runner gets, and
 * what `gate.mjs` binds to once the bundler rewrites its import; inside this
 * workspace `extract.mjs` re-binds the same factory with the private prefixes.
 */
export const isRestrictedPath = makeRestrictedPath();

/**
 * UTF-16 code-unit order, the same order a bare `.sort()` gives an array of
 * strings. Written out because this one is load-bearing: the id below is
 * compared between the daemon's Mac and a public runner's Ubuntu, and a
 * locale-aware comparator would let two hosts gate identically and still
 * disagree about it. Local to this module, which imports nothing by
 * construction.
 */
const byCodeUnit = (a, b) => (a < b ? -1 : Number(a > b));

/** Identity of a deny list, so two actors can say whether they gated alike. */
export function denyListId(extraPrefixes = []) {
  return [...UNIVERSAL_PREFIXES, ...extraPrefixes].map(String).sort(byCodeUnit).join(',');
}
