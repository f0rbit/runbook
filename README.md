# @f0rbit/runbook

Typed workflow engine for orchestrating AI agents, shell commands, and human checkpoints with compile-time safety.

## What is this?

Runbook lets you define workflows as pipelines of typed steps. Each step has Zod input/output schemas -- mis-wired pipelines fail at compile time, not runtime. Steps can be pure functions, shell commands, AI agent sessions, or human checkpoints.

## Quick Start

```bash
bun add @f0rbit/runbook @f0rbit/runbook-server zod @f0rbit/corpus
```

```typescript
import { agent, defineWorkflow } from "@f0rbit/runbook";
import { createEngine } from "@f0rbit/runbook-server";
import { ok } from "@f0rbit/corpus";
import { z } from "zod";

const IssueSchema = z.object({
  issues: z.array(z.string()),
  severity: z.enum(["low", "medium", "high"]),
});

const analyze = agent({
  id: "analyze",
  input: z.object({ code: z.string() }),
  output: IssueSchema,
  prompt: (input) => `Analyze this code for issues:\n${input.code}`,
});

const workflow = defineWorkflow(z.object({ code: z.string() }))
  .pipe(analyze, (wf_input) => ({ code: wf_input.code }))
  .done("code-review", IssueSchema);

// Run it
const engine = createEngine({ providers: { agent: myAgentExecutor } });
const result = await engine.run(workflow, { code: "console.log('hello')" });

if (result.ok) {
  console.log(result.value.output); // { issues: [...], severity: "low" }
}
```

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| `packages/core` | `@f0rbit/runbook` | SDK: types, step builders, workflow builder, trace types |
| `packages/server` | `@f0rbit/runbook-server` | Hono HTTP server: engine, providers, routes, state |
| `packages/cli` | `@f0rbit/runbook-cli` | Thin CLI client: HTTP client, command handlers, config |
| `packages/git-store` | `@f0rbit/runbook-git-store` | Git-based artifact store for workflow traces |

## Step Types

### `fn()` -- Pure function

```typescript
import { fn } from "@f0rbit/runbook";
import { ok } from "@f0rbit/corpus";

const transform = fn({
  id: "transform",
  input: z.object({ text: z.string() }),
  output: z.object({ words: z.number() }),
  run: async (input) => ok({ words: input.text.split(" ").length }),
});
```

### `shell()` -- Shell command

```typescript
import { shell } from "@f0rbit/runbook";
import { ok } from "@f0rbit/corpus";

const lint = shell({
  id: "lint",
  input: z.object({ path: z.string() }),
  output: z.object({ clean: z.boolean(), output: z.string() }),
  command: (input) => `eslint ${input.path} --format json`,
  parse: (stdout, code) => ok({ clean: code === 0, output: stdout }),
});
```

### `agent()` -- AI agent

Two output modes:
- `"analyze"` (default) -- agent returns JSON matching the output schema
- `"build"` -- output is extracted from the agent session metadata (files changed, tool calls, etc.)

```typescript
import { agent } from "@f0rbit/runbook";

const review = agent({
  id: "review",
  input: z.object({ diff: z.string() }),
  output: z.object({ approved: z.boolean(), comments: z.array(z.string()) }),
  prompt: (input) => `Review this diff:\n${input.diff}`,
  mode: "analyze",
});
```

### `checkpoint()` -- Human approval

Pauses the workflow and waits for human input. The server exposes a POST endpoint; the CLI prompts stdin.

```typescript
import { checkpoint } from "@f0rbit/runbook";

const approve = checkpoint({
  id: "approve",
  input: z.object({ summary: z.string() }),
  output: z.object({ approved: z.boolean() }),
  prompt: (input) => `Review and approve:\n${input.summary}`,
});
```

## Workflow Composition

### `pipe()` -- Sequential steps

The mapper receives `(workflow_input, previous_step_output)`, both fully typed.

