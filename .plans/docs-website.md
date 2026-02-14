# Plan: Documentation Website

## Executive Summary

Create a documentation website for `@f0rbit/runbook` using Astro + Starlight + @astrojs/solid-js + @f0rbit/ui, deployed via GitHub Actions to GitHub Pages. Content is restructured from existing README.md, USECASE.md, and AGENTS.md. Auto-generated LLM-friendly `.txt` files provide machine-readable documentation.

The `docs/` directory lives at the monorepo root but is **not** a workspace package (matches @f0rbit/ui convention). No changes to existing packages.

## Architecture

```
runbook/
├── docs/                          # NOT a workspace package
│   ├── package.json               # @f0rbit/runbook-docs
│   ├── astro.config.mjs
│   ├── tsconfig.json
│   ├── scripts/
│   │   └── generate-llm-docs.js   # Pre-build LLM doc generator
│   ├── public/                    # Static assets (llms.txt written here by script)
│   ├── src/
│   │   ├── components/
│   │   │   ├── ThemeSelect.astro  # Override: uses @f0rbit/ui theme
│   │   │   ├── PageTitle.astro    # Override: custom styling
│   │   │   ├── SiteTitle.astro    # Override: custom branding
│   │   │   └── Footer.astro       # Override: custom footer
│   │   ├── styles/
│   │   │   └── custom.css         # @import "@f0rbit/ui/styles/starlight"
│   │   └── content/
│   │       └── docs/
│   │           ├── index.mdx                    # Introduction
│   │           ├── getting-started/
│   │           │   ├── installation.mdx
│   │           │   └── quick-start.mdx
│   │           ├── concepts/
│   │           │   ├── steps.mdx
│   │           │   ├── workflows.mdx
│   │           │   ├── providers.mdx
│   │           │   ├── traces.mdx
│   │           │   └── configuration.mdx
│   │           ├── packages/
│   │           │   ├── core.mdx
│   │           │   ├── server.mdx
│   │           │   ├── cli.mdx
│   │           │   └── git-store.mdx
│   │           ├── guides/
│   │           │   ├── testing.mdx
│   │           │   ├── agent-steps.mdx
│   │           │   ├── git-artifact-store.mdx
│   │           │   └── config-files.mdx
│   │           ├── use-cases/
│   │           │   ├── overview.mdx
│   │           │   └── comparisons.mdx
│   │           └── resources/
│   │               ├── llms.mdx
│   │               └── architecture.mdx
│   └── dist/                      # Build output (gitignored)
├── .github/
│   └── workflows/
│       └── docs.yml               # GitHub Pages deployment
└── ... (existing packages/)
```

## Sidebar Structure

```js
sidebar: [
  {
    label: "Getting Started",
    items: [
      { label: "Introduction", slug: "" },       // index.mdx
      { label: "Installation", slug: "getting-started/installation" },
      { label: "Quick Start", slug: "getting-started/quick-start" },
    ],
  },
  {
    label: "Concepts",
    items: [
      { label: "Steps", slug: "concepts/steps" },
      { label: "Workflows", slug: "concepts/workflows" },
      { label: "Providers", slug: "concepts/providers" },
      { label: "Traces & Events", slug: "concepts/traces" },
      { label: "Configuration", slug: "concepts/configuration" },
    ],
  },
  {
    label: "Packages",
    items: [
      { label: "Core SDK", slug: "packages/core" },
      { label: "Server", slug: "packages/server" },
      { label: "CLI", slug: "packages/cli" },
      { label: "Git Store", slug: "packages/git-store" },
    ],
  },
  {
    label: "Guides",
    items: [
      { label: "Testing Workflows", slug: "guides/testing" },
      { label: "Agent Steps", slug: "guides/agent-steps" },
      { label: "Git Artifact Store", slug: "guides/git-artifact-store" },
      { label: "Writing Config Files", slug: "guides/config-files" },
    ],
  },
  {
    label: "Use Cases",
    items: [
      { label: "Overview", slug: "use-cases/overview" },
      { label: "Comparisons", slug: "use-cases/comparisons" },
    ],
  },
  {
    label: "Resources",
    items: [
      { label: "Architecture", slug: "resources/architecture" },
      { label: "LLM Documentation", slug: "resources/llms" },
    ],
  },
],
```

