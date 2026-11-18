# DCYFR Labs

[![dcyfr.ai](https://img.shields.io/badge/dcyfr.ai-live-brightgreen?style=flat-square)](https://www.dcyfr.ai)
[![npm](https://img.shields.io/npm/v/@dcyfr/ai?style=flat-square&label=%40dcyfr%2Fai&color=blue)](https://www.npmjs.com/package/@dcyfr/ai)
[![Sponsor](https://img.shields.io/github/sponsors/dcyfr?style=flat-square&label=sponsors)](https://github.com/sponsors/dcyfr)

Security for agent systems, by someone who runs one. I'm Drew Gowan, and DCYFR
Labs is my lab and advisory practice. The open-source code here is the working
proof: an agent harness, the checks around it, and starter templates to build
on. Everything here is MIT-licensed unless a repository says otherwise.

I'm not taking paid engagements right now, and advice is pro bono.

## Start here

| Repository | What it does |
|---|---|
| [`cache-invariants`](https://github.com/dcyfr-labs/cache-invariants) | Finds the code that silently breaks LLM prompt caching, and audits real call logs to prove where a prefix changed |
| [`spend-gate`](https://github.com/dcyfr-labs/spend-gate) | Stops an autonomous agent's paid calls when spend crosses a threshold, and keeps them stopped through a Redis outage or restart (Apache-2.0) |
| [`aei-audit`](https://github.com/dcyfr-labs/aei-audit) | Audits Anthropic Economic Index automation shares task by task against O\*NET task statements |
| [`dcyfr-ai`](https://github.com/dcyfr-labs/dcyfr-ai) | Runs one TypeScript agent across providers, with plugins and cost telemetry built in (`npm i @dcyfr/ai`) |
| [`dcyfr-ai-cli`](https://github.com/dcyfr-labs/dcyfr-ai-cli) | Scaffolds projects and runs DCYFR AI workflows from one CLI (`npm i -g @dcyfr/ai-cli`) |
| [`dcyfr-ai-rag`](https://github.com/dcyfr-labs/dcyfr-ai-rag) | Builds retrieval-augmented generation pipelines in Node.js (`npm i @dcyfr/ai-rag`) |
| [`dcyfr-ai-code-gen`](https://github.com/dcyfr-labs/dcyfr-ai-code-gen) | Generates and scaffolds code with AST transforms and a template engine (`npm i @dcyfr/ai-code-gen`) |

## Starter templates

Clone one, or use GitHub's **Use this template** button.

| I want to build... | Template | Stack |
|---|---|---|
| Autonomous agents | [dcyfr-ai-agents](https://github.com/dcyfr-labs/dcyfr-ai-agents) | Node 20+, TypeScript, tool use, memory |
| A REST API | [dcyfr-ai-api](https://github.com/dcyfr-labs/dcyfr-ai-api) | Express 5, Drizzle ORM, JWT, OpenAPI |
| A GraphQL API | [dcyfr-ai-graphql](https://github.com/dcyfr-labs/dcyfr-ai-graphql) | Apollo Server 4, schema-first |
| A React SPA | [dcyfr-ai-react](https://github.com/dcyfr-labs/dcyfr-ai-react) | React 19, Vite, TanStack, Zustand, shadcn/ui |
| A chatbot | [dcyfr-ai-chatbot](https://github.com/dcyfr-labs/dcyfr-ai-chatbot) | Multi-turn conversations, streaming |
| A Node.js service | [dcyfr-ai-nodejs](https://github.com/dcyfr-labs/dcyfr-ai-nodejs) | Node 24+, strict TypeScript |

To try `@dcyfr/ai` without starting a project, use
[dcyfr-ai-sandbox](https://github.com/dcyfr-labs/dcyfr-ai-sandbox).

<details>
<summary>Archived (read-only, no longer maintained)</summary>

| Repository | Since | Notes |
|---|---|---|
| [dcyfr-ai-docker](https://github.com/dcyfr-labs/dcyfr-ai-docker) | Feb 2026 | Archived. A template collection, not a library; the npm package is deprecated |
| [dcyfr-ai-kubernetes](https://github.com/dcyfr-labs/dcyfr-ai-kubernetes) | Feb 2026 | Archived. See Helm, Pulumi or cdk8s |
| [dcyfr-ai-notebooks](https://github.com/dcyfr-labs/dcyfr-ai-notebooks) | Feb 2026 | Archived. See Jupyter, Observable or Hex |
| [dcyfr-ai-web](https://github.com/dcyfr-labs/dcyfr-ai-web) | Feb 2026 | Archived |

</details>

## Plugins

| Registry | Who reviews it |
|---|---|
| [dcyfr-plugins](https://github.com/dcyfr-labs/dcyfr-plugins) | Curated and security-scanned |
| [dcyfr-community-plugins](https://github.com/dcyfr-labs/dcyfr-community-plugins) | Scanned automatically, not manually audited |

## Sites

| Site | Repository | What's there |
|---|---|---|
| [dcyfr.ai](https://www.dcyfr.ai) | (private) | Blog, portfolio and reference architecture |
| [dcyfr.io](https://www.dcyfr.io) | [dcyfr-io](https://github.com/dcyfr-labs/dcyfr-io) | A map of every DCYFR site and tool |
| [dcyfr.app](https://www.dcyfr.app) | [dcyfr-app](https://github.com/dcyfr-labs/dcyfr-app) | Starter template showcase |
| [dcyfr.tech](https://www.dcyfr.tech) | [dcyfr-tech](https://github.com/dcyfr-labs/dcyfr-tech) | Research and technical deep dives |
| [dcyfr.codes](https://www.dcyfr.codes) | [dcyfr-codes](https://github.com/dcyfr-labs/dcyfr-codes) | Searchable code patterns and recipes |
| [dcyfr.bot](https://www.dcyfr.bot) | [dcyfr-bot](https://github.com/dcyfr-labs/dcyfr-bot) | Agent directory and chat |
| [dcyfr.build](https://www.dcyfr.build) | [dcyfr-build](https://github.com/dcyfr-labs/dcyfr-build) | Infrastructure templates and a cost estimator |
| [dcyfr.work](https://www.dcyfr.work) | [dcyfr-work](https://github.com/dcyfr-labs/dcyfr-work) | CLI docs, editor extensions and community links |

## In design

[atrium](https://github.com/dcyfr-labs/atrium) is a planned local-first control
plane for AI agents. It is at the design stage, with no code yet.

## Upstream

When a project I depend on is broken, the fix goes back to it. The pull
requests are listed on [my profile](https://github.com/dcyfr#upstream), in a
table rebuilt weekly from GitHub search.

## Sponsor

[GitHub Sponsors](https://github.com/sponsors/dcyfr) pays for the maintenance
of everything on this page and for the upstream fixes. Tiers start at $5 a
month. Sponsors are listed at [dcyfr.ai/sponsors](https://www.dcyfr.ai/sponsors).

## Contributing

Bug reports, fixes and docs improvements are welcome in any repository. Read
the [contributing guide](https://github.com/dcyfr-labs/.github/blob/main/CONTRIBUTING.md)
first; it applies to every repo that doesn't carry its own. For questions, see
[getting help](https://github.com/dcyfr-labs/.github/blob/main/SUPPORT.md).

Report security problems privately, never in a public issue: use a
repository's **Security** tab, or email **security@dcyfr.ai**. The
[security policy](https://github.com/dcyfr-labs/.github/blob/main/SECURITY.md)
has the details.

## Elsewhere

- [dcyfr.ai](https://www.dcyfr.ai)
- npm: [@dcyfr](https://www.npmjs.com/org/dcyfr)
- All repositories: [github.com/orgs/dcyfr-labs/repositories](https://github.com/orgs/dcyfr-labs/repositories)
