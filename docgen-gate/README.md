# docgen gate runner

The `docs-wiki-eval` job, packaged so it can run inside a public repository.

Generated documentation is written by a daemon in a private workspace and lands
as a pull request in the repository it describes. The hard gates that decide
whether that pull request may merge have to be recomputed where the pull request
is, by something that does not trust the daemon's own report. Most of those
repositories are public, and a public Actions runner cannot reach the private
workspace's validators. So the gate is published.

## What is in here

| Path | Origin |
| --- | --- |
| `eval.mjs` | authored for the bundle: reconstructs the page set and recomputes H1 through H7 |
| `workflows/docs-wiki-eval-reusable.yml` | authored: the reusable workflow, source of truth for the copy under `.github/workflows/` |
| `scripts/docgen/{core,gate,restricted,mermaid-check}.mjs` | vendored byte for byte from the workspace |
| `scripts/validate-prose.mjs` | vendored byte for byte |
| `usr/docgen/{thresholds.json,docgen.markdownlint-cli2.jsonc}` | vendored byte for byte |
| `scripts/docgen/extract.mjs` | generated stub, see below |
| `usr/prose/prose-rules.json` | generated projection, see below |
| `package.json` | generated: exact pins for jsdom, mermaid and markdownlint-cli2 |
| `MANIFEST.json` | generated: sha256 of every file above, plus the lychee pin |

Nothing here is hand-copied. `scripts/docgen/bundle-gate.mjs` in the workspace
builds the tree, and `--check` re-derives every vendored and generated file and
diffs it against what is on disk. That check runs in the workspace's own CI, so
the published copy cannot drift from the code it was cut from without a red
build. Do not edit any file in this directory except the three authored ones;
rebuild instead.

The vendored files sit at the paths they have in the workspace. That is what
lets `gate.mjs` spawn `<root>/scripts/validate-prose.mjs` and read
`<root>/usr/docgen/docgen.markdownlint-cli2.jsonc` with no path rewriting: the
runner passes the bundle directory as `root` and every constant resolves.

## The two files that are not copies

**`scripts/docgen/extract.mjs`** is a stub re-exporting the universal restricted
path predicate. The workspace binds the same factory with a second list naming
its own private trees, and that list is deliberately absent here. Publishing an
inventory of the directories too sensitive to document would be the disclosure
hard gate H1 exists to prevent. The consequence is that this runner cannot fail
a page for naming a private workspace path, because it does not know those
paths. The daemon's gate does, and runs first. `MANIFEST.json` records which
deny list shipped as `deny_list_id`, so two actors can say whether they gated
alike.

**`usr/prose/prose-rules.json`** is a projection: the global cadence rules, the
one voice generated pages are written in, and that voice's inheritance chain.
The workspace file's surface map names every project in the workspace and does
not ship. Voices are projected key by key rather than copied minus a deny list,
so a voice that gains a field later does not leak it.

## Publishing

The bundle is copied into `dcyfr-labs/.github`, which is public and already
hosts the security-review reusable workflow.

```bash
# from a checkout of dcyfr-labs/.github, with rei-workspace beside it
rm -rf docgen-gate
cp -R ../rei-workspace/usr/docgen/gate-runner docgen-gate
cp docgen-gate/workflows/docs-wiki-eval-reusable.yml .github/workflows/
node docgen-gate/eval.mjs --verify-bundle
```

GitHub requires a reusable workflow to live under `.github/workflows/`, which is
why that one file exists twice. The job's first step diffs the two copies, so
the executable one cannot quietly become something the bundle never said.

## Calling it

Each documented repository adds a thin caller. It pins by full commit SHA in
both places, and the two SHAs must match:

```yaml
jobs:
  docs-wiki-eval:
    if: github.event.pull_request.user.login == 'app/rei-doc-specialist'
    uses: dcyfr-labs/.github/.github/workflows/docs-wiki-eval-reusable.yml@<sha>
    with:
      gate-ref: <the same sha>
      gate-version: '0.1.0'
```

`gate-version` is the bundle version the daemon wrote the pages against. The job
fails if the checked-out runner reports a different one. A repository is
therefore gated by the runner its pages were written for, and a new bundle
reaches it when someone updates the caller rather than the moment it is
published.

Tags are not used. A branch name resolves to whatever landed last, and a SHA on
a squash-merged branch goes dangling, so the caller records the commit it was
reviewed against and nothing else.

## What the job needs

`fetch-depth: 0` on the repository under evaluation. Citations resolve against
the commit each page records in `source_sha`, and that commit is usually older
than a shallow clone reaches. Without the full history every citation reports as
unresolvable and H2 fails the whole pull request.

Three npm packages and one binary. `jsdom` and `mermaid` parse the diagrams,
`markdownlint-cli2` half of H4, and `lychee` the external links. All four are
pinned: the packages to exact versions in `package.json`, lychee to a release
asset and to the sha256 that asset had when the bundle was cut.

A missing tool does not weaken the gate, it blocks the pull request. Every
measurement omits its key when the tool could not run, and the evaluator treats
an absent key as a failure reading `<key> was not measured`.

## Running it by hand

```bash
node eval.mjs --repo /path/to/checkout --base <base-sha> --head <head-sha>
node eval.mjs --verify-bundle
```

Exit 0 means every hard gate passed for every page. Exit 1 means at least one
failed, or the bundle did not verify. `--json <path>` writes the full record,
including per-page measurements, for anything downstream that wants numbers
rather than a verdict.