## Content Mapping

Source material → docs pages:

| Source | Target Page(s) |
|--------|----------------|
| README.md §What is this | `index.mdx` — hero + overview |
| README.md §Quick Start | `getting-started/quick-start.mdx` |
| README.md §Packages table | `getting-started/installation.mdx` + each `packages/*.mdx` |
| README.md §Step Types | `concepts/steps.mdx` |
| README.md §Workflow Composition | `concepts/workflows.mdx` |
| README.md §Testing | `guides/testing.mdx` |
| README.md §CLI | `packages/cli.mdx` |
| README.md §Git Artifact Store | `guides/git-artifact-store.mdx` |
| README.md §Configuration | `concepts/configuration.mdx` + `guides/config-files.mdx` |
| README.md §Architecture | `resources/architecture.mdx` |
| README.md §Development | `getting-started/installation.mdx` (development section) |
| USECASE.md §1 Problem | `use-cases/overview.mdx` |
| USECASE.md §2 Solution | `index.mdx` (key differentiators) + `use-cases/overview.mdx` |
| USECASE.md §3 Use Cases | `use-cases/overview.mdx` |
| USECASE.md §4 Who Is This For | `use-cases/overview.mdx` |
| USECASE.md §5 Why Not X | `use-cases/comparisons.mdx` |
| USECASE.md §6-7 Architecture + Status | `resources/architecture.mdx` |
| AGENTS.md §Provider Wiring | `concepts/providers.mdx` |
| AGENTS.md §Engine Features | `guides/agent-steps.mdx` |
| Core exports | `packages/core.mdx` |
| Server exports | `packages/server.mdx` |
| Git-store exports | `packages/git-store.mdx` |

## Phases

---

### Phase 1: Scaffold (sequential)

Create the docs/ directory structure, install dependencies, configure Astro + Starlight, add the @f0rbit/ui theme bridge, create all component overrides, and add a single placeholder index page. Verify: `bun install && bun run build` succeeds in `docs/`.

**No parallel tasks — all files are interdependent for the build to work.**

#### Task 1.1: Create `docs/package.json`

- **Files**: `docs/package.json`
- **LOC**: ~20
- **Dependencies**: none
- **Details**:
  ```json
  {
    "name": "@f0rbit/runbook-docs",
    "type": "module",
    "version": "0.0.1",
    "scripts": {
      "dev": "astro dev",
      "build": "node scripts/generate-llm-docs.js && astro build",
      "preview": "astro preview"
    },
    "dependencies": {
      "@astrojs/starlight": "^0.37.0",
      "astro": "^5.1.0",
      "@astrojs/solid-js": "^5.0.0",
      "solid-js": "^1.9.0",
      "@f0rbit/ui": "latest"
    }
  }
  ```

#### Task 1.2: Create `docs/astro.config.mjs`

- **Files**: `docs/astro.config.mjs`
- **LOC**: ~60
- **Dependencies**: 1.1
- **Details**: Full Astro config with Starlight, solidJs integration, site/base config, component overrides, social links, and complete sidebar structure (all entries pointing at pages that will be created in Phase 2 — Starlight handles missing pages gracefully during scaffold).

#### Task 1.3: Create `docs/tsconfig.json`

- **Files**: `docs/tsconfig.json`
- **LOC**: ~5
- **Details**: Extends `astro/tsconfigs/strict`. Standard Astro project tsconfig.

#### Task 1.4: Create `docs/src/styles/custom.css`

- **Files**: `docs/src/styles/custom.css`
- **LOC**: ~5
- **Details**:
  ```css
  @import "@f0rbit/ui/styles/starlight";
  ```
  Plus any minor overrides if needed.

#### Task 1.5: Create component overrides

