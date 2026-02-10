# @f0rbit/runbook -- Use Case

## 1. The Problem

Software teams increasingly use AI coding agents -- Claude Code, Cursor, OpenCode, Aider, Goose -- for real development work. Not chat. Full coding sessions that read files, edit code, run tests, and deploy. But there is no standard way to:

**Orchestrate multi-step agent workflows.** "Analyze this PR, then fix the issues, then run tests, then open a PR" requires manual coordination or brittle shell scripts. Each step is a separate agent invocation with no typed contract between them.

**Validate agent output.** Agents return unstructured text. There is no compile-time guarantee that what one step produces matches what the next step expects. A code review agent might return `{ comments: [...] }` or it might return a paragraph of prose -- the downstream step has no way to know until runtime.

**Audit what happened.** Agent sessions produce logs, but there is no structured trace of decisions, tool calls, and outputs across a multi-step pipeline. When a deployment goes wrong after an agent-assisted change, reconstructing what the agent did requires digging through terminal scrollback.

**Test agent workflows.** You cannot unit test a workflow that calls GPT-4. Each run costs money, takes 30-60 seconds, and produces non-deterministic output. You need in-memory fakes that run instantly and deterministically.

**Compose workflows.** Reusing a "review code" workflow inside a "deploy feature" workflow should not require copy-pasting steps. Workflows should be composable units with typed boundaries.

These are not hypothetical problems. They are the daily reality of teams that have moved past "ask the AI a question" into "the AI is part of our development pipeline."

## 2. The Solution

Runbook is a typed workflow engine where AI agents are first-class step types alongside pure functions, shell commands, and human checkpoints. Workflows are defined in TypeScript with Zod schemas at every boundary. The compiler catches wiring errors before any code runs.

### Key Differentiators

**Compile-time type safety.** Every step declares its input and output as Zod schemas. The `pipe()` builder method infers types across the chain -- if step B expects `{ files: string[] }` but step A produces `{ result: string }`, TypeScript catches it at compile time.

```typescript
const pipeline = defineWorkflow({ id: "review", input: z.object({ pr_url: z.string() }) })
  .pipe(fetchDiff, (wf) => ({ url: wf.pr_url }))
  .pipe(reviewAgent, (wf, prev) => ({
    diff: prev.diff,         // TypeScript knows prev has { diff: string }
    guidelines: "standard",
  }))
  .done();
```

**AgentExecutor pattern.** Agent steps dispatch to a pluggable executor interface, not raw LLM APIs. The executor manages sessions, prompts, tool calls, and permissions. OpenCode is the first implementation; Claude Code, Aider, and others can be added behind the same interface without changing workflow definitions.

**Two agent output modes.** `"analyze"` mode extracts structured JSON from the LLM's text response (for analysis, review, planning). `"build"` mode derives output from session metadata like `files_changed` (for code generation, refactoring). The engine handles both -- workflow authors just declare the mode and the output schema.

**In-memory test providers.** Every external dependency (shell execution, agent sessions, human checkpoints) is behind a Provider interface. Swap in `InMemoryShellProvider`, `InMemoryAgentExecutor`, and `InMemoryCheckpointProvider` for instant, deterministic tests. No mocking libraries. No network calls. Sub-second test runs.

**Structured traces.** Every execution produces a typed event stream: workflow lifecycle, step inputs/outputs, agent session creation, tool calls, checkpoint decisions. Not string logs -- typed `TraceEvent` objects that can be queried, diffed, and stored.

**Git artifact store.** Completed runs are stored in git's object database under custom refs (`refs/runbook/runs/<run-id>`). Invisible to `git log`. Pushable and pullable like any git ref. Every prompt sent to every agent, every response, every tool call, every retry -- recorded and content-addressed. No other AI coding tool provides this level of auditability.

## 3. Use Cases

### 3.1 Automated Code Review Pipeline

```
read PR diff -> agent: analyze for issues -> agent: suggest fixes
  -> checkpoint: human approval -> apply fixes -> run tests
```

The analysis agent's output schema is explicit:

```typescript
z.object({
  issues: z.array(z.object({
    file: z.string(),
    line: z.number(),
    description: z.string(),
    severity: z.enum(["error", "warning", "info"]),
  })),
})
```

If the agent returns garbage, the pipeline fails immediately with a structured validation error -- not silently, not downstream when the next step tries to access `issues[0].file` on undefined.

### 3.2 Feature Implementation Workflow

```
parse spec -> agent: plan implementation -> checkpoint: approve plan
  -> agent: write code -> shell: run tests -> agent: fix failures -> shell: lint
```

The planning agent uses `mode: "analyze"` and returns `{ files_to_create, files_to_modify, approach }`. The coding agent uses `mode: "build"` and returns `{ files_changed, success }` derived from session metadata. The planning output feeds directly into the coding prompt -- typed end-to-end. No string munging, no "parse the agent's response and hope it has the right fields."

### 3.3 CI/CD with Agent Steps

```
shell: build -> shell: test -> agent: analyze test failures
  -> checkpoint: deploy approval -> shell: deploy
```

