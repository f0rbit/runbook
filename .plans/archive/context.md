# @f0rbit/runbook — Session Context

This file captures all decisions, context, and rationale from the initial planning session. Read this first, then `.plans/runbook.md` for the full technical plan.

---

## What Is This Project?

**@f0rbit/runbook** is a typed workflow engine for AI-assisted development. It makes `workflow.md`-style dev processes executable: define multi-step pipelines where AI coding agents (like OpenCode) are first-class, typed steps alongside shell commands and pure functions.

**One-line pitch:** CI/CD for AI-assisted development — typed, testable, observable, with a full audit trail stored in git.

## Why This Project?

Selected from ~25 projects in `~/dev` as the best candidate for:
- **Portfolio piece** — novel (nothing like it exists in the TS ecosystem), technically deep, demonstrates stack mastery
- **Vibe coding** — fully type-safe (compiler catches wiring errors), testable without mocking (Provider pattern + in-memory fakes), pure function core
- **Developer sphere** — extends the developer's existing AI-assisted workflow (currently manual via `workflow.md` files)

## Key Architectural Decisions

### Client/Server + OpenCode Agent Executor

The original plan had AI steps as simple LLM API calls. This was revised to:

1. **Server** (Hono HTTP) — manages workflow execution, state, traces
2. **Client** (CLI) — thin HTTP client that submits workflows and monitors execution
3. **Agent Executor** (OpenCode) — pluggable backend for AI steps; does the full agentic coding loop (file reads, edits, shell commands)

The user specifically requested OpenCode (opencode.ai, by Anomaly/thdxr) as the agent executor. OpenCode has:
- `@opencode-ai/sdk` — type-safe JS/TS SDK
- `createOpencode()` — starts server + client locally
- `createOpencodeClient({ baseUrl })` — connects to existing server
- `opencode serve` — headless HTTP server with OpenAPI 3.1 spec
- Session-based API: create session, send prompt, get structured response with tool calls
- SSE events for real-time monitoring
- Built-in agents: `build` (full access) and `plan` (read-only)
- SDK docs: https://opencode.ai/docs/sdk
- Server docs: https://opencode.ai/docs/server
- CLI docs: https://opencode.ai/docs/cli

### Agent Output Mode Split

Agent steps have two modes because the output semantics differ:

- **`mode: "analyze"`** (default) — Agent returns structured JSON. System prompt injected with output schema. Response text parsed for JSON and validated against Zod schema.
- **`mode: "build"`** — Agent performs side effects (file edits). Output is derived from session metadata (files_changed, tool_calls), NOT parsed from LLM text.

This was identified as the biggest gap in the original plan — treating both modes identically would break build-mode steps.

### Git Artifact Store

Completed workflow runs are stored in git's object database under custom refs (`refs/runbook/runs/<run-id>`). This is:
- **Separate from commits** — invisible to `git log`, doesn't pollute commit history
- **Content-addressed** — deduplication via git's object store
- **Pushable/pullable** — `git push origin 'refs/runbook/runs/*'`
- **Browsable** — `runbook history`, `runbook show <run-id> <step-id> --prompt`

Records every prompt sent to every LLM, every response, every iteration/retry, every tool call, every file change. Full audit trail.

This is the killer differentiator — no other AI coding tool tracks session artifacts in git.

### Bun-Only for v0.1

No build step, no JS compilation. Raw TypeScript via Bun. Consumers must use Bun. Node.js support is future scope. Consistent with the developer's other published packages.

## Gaps Identified and Fixed

| Gap | Fix |
|-----|-----|
| Agent output parsing (biggest) | `mode: "analyze"` vs `mode: "build"` split |
| OpenCode permissions in headless mode | `auto_approve: true` in executor config |
| Working directory propagation | Config → server → agent executor → OpenCode session |
| Checkpoint blocking mechanism | Promise-based pause + `POST /runs/:id/checkpoints/:id` + CLI stdin |
| Config file discovery | CLI flag → cwd → parent directory walk (like package.json) |
| Bun-only decision | Explicit: no Node support in v0.1 |

## Stack & Conventions

| Concern | Choice |
|---------|--------|
| Runtime | Bun |
| Language | TypeScript (strict) |
| Validation | Zod everywhere |
| Error handling | `Result<T, E>` from `@f0rbit/corpus` — never throw |
| Testing | `bun:test`, integration-first, in-memory fakes, Provider pattern |
| Linting | Biome (NOT ESLint/Prettier) |
| HTTP server | Hono |
| Variables | `snake_case` |
| Functions | `camelCase` |
| Types | `PascalCase` |
| Architecture | Early returns, no comments except complex logic, builder pattern |

## Package Structure

```
runbook/
├── packages/
│   ├── core/           → @f0rbit/runbook              # SDK: types, builders, test providers
│   ├── server/         → @f0rbit/runbook-server        # Hono server, engine, OpenCode executor
│   ├── git-store/      → @f0rbit/runbook-git-store     # Git refs artifact storage
│   └── cli/            → @f0rbit/runbook-cli           # Thin HTTP client, bin: "runbook"
├── examples/
│   ├── analyze-file.ts                                 # Minimal example: fn → agent
│   └── runbook.config.ts
├── .plans/
│   ├── runbook.md                                      # Full technical plan
│   └── context.md                                      # This file
```