- **Files**: `docs/src/components/ThemeSelect.astro`, `PageTitle.astro`, `SiteTitle.astro`, `Footer.astro`
- **LOC**: ~80 total (~20 each)
- **Dependencies**: 1.4 (uses custom styles)
- **Details**: Minimal Astro component overrides following @f0rbit/ui patterns. ThemeSelect bridges @f0rbit/ui theme toggling with Starlight. SiteTitle shows `@f0rbit/runbook`. Footer shows version/links. PageTitle is a thin wrapper.

#### Task 1.6: Create placeholder `docs/src/content/docs/index.mdx`

- **Files**: `docs/src/content/docs/index.mdx`
- **LOC**: ~20
- **Dependencies**: 1.2 (sidebar references this)
- **Details**: Minimal frontmatter + hero content. Just enough to verify the build works.

#### Task 1.7: Create stub `docs/scripts/generate-llm-docs.js`

- **Files**: `docs/scripts/generate-llm-docs.js`
- **LOC**: ~15
- **Dependencies**: none
- **Details**: Stub script that writes empty `docs/public/llms.txt` and `docs/public/llms-full.txt` so the build command (`node scripts/generate-llm-docs.js && astro build`) doesn't fail. Real implementation in Phase 3.

#### Task 1.8: Update `.gitignore`

- **Files**: `.gitignore`
- **LOC**: ~3 (append)
- **Dependencies**: none
- **Details**: Add `docs/dist/`, `docs/.astro/`, `docs/node_modules/` (though `node_modules/` already covers the last one).

**Phase 1 Verification**: Run `bun install && bun run build` in `docs/`. Astro must produce `docs/dist/` with a valid index.html.

**Estimated total**: ~210 LOC

---

### Phase 2: Content Pages (parallel)

Convert README.md, USECASE.md, and AGENTS.md content into proper MDX docs pages. All pages are independent `.mdx` files that don't import from each other, so they can be written in parallel.

**Parallel group A** — Getting Started:

#### Task 2.1: `docs/src/content/docs/getting-started/installation.mdx`
- **LOC**: ~60
- **Content**: Install commands for each package, peer deps (zod, @f0rbit/corpus), dev setup (clone, install, typecheck, test, lint). Source: README §Packages + §Development.

#### Task 2.2: `docs/src/content/docs/getting-started/quick-start.mdx`
- **LOC**: ~100
- **Content**: Full quick-start walkthrough: install, define step, define workflow, create engine, run. Source: README §Quick Start. Expand with explanation of each part.

**Parallel group B** — Concepts:

#### Task 2.3: `docs/src/content/docs/concepts/steps.mdx`
- **LOC**: ~150
- **Content**: fn(), shell(), agent(), checkpoint() — full API for each with code examples and explanations. Source: README §Step Types. Expand with parameter tables.

#### Task 2.4: `docs/src/content/docs/concepts/workflows.mdx`
- **LOC**: ~120
- **Content**: defineWorkflow(), pipe(), parallel(), asStep(), done(). Source: README §Workflow Composition. Add mapper function typing explanation.

#### Task 2.5: `docs/src/content/docs/concepts/providers.mdx`
- **LOC**: ~100
- **Content**: ShellProvider, AgentExecutor, CheckpointProvider interfaces. Provider pattern explanation. In-memory vs real providers. Source: AGENTS.md §Provider Wiring + README §Architecture.

#### Task 2.6: `docs/src/content/docs/concepts/traces.mdx`
- **LOC**: ~80
- **Content**: TraceEvent types, TraceCollector, event stream structure. Source: AGENTS.md §Testing + core exports (TraceEventSchema, TraceSchema).

#### Task 2.7: `docs/src/content/docs/concepts/configuration.mdx`
- **LOC**: ~90
- **Content**: defineConfig(), RunbookConfigSchema fields, config discovery priority, server config, provider config, artifacts config. Source: README §Configuration + AGENTS.md §Config Discovery.

**Parallel group C** — Packages:

