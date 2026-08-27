# .github

Org-level defaults for **dcyfr-labs**: the profile README, and the reusable
workflows every repo calls instead of keeping its own copy.

## Reusable workflows

| Workflow | Purpose |
|---|---|
| [`dependabot-auto-merge.yml`](.github/workflows/dependabot-auto-merge.yml) | Auto-merge Dependabot patch/minor bumps, gated on a supply-chain package-age cooldown |
| [`security-review-reusable.yml`](.github/workflows/security-review-reusable.yml) | Claude Code security review |

### Dependabot auto-merge: caller contract

The auto-merge workflow runs in **two modes**, chosen by the caller's trigger.

**PR mode** evaluates the PR in the event payload. **Sweep mode** re-runs
auto-merge runs that withheld, so a PR held back by the age cooldown is
re-examined once the cooldown expires. Without a sweep trigger a withheld PR is
never looked at again. It stays green, mergeable, and stranded indefinitely.

Full caller, both modes:

```yaml
name: Dependabot auto-merge

on:
  pull_request:
    types: [opened, synchronize, reopened]
  schedule:
    - cron: "17 5 * * *"   # daily; stagger the minute across repos
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write
  actions: write           # sweep mode calls `gh run rerun`

jobs:
  auto-merge:
    # PR mode is Dependabot-only; sweep mode has no Dependabot actor.
    if: ${{ github.event_name != 'pull_request' || github.actor == 'dependabot[bot]' }}
    uses: dcyfr-labs/.github/.github/workflows/dependabot-auto-merge.yml@main
    permissions:
      contents: write
      pull-requests: write
      actions: write
```

Three things bite if you shortcut this:

- **`actions: write` is required.** A caller's `permissions:` block is the
  ceiling for the reusable workflow, so leaving it out makes `gh run rerun`
  403 while every other step still reports green.
- **The job-level `if:` must admit non-PR events.** The original
  `github.actor == 'dependabot[bot]'` gate alone skips every scheduled run.
- **Stagger the cron minute** across repos. Identical `cron` values across a
  dozen repos queue against the same runner pool at the same instant.

Sweep mode is safe to run on any cadence: a PR still inside its cooldown simply
withholds again, and a merged PR drops out of the list.
