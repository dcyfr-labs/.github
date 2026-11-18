# AGENTS.md

`dcyfr-labs/.github` is the organization's default community health repository and the home of its shared GitHub Actions workflows. **A change merged to `main` here reaches every dcyfr-labs repository**: default files (code of conduct, contributing guide, security policy, support, issue forms, PR template) apply wherever a repo has no copy of its own, and most callers reference the reusable workflows at `@main`.

## Layout

```
profile/README.md                   the organization profile page
CODE_OF_CONDUCT.md, CONTRIBUTING.md, SECURITY.md, SUPPORT.md, FUNDING.yml   org-wide defaults
LICENSE, NOTICE                     Apache-2.0
.github/ISSUE_TEMPLATE/             bug_report, feature_request, question, config (issue forms)
.github/pull_request_template.md    org default PR template: What this changes, How you tested it, Checklist
.github/workflows/                  reusable workflows and their own tests (table below)
docs-hygiene/                       scan.mjs documentation scanner, scan.test.mjs, README.md
docgen-gate/                        published gate runner for generated docs (package.json, MANIFEST.json, eval.mjs, scripts/, usr/, workflows/)
```

## Workflows, and who calls them

Callers were found by reading the workflow files of every non-archived repo under `dcyfr-labs` and `dcyfr` on 2026-11-17. Private repos not visible to that scan may also call these; re-check before removing or renaming anything.

| Workflow | Trigger | Callers |
|---|---|---|
| `dependabot-auto-merge.yml` | `workflow_call`, PR mode | 20 repos: dcyfr-labs, dcyfr-work, dcyfr-build, dcyfr-tech, dcyfr-bot, dcyfr-io, dcyfr-codes, dcyfr-app, dcyfr-ai, dcyfr-ai-graphql, dcyfr-ai-api, dcyfr-ai-react, dcyfr-ai-code-gen, dcyfr-ai-nodejs, dcyfr-ai-cli, dcyfr-ai-workspace, dcyfr-ai-sandbox, dcyfr-ai-chatbot, dcyfr-ai-rag, dcyfr-ai-agents. Referenced at `@main`. |
| `dependabot-auto-merge-sweep.yml` | `workflow_call`, re-runs withheld PR-mode runs | The same 20 repos, at `@main`. |
| `security-review-reusable.yml` | `workflow_call`, Claude Code security review | dcyfr-ai, dcyfr-ai-api, dcyfr-ai-code-gen, dcyfr-ai-cli, dcyfr-ai-agents, pinned to a commit SHA. Takes the secret `CLAUDE_API_KEY`. |
| `docs-wiki-eval-reusable.yml` | `workflow_call`, docs gate | dcyfr-ai (`docs-wiki-eval.yml`), pinned to a commit SHA. Inputs `gate-ref` and `gate-version` are required and `gate-ref` must equal the SHA in the caller's `uses:`. |
| `docs-hygiene-reusable.yml` | `workflow_call`, runs `docs-hygiene/scan.mjs` against a caller repo | No external caller found. Input `gate-ref` is required. Optional `baseline`, `fail`, `remote`, `runs-on`. |
| `docs-hygiene-sweep.yml` | cron `17 14 * * 1` and `workflow_dispatch`; report-only | Runs here; scans every public, unarchived dcyfr-labs repo and writes findings to the job summary. `FAIL_ON_FINDINGS` is `'false'`. |
| `docs-hygiene-test.yml` | pull requests touching `docs-hygiene/**` or `.github/workflows/docs-hygiene-*.yml`, and pushes to `main` touching `docs-hygiene/**` | This repo's own check. |

## Contracts that break callers silently