#### Task 2.8: `docs/src/content/docs/packages/core.mdx`
- **LOC**: ~120
- **Content**: Full export table (schemas, step builders, types, TraceCollector, errors). Subpath exports (. and ./test). Source: core/src/index.ts exports.

#### Task 2.9: `docs/src/content/docs/packages/server.mdx`
- **LOC**: ~100
- **Content**: createEngine, createServer, providers (BunShellProvider, OpenCodeExecutor, createServerCheckpointProvider), resolveProviders, state store. Source: server/src/index.ts exports.

#### Task 2.10: `docs/src/content/docs/packages/cli.mdx`
- **LOC**: ~100
- **Content**: All 11 commands with usage, flags, examples. Source: README §CLI + cli/src/index.ts command list.

#### Task 2.11: `docs/src/content/docs/packages/git-store.mdx`
- **LOC**: ~80
- **Content**: createGitArtifactStore, types (GitArtifactStore, StorableRun, StoredRun, etc.), ref structure. Source: git-store/src/index.ts + README §Git Artifact Store.

**Parallel group D** — Guides:

#### Task 2.12: `docs/src/content/docs/guides/testing.mdx`
- **LOC**: ~120
- **Content**: InMemoryShellProvider, InMemoryAgentExecutor, InMemoryCheckpointProvider usage. Full test example. `.on()` matcher pattern. Source: README §Testing + AGENTS.md §Testing.

#### Task 2.13: `docs/src/content/docs/guides/agent-steps.mdx`
- **LOC**: ~120
- **Content**: Analyze vs build mode deep dive. system_prompt_file, agent_type, AgentExecutor interface. Source: AGENTS.md §Engine Features + README §agent() step.

#### Task 2.14: `docs/src/content/docs/guides/git-artifact-store.mdx`
- **LOC**: ~100
- **Content**: How runs are stored, ref structure, metadata.json/trace.json/steps/ layout, push/pull workflow. Source: README §Git Artifact Store + USECASE.md §Solution.

#### Task 2.15: `docs/src/content/docs/guides/config-files.mdx`
- **LOC**: ~100
- **Content**: Full config file walkthrough, defineConfig fields, workflow definitions in config, global fallback config. Source: README §Configuration + AGENTS.md §Config Discovery + §Workflow Definitions.

**Parallel group E** — Use Cases + Resources:

#### Task 2.16: `docs/src/content/docs/use-cases/overview.mdx`
- **LOC**: ~150
- **Content**: Problem statement, solution overview, 5 use cases with code snippets, target audience. Source: USECASE.md §1-4.

#### Task 2.17: `docs/src/content/docs/use-cases/comparisons.mdx`
- **LOC**: ~80
- **Content**: vs LangChain, vs Temporal/Inngest, vs GitHub Actions, vs raw scripting, vs custom orchestrators. Source: USECASE.md §5.

#### Task 2.18: `docs/src/content/docs/resources/architecture.mdx`
- **LOC**: ~80
- **Content**: Architecture diagram, client/server split, engine dispatch, provider wiring, state management. Source: README §Architecture + USECASE.md §6-7.

#### Task 2.19: Update `docs/src/content/docs/index.mdx` (full version)
- **LOC**: ~80 (replace placeholder from Phase 1)
- **Content**: Hero section with tagline, key features grid (type safety, agent steps, testing, traces, git store), links to getting started.

**Phase 2 Verification**: Run `bun run build` in `docs/`. All pages must build without errors. Spot-check `dist/` for correct HTML output.

**Estimated total**: ~1,830 LOC across 19 MDX files

**Parallelization**: Tasks 2.1–2.19 can ALL run in parallel (no shared files). Group into 4-5 parallel coder agents:
- Agent A: Tasks 2.1, 2.2, 2.19 (Getting Started + index)
- Agent B: Tasks 2.3, 2.4, 2.5, 2.6, 2.7 (Concepts)
- Agent C: Tasks 2.8, 2.9, 2.10, 2.11 (Packages)
- Agent D: Tasks 2.12, 2.13, 2.14, 2.15 (Guides)
- Agent E: Tasks 2.16, 2.17, 2.18 (Use Cases + Resources)

