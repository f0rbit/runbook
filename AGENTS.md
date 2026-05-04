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
  - Claude Code is the bundled implementation via `@anthropic-ai/claude-agent-sdk`
  - The executor manages sessions, prompts, and tool calls
  - Two output modes: `"analyze"` (JSON from LLM text) and `"build"` (output from session metadata)
  - Agent output is validated against the step's Zod output schema regardless of mode
- Workflows are linear pipelines with optional parallel fan-out/fan-in
- The `pipe()` mapper receives `(workflow_input, previous_step_output)` — both fully typed
- `parallel()` returns a tuple type of all parallel step outputs
- Sub-workflows compose via `.asStep()` which wraps a Workflow as a Step
- Engine dispatches to Providers — never calls Bun.spawn or fetch directly
- Traces are typed event streams, not string logs — includes agent-level events
- Server uses in-memory state store backed by optional git-store persistence
- Git artifact store writes to `refs/runbook/runs/` using raw git commands (no git library)
- Checkpoints use a Promise-based flow: engine pauses, server exposes POST endpoint, CLI prompts stdin
- Checkpoint-paused runs can resume after restart via event-sourced snapshot replay
- Config discovery: `--config` flag → `runbook.config.ts` in cwd → walk up parent dirs
- Bun-only runtime — no build step, no Node.js support in v0.1

## Testing
- `bun test` only
- Integration tests use InMemoryShellProvider + InMemoryAgentExecutor + InMemoryCheckpointProvider
- No mocking — Provider pattern replaces all external dependencies
- Server API tests use Hono `app.request()` — no real HTTP
- Git-store tests create temp directories with `git init` — fully isolated
- Tests call SDK functions and server handlers directly, not the CLI binary

## Engine Features
- `system_prompt_file` on agent steps — loads markdown files as system prompts at execution time
  - Absolute paths used as-is; relative paths resolved against `engine_opts.working_directory`
  - File content prepended to any inline `system_prompt`; both are combined
- `working_directory` propagation: config → engine → shell `opts.cwd` + agent `createSession`
- `ctx.engine` on `StepContext` — fn() steps can run sub-workflows with inherited providers
  - Enables: dynamic parallelism, conditional routing, retry loops, multi-turn sessions
  - The `fn()` step is the escape hatch for all control flow not expressible in the pipeline builder
- `agent_type` is a freeform `string` (not limited to "build" | "plan")

## Persistence & Resilience
- `ServerDeps.git_store` — optional `GitArtifactStore`, created when `config.artifacts.git` is truthy
- Completed/failed runs auto-archive to git-store (fire-and-forget, errors logged not thrown)
- Cancelled runs are NOT persisted to git-store
- On startup with `artifacts.git`, server hydrates in-memory state from git-store history
- `GET /runs/history` — reads from git-store, separate from `GET /runs` (in-memory)
- `RunSnapshot` type enables checkpoint resume via event-sourced replay
- Engine `RunOpts.snapshot` causes completed steps to be skipped (output read from snapshot)
- Checkpoint-paused runs persist to git-store on `checkpoint_waiting` event
- `POST /workflows/:id/resume/:run_id` — rebuilds snapshot from trace, re-runs with skip logic
- `runbook resume <run-id>` — CLI command for resuming checkpoint-paused runs
- **Convention**: All state that must survive a checkpoint MUST flow through pipe() mappers, not module-level closures

## Provider Wiring
- `resolveProviders(config)` in server package creates real providers from `ProviderConfig`
  - Always creates `BunShellProvider`; creates `ClaudeCodeExecutor` when `agent.type === "claude-code"`
- `createServerCheckpointProvider()` bridges engine checkpoint flow with HTTP endpoint
- `handleServe` calls `resolveProviders()` and passes `working_directory` to `createEngine()`

## Config Discovery
- Priority: `--config` flag → walk up from cwd → `~/.config/runbook/runbook.config.ts` (global fallback)
- The global fallback enables user-wide workflow definitions separate from project configs
- Local configs always take precedence over global

## Workflow Definitions (at ~/.config/runbook/)
- 4 workflows: `verify`, `question`, `simple-change`, `feature`
- `verify` — parallel shell steps (tsc + bun test + biome) → merge fn
- `question` — single explore agent step (analyze mode)
- `simple-change` — coder agent (build mode) → verify sub-workflow → git commit
- `feature` — explore → plan → checkpoint → dynamic phase execution via fn() + ctx.engine
  - Phase execution: coder → verify → retry-fix loop (max 2) → git commit per phase
  - Merge-step pattern: module-level closure captures plan data across checkpoint boundary
  - **TODO**: Refactor closure pattern to use pipe() mappers for checkpoint resume compatibility
- Agent system prompts stored in `~/.config/runbook/prompts/*.md`
- Shared Zod schemas in `~/.config/runbook/schemas/common.ts`

## Known Patterns and Gotchas
- Checkpoint output replaces previous step output — use pipe() mappers to carry data forward (NOT module-level closures)
- Sub-workflows inherit parent engine providers via `ctx.engine.run()` — do NOT create `createEngine({})` in fn() steps
- `InMemoryAgentExecutor.created_sessions` tracks session creation opts for test assertions
- `buildSnapshot()` extracts completed step outputs from `step_complete` trace events — the trace is the source of truth for resume
- Parallel node skip-logic: ALL branches must be in snapshot to skip; partial skips run the entire node
- 129 tests across 13 test files (as of server-resilience milestone)
