# docs-hygiene

A scanner for the documentation problems the October 2026 audit of the DCYFR Labs
repositories kept finding by hand. Each rule below is one class of finding that
showed up in more than one repository. Checking for them in CI is cheaper than
auditing for them again. `scan.mjs` uses only Node built-ins, so it runs from a bare checkout with no
install step.

## Rules

| Rule | Flags | Why |
| --- | --- | --- |
| `attribution.bare-dcyfr` | A copyright, maintainer, author, owner or "by" line that names bare "DCYFR" as the entity | The entity is DCYFR Labs. "DCYFR" alone is a brand, so brand uses (`DCYFR AI`, `@dcyfr/ai`) and trademark lines pass |
| `attribution.person-copyright` | A copyright line naming a person (`--person`, default Drew Gowan) | Copyright belongs to DCYFR Labs. The trademark is credited to Drew Gowan, so trademark lines pass |
| `exposure.home-path` | `/Users/<name>/` or `/home/<name>/` | A real home path leaks a username and a machine layout. Placeholders (`you`, `user`, `<name>`) and container paths (`runner`, `node`, `app`) pass |
| `exposure.op-ref` | A 1Password `op://` reference with real vault or item IDs | It names where a secret lives. Templated references (`op://<vault>/...`, `op://${VAULT}/...`) pass |
| `exposure.tlp` | A `TLP:AMBER` or `TLP:RED` marker in a doc | A file marked for limited sharing should not be in a public repository. Prose or tables that explain TLP pass |
| `exposure.tracked-file` | Tracked logs (`*.ndjson`, `*.jsonl`, `*.log`), `.env`, `.env.ci`, `.mcp.json` | Runtime state and local config belong in `.gitignore`. Commit an `.example` copy instead |
| `links.relative-missing` | A relative Markdown link to a file that does not exist | URLs, `#anchors` and site routes (`/blog`) are skipped, as are links into git submodules (not checked out in CI) |
| `links.repo-unreachable` | A link to a `dcyfr-labs` or `dcyfr` repository the public cannot open | A private, renamed or deleted repo is a dead link for every reader. `--remote` only |
| `links.repo-archived` | A link to an archived repository on a line that does not say "archived" | Readers follow it expecting a live project. `--remote` only |

Fenced code blocks and inline code are skipped in Markdown. A line containing
`docs-hygiene-allow` is skipped by every rule: use it for test fixtures and for
an exception you have a reason for, and put the reason on the same line.

## Running it

```sh
node docs-hygiene/scan.mjs --root ../some-repo            # report
node docs-hygiene/scan.mjs --root ../some-repo --remote   # add the GitHub lookups
node docs-hygiene/scan.mjs --root . --fail                # exit 1 on new findings
```

`--remote` calls the GitHub API once per linked repository. It reads
`GITHUB_TOKEN` when set; without a token it is subject to the anonymous rate limit.

## Baselines

A repository that starts with findings records them once. After that, only new
findings fail the run:

```sh
node docs-hygiene/scan.mjs --root . --remote --write-baseline .docs-hygiene-baseline.json
```

A baseline entry is the rule, the file and the trimmed line text. Line numbers
are not part of it, so edits elsewhere in a file do not invalidate the
baseline. Fixing a finding changes or removes its line, and the stale entry
drops out the next time the baseline is written. Commit the shrinking baseline
with the fix.

## Using it from a repository

Pin the reusable workflow by commit SHA and pass the same SHA as `gate-ref`. The
job checks out that commit of the scanner, so the pin covers both:

```yaml
jobs:
  docs-hygiene:
    uses: dcyfr-labs/.github/.github/workflows/docs-hygiene-reusable.yml@<sha>
    with:
      gate-ref: <sha>
```

Inputs: `baseline` (default `.docs-hygiene-baseline.json`, a missing file means
no baseline), `fail` (default `true`), `remote` (default `true`) and `runs-on`.

## Org sweep

`docs-hygiene-sweep.yml` runs weekly and on demand. It clones every public,
unarchived `dcyfr-labs` repository, scans it with `--remote` and writes a table
of counts to the run summary. It is report-only until the org is clean: it
fails only if `FAIL_ON_FINDINGS` in the workflow is set to `'true'`.

## Tests

Run `node --test docs-hygiene/scan.test.mjs`. `docs-hygiene-test.yml` runs the tests and scans this repository on every pull
request that touches the scanner or its workflows.