---

### Phase 3: LLM Docs Generation (sequential)

Implement the `generate-llm-docs.js` script and the `resources/llms.mdx` page.

#### Task 3.1: Implement `docs/scripts/generate-llm-docs.js`

- **Files**: `docs/scripts/generate-llm-docs.js`
- **LOC**: ~200
- **Dependencies**: Phase 2 content exists (script reads MDX files)
- **Details**:
  The script reads source files and generates two output files:

  **`docs/public/llms.txt`** (concise):
  ```
  # @f0rbit/runbook

  > Typed workflow engine for orchestrating AI agents, shell commands, and human checkpoints.

  ## Installation
  bun add @f0rbit/runbook @f0rbit/runbook-server zod @f0rbit/corpus

  ## Core Concepts
  - 4 step types: fn(), shell(), agent(), checkpoint()
  - Workflows: pipe(), parallel(), asStep()
  - Providers: ShellProvider, AgentExecutor, CheckpointProvider
  - Type-safe: Zod schemas at every boundary

  ## Packages
  - @f0rbit/runbook — Core SDK (step builders, workflow builder, types)
  - @f0rbit/runbook-server — Hono HTTP server (engine, providers, routes)
  - @f0rbit/runbook-cli — CLI client (11 commands)
  - @f0rbit/runbook-git-store — Git-based artifact store

  ## CLI Commands
  serve, run, status, trace, list, history, show, diff, push, cancel, pull

  ## Links
  - Docs: https://f0rbit.github.io/runbook
  - Full LLM docs: https://f0rbit.github.io/runbook/llms-full.txt
  - GitHub: https://github.com/f0rbit/runbook
  ```

  **`docs/public/llms-full.txt`** (comprehensive):
  Aggregates:
  - Full README.md content
  - Full USECASE.md content
  - Per-package API exports with descriptions
  - CLI command reference (from cli/src/index.ts help text)
  - All MDX page content (stripped of frontmatter)
  - Configuration reference

  **Implementation approach**:
  - Read README.md, USECASE.md from repo root (using `../README.md` relative paths)
  - Read MDX files from `src/content/docs/` — strip YAML frontmatter, extract markdown
  - Read package export files from `../packages/*/src/index.ts`
  - Concatenate into structured plain text
  - Write to `public/llms.txt` and `public/llms-full.txt`
  - Script is plain Node.js/Bun — uses `fs` and `path`, no external deps

#### Task 3.2: Create `docs/src/content/docs/resources/llms.mdx`

- **Files**: `docs/src/content/docs/resources/llms.mdx`
- **LOC**: ~40
- **Dependencies**: none (can parallel with 3.1)
- **Details**: Page explaining LLM-friendly docs, linking to `/runbook/llms.txt` and `/runbook/llms-full.txt`. Follows llms.txt standard.

**Phase 3 Verification**: Run `bun run build` in `docs/`. Verify `dist/llms.txt` and `dist/llms-full.txt` exist and contain expected content.

**Estimated total**: ~240 LOC

---

### Phase 4: GitHub Actions (sequential)

#### Task 4.1: Create `.github/workflows/docs.yml`

- **Files**: `.github/workflows/docs.yml`
- **LOC**: ~45
- **Dependencies**: none
- **Details**:
  ```yaml
  name: Deploy Docs to GitHub Pages
  on:
    push:
      branches: [main]
    workflow_dispatch:
  permissions:
    contents: read
    pages: write
    id-token: write
  concurrency:
    group: "pages"
    cancel-in-progress: false
  jobs:
    build:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: oven-sh/setup-bun@v2
          with:
            bun-version: latest
        - run: bun install
        - run: bun install
          working-directory: docs
        - run: bun run build
          working-directory: docs
        - uses: actions/upload-pages-artifact@v3
          with:
            path: docs/dist
    deploy:
      environment:
        name: github-pages
        url: ${{ steps.deployment.outputs.page_url }}
      runs-on: ubuntu-latest
      needs: build
      steps:
        - id: deployment
          uses: actions/deploy-pages@v4
  ```