- **Never add a permission to `dependabot-auto-merge.yml`.** It declares `contents: write` and `pull-requests: write`, exactly what its callers grant. A reusable workflow cannot request more than its caller grants, and the ceiling covers the whole file, so one extra permission makes every call fail with `startup_failure`: no check, no annotation, green-looking PRs. This happened to 20 of 20 repos for five days in 2026 (the header of the file records it). A step that needs another permission gets its own workflow file.
- **Sweep callers** must trigger on `schedule` or `workflow_dispatch`, never `pull_request`, and must grant `contents: write`, `pull-requests: write` and `actions: write`. After adding a caller, confirm its first run reached a step.
- **Inputs are an interface.** Renaming or removing an input, a secret or a default in a reusable workflow breaks callers at `@main` on their next run. Add new inputs with defaults.
- **Pinned callers do not move.** `security-review-reusable.yml` and `docs-wiki-eval-reusable.yml` are called by SHA, so a change here reaches them only after each caller bumps its pin. Third-party actions inside these files are pinned by SHA with a version comment; keep that.
- **`docs-wiki-eval-reusable.yml` has a source of truth elsewhere**: `docgen-gate/workflows/docs-wiki-eval-reusable.yml`. The copy under `.github/workflows/` is derived from it; change the source and keep the two identical.

## Commands

| Command | What it does |
|---|---|
| `node --test docs-hygiene/scan.test.mjs` | The scanner's unit tests (18 tests). Needs Node, no install. |
| `node docs-hygiene/scan.mjs --root . --fail` | Scan this repo's own docs; exits 1 on new findings. Expect `docs-hygiene: 0 new, 0 in baseline`. |
| `node docs-hygiene/scan.mjs --root ../other-repo [--remote]` | Report on another checkout. `--remote` adds GitHub lookups and needs a token in the environment. |
| `actionlint .github/workflows/*.yml` | Lint the workflows. Run before committing any workflow change; it is clean on `main`. |

There is no root `package.json`. `docgen-gate/` has its own (`private`, version 0.3.1, engines `^22.22.2 || ^24.15.0 || >=26.0.0`, pinned `jsdom`, `markdownlint-cli2`, `mermaid`); its `node_modules/` is gitignored.

## Testing a workflow change

1. `actionlint` and, for anything under `docs-hygiene/`, the two `node` commands above.
2. A reusable workflow only runs when something calls it. Push the change to a branch, then in one low-risk caller repo point `uses:` at that branch (or the branch's commit SHA) and run it with `workflow_dispatch` or a throwaway PR. Do not merge the caller change.
3. For the Dependabot workflows, use a repo with an open Dependabot PR you can afford to see merged, or one where the withhold path applies, and check the run reached a step.
4. Merge here only after the branch run is green. For `@main` callers the merge is the deploy.
5. For the SHA-pinned callers, the merge changes nothing until each caller bumps its pin; open those bumps as separate PRs in the caller repos.

## CI

`docs-hygiene-test.yml` is the only check that runs on pull requests here, and only when `docs-hygiene/**` or a `docs-hygiene-*.yml` workflow changes: it runs `node --test docs-hygiene/scan.test.mjs` and `node docs-hygiene/scan.mjs --root . --fail`. Workflow YAML is not linted in CI, so run `actionlint` yourself.

## Gotchas

- `docgen-gate/` is generated by a build in a private workspace. Its files other than `README.md`, `eval.mjs` and `workflows/docs-wiki-eval-reusable.yml` are vendored byte for byte and described by `MANIFEST.json` digests. Do not hand-edit them; a change belongs in the workspace and arrives as a rebuilt bundle.
- `docs-hygiene` skips any line containing `docs-hygiene-allow`; use it only with a reason on the same line.
- The org PR template and issue forms here are inherited by every repo that has none of its own. A repo's own `.github/` copy wins.
- Copyright and maintainer lines say "DCYFR Labs", never bare "DCYFR".

## Never

- Add a permission, required input or required secret to a workflow that has callers.
- Rename or delete a reusable workflow without first checking the callers (`gh search code` is incomplete; read each repo's workflow files).
- Commit secrets, tokens or `op://` references with real vault or item IDs.
- Hand-edit vendored files in `docgen-gate/`.
- Push to `main`.
