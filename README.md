# .github

Org-level defaults for **dcyfr-labs**: the profile README, and the reusable
workflows every repo calls instead of keeping its own copy.

It also holds the default [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md), which
every dcyfr-labs repository without its own file inherits. Do not add
per-repo copies.

## Reusable workflows

| Workflow | Purpose |
|---|---|
| [`dependabot-auto-merge.yml`](.github/workflows/dependabot-auto-merge.yml) | Auto-merge Dependabot patch/minor bumps, gated on a supply-chain package-age cooldown |
| [`dependabot-auto-merge-sweep.yml`](.github/workflows/dependabot-auto-merge-sweep.yml) | Re-run auto-merge runs that withheld, so they merge once eligible |
| [`security-review-reusable.yml`](.github/workflows/security-review-reusable.yml) | Claude Code security review |

### Dependabot auto-merge: caller contract

Auto-merge is **two reusable workflows**, and each repo needs **two thin
callers**, one per file:

- **PR mode** (`dependabot-auto-merge.yml`) evaluates the PR in the event
  payload. It merges, withholds (age cooldown), or hands off for review.
- **Sweep** (`dependabot-auto-merge-sweep.yml`) re-runs the latest auto-merge
  run of each open Dependabot PR, so a withheld PR is looked at again. Without
  a sweep caller a withheld PR stays green, mergeable and stranded.

They are separate files because a reusable workflow may not request more
permission than its caller grants, and that ceiling applies to the whole called
file. Sweep needs `actions: write` for `gh run rerun`; while both modes lived in
one file, every PR-mode call died at `startup_failure` (2026-08-31 to
2026-09-05, 20 of 20 repos).

PR-mode caller, `.github/workflows/dependabot-auto-merge.yml`:

```yaml
name: Dependabot auto-merge

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: write
  pull-requests: write

jobs:
  auto-merge:
    if: ${{ github.actor == 'dependabot[bot]' }}
    uses: dcyfr-labs/.github/.github/workflows/dependabot-auto-merge.yml@main
    permissions:
      contents: write
      pull-requests: write
```

Sweep caller, `.github/workflows/dependabot-auto-merge-sweep.yml`:

```yaml
name: Dependabot auto-merge sweep

on:
  schedule:
    - cron: '6 6 * * 2'   # weekly; give each repo its own weekday AND minute
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write
  actions: write

jobs:
  sweep:
    uses: dcyfr-labs/.github/.github/workflows/dependabot-auto-merge-sweep.yml@main
    permissions:
      contents: write
      pull-requests: write
      actions: write
```

What bites if you shortcut this:

- **Never add a permission to `dependabot-auto-merge.yml`.** Every PR-mode
  caller grants exactly `contents: write` + `pull-requests: write`, so a third
  permission breaks all of them at once. A step that needs more gets its own
  file.
- **The sweep caller must grant all three permissions.** Granting less fails
  at `startup_failure`, which is silent: no check, no annotation. Run a new
  sweep caller once with `gh workflow run "Dependabot auto-merge sweep"` and
  confirm the run reached a step.
- **The sweep caller must not trigger on `pull_request`**, and needs no actor
  gate: scheduled runs have no Dependabot actor.
- **Spread the sweep cron across the week, not just the hour.** Every repo
  competes for the same hosted runners; at most three per weekday, each on its
  own minute.
- **The PR-mode gate reads `github.actor`, the account behind the latest
  push.** A commit pushed onto a Dependabot branch with a personal token (a
  lockfile sync, say) makes that run's actor the token's owner, so the run is
  skipped, and so is every sweep re-run of it.

Inputs (all optional): PR mode takes `merge-method` (`squash`),
`timeout-minutes` (`45`), `min-package-age-days` (`7`), `review-assignee`
(`dcyfr`) and `review-label` (`needs-review`); sweep takes `sweep-max-prs`
(`50`). Sweep is safe on any cadence: a PR still inside its cooldown withholds
again, and a merged PR drops out of the list.

### Dependabot auto-merge: manual review hand-off

A PR that PR mode will not merge is assigned to `review-assignee` (default
`dcyfr`) and labelled `review-label` (default `needs-review`, created on first
use). That covers major or unclassified bumps, failed or cancelled checks, a
polling timeout, and an errored merge step. Age-cooldown withholds are not
assigned, because sweep merges them once the cooldown expires.

Find them org-wide with
`is:pr is:open assignee:dcyfr label:needs-review org:dcyfr-labs`, or GitHub's
"Assigned to you" filter. Pass either input as `''` to switch that half off
for one caller:

```yaml
    uses: dcyfr-labs/.github/.github/workflows/dependabot-auto-merge.yml@main
    with:
      review-assignee: ''
```