**Phase 4 Verification**: Validate YAML syntax. No build step needed — this is infrastructure config.

**Estimated total**: ~45 LOC

---

### Phase 5: Polish (sequential)

Final adjustments after all content is in place.

#### Task 5.1: Review and fix cross-links between pages

- **Files**: Multiple MDX files
- **LOC**: ~30 (edits across files)
- **Dependencies**: Phase 2 + 3
- **Details**: Ensure all internal links between docs pages use correct slugs with `/runbook/` base prefix. Starlight handles this with relative links, but verify.

#### Task 5.2: Add `docs/public/favicon.svg` (optional)

- **Files**: `docs/public/favicon.svg`
- **LOC**: ~5
- **Details**: Simple SVG favicon. Can use a generic one or skip.

**Phase 5 Verification**: Full `bun run build` in `docs/`. Manual review of `dist/` output.

**Estimated total**: ~35 LOC

---

## Phase Summary

| Phase | Tasks | Total LOC | Parallel Agents | Verification |
|-------|-------|-----------|-----------------|--------------|
| 1. Scaffold | 1.1–1.8 | ~210 | 1 (sequential) | `bun install && bun run build` in docs/ |
| 2. Content | 2.1–2.19 | ~1,830 | 5 parallel | `bun run build` in docs/ |
| 3. LLM Docs | 3.1–3.2 | ~240 | 1 (sequential) | `bun run build`, check dist/llms*.txt |
| 4. GitHub Actions | 4.1 | ~45 | 1 | YAML validation |
| 5. Polish | 5.1–5.2 | ~35 | 1 | Full build |
| **Total** | | **~2,360** | | |

## File Ownership (Parallel Safety)

Phase 2 parallelization — no file conflicts:
- Agent A: `index.mdx`, `getting-started/installation.mdx`, `getting-started/quick-start.mdx`
- Agent B: `concepts/steps.mdx`, `concepts/workflows.mdx`, `concepts/providers.mdx`, `concepts/traces.mdx`, `concepts/configuration.mdx`
- Agent C: `packages/core.mdx`, `packages/server.mdx`, `packages/cli.mdx`, `packages/git-store.mdx`
- Agent D: `guides/testing.mdx`, `guides/agent-steps.mdx`, `guides/git-artifact-store.mdx`, `guides/config-files.mdx`
- Agent E: `use-cases/overview.mdx`, `use-cases/comparisons.mdx`, `resources/architecture.mdx`

No two agents touch the same file. `astro.config.mjs` is only modified in Phase 1 (scaffold).

## Decisions

No `DECISION NEEDED` items — the user has specified the tech stack, sidebar structure, deployment target, and reference implementation. All decisions are determined.

## Constraints Checklist

- [x] `docs/` is NOT a workspace package (not in `packages/*`)
- [x] Bun as runtime
- [x] @f0rbit/ui from npm (not workspace link)
- [x] LLM docs generation as pre-build step
- [x] Astro component overrides in `docs/src/components/`
- [x] Content as .mdx in `docs/src/content/docs/`
- [x] `.gitignore` updated for `docs/dist/` and `docs/.astro/`

## Suggested AGENTS.md Updates

After implementation, add:

```markdown
## Documentation Site
- `docs/` directory at monorepo root — NOT a workspace package
- Astro + Starlight + @astrojs/solid-js + @f0rbit/ui
- `bun run build` in docs/ runs LLM doc generation then Astro build
- GitHub Pages deployment via `.github/workflows/docs.yml` on push to main
- LLM docs: `docs/public/llms.txt` (concise) and `docs/public/llms-full.txt` (comprehensive)
- Custom theme via `@import "@f0rbit/ui/styles/starlight"` in custom.css
- Component overrides: ThemeSelect, PageTitle, SiteTitle, Footer in `docs/src/components/`
```
