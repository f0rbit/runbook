# @f0rbit/runbook

## Project Structure
- Bun workspace monorepo: `packages/core`, `packages/server`, `packages/cli`
- `packages/core` — SDK: types, step builders, workflow builder, trace types, in-memory test providers
  - Published as `@f0rbit/runbook` with `./test` subpath export
- `packages/server` — Hono HTTP server: engine, providers, routes, state
  - Published as `@f0rbit/runbook-server`
- `packages/cli` — Thin CLI client: HTTP client, command handlers, config loader
  - Published as `@f0rbit/runbook-cli` with `runbook` bin
- `packages/git-store` — Git-based artifact store for workflow traces and agent sessions
  - Published as `@f0rbit/runbook-git-store`
  - Stores under `refs/runbook/runs/<run-id>` — invisible to `git log`

## Conventions
- `@f0rbit/corpus` for all Result<T, E> types — import `ok`, `err`, `pipe`, `unwrap` from there
- Zod schemas define the source of truth for all types — never hand-write interfaces that duplicate a schema
- Provider pattern for all external I/O (shell, agent executors, checkpoints)
- `@f0rbit/runbook/test` export path for in-memory providers
- CLI uses raw `process.argv` parsing — no CLI framework dependency
- snake_case variables, camelCase functions, PascalCase types
- Biome for linting (not ESLint)
- Hono for HTTP server (not Express)

## Key Architecture Decisions
- **Client/Server split**: Engine runs in server process, CLI is a thin HTTP client
- **Agent steps dispatch to AgentExecutor interface**, not raw LLM APIs
  - OpenCode is the first implementation via `@opencode-ai/sdk`
  - The executor manages sessions, prompts, and tool calls
  - Two output modes: `"analyze"` (JSON from LLM text) and `"build"` (output from session metadata)
  - Agent output is validated against the step's Zod output schema regardless of mode
- Workflows are linear pipelines with optional parallel fan-out/fan-in
- The `pipe()` mapper receives `(workflow_input, previous_step_output)` — both fully typed
- `parallel()` returns a tuple type of all parallel step outputs
- Sub-workflows compose via `.asStep()` which wraps a Workflow as a Step
- Engine dispatches to Providers — never calls Bun.spawn or fetch directly
- Traces are typed event streams, not string logs — includes agent-level events
- Server uses in-memory state store (v0.1) — no database yet
- Git artifact store writes to `refs/runbook/runs/` using raw git commands (no git library)
- Checkpoints use a Promise-based flow: engine pauses, server exposes POST endpoint, CLI prompts stdin
- Config discovery: `--config` flag → `runbook.config.ts` in cwd → walk up parent dirs
- Bun-only runtime — no build step, no Node.js support in v0.1

## Testing
- `bun test` only
- Integration tests use InMemoryShellProvider + InMemoryAgentExecutor + InMemoryCheckpointProvider
- No mocking — Provider pattern replaces all external dependencies
- Server API tests use Hono `app.request()` — no real HTTP
- Git-store tests create temp directories with `git init` — fully isolated
- Tests call SDK functions and server handlers directly, not the CLI binary