```typescript
const workflow = defineWorkflow(z.object({ url: z.string() }))
  .pipe(fetch_step, (wf_input) => ({ url: wf_input.url }))
  .pipe(parse_step, (_wf_input, prev) => ({ html: prev.body }))
  .pipe(summarize_step, (_wf_input, prev) => ({ text: prev.content }))
  .done("scrape-pipeline", SummarySchema);
```

### `parallel()` -- Fan-out/fan-in

Returns a tuple type of all parallel step outputs.

```typescript
const workflow = defineWorkflow(z.object({ code: z.string() }))
  .parallel(
    [lint_step, (wf) => ({ path: wf.code })],
    [test_step, (wf) => ({ path: wf.code })],
    [typecheck_step, (wf) => ({ path: wf.code })],
  )
  .pipe(merge_step, (_wf, [lint, test, types]) => ({
    lint_ok: lint.clean,
    tests_pass: test.passed,
    types_ok: types.clean,
  }))
  .done("ci-pipeline", MergedResultSchema);
```

### `asStep()` -- Sub-workflows

Wrap a workflow as a step for composition.

```typescript
const inner = defineWorkflow(z.object({ file: z.string() }))
  .pipe(read_step, (wf) => ({ path: wf.file }))
  .pipe(process_step, (_wf, prev) => ({ content: prev.text }))
  .done("inner-wf", OutputSchema);

const outer = defineWorkflow(z.object({ files: z.array(z.string()) }))
  .pipe(inner.asStep(), (wf) => ({ file: wf.files[0] }))
  .done("outer-wf", OutputSchema);
```

## Testing

Use in-memory providers from `@f0rbit/runbook/test` -- no mocking, no real I/O.

```typescript
import { describe, expect, test } from "bun:test";
import { InMemoryAgentExecutor, InMemoryShellProvider } from "@f0rbit/runbook/test";
import { createEngine } from "@f0rbit/runbook-server";

describe("my workflow", () => {
  test("runs end to end", async () => {
    const shell = new InMemoryShellProvider();
    shell.on(/eslint/, { stdout: "[]", exit_code: 0 });

    const agent = new InMemoryAgentExecutor();
    agent.on(/Analyze/, { text: '{"issues": [], "severity": "low"}' });

    const engine = createEngine({ providers: { shell, agent } });
    const result = await engine.run(workflow, { code: "const x = 1;" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output.severity).toBe("low");
    }
  });
});
```

## CLI

```
Usage: runbook <command> [options]

Commands:
  serve                                  Start the runbook server
  run <workflow> [task...] [--input json] Submit a workflow run (positional words become { task })
  status [run-id] [--live]               Get run status (defaults to latest, --live streams events)
  trace <run-id>                         Display run trace
  list                                   List available workflows
  cancel [run-id]                        Cancel a running workflow (defaults to latest)
  resume <run-id>                        Resume a checkpoint-paused run
  history                                List stored runs from git
  show <run-id> [step-id]                Show run or step artifacts
  diff <run-id-1> <run-id-2>             Diff two stored runs
  push [--remote origin]                 Push artifact refs to remote
  pull [--remote origin]                 Pull artifact refs from remote

Options:
  --url <url>                            Server URL (default: http://localhost:4400, env: RUNBOOK_URL)
  --config <path>                        Config file path
  --help                                 Show this help
```

```bash
# Start the server
runbook serve

# Run a workflow — explicit JSON input
runbook run code-review --input '{"code": "console.log(1)"}'

# Run a workflow — bare positional shorthand for { task: "..." }
runbook run feature add a dark-mode toggle to the settings page

# Watch a running workflow
runbook status --live

# Cancel a runaway run
runbook cancel

# Inspect results
runbook trace <run-id>
runbook show <run-id> analyze
```

## HTTP API

The CLI is a thin client over these endpoints. They're stable; build your own client if you need to.