## Dependencies

| Package | Purpose | Where |
|---------|---------|-------|
| `zod` | Schema validation | core (peer), server, cli |
| `@f0rbit/corpus` | Result types (`ok`/`err`/`pipe`) | core, server, cli, git-store |
| `hono` | HTTP server | server |
| `@opencode-ai/sdk` | OpenCode agent executor | server |
| `zod-to-json-schema` | Convert Zod → JSON Schema for agent prompts | server |
| No CLI framework | Raw `process.argv` parsing | cli |
| No test framework beyond `bun:test` | — | all |

## Dev Loop

### Fast loop (day-to-day, ~3s, deterministic, CI-safe)
```bash
tsc --noEmit --watch
bun test --watch
```

### Full OpenCode verification (~60s, non-deterministic, manual)
```bash
# Terminal 1: opencode serve --port 4096
# Terminal 2: OPENCODE_URL=http://localhost:4096 bun test --filter e2e
```

### Manual exploration
```bash
# Terminal 1: opencode serve --port 4096
# Terminal 2: OPENCODE_URL=http://localhost:4096 runbook serve
# Terminal 3: runbook run analyze-file --input '{"file_path": "src/index.ts"}'
```

### E2E tests skip gracefully when OPENCODE_URL is absent
```typescript
describe.skipIf(!process.env.OPENCODE_URL)("opencode e2e", () => { ... });
```

## Testing Layers

| Layer | What | Speed | Deterministic | CI |
|-------|------|-------|---------------|-----|
| Types | `tsc --noEmit` | ~1s | Yes | Yes |
| Core unit | DAG resolution, schema validation | ~1s | Yes | Yes |
| Engine integration | Full workflows with in-memory providers | ~2s | Yes | Yes |
| Server API | Hono `app.request()` + in-memory providers | ~2s | Yes | Yes |
| Git-store | Temp git repos, store/retrieve/push/pull | ~200ms/test | Yes | Yes |
| Server → git-store | Temp repos + in-memory providers | ~2s | Yes | Yes |
| OpenCode E2E | Real OpenCode server, real LLM | ~60s | No | Skip |

## Phase Plan Summary

| Phase | What | Est. LOC |
|-------|------|----------|
| 0 | Scaffold monorepo (4 packages + examples) | ~230 |
| 1 | Core types + SDK (types, errors, schema, step builders, workflow builder, trace) | ~940 |
| 2 | Engine + providers (execution engine, shell, opencode, in-memory, state store) | ~920 |
| 3 | Server HTTP layer (Hono routes, checkpoint endpoint, server factory) | ~280 |
| 3.5 | Git artifact store (git commands, store implementation, types) | ~595 |
| 4 | Tests (integration, unit, E2E, git-store tests) | ~1,000 |
| 5 | CLI (HTTP client, config loader, output formatting, all commands, push/pull) | ~940 |
| 6 | Polish + barrel exports | ~40 |
| **Total** | | **~5,500-6,000** |

## CLI Commands (full list)

| Command | Description |
|---------|-------------|
| `runbook serve` | Start the runbook server |
| `runbook run <workflow> [--input json]` | Submit a workflow run |
| `runbook status <run-id>` | Get run status |
| `runbook trace <run-id>` | Display run trace |
| `runbook list` | List available workflows |
| `runbook history` | List stored runs from git |
| `runbook show <run-id> [step-id]` | Show run or step artifacts |
| `runbook diff <run-id-1> <run-id-2>` | Diff two runs |
| `runbook push [--remote origin]` | Push artifact refs to remote |
| `runbook pull [--remote origin]` | Pull artifact refs from remote |

## Business Case

**Problem:** AI coding agents are powerful but unstructured. No composability, no reproducibility, no observability, no testability, no orchestration.

**Solution:** Runbook turns ad-hoc agent sessions into typed, testable, observable pipelines with a full audit trail in git.

**Differentiators:**
1. Type-safe step composition with Zod schemas (compile-time validation of pipeline wiring)
2. First-class AI agent steps via pluggable AgentExecutor (not raw LLM calls — full coding agents)
3. Structured execution traces with agent-level events
4. In-memory test providers for instant, deterministic testing
5. Git-based artifact storage — every prompt, response, and iteration recorded in git refs

**Target audience:** TypeScript developers who use AI coding agents and want to formalize their workflows.

## Decisions Made (for reference)

- Package name: `@f0rbit/runbook` (scoped, consistent with other packages)
- Project name: "runbook"
- Monorepo over flat src/ (client/server split demands it)
- `@f0rbit/corpus` for Result types (not inlined — keeps ecosystem consistent)
- `zod-to-json-schema` for agent prompt schema injection (not custom serializer)
- `@opencode-ai/sdk` with `^` range, insulated by AgentExecutor interface
- Git refs for artifact storage (not JSON files, not git notes)
- Git artifacts enabled by default in config
- Push/pull included in v0.1 scope
- Bun-only for v0.1 (no Node support)
- No CLI framework (raw process.argv)

## What to Do Next

1. Read `.plans/runbook.md` for the full technical plan with type signatures, code examples, and phase breakdown
2. Start with Phase 0: scaffold the monorepo
3. Follow the phase sequence strictly — each phase ends with verification + commit
4. Within phases, parallelize where the plan indicates "parallel-safe"