Traditional CI steps (build, test, deploy) composed with agent intelligence (failure analysis) and human gates (deploy approval). The trace records exactly what the agent recommended and whether the human approved. When something goes wrong in production, you can inspect the full decision chain.

### 3.4 Documentation Generation

```
agent: scan codebase -> agent: generate docs -> shell: format with prettier
  -> checkpoint: review
```

The scanning agent produces a typed codebase summary. The documentation agent consumes it. Prettier formats the output. A human reviews before merge. Each step is independently testable with in-memory providers.

### 3.5 Incident Response Runbook

```
shell: collect logs -> agent: analyze root cause -> agent: draft fix
  -> checkpoint: approve -> agent: implement fix -> shell: run tests
  -> shell: deploy hotfix
```

The literal use case that inspired the name. Executable runbooks that combine automated analysis with human oversight. The git artifact store records the full incident response -- which logs were analyzed, what root cause the agent identified, what fix was proposed, who approved it, and what tests passed before deployment.

## 4. Who Is This For

**Teams building AI-augmented dev tooling.** You need a typed pipeline runtime, not another prompt chain library. Runbook gives you compile-time step wiring, structured traces, and testable workflows without mocking.

**Platform engineers.** Standardize how agent workflows are defined, tested, and audited across teams. The Provider pattern means you control which agent backends are available. The git artifact store means every agent interaction is recorded and reviewable.

**Solo developers.** Automate multi-step coding workflows with structured output and full traceability. Define your personal runbooks in TypeScript, test them locally with in-memory providers, run them with real agents when ready.

## 5. Why Not X

**vs. LangChain / LlamaIndex.** These are LLM prompt chain libraries. Runbook is a workflow engine where agents are one step type among many. LangChain does not have shell steps, checkpoint steps, or compile-time type checking of step boundaries. It is designed for prompt engineering; Runbook is designed for workflow orchestration.

**vs. Temporal / Inngest.** Temporal is a distributed workflow engine for microservices. Runbook is purpose-built for AI agent orchestration with typed step boundaries and structured traces. No Java/Go required, no cluster setup, no Temporal server. Runbook runs locally on Bun with a single server process.

**vs. GitHub Actions / CI systems.** Actions are cloud-hosted CI/CD with YAML definitions. Runbook is a local-first TypeScript engine where AI agents are first-class, output is typed, and workflows are testable without Docker or cloud infrastructure. Actions cannot pause for human input mid-workflow or validate agent output against a schema.

**vs. Raw scripting.** Shell scripts and Node.js scripts do not give you type-safe step composition, structured traces, in-memory test doubles, or human checkpoint gates. A shell script that calls three agents in sequence has no way to validate that agent A's output matches agent B's expected input.

**vs. Custom orchestrators.** Building your own with Zod + fetch is viable for a single workflow. It stops being viable when you need structured traces, checkpoint pausing, parallel fan-out, sub-workflow composition, git-based artifact storage, and a test harness -- all of which Runbook provides out of the box.

## 6. Architecture at a Glance

Runbook uses a client/server architecture:

- **Server** (`@f0rbit/runbook-server`): Hono HTTP server that hosts the execution engine, manages run state, and dispatches steps to providers. Runs as a persistent process.
- **CLI** (`@f0rbit/runbook-cli`): Thin HTTP client. Submits workflow runs, streams real-time trace events via SSE, handles checkpoint prompts via stdin.
- **Core SDK** (`@f0rbit/runbook`): Type definitions, step builders, workflow builder, trace types. Consumed by both server and users who define workflows. No runtime dependencies beyond Zod and `@f0rbit/corpus`.
- **Git Store** (`@f0rbit/runbook-git-store`): Stores completed runs in git refs. Reads and writes git objects directly via `git hash-object`, `git mktree`, and `git update-ref`.

Providers are injected, never hardcoded. The engine dispatches `"fn"` steps directly, `"shell"` steps to `ShellProvider`, `"agent"` steps to `AgentExecutor`, and `"checkpoint"` steps to `CheckpointProvider`. Swap any provider for an in-memory fake in tests.

Traces are stored in git refs (`refs/runbook/runs/<run-id>`) alongside step-level artifacts: inputs, outputs, agent prompts, agent responses, and retry iterations. These refs are invisible to `git log`, pushable/pullable independently, and browsable via `runbook show` and `runbook diff`.

## 7. Current Status and Future Scope

Runbook v0.1 ships with linear pipelines, parallel fan-out/fan-in, four step types (fn, shell, agent, checkpoint), in-memory state, and git artifact storage. OpenCode is the first agent executor.

Planned for future versions:

- **Persistence** -- SQLite + Drizzle for durable run state across server restarts
- **Conditional branching** -- route to different steps based on previous output
- **Retry policies** -- configurable retry with backoff for failed steps
- **Workflow visualizer** -- terminal and web UI for trace inspection
- **Additional agent executors** -- Claude Code, Aider, Goose behind the same AgentExecutor interface
- **MCP integration** -- expose workflows as MCP tools, consume MCP servers as step providers
- **Node.js support** -- currently Bun-only; Node.js runtime support in a future release
