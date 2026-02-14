# Implementation Plan

## Phase 1: Phase 1: Scaffold

- **1.1**: Create docs/package.json with @astrojs/starlight, astro, @astrojs/solid-js, solid-js, @f0rbit/ui dependencies. Scripts: dev (astro dev), build (node scripts/generate-llm-docs.js && astro build), preview (astro preview). Name: @f0rbit/runbook-docs, type: module.
  - Files: docs/package.json
  - Parallel safe: no
- **1.2**: Create docs/astro.config.mjs with Starlight config: site https://f0rbit.github.io, base /runbook, solidJs() integration, customCss pointing to ./src/styles/custom.css, component overrides (ThemeSelect, PageTitle, SiteTitle, Footer), social link to GitHub repo, and full sidebar structure with all 6 sections (Getting Started, Concepts, Packages, Guides, Use Cases, Resources) and 19 page entries.
  - Files: docs/astro.config.mjs
  - Parallel safe: no
- **1.3**: Create docs/tsconfig.json extending astro/tsconfigs/strict.
  - Files: docs/tsconfig.json
  - Parallel safe: no
- **1.4**: Create docs/src/styles/custom.css with @import '@f0rbit/ui/styles/starlight' to bridge @f0rbit/ui design tokens (--bg, --fg, --accent, --border) to Starlight's --sl-color-* variables. Add minor overrides if needed.
  - Files: docs/src/styles/custom.css
  - Parallel safe: no