```
GET  /health
GET  /workflows                                 List registered workflows
POST /workflows/:id/run                         Submit a run, returns { run_id }
POST /workflows/:id/resume/:run_id              Resume a checkpoint-paused run
GET  /runs                                      List in-memory runs (latest first)
GET  /runs/history                              List runs archived to git-store
GET  /runs/:id                                  Run state + status
GET  /runs/:id/trace                            Full typed event stream
GET  /runs/:id/events                           SSE stream of new events
POST /runs/:id/cancel                           Abort the run (shell + agent + parallel branches)
POST /runs/:id/checkpoints/:checkpoint_id       Resolve a paused checkpoint
```

## Integrations

| Surface | Bundled | Notes |
|---|---|---|
| Agent executor | **Claude Code** via `@anthropic-ai/claude-agent-sdk` | `ClaudeCodeExecutor`. Reads `ANTHROPIC_API_KEY` from env. Push-based event streaming, no polling. |
| Shell | **Bun** | `BunShellProvider`. Honours `working_directory` and `AbortSignal` for cancellation. |
| Checkpoint | In-process | Engine pauses, server holds the pending promise on `RunState`, HTTP endpoint resolves it with a Zod-parsed value. |
| Artifact persistence | **Git refs** (opt-in) | `@f0rbit/runbook-git-store`. Completed runs + checkpoint snapshots under `refs/runbook/runs/<run-id>` -- enable via `artifacts: { git: true }`. |
| Test doubles | **In-memory** | `InMemoryAgentExecutor`, `InMemoryShellProvider` from `@f0rbit/runbook/test`. Pattern-matched scripted responses, no mocking. |

Real-provider integration tests are gated via `describe.skipIf(!process.env.ANTHROPIC_API_KEY)`. Unit/integration suites use the in-memory providers and run unconditionally.

## Git Artifact Store

Workflow traces are stored as git objects under `refs/runbook/runs/<run-id>`. These refs are invisible to `git log` -- they live outside the normal commit graph.

Each run stores:
- `metadata.json` -- workflow ID, input, output, timing, optional commit SHA
- `trace.json` -- full typed event stream
- `steps/<step-id>/` -- per-step input, output, prompt, and response artifacts

```bash
# List stored runs
runbook history

# Show a specific run
runbook show <run-id>

# Show a specific step's artifacts
runbook show <run-id> <step-id>

# Diff two runs
runbook diff <run-id-1> <run-id-2>

# Sync with remote
runbook push
runbook pull
```

## Configuration

Create `runbook.config.ts` in your project root:

```typescript
import { defineConfig, defineWorkflow, fn } from "@f0rbit/runbook";
import { z } from "zod";
import { ok } from "@f0rbit/corpus";

const hello = fn({
  id: "hello",
  input: z.object({ name: z.string() }),
  output: z.object({ greeting: z.string() }),
  run: async (input) => ok({ greeting: `Hello, ${input.name}!` }),
});

const workflow = defineWorkflow(z.object({ name: z.string() }))
  .pipe(hello, (wf) => ({ name: wf.name }))
  .done("hello-world", z.object({ greeting: z.string() }));

export default defineConfig({
  workflows: [workflow],
  server: { port: 4400 },
  providers: {
    agent: { type: "claude-code" },
  },
  artifacts: { git: true },
});
```

Config discovery: `--config` flag > `runbook.config.ts` in cwd > walk up parent dirs.

## Architecture

```
CLI ──HTTP──> Server (Hono)
                ├── Engine
                │   ├── fn steps (in-process)
                │   ├── shell steps (ShellProvider)
                │   ├── agent steps (AgentExecutor)
                │   └── checkpoint steps (pause/resume)
                ├── State Store (in-memory)
                └── Git Artifact Store (refs/runbook/runs/*)
```

The CLI is a thin HTTP client. All execution happens in the server process. The engine dispatches to provider interfaces -- never calls `Bun.spawn` or LLM APIs directly. Providers are swappable: use `BunShellProvider` in production, `InMemoryShellProvider` in tests.

## Development

```bash
bun install
bun run typecheck
bun test
bun run lint
```