- **1.5**: Create 4 Astro component overrides adapted from @f0rbit/ui docs patterns: ThemeSelect.astro (bridges @f0rbit/ui theme with Starlight's StarlightThemeProvider via starlight-theme-select custom element), PageTitle.astro (thin wrapper with splash template check), SiteTitle.astro (runbook branding with logo SVG), Footer.astro (pagination, edit link, last updated, custom footer with @f0rbit/runbook brand, MIT license, and nav links to GitHub/Docs/Getting Started).
  - Files: docs/src/components/ThemeSelect.astro, docs/src/components/PageTitle.astro, docs/src/components/SiteTitle.astro, docs/src/components/Footer.astro
  - Parallel safe: no
- **1.6**: Create placeholder docs/src/content/docs/index.mdx with minimal frontmatter (title, description, template: splash) and basic hero content. Just enough to verify the build works.
  - Files: docs/src/content/docs/index.mdx
  - Parallel safe: no
- **1.7**: Create stub docs/scripts/generate-llm-docs.js that writes empty docs/public/llms.txt and docs/public/llms-full.txt so the build command doesn't fail. Real implementation in Phase 3.
  - Files: docs/scripts/generate-llm-docs.js
  - Parallel safe: no
- **1.8**: Append docs/.astro/ to .gitignore (docs/dist/ and docs/node_modules/ are already covered by existing dist/ and node_modules/ entries).
  - Files: .gitignore
  - Parallel safe: no

## Phase 2: Phase 2: Content Pages

- **2.1**: Create getting-started/installation.mdx: Install commands for each package (bun add @f0rbit/runbook, @f0rbit/runbook-server, @f0rbit/runbook-cli, @f0rbit/runbook-git-store), peer deps (zod, @f0rbit/corpus), dev setup (clone, bun install, typecheck, test, lint). Source: README §Packages + §Development.
  - Files: docs/src/content/docs/getting-started/installation.mdx
  - Parallel safe: yes
- **2.2**: Create getting-started/quick-start.mdx: Full walkthrough — install, define agent step with Zod schemas, define workflow with pipe(), create engine, run workflow, inspect result. Expand README §Quick Start with explanation of each part.
  - Files: docs/src/content/docs/getting-started/quick-start.mdx
  - Parallel safe: yes
- **2.3**: Create concepts/steps.mdx: fn(), shell(), agent(), checkpoint() — full API for each with code examples, parameter tables, and explanations. Source: README §Step Types.
  - Files: docs/src/content/docs/concepts/steps.mdx
  - Parallel safe: yes
- **2.4**: Create concepts/workflows.mdx: defineWorkflow(), pipe(), parallel(), asStep(), done(). Mapper function typing (wf_input, previous_step_output). Source: README §Workflow Composition.
  - Files: docs/src/content/docs/concepts/workflows.mdx
  - Parallel safe: yes
- **2.5**: Create concepts/providers.mdx: ShellProvider, AgentExecutor, CheckpointProvider interfaces. Provider pattern explanation. In-memory vs real providers. resolveProviders(). Source: AGENTS.md §Provider Wiring + README §Architecture.
  - Files: docs/src/content/docs/concepts/providers.mdx
  - Parallel safe: yes
- **2.6**: Create concepts/traces.mdx: TraceEvent types (TraceEventSchema), TraceCollector, Trace type, event stream structure. Source: core exports.
  - Files: docs/src/content/docs/concepts/traces.mdx
  - Parallel safe: yes
- **2.7**: Create concepts/configuration.mdx: defineConfig(), RunbookConfigSchema fields, config discovery priority (--config → walk up → global fallback), server config, provider config, artifacts config. Source: README §Configuration + AGENTS.md §Config Discovery.
  - Files: docs/src/content/docs/concepts/configuration.mdx
  - Parallel safe: yes
- **2.8**: Create packages/core.mdx: Full export table — schemas (RunbookConfigSchema, TraceEventSchema, etc.), step builders (fn, shell, agent, checkpoint), types (42 type exports), TraceCollector, errors. Subpath exports (. and ./test). Source: packages/core/src/index.ts.
  - Files: docs/src/content/docs/packages/core.mdx
  - Parallel safe: yes
- **2.9**: Create packages/server.mdx: createEngine, createServer, providers (BunShellProvider, OpenCodeExecutor, createServerCheckpointProvider), resolveProviders, verifyProviders, state store (createInMemoryStateStore). Source: packages/server/src/index.ts.
  - Files: docs/src/content/docs/packages/server.mdx
  - Parallel safe: yes
- **2.10**: Create packages/cli.mdx: All 11 commands (serve, run, status, trace, list, history, show, diff, push, cancel, pull) with usage, flags, examples. Source: README §CLI + cli/src/index.ts help text.
  - Files: docs/src/content/docs/packages/cli.mdx
  - Parallel safe: yes
- **2.11**: Create packages/git-store.mdx: createGitArtifactStore function, types (GitArtifactStore, StorableRun, StoredRun, StoredRunInfo, StepArtifacts, StoreOpts, ListOpts, SyncOpts, SyncResult, GitStoreError), ref structure (refs/runbook/runs/), metadata layout. Source: packages/git-store/src/index.ts + README §Git Artifact Store.
  - Files: docs/src/content/docs/packages/git-store.mdx
  - Parallel safe: yes
- **2.12**: Create guides/testing.mdx: InMemoryShellProvider, InMemoryAgentExecutor, InMemoryCheckpointProvider usage. Full test example with .on() matcher pattern. @f0rbit/runbook/test subpath export. Source: README §Testing + AGENTS.md §Testing.
  - Files: docs/src/content/docs/guides/testing.mdx
  - Parallel safe: yes
- **2.13**: Create guides/agent-steps.mdx: Analyze vs build mode deep dive. system_prompt_file (absolute/relative path resolution), agent_type (freeform string), AgentExecutor interface, session lifecycle. Source: AGENTS.md §Engine Features + README §agent() step.
  - Files: docs/src/content/docs/guides/agent-steps.mdx
  - Parallel safe: yes
- **2.14**: Create guides/git-artifact-store.mdx: How runs are stored under refs/runbook/runs/<run-id>, metadata.json/trace.json/steps/ layout, push/pull workflow, invisible to git log. Source: README §Git Artifact Store + USECASE.md §Solution.
  - Files: docs/src/content/docs/guides/git-artifact-store.mdx
  - Parallel safe: yes
- **2.15**: Create guides/config-files.mdx: Full config file walkthrough, defineConfig fields, workflow definitions in config, global fallback config at ~/.config/runbook/runbook.config.ts, working_directory propagation. Source: README §Configuration + AGENTS.md §Config Discovery + §Workflow Definitions.
  - Files: docs/src/content/docs/guides/config-files.mdx
  - Parallel safe: yes
- **2.16**: Create use-cases/overview.mdx: Problem statement (5 problems from USECASE.md §1), solution overview with key differentiators, 5 use cases with code snippets, target audience (Who Is This For). Source: USECASE.md §1-4.
  - Files: docs/src/content/docs/use-cases/overview.mdx
  - Parallel safe: yes
- **2.17**: Create use-cases/comparisons.mdx: vs LangChain/LangGraph, vs Temporal/Inngest, vs GitHub Actions, vs raw scripting, vs custom orchestrators. Source: USECASE.md §5.
  - Files: docs/src/content/docs/use-cases/comparisons.mdx
  - Parallel safe: yes
- **2.18**: Create resources/architecture.mdx: Architecture diagram (client/server split), engine dispatch flow, provider wiring, state management (in-memory v0.1), trace system, agent executor dispatch. Source: README §Architecture + USECASE.md §6-7.
  - Files: docs/src/content/docs/resources/architecture.mdx
  - Parallel safe: yes
- **2.19**: Replace placeholder index.mdx with full version: Hero section with tagline ('Typed workflow engine for orchestrating AI agents, shell commands, and human checkpoints'), key features grid (type safety, agent steps, testing, traces, git store, composability), links to getting started + quick start.
  - Files: docs/src/content/docs/index.mdx
  - Parallel safe: yes

## Phase 3: Phase 3: LLM Docs Generation

- **3.1**: Implement docs/scripts/generate-llm-docs.js (replace stub from Phase 1). Reads: README.md + USECASE.md from repo root (../README.md), all MDX files from src/content/docs/ (strip YAML frontmatter), package export files from ../packages/*/src/index.ts. Produces two files: (1) docs/public/llms.txt — concise overview with installation, core concepts, 4 packages, 11 CLI commands, links to full docs and GitHub. (2) docs/public/llms-full.txt — comprehensive version aggregating full README, full USECASE, per-package API exports with descriptions, CLI command reference, all MDX content stripped of frontmatter, and configuration reference. Uses only Node.js builtins (fs, path). Pattern adapted from @f0rbit/ui scripts/generate-llm-docs.js but reads markdown/exports instead of component sources.
  - Files: docs/scripts/generate-llm-docs.js
  - Parallel safe: no
- **3.2**: Create resources/llms.mdx page explaining LLM-friendly docs, linking to /runbook/llms.txt and /runbook/llms-full.txt, with usage instructions for AI assistants. Follows the pattern from @f0rbit/ui docs llms.mdx page.
  - Files: docs/src/content/docs/resources/llms.mdx
  - Parallel safe: yes

## Phase 4: Phase 4: GitHub Actions

- **4.1**: Create .github/workflows/docs.yml for GitHub Pages deployment. Triggers: push to main + workflow_dispatch. Permissions: contents:read, pages:write, id-token:write. Jobs: (1) build — checkout, setup-bun, bun install (root), bun install (docs/), bun run build (docs/), upload-pages-artifact from docs/dist. (2) deploy — deploy-pages. Note: no 'Build library' step needed since runbook has no build step (Bun runs .ts directly). Pattern from @f0rbit/ui .github/workflows/docs.yml with that step removed.
  - Files: .github/workflows/docs.yml
  - Parallel safe: no

## Phase 5: Phase 5: Polish

- **5.1**: Review and fix cross-links between all MDX pages. Ensure internal links use correct slugs. Starlight handles relative links with the /runbook/ base prefix, but verify all inter-page references are correct (e.g., concepts/steps.mdx linking to packages/core.mdx, guides/testing.mdx linking to concepts/providers.mdx, etc.).
  - Files: docs/src/content/docs/index.mdx, docs/src/content/docs/getting-started/installation.mdx, docs/src/content/docs/getting-started/quick-start.mdx, docs/src/content/docs/concepts/steps.mdx, docs/src/content/docs/concepts/workflows.mdx, docs/src/content/docs/concepts/providers.mdx, docs/src/content/docs/concepts/traces.mdx, docs/src/content/docs/concepts/configuration.mdx, docs/src/content/docs/packages/core.mdx, docs/src/content/docs/packages/server.mdx, docs/src/content/docs/packages/cli.mdx, docs/src/content/docs/packages/git-store.mdx, docs/src/content/docs/guides/testing.mdx, docs/src/content/docs/guides/agent-steps.mdx, docs/src/content/docs/guides/git-artifact-store.mdx, docs/src/content/docs/guides/config-files.mdx, docs/src/content/docs/use-cases/overview.mdx, docs/src/content/docs/use-cases/comparisons.mdx, docs/src/content/docs/resources/architecture.mdx, docs/src/content/docs/resources/llms.mdx
  - Parallel safe: no
- **5.2**: Add docs/public/favicon.svg — simple SVG favicon for the runbook docs site. Can be a minimal icon representing workflows/pipelines.
  - Files: docs/public/favicon.svg
  - Parallel safe: yes
