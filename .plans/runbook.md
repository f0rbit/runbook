# @f0rbit/runbook — Typed Workflow Engine (Client/Server + Agent Executor)

## Executive Summary

A TypeScript-native workflow engine that makes `.md`-style dev workflows executable. Workflows are DAGs of typed steps with Zod input/output schemas, where mis-wired pipelines fail at compile time, not runtime. Steps can be functions, shell commands, **agent sessions** (dispatched to pluggable agent executors like OpenCode), or human checkpoints. Execution produces structured traces (typed event streams) capturing both runbook-level and agent-level events.

Ships as a **monorepo** with four packages: `packages/core` (SDK + engine types), `packages/server` (Hono HTTP server), `packages/cli` (thin client), and `packages/git-store` (git-based artifact storage). The server manages workflow execution, state, and traces. The CLI submits workflows, monitors execution, and views traces. Agent steps dispatch to an **AgentExecutor** interface with two output modes: `"analyze"` (structured JSON from LLM text) and `"build"` (output derived from session metadata). OpenCode is the first implementation, but Claude Code, Aider, etc. could be plugged in later. Completed workflow runs are optionally stored in git's object database under custom refs for full auditability.

**Estimated total:** ~5,500–6,000 LOC across 8 phases.

---

## 1. Architecture Decision: Monorepo

**Decision: Bun workspace monorepo.**

Rationale:
- Client/server split demands separate packages — the CLI should not bundle server internals
- The core SDK (workflow definition, types, step builders) is consumed by both server and CLI
- Users who write workflows depend on `@f0rbit/runbook` (core) only — they don't need server or CLI
- The server is a standalone process that imports core and adds HTTP/execution concerns
- The CLI is a thin HTTP client that imports core for type definitions

```
runbook/
├── packages/
│   ├── core/                        # SDK: types, step builders, workflow builder
│   │   ├── src/
│   │   │   ├── index.ts             # Barrel export
│   │   │   ├── types.ts             # Core type definitions
│   │   │   ├── errors.ts            # Error types + constructors
│   │   │   ├── schema.ts            # Zod schemas (config, trace events, API)
│   │   │   ├── workflow.ts          # Workflow builder (defineWorkflow)
│   │   │   ├── step.ts              # Step builders (fn, shell, agent, checkpoint)
│   │   │   ├── trace.ts             # Trace collector + types
│   │   │   └── test.ts              # @f0rbit/runbook/test — in-memory providers
│   │   ├── __tests__/
│   │   │   ├── integration/
│   │   │   │   ├── engine-workflows.test.ts
│   │   │   │   └── agent-step.test.ts
│   │   │   └── unit/
│   │   │       ├── dag-resolution.test.ts
│   │   │       └── schema-validation.test.ts
│   │   └── package.json
│   ├── server/                      # HTTP server: engine, providers, API
│   │   ├── src/
│   │   │   ├── index.ts             # Barrel export
│   │   │   ├── server.ts            # Hono app factory
│   │   │   ├── engine.ts            # Execution engine
│   │   │   ├── routes/
│   │   │   │   ├── workflows.ts     # POST /workflows/run, GET /workflows
│   │   │   │   ├── runs.ts          # GET /runs/:id, GET /runs/:id/trace
│   │   │   │   └── health.ts        # GET /health
│   │   │   ├── providers/
│   │   │   │   ├── types.ts         # Provider interfaces (Shell, Agent, Checkpoint)
│   │   │   │   ├── shell.ts         # ShellProvider (Bun.spawn)
│   │   │   │   ├── agent.ts         # AgentExecutor interface
│   │   │   │   ├── opencode.ts      # OpenCodeExecutor (first implementation)
│   │   │   │   ├── checkpoint.ts    # CheckpointProvider (stdin or API callback)
│   │   │   │   └── in-memory.ts     # InMemory{Shell,Agent,Checkpoint} for tests
│   │   │   └── state.ts             # In-memory run state store
│   │   ├── __tests__/
│   │   │   └── integration/
│   │   │       ├── server-api.test.ts
│   │   │       ├── engine-execution.test.ts
│   │   │       └── opencode-executor.test.ts
│   │   └── package.json
│   ├── cli/                         # CLI client
│   │   ├── src/
│   │   │   ├── index.ts             # CLI entry point (bin)
│   │   │   ├── client.ts            # HTTP client for runbook server
│   │   │   ├── commands/
│   │   │   │   ├── run.ts           # runbook run <workflow>
│   │   │   │   ├── status.ts        # runbook status <run-id>
│   │   │   │   ├── trace.ts         # runbook trace <run-id>
│   │   │   │   ├── list.ts          # runbook list
│   │   │   │   ├── serve.ts         # runbook serve (starts server)
│   │   │   │   ├── history.ts       # runbook history (git-store)
│   │   │   │   ├── show.ts          # runbook show <run-id> [step-id]
│   │   │   │   ├── diff.ts          # runbook diff <run-id-1> <run-id-2>
│   │   │   │   ├── push.ts         # runbook push [--remote]
│   │   │   │   └── pull.ts         # runbook pull [--remote]
│   │   │   ├── config.ts            # Config file loader (runbook.config.ts)
│   │   │   └── output.ts            # Terminal output formatting
│   │   ├── __tests__/
│   │   │   └── integration/
│   │   │       └── cli-commands.test.ts
│   │   └── package.json
│   └── git-store/                   # Git artifact store
│       ├── src/
│       │   ├── index.ts             # Barrel export
│       │   ├── store.ts             # GitArtifactStore implementation
│       │   ├── git.ts               # Low-level git command wrappers
│       │   └── types.ts             # Types (StoredRun, StepArtifacts, etc.)
│       ├── __tests__/
│       │   └── integration/
│       │       └── git-store.test.ts
│       └── package.json
├── package.json                     # Root workspace config
├── tsconfig.json                    # Root TypeScript config
└── biome.json
```

**Root `package.json`:**
```json
{
  "name": "runbook",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "bun test",
    "lint": "biome check .",
    "lint:fix": "biome check --fix ."
  }
}
```

**`packages/core/package.json`:**
```json
{
  "name": "@f0rbit/runbook",
  "version": "0.0.1",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "exports": {
    ".": { "types": "./src/index.ts", "import": "./src/index.ts" },
    "./test": { "types": "./src/test.ts", "import": "./src/test.ts" }
  },
  "peerDependencies": {
    "zod": "^3"
  },
  "dependencies": {
    "@f0rbit/corpus": "^0.3"
  }
}
```

**`packages/server/package.json`:**
```json
{
  "name": "@f0rbit/runbook-server",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "dependencies": {
    "@f0rbit/runbook": "workspace:*",
    "@f0rbit/corpus": "^0.3",
    "@opencode-ai/sdk": "^0.1",
    "hono": "^4",
    "zod": "^3"
  }
}
```

**`packages/cli/package.json`:**
```json
{
  "name": "@f0rbit/runbook-cli",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "bin": { "runbook": "src/index.ts" },
  "dependencies": {
    "@f0rbit/runbook": "workspace:*",
    "@f0rbit/runbook-git-store": "workspace:*",
    "@f0rbit/corpus": "^0.3",
    "zod": "^3"
  }
}
```

**Root `tsconfig.json`:**
```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "paths": {
      "@f0rbit/runbook": ["./packages/core/src"],
      "@f0rbit/runbook/*": ["./packages/core/src/*"],
      "@f0rbit/runbook-server": ["./packages/server/src"],
      "@f0rbit/runbook-server/*": ["./packages/server/src/*"],
      "@f0rbit/runbook-cli": ["./packages/cli/src"],
      "@f0rbit/runbook-cli/*": ["./packages/cli/src/*"],
      "@f0rbit/runbook-git-store": ["./packages/git-store/src"],
      "@f0rbit/runbook-git-store/*": ["./packages/git-store/src/*"]
    },
    "baseUrl": "."
  },
  "include": ["packages/*/src/**/*.ts", "packages/*/__tests__/**/*.ts"]
}
```

---

## 2. Core Type System

This is the heart of the project. The type system enforces that step outputs match downstream step inputs **at compile time**.

### 2.1 Step Definition

A step has a typed input schema, a typed output schema, and a step kind that determines dispatch:

```typescript
import { z } from "zod";
import type { Result } from "@f0rbit/corpus";

// ── Step Kind ──────────────────────────────────────────────
// Discriminated union that tells the engine HOW to execute a step.
// The engine pattern-matches on `kind` and dispatches to the right provider.

type StepKind =
  | { kind: "fn"; run: (input: any, ctx: StepContext) => Promise<Result<any, StepError>> }
  | { kind: "shell"; command: (input: any) => string; parse: (stdout: string, code: number) => Result<any, StepError> }
  | { kind: "agent"; prompt: (input: any) => string; mode: AgentOutputMode; agent_opts?: AgentStepOpts }
  | { kind: "checkpoint"; prompt: (input: any) => string };

// ── Core Step ──────────────────────────────────────────────
type Step<I, O> = {
  id: string;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  kind: StepKind;
  description?: string;
};

// ── Agent Output Mode ──────────────────────────────────────
// Determines HOW the step's output is derived from the agent response.
//
// "analyze" (default) — Agent returns structured JSON matching the output schema.
//   System prompt is injected with the output schema description.
//   Response text is parsed for JSON, validated against the Zod output schema.
//
// "build" — Agent performs side effects (file edits, shell commands).
//   Output is derived from AgentResponse.metadata (files_changed, tool_calls, etc.).
//   The output schema describes the metadata shape, NOT parsed from LLM text.
//   The engine maps metadata fields → output schema fields automatically.
type AgentOutputMode = "analyze" | "build";

// ── Agent Step Options ─────────────────────────────────────
// These are hints to the AgentExecutor about how to run this step.
type AgentStepOpts = {
  model?: { provider_id: string; model_id: string };
  agent_type?: "build" | "plan";   // OpenCode built-in agents
  timeout_ms?: number;
  system_prompt?: string;          // Prepended to the prompt
};

// ── Step Context ───────────────────────────────────────────
// Available to every step during execution (server-side only).
type StepContext = {
  workflow_id: string;
  step_id: string;
  run_id: string;
  trace: TraceEmitter;
  signal: AbortSignal;
};
```

### 2.2 Step Builders

Ergonomic builder functions for each step type:

```typescript
// ── Pure function step ─────────────────────────────────────
const compile = fn({
  id: "compile",
  input: z.object({ source_dir: z.string() }),
  output: z.object({ artifacts: z.array(z.string()), success: z.boolean() }),
  async run(input, ctx) {
    // ... implementation
    return ok({ artifacts: ["dist/index.js"], success: true });
  },
});

// ── Shell command step ─────────────────────────────────────
const test_step = shell({
  id: "test",
  input: z.object({ test_dir: z.string() }),
  output: z.object({ passed: z.number(), failed: z.number() }),
  command: (input) => `bun test ${input.test_dir}`,
  parse: (stdout, code) => ok({ passed: 10, failed: 0 }),
});

// ── Agent step: "build" mode (output from metadata) ────────
// The agent performs side effects. Output is derived from AgentResponse.metadata,
// NOT from parsing the LLM's text response.
const implement = agent({
  id: "implement_feature",
  mode: "build",
  input: z.object({ spec: z.string(), target_files: z.array(z.string()) }),
  output: z.object({
    files_changed: z.array(z.string()),
    success: z.boolean(),
  }),
  prompt: (input) =>
    `Implement the following spec:\n${input.spec}\n\nTarget files: ${input.target_files.join(", ")}`,
  agent_opts: {
    agent_type: "build",
    model: { provider_id: "anthropic", model_id: "claude-sonnet-4-20250514" },
  },
});

// ── Agent step: "analyze" mode (default — output from JSON text) ──
// The agent returns structured JSON matching the output schema.
// System prompt is injected with schema description; response text is parsed.
const review = agent({
  id: "code_review",
  mode: "analyze",  // default, can be omitted
  input: z.object({ diff: z.string(), guidelines: z.string() }),
  output: z.object({ approved: z.boolean(), comments: z.array(z.string()) }),
  prompt: (input) =>
    `Review this diff against the guidelines:\n${input.diff}\n\nGuidelines: ${input.guidelines}`,
  agent_opts: {
    agent_type: "plan",  // read-only OpenCode agent
  },
});

// ── Human checkpoint step ──────────────────────────────────
const approve = checkpoint({
  id: "manual_approval",
  input: z.object({ summary: z.string(), risk_level: z.enum(["low", "medium", "high"]) }),
  output: z.object({ approved: z.boolean(), notes: z.string().optional() }),
  prompt: (input) => `Approve deployment? Risk: ${input.risk_level}\n${input.summary}`,
});
```

### 2.3 Workflow Definition — The Type-Safe Wiring

The workflow builder uses TypeScript's type system to enforce that step connections are valid:

```typescript
const deploy = defineWorkflow({
  id: "deploy-feature",
  input: z.object({ branch: z.string(), env: z.enum(["staging", "prod"]) }),
})
  .pipe(compile, (wf_input) => ({ source_dir: "./src" }))
  .pipe(test_step, (wf_input, prev) => ({ test_dir: "./tests" }))
  .pipe(implement, (wf_input, prev) => ({
    spec: `Deploy branch ${wf_input.branch} with ${prev.passed} passing tests`,
    target_files: ["src/deploy.ts"],
  }))
  .pipe(review, (wf_input, prev) => ({
    diff: prev.summary,                    // <-- TypeScript knows prev is implement's output
    guidelines: "standard",
  }))
  .pipe(approve, (wf_input, prev) => ({
    summary: prev.comments.join("\n"),     // <-- TypeScript knows prev is review's output
    risk_level: wf_input.env === "prod" ? "high" as const : "low" as const,
  }))
  .done();
```

**Key insight**: The `pipe()` method's mapper function receives the **workflow input** and the **previous step's typed output**. TypeScript infers both. If you try to access a field that doesn't exist on the previous step's output schema, you get a compile error.

### 2.4 The Type Machinery (Implementation Detail)

```typescript
// ── WorkflowBuilder: accumulates steps, tracks type chain ──

type WorkflowBuilder<WI, LastO> = {
  pipe: <I, O>(
    step: Step<I, O>,
    mapper: (workflow_input: WI, previous_output: LastO) => I,
  ) => WorkflowBuilder<WI, O>;

  parallel: <Steps extends ParallelStepDef<WI, LastO, any, any>[]>(
    ...steps: Steps
  ) => WorkflowBuilder<WI, ParallelOutputTuple<Steps>>;

  done: () => Workflow<WI, LastO>;
};

// ── Workflow: the frozen, executable definition ────────────

type Workflow<I, O> = {
  id: string;
  input: z.ZodType<I>;
  output: z.ZodType<O>;   // inferred from last step
  steps: StepNode[];       // ordered list for execution
  asStep: () => Step<I, O>; // wrap workflow as composable step
};

// ── StepNode: runtime step entry in the workflow DAG ───────

type StepNode =
  | { type: "sequential"; step: Step<any, any>; mapper: MapperFn }
  | { type: "parallel"; branches: Array<{ step: Step<any, any>; mapper: MapperFn }> };

type MapperFn = (workflow_input: any, previous_output: any) => any;
```

### 2.5 Parallel Steps (DAG)

For v0.1, we support **linear pipelines** (`pipe()`) and **parallel fan-out/fan-in**:

```typescript
const ci = defineWorkflow({
  id: "ci-pipeline",
  input: z.object({ repo: z.string() }),
})
  .pipe(checkout, (wf) => ({ repo: wf.repo }))
  .parallel(
    [lint, (wf, prev) => ({ files: prev.files })],
    [test_step, (wf, prev) => ({ dir: prev.dir })],
    [typecheck, (wf, prev) => ({ tsconfig: prev.tsconfig })],
  )
  .pipe(deploy_step, (wf, prev) => ({
    // prev is a tuple: [LintOutput, TestOutput, TypecheckOutput]
    lint_passed: prev[0].passed,
    test_passed: prev[1].passed,
    types_ok: prev[2].passed,
  }))
  .done();
```

**`parallel()` types**: The return type is a tuple of each parallel step's output type:

```typescript
type ParallelStepDef<WI, PrevO, I, O> = [
  Step<I, O>,
  (workflow_input: WI, previous_output: PrevO) => I,
];

type ParallelOutputTuple<T extends [Step<any, any>, any][]> = {
  [K in keyof T]: T[K] extends [Step<any, infer O>, any] ? O : never;
};
```

### 2.6 Sub-Workflow Composition

A workflow is itself a valid step (same shape: input schema, output schema):

```typescript
const verify_and_commit = defineWorkflow({
  id: "verify-commit",
  input: z.object({ message: z.string() }),
})
  .pipe(typecheck_step, () => ({}))
  .pipe(test_step_2, () => ({}))
  .pipe(commit_step, (wf) => ({ message: wf.message }))
  .done();

// Use as a step in another workflow
const feature = defineWorkflow({ id: "feature", input: z.object({ branch: z.string() }) })
  .pipe(implement_step, (wf) => ({ branch: wf.branch }))
  .pipe(verify_and_commit.asStep(), (wf, prev) => ({ message: `feat: ${prev.description}` }))
  .done();
```

The `.asStep()` method on a Workflow wraps it as a `Step<WI, WO>` — its input/output schemas come from the workflow's own schemas. Internally it creates a `{ kind: "fn" }` step that recursively runs the sub-workflow through the engine.

---

## 3. AgentExecutor Interface

This is the primary architectural difference from the original plan. Agent steps don't call LLM APIs directly — they dispatch to an **AgentExecutor** that manages the full agentic coding loop.

### 3.1 The Interface

```typescript
// ── AgentExecutor: pluggable backend for agent steps ───────

type AgentExecutor = {
  /** Create a new agent session */
  createSession: (opts: CreateSessionOpts) => Promise<Result<AgentSession, AgentError>>;

  /** Send a prompt to an existing session and wait for completion */
  prompt: (session_id: string, opts: PromptOpts) => Promise<Result<AgentResponse, AgentError>>;

  /** Subscribe to real-time events from a session (optional) */
  subscribe?: (session_id: string) => AsyncIterable<AgentEvent>;

  /** Destroy a session */
  destroySession?: (session_id: string) => Promise<Result<void, AgentError>>;
};

// ── Session types ──────────────────────────────────────────

type CreateSessionOpts = {
  title?: string;
  system_prompt?: string;
  working_directory?: string;
};

type AgentSession = {
  id: string;
  created_at: Date;
};

type PromptOpts = {
  text: string;
  model?: { provider_id: string; model_id: string };
  agent_type?: "build" | "plan";
  timeout_ms?: number;
};

type AgentResponse = {
  session_id: string;
  /** Raw text output from the agent */
  text: string;
  /** Structured data extracted via output schema parsing */
  metadata: {
    files_changed?: string[];
    tool_calls?: AgentToolCall[];
    tokens_used?: { input: number; output: number };
    duration_ms: number;
  };
};

type AgentToolCall = {
  tool: string;
  args: Record<string, unknown>;
  result?: string;
};

// ── Agent events (for real-time streaming) ─────────────────

type AgentEvent =
  | { type: "session_created"; session_id: string; timestamp: Date }
  | { type: "prompt_sent"; session_id: string; text: string; timestamp: Date }
  | { type: "tool_call"; session_id: string; tool: string; args: Record<string, unknown>; timestamp: Date }
  | { type: "tool_result"; session_id: string; tool: string; result: string; timestamp: Date }
  | { type: "text_chunk"; session_id: string; text: string; timestamp: Date }
  | { type: "completed"; session_id: string; response: AgentResponse; timestamp: Date }
  | { type: "error"; session_id: string; error: AgentError; timestamp: Date };
```

### 3.2 How Agent Steps Execute

When the engine encounters a step with `kind: "agent"`, the flow diverges based on the step's `mode`:

**Common setup (both modes):**
1. Calls `prompt()` builder with the step's input → produces prompt text
2. Creates an agent session via `executor.createSession()`
3. Sends the prompt via `executor.prompt(session_id, { text, model, agent_type })`
4. Receives `AgentResponse` with raw text + metadata
5. Emits trace events for the agent session

**`mode: "analyze"` (default) — Output from LLM text:**
6. System prompt is prepended with output schema description (JSON Schema)
7. Response text is parsed for JSON (full text, or first `{...}`/`[...]` block)
8. Parsed JSON is validated against the step's output Zod schema
9. Returns `Result<O, StepError>` where `O` is the validated output

**`mode: "build"` — Output from session metadata:**
6. No schema injection in the system prompt (agent writes code, not JSON)
7. `AgentResponse.metadata` is used as the output source
8. Metadata fields are mapped to the output schema (e.g., `metadata.files_changed` → `output.files_changed`)
9. The mapped object is validated against the step's output Zod schema
10. `success` is inferred as `true` if the agent completed without error (unless explicitly in metadata)

```typescript
// Simplified execution flow for agent steps (inside engine.ts)

async function executeAgentStep<I, O>(
  step: Step<I, O>,
  input: I,
  ctx: StepContext,
  executor: AgentExecutor,
): Promise<Result<O, StepError>> {
  if (step.kind.kind !== "agent") return err(errors.execution(step.id, "not an agent step"));

  const { mode } = step.kind;
  const prompt_text = step.kind.prompt(input);

  // For "analyze" mode, inject the output schema into the system prompt
  const system_prompt = mode === "analyze"
    ? [step.kind.agent_opts?.system_prompt, formatOutputSchemaPrompt(step.output)].filter(Boolean).join("\n\n")
    : step.kind.agent_opts?.system_prompt;

  const session_result = await executor.createSession({
    title: `runbook:${ctx.workflow_id}:${step.id}`,
    system_prompt,
  });
  if (!session_result.ok) return err(errors.agent(step.id, session_result.error));

  const session = session_result.value;
  ctx.trace.emit({ type: "agent_session_created", step_id: step.id, session_id: session.id, timestamp: new Date() });

  const response_result = await executor.prompt(session.id, {
    text: prompt_text,
    model: step.kind.agent_opts?.model,
    agent_type: step.kind.agent_opts?.agent_type,
    timeout_ms: step.kind.agent_opts?.timeout_ms,
  });
  if (!response_result.ok) return err(errors.agent(step.id, response_result.error));

  const response = response_result.value;
  ctx.trace.emit({ type: "agent_response", step_id: step.id, session_id: session.id, response, timestamp: new Date() });

  // ── Mode-specific output extraction ────────────────────
  if (mode === "build") {
    // Output is derived from metadata, not from LLM text
    const output_candidate = {
      ...response.metadata,
      success: response.metadata.success ?? true,
    };
    const parsed = step.output.safeParse(output_candidate);
    if (!parsed.success) return err(errors.validation(step.id, parsed.error.issues));
    return ok(parsed.data);
  }

  // mode === "analyze": parse JSON from response text
  const json_result = extractJson(response.text);
  if (!json_result.ok) return err(errors.agent_parse(step.id, response.text, []));

  const parsed = step.output.safeParse(json_result.value);
  if (!parsed.success) return err(errors.agent_parse(step.id, response.text, parsed.error.issues));

  return ok(parsed.data);
}
```

### 3.3 Output Schema Enforcement

Agent steps have a challenge: the agent returns free-form text, but the step has a typed output schema. The resolution strategy depends on the step's **mode**:

#### `mode: "analyze"` — JSON from LLM text

1. **System prompt injection**: The engine prepends a system prompt instructing the agent to return JSON matching the output schema
2. **JSON extraction**: The engine attempts to parse the response text as JSON. If the full text isn't valid JSON, it searches for the first `{...}` or `[...]` block
3. **Zod validation**: The parsed JSON is validated against the step's output schema
4. **Retry on failure**: If parsing/validation fails, the engine can optionally re-prompt the agent with the validation errors (configurable via `agent_opts.retry_on_parse_failure`)

```typescript
// Schema description generation for system prompt injection (analyze mode only)
function formatOutputSchemaPrompt(schema: z.ZodType): string {
  const json_schema = JSON.stringify(zodToJsonSchema(schema), null, 2);
  return `You MUST respond with a JSON object matching this schema:\n\`\`\`json\n${json_schema}\n\`\`\`\nRespond with ONLY the JSON object, no other text.`;
}
```

#### `mode: "build"` — Output from session metadata

1. **No schema injection** in system prompt — the agent writes code, runs commands, edits files
2. **Metadata mapping**: After the agent completes, `AgentResponse.metadata` is used as the output source
3. **Field mapping**: The engine spreads `metadata` fields and validates against the output schema
4. **Success inference**: If the output schema has a `success` field and it's not in metadata, it defaults to `true` (agent completed without error)

Build-mode output schemas should only reference fields available in `AgentResponse.metadata`: `files_changed`, `tool_calls`, `tokens_used`, `duration_ms`, plus a `success` boolean.

**DECISION NEEDED:** Should we depend on `zod-to-json-schema` for converting Zod schemas to JSON Schema descriptions in agent prompts? Alternative is a simpler custom serializer that handles common Zod types (object, array, string, number, enum, optional).

---

## 4. OpenCode Executor

The first `AgentExecutor` implementation, using `@opencode-ai/sdk`.

### 4.1 Implementation

```typescript
import { createOpencodeClient, createOpencode } from "@opencode-ai/sdk";

type OpenCodeExecutorOpts = {
  /** Connect to an existing OpenCode server */
  base_url?: string;
  /** Or start a new one (default behavior) */
  auto_start?: boolean;
  /** Auto-approve tool calls in headless mode (default: true).
   *  When using session.prompt() programmatically, OpenCode's SDK likely
   *  auto-approves tool calls. If not, this flag ensures the executor
   *  configures the session for non-interactive use. Set to false only
   *  if you want to manually approve tool calls via OpenCode's UI. */
  auto_approve?: boolean;
};

class OpenCodeExecutor implements AgentExecutor {
  private client: ReturnType<typeof createOpencodeClient>;

  static async create(opts: OpenCodeExecutorOpts = {}): Promise<Result<OpenCodeExecutor, AgentError>> {
    if (opts.base_url) {
      // Connect to existing server
      const client = createOpencodeClient({ baseUrl: opts.base_url });
      return ok(new OpenCodeExecutor(client));
    }
    // Start new server + client
    const oc = await createOpencode();
    return ok(new OpenCodeExecutor(oc.client));
  }

  async createSession(opts: CreateSessionOpts): Promise<Result<AgentSession, AgentError>> {
    const session = await this.client.session.create({
      body: { title: opts.title ?? "runbook-session" },
    });
    return ok({ id: session.id, created_at: new Date() });
  }

  async prompt(session_id: string, opts: PromptOpts): Promise<Result<AgentResponse, AgentError>> {
    const started = Date.now();
    const result = await this.client.session.prompt({
      path: { id: session_id },
      body: {
        model: opts.model
          ? { providerID: opts.model.provider_id, modelID: opts.model.model_id }
          : undefined,
        parts: [{ type: "text", text: opts.text }],
      },
    });
    // Map OpenCode response → AgentResponse
    return ok({
      session_id,
      text: extractTextFromResult(result),
      metadata: {
        files_changed: extractFilesChanged(result),
        tool_calls: extractToolCalls(result),
        duration_ms: Date.now() - started,
      },
    });
  }

  async *subscribe(session_id: string): AsyncIterable<AgentEvent> {
    const events = this.client.event.subscribe();
    for await (const event of events) {
      if (event.sessionID === session_id) {
        yield mapOpenCodeEvent(event);
      }
    }
  }

  async destroySession(session_id: string): Promise<Result<void, AgentError>> {
    // OpenCode sessions are persistent; we just stop tracking them
    return ok(undefined);
  }
}
```

### 4.2 OpenCode Agent Type Mapping

OpenCode has built-in agent types that map to runbook's `agent_type` option:

| Runbook `agent_type` | OpenCode agent | Capabilities |
|---------------------|----------------|--------------|
| `"build"` | Default agent | Full access: read files, write files, run shell commands |
| `"plan"` | Plan agent | Read-only: can read files and analyze, but cannot write |
| `undefined` | Default agent | Falls back to `"build"` |

### 4.3 Connecting to OpenCode

Three modes of operation:

1. **Auto-start** (default): Runbook server calls `createOpencode()` which starts an OpenCode server process and returns a connected client. Best for local dev.

2. **Connect to existing**: User runs `opencode serve` separately, configures runbook with `base_url: "http://localhost:4096"`. Best for shared/remote setups.

3. **CLI attach mode**: For debugging, users can also run `opencode run --attach http://localhost:4096 "prompt"` to interact with the same server the runbook is using.

**Working directory propagation:** `RunbookConfig.working_directory` flows through to the agent executor:
- `RunbookConfig.working_directory` → server reads from config
- `ProviderConfig.agent.working_directory` → passed to `createSession({ working_directory })`
- `CreateSessionOpts.working_directory` → already exists in the interface (Section 3.1)

If not explicitly set, defaults to the directory containing `runbook.config.ts`.

Configuration in `runbook.config.ts`:

```typescript
export default defineConfig({
  workflows: [deploy, ci],
  working_directory: process.cwd(),  // optional, defaults to config file location
  providers: {
    agent: {
      type: "opencode",
      base_url: process.env.OPENCODE_URL,  // optional; auto-starts if omitted
    },
    // Future: agent: { type: "claude-code", api_key: "..." }
  },
});
```

---

## 5. Server Design

### 5.1 Server Architecture

The server is a Hono HTTP app that manages workflow execution:

```typescript
import { Hono } from "hono";

type ServerDeps = {
  engine: Engine;
  state: RunStateStore;
  workflows: Map<string, Workflow<any, any>>;
};

function createServer(deps: ServerDeps): Hono {
  const app = new Hono();

  // Health check
  app.get("/health", (c) => c.json({ status: "ok" }));

  // List registered workflows
  app.get("/workflows", (c) => {
    const workflows = Array.from(deps.workflows.entries()).map(([id, wf]) => ({
      id,
      input_schema: zodToJsonSchema(wf.input),
      output_schema: zodToJsonSchema(wf.output),
      step_count: wf.steps.length,
    }));
    return c.json({ workflows });
  });

  // Submit a workflow run
  app.post("/workflows/:id/run", async (c) => {
    const workflow_id = c.req.param("id");
    const workflow = deps.workflows.get(workflow_id);
    if (!workflow) return c.json({ error: "workflow not found" }, 404);

    const body = await c.req.json();
    const run_id = generateRunId();

    // Start async execution
    deps.state.create(run_id, workflow_id);
    executeAsync(deps, workflow, body.input, run_id);

    return c.json({ run_id, status: "started" }, 202);
  });

  // Get run status
  app.get("/runs/:id", (c) => {
    const run = deps.state.get(c.req.param("id"));
    if (!run) return c.json({ error: "run not found" }, 404);
    return c.json(run);
  });

  // Get run trace
  app.get("/runs/:id/trace", (c) => {
    const run = deps.state.get(c.req.param("id"));
    if (!run) return c.json({ error: "run not found" }, 404);
    return c.json({ trace: run.trace });
  });

  // SSE stream for real-time run events
  app.get("/runs/:id/events", (c) => {
    // Server-sent events for real-time trace streaming
    return streamSSE(c, async (stream) => {
      const run = deps.state.get(c.req.param("id"));
      if (!run) { await stream.close(); return; }
      for await (const event of run.events) {
        await stream.writeSSE({ data: JSON.stringify(event), event: event.type });
      }
    });
  });

  return app;
}
```

### 5.2 Run State Store

In-memory state for v0.1. Tracks active and completed runs:

```typescript
type RunState = {
  run_id: string;
  workflow_id: string;
  status: "pending" | "running" | "success" | "failure";
  input: unknown;
  output?: unknown;
  error?: WorkflowError;
  trace: Trace;
  started_at: Date;
  completed_at?: Date;
};

type RunStateStore = {
  create: (run_id: string, workflow_id: string) => void;
  get: (run_id: string) => RunState | undefined;
  update: (run_id: string, patch: Partial<RunState>) => void;
  list: () => RunState[];
};
```

### 5.3 Checkpoint Flow

When the engine encounters a checkpoint step, it pauses execution and waits for external input via the server API:

1. Engine hits a checkpoint step
2. Engine emits `checkpoint_waiting` trace event with the prompt text and a `checkpoint_id` (generated UUID)
3. Engine creates a `Promise` and stores the resolver function in the run state (`pending_checkpoints` map)
4. Server exposes `POST /runs/:id/checkpoints/:checkpoint_id` endpoint
5. CLI receives the `checkpoint_waiting` SSE event via the `/runs/:id/events` stream
6. CLI prompts the user for input (stdin)
7. CLI POSTs the user's response to the checkpoint endpoint
8. Server validates the response body against the checkpoint step's Zod output schema
9. Server resolves the stored Promise with the validated data; engine continues execution

```typescript
// Added to RunState
type RunState = {
  // ... existing fields ...
  pending_checkpoints: Map<string, {
    step_id: string;
    schema: z.ZodType;
    resolve: (value: unknown) => void;
    reject: (error: CheckpointError) => void;
  }>;
};

// Checkpoint route (added to routes/runs.ts)
// POST /runs/:id/checkpoints/:checkpoint_id
app.post("/runs/:id/checkpoints/:checkpoint_id", async (c) => {
  const run = deps.state.get(c.req.param("id"));
  if (!run) return c.json({ error: "run not found" }, 404);

  const checkpoint = run.pending_checkpoints.get(c.req.param("checkpoint_id"));
  if (!checkpoint) return c.json({ error: "checkpoint not found or already resolved" }, 404);

  const body = await c.req.json();
  const parsed = checkpoint.schema.safeParse(body.value);
  if (!parsed.success) return c.json({ error: "validation_failed", issues: parsed.error.issues }, 400);

  checkpoint.resolve(parsed.data);
  run.pending_checkpoints.delete(c.req.param("checkpoint_id"));
  return c.json({ status: "resolved" }, 200);
});
```

The `checkpoint_waiting` trace event includes the `checkpoint_id` so the CLI knows which endpoint to POST to:

```typescript
// Extended trace event (addition to Section 7.1)
| { type: "checkpoint_waiting"; step_id: string; checkpoint_id: string; prompt: string; timestamp: Date }
```

### 5.4 Execution Engine

The engine lives in the server package. It takes workflow definitions from core and executes them using providers:

```typescript
type Engine = {
  run: <I, O>(
    workflow: Workflow<I, O>,
    input: I,
    opts?: RunOpts,
  ) => Promise<Result<RunResult<O>, WorkflowError>>;
};

type RunOpts = {
  run_id?: string;
  providers?: ProviderConfig;
  signal?: AbortSignal;
  on_trace?: (event: TraceEvent) => void;
};

type RunResult<O> = {
  output: O;
  trace: Trace;
  duration_ms: number;
};

type ProviderConfig = {
  shell?: ShellProvider;
  agent?: AgentExecutor;
  checkpoint?: CheckpointProvider;
};
```

**Execution flow:**
1. Validate workflow structure
2. Create trace collector
3. Iterate step nodes (handles sequential + parallel groups)
4. For each step: run mapper → validate input → dispatch to provider → validate output → emit trace
5. Return `Result<RunResult<O>, WorkflowError>`

Provider dispatch based on `step.kind.kind`:
- `"fn"` → direct invocation
- `"shell"` → `ShellProvider.exec()`
- `"agent"` → `AgentExecutor.createSession()` + `AgentExecutor.prompt()`
- `"checkpoint"` → `CheckpointProvider.prompt()`

### 5.5 Server Startup

```typescript
// packages/server/src/index.ts

async function startServer(config: RunbookConfig): Promise<void> {
  const agent_executor = await resolveAgentExecutor(config.providers?.agent);
  const shell_provider = new BunShellProvider();
  const state = createInMemoryStateStore();

  const engine = createEngine({
    providers: {
      shell: shell_provider,
      agent: agent_executor,
    },
  });

  const workflows = new Map(config.workflows.map((wf) => [wf.id, wf]));
  const app = createServer({ engine, state, workflows });

  const port = config.server?.port ?? 4400;
  Bun.serve({ fetch: app.fetch, port });
  console.log(`Runbook server listening on http://localhost:${port}`);
}
```

---

## 6. CLI Design

### 6.1 Commands

| Command | Description |
|---------|-------------|
| `runbook serve` | Start the runbook server (loads config, starts HTTP server) |
| `runbook run <workflow> [--input json]` | Submit a workflow run to the server |
| `runbook status <run-id>` | Get current status of a run |
| `runbook trace <run-id>` | Display a run's full trace |
| `runbook list` | List available workflows from the server |
| `runbook history` | List all stored runs from git artifact store |
| `runbook show <run-id> [step-id]` | Show run summary or step artifacts |
| `runbook diff <run-id-1> <run-id-2>` | Diff two stored runs |
| `runbook push [--remote origin]` | Push artifact refs to remote |
| `runbook pull [--remote origin]` | Pull artifact refs from remote |

### 6.2 CLI HTTP Client

The CLI is a thin HTTP client. No workflow logic lives here:

```typescript
type RunbookClient = {
  listWorkflows: () => Promise<Result<WorkflowInfo[], ClientError>>;
  submitRun: (workflow_id: string, input: unknown) => Promise<Result<{ run_id: string }, ClientError>>;
  getRunStatus: (run_id: string) => Promise<Result<RunState, ClientError>>;
  getRunTrace: (run_id: string) => Promise<Result<Trace, ClientError>>;
  streamEvents: (run_id: string) => AsyncIterable<TraceEvent>;
};

function createRunbookClient(base_url: string): RunbookClient {
  return {
    async listWorkflows() {
      const res = await fetch(`${base_url}/workflows`);
      if (!res.ok) return err({ kind: "http_error", status: res.status, message: await res.text() });
      return ok((await res.json()).workflows);
    },
    // ... etc
  };
}
```

### 6.3 Config File

`runbook.config.ts` at project root:

```typescript
import { defineConfig } from "@f0rbit/runbook";
import { deploy } from "./workflows/deploy";
import { ci } from "./workflows/ci";

export default defineConfig({
  workflows: [deploy, ci],
  server: {
    port: 4400,
  },
  providers: {
    agent: {
      type: "opencode",
      base_url: process.env.OPENCODE_URL,  // auto-starts if omitted
    },
  },
});
```

The `defineConfig` helper is exported from `@f0rbit/runbook` (core) for type safety. The CLI and server both load this config.

**Config discovery order:**
1. `--config <path>` CLI flag (explicit path)
2. `runbook.config.ts` in current working directory
3. `runbook.config.ts` walking up parent directories (like `package.json` resolution)

The config loader (`packages/cli/src/config.ts`) uses Bun's native `import()` to dynamically load the config file. Walking up parent directories stops at the filesystem root or when a `package.json` with `"private": true` is found (workspace root heuristic).

### 6.4 CLI Implementation

Use raw `process.argv` parsing — no CLI framework dependency:

```typescript
#!/usr/bin/env bun

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "serve":   return handleServe(args);
  case "run":     return handleRun(args);
  case "status":  return handleStatus(args);
  case "trace":   return handleTrace(args);
  case "list":    return handleList(args);
  case "history": return handleHistory(args);
  case "show":    return handleShow(args);
  case "diff":    return handleDiff(args);
  default:        return printHelp();
}
```

### 6.5 `runbook run` with Real-Time Output

When the user runs `runbook run deploy-feature --input '{"branch": "main"}'`:

1. CLI submits to server via `POST /workflows/deploy-feature/run`
2. Server returns `{ run_id: "abc123" }` with status 202
3. CLI connects to `GET /runs/abc123/events` (SSE)
4. CLI streams trace events to terminal in real-time:

```
$ runbook run deploy-feature --input '{"branch": "main", "env": "staging"}'

▸ deploy-feature [run:abc123]
  ✓ compile           12.3s  { artifacts: ["dist/index.js"], success: true }
  ✓ test               4.1s  { passed: 42, failed: 0 }
  ◎ implement_feature  —     agent session:s7f2a created
    ↳ tool: read_file("src/deploy.ts")
    ↳ tool: edit_file("src/deploy.ts", ...)
    ↳ tool: run_command("bun test src/deploy.test.ts")
  ✓ implement_feature 28.4s  { files_changed: ["src/deploy.ts"], success: true }
  ✓ code_review        8.7s  { approved: true, comments: [] }
  ⏸ manual_approval    —     waiting for input...
    > Approve deployment? Risk: low
    > [y/n]: y
  ✓ manual_approval    0.1s  { approved: true }

✓ Completed in 53.6s
```

---

## 7. Trace System

Every execution produces a structured `Trace` — a typed event stream. The revised version includes agent-specific events.

### 7.1 Trace Events

```typescript
type TraceEvent =
  // Workflow lifecycle
  | { type: "workflow_start"; workflow_id: string; run_id: string; input: unknown; timestamp: Date }
  | { type: "workflow_complete"; output: unknown; duration_ms: number; timestamp: Date }
  | { type: "workflow_error"; error: WorkflowError; duration_ms: number; timestamp: Date }
  // Step lifecycle
  | { type: "step_start"; step_id: string; input: unknown; timestamp: Date }
  | { type: "step_complete"; step_id: string; output: unknown; duration_ms: number; timestamp: Date }
  | { type: "step_error"; step_id: string; error: StepError; duration_ms: number; timestamp: Date }
  | { type: "step_skipped"; step_id: string; reason: string; timestamp: Date }
  // Agent events (nested within a step)
  | { type: "agent_session_created"; step_id: string; session_id: string; timestamp: Date }
  | { type: "agent_prompt_sent"; step_id: string; session_id: string; prompt: string; timestamp: Date }
  | { type: "agent_tool_call"; step_id: string; session_id: string; tool: string; args: Record<string, unknown>; timestamp: Date }
  | { type: "agent_tool_result"; step_id: string; session_id: string; tool: string; result: string; timestamp: Date }
  | { type: "agent_response"; step_id: string; session_id: string; response: AgentResponse; timestamp: Date }
  // Checkpoint events
  | { type: "checkpoint_waiting"; step_id: string; checkpoint_id: string; prompt: string; timestamp: Date }
  | { type: "checkpoint_resolved"; step_id: string; checkpoint_id: string; input: unknown; timestamp: Date };

type Trace = {
  run_id: string;
  workflow_id: string;
  events: TraceEvent[];
  status: "success" | "failure";
  duration_ms: number;
};
```

### 7.2 Trace Collector

```typescript
type TraceEmitter = {
  emit: (event: TraceEvent) => void;
};

class TraceCollector implements TraceEmitter {
  events: TraceEvent[] = [];
  listeners: ((event: TraceEvent) => void)[] = [];

  emit(event: TraceEvent): void {
    this.events.push(event);
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  onEvent(listener: (event: TraceEvent) => void): void {
    this.listeners.push(listener);
  }

  toTrace(run_id: string, workflow_id: string, status: "success" | "failure", duration_ms: number): Trace {
    return { run_id, workflow_id, events: this.events, status, duration_ms };
  }
}
```

---

## 8. Git Artifact Store (`packages/git-store`)

After each workflow run, the complete execution trace and all agent artifacts are stored in git's object database under custom refs (`refs/runbook/runs/<run-id>`). This is separate from commits — invisible to `git log`, pushable/pullable independently, browsable via git commands or the CLI.

**Package:** `packages/git-store` → `@f0rbit/runbook-git-store`

### 8.1 Ref Structure

```
refs/runbook/runs/<run-id>     → tree object:
  ├── trace.json               → full workflow trace
  ├── metadata.json            → workflow input, timestamps, commit SHA (if any)
  ├── steps/
  │   ├── <step-id>/
  │   │   ├── input.json       → step input (after mapper)
  │   │   ├── output.json      → step output (validated)
  │   │   ├── prompt.txt       → (agent steps) exact prompt sent
  │   │   ├── response.json    → (agent steps) full agent response + tool calls
  │   │   └── iterations/      → (agent steps, if retries)
  │   │       ├── 01.json
  │   │       └── 02.json
  │   └── ...
```

### 8.2 Interface

```typescript
type GitArtifactStore = {
  /** Store a completed run's artifacts in git refs */
  store: (run: RunResult, opts?: StoreOpts) => Promise<Result<StoredRun, GitStoreError>>;

  /** List all stored runs */
  list: (opts?: ListOpts) => Promise<Result<StoredRunInfo[], GitStoreError>>;

  /** Retrieve a specific run's trace */
  getTrace: (run_id: string) => Promise<Result<Trace, GitStoreError>>;

  /** Retrieve a specific step's artifacts */
  getStepArtifacts: (run_id: string, step_id: string) => Promise<Result<StepArtifacts, GitStoreError>>;

  /** Link a run to a commit SHA */
  linkToCommit: (run_id: string, commit_sha: string) => Promise<Result<void, GitStoreError>>;

  /** Push artifact refs to a remote */
  push: (opts?: SyncOpts) => Promise<Result<SyncResult, GitStoreError>>;

  /** Pull artifact refs from a remote */
  pull: (opts?: SyncOpts) => Promise<Result<SyncResult, GitStoreError>>;
};

type SyncOpts = {
  remote?: string;       // default: "origin"
  cwd?: string;
};

type SyncResult = {
  refs_synced: number;
  remote: string;
};

type StoreOpts = {
  commit_sha?: string;   // link to a commit
  cwd?: string;          // git repo directory
};

type ListOpts = {
  limit?: number;
  workflow_id?: string;  // filter by workflow
  cwd?: string;
};

type StoredRun = {
  run_id: string;
  ref: string;           // full ref path
};

type StoredRunInfo = {
  run_id: string;
  workflow_id: string;
  status: "success" | "failure";
  started_at: Date;
  duration_ms: number;
  commit_sha?: string;
};

type StepArtifacts = {
  step_id: string;
  input: unknown;
  output: unknown;
  prompt?: string;        // agent steps only
  response?: AgentResponse;
  iterations?: AgentResponse[];
};

type GitStoreError =
  | { kind: "git_not_found"; cwd: string }
  | { kind: "ref_not_found"; run_id: string }
  | { kind: "git_command_failed"; command: string; stderr: string; exit_code: number }
  | { kind: "parse_error"; path: string; cause: string };
```

### 8.3 Implementation

Uses `Bun.spawn` to call git commands (no git library dependency):

- `git hash-object -w --stdin` → write blob, get SHA
- `git mktree` → create tree from entries
- `git update-ref refs/runbook/runs/<id> <tree-sha>` → create ref
- `git for-each-ref refs/runbook/runs/` → list runs
- `git cat-file -p <ref>:<path>` → read artifact
- `git push <remote> 'refs/runbook/runs/*:refs/runbook/runs/*'` → push artifacts
- `git fetch <remote> 'refs/runbook/runs/*:refs/runbook/runs/*'` → pull artifacts

Low-level git wrappers are isolated in `git.ts`. The store implementation in `store.ts` composes these to build the tree structure from a `RunResult`.

### 8.4 Integration with Server

After `engine.run()` completes, the server optionally calls `store.store(result)`. Controlled by config:

```typescript
export default defineConfig({
  workflows: [deploy, ci],
  artifacts: {
    git: true,  // enable git artifact storage (default: true)
  },
  // ...
});
```

### 8.5 CLI Commands (additions)

| Command | Description |
|---------|-------------|
| `runbook history` | List all stored runs (reads `refs/runbook/runs/*`) |
| `runbook show <run-id>` | Show run summary |
| `runbook show <run-id> <step-id>` | Show step artifacts (prompt, response, iterations) |
| `runbook show <run-id> <step-id> --prompt` | Show just the prompt |
| `runbook diff <run-id-1> <run-id-2>` | Diff two runs |
| `runbook push [--remote origin]` | Push artifact refs to remote |
| `runbook pull [--remote origin]` | Pull artifact refs from remote |

### 8.6 Package Structure

```
packages/git-store/
├── src/
│   ├── index.ts          # Barrel export
│   ├── store.ts          # GitArtifactStore implementation
│   ├── git.ts            # Low-level git command wrappers
│   └── types.ts          # Types (StoredRun, StepArtifacts, GitStoreError, etc.)
├── __tests__/
│   └── integration/
│       └── git-store.test.ts   # Tests using a temp git repo
└── package.json
```

**`package.json`:**
```json
{
  "name": "@f0rbit/runbook-git-store",
  "version": "0.0.1",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "dependencies": {
    "@f0rbit/runbook": "workspace:*",
    "@f0rbit/corpus": "^0.3",
    "zod": "^3"
  }
}
```

### 8.7 Testing

Integration tests create a temp directory, `git init`, run a workflow with in-memory providers, store artifacts, and verify they can be read back. No real LLM needed. Tests exercise:

- Store a `RunResult` → verify ref exists via `git for-each-ref`
- List runs → verify count and metadata
- Get trace → verify round-trip JSON fidelity
- Get step artifacts → verify prompt, response, input, output
- Link to commit → verify metadata includes commit SHA
- Error cases: not a git repo, invalid run_id

---

## 9. Error Types

Using `@f0rbit/corpus` Result pattern. All errors are discriminated unions with a `kind` field:

```typescript
type StepError =
  | { kind: "validation_error"; step_id: string; issues: z.ZodIssue[] }
  | { kind: "execution_error"; step_id: string; cause: string }
  | { kind: "timeout"; step_id: string; timeout_ms: number }
  | { kind: "aborted"; step_id: string }
  | { kind: "shell_error"; step_id: string; command: string; code: number; stderr: string }
  | { kind: "agent_error"; step_id: string; session_id?: string; cause: string }
  | { kind: "agent_parse_error"; step_id: string; raw_output: string; issues: z.ZodIssue[] }
  | { kind: "checkpoint_rejected"; step_id: string };

type WorkflowError =
  | { kind: "step_failed"; step_id: string; error: StepError; trace: Trace }
  | { kind: "invalid_workflow"; issues: string[] }
  | { kind: "config_error"; message: string };

type AgentError =
  | { kind: "connection_failed"; url: string; cause: string }
  | { kind: "session_failed"; cause: string }
  | { kind: "prompt_failed"; session_id: string; cause: string }
  | { kind: "timeout"; session_id: string; timeout_ms: number };

type ClientError =
  | { kind: "http_error"; status: number; message: string }
  | { kind: "connection_refused"; url: string }
  | { kind: "parse_error"; body: string };
```

Error constructors (factory functions, not classes):

```typescript
const errors = {
  validation: (step_id: string, issues: z.ZodIssue[]): StepError =>
    ({ kind: "validation_error", step_id, issues }),
  execution: (step_id: string, cause: string): StepError =>
    ({ kind: "execution_error", step_id, cause }),
  shell: (step_id: string, command: string, code: number, stderr: string): StepError =>
    ({ kind: "shell_error", step_id, command, code, stderr }),
  agent: (step_id: string, cause: AgentError): StepError =>
    ({ kind: "agent_error", step_id, session_id: undefined, cause: formatAgentError(cause) }),
  agent_parse: (step_id: string, raw_output: string, issues: z.ZodIssue[]): StepError =>
    ({ kind: "agent_parse_error", step_id, raw_output, issues }),
  timeout: (step_id: string, timeout_ms: number): StepError =>
    ({ kind: "timeout", step_id, timeout_ms }),
  aborted: (step_id: string): StepError =>
    ({ kind: "aborted", step_id }),
  checkpoint_rejected: (step_id: string): StepError =>
    ({ kind: "checkpoint_rejected", step_id }),
  step_failed: (step_id: string, error: StepError, trace: Trace): WorkflowError =>
    ({ kind: "step_failed", step_id, error, trace }),
  invalid_workflow: (issues: string[]): WorkflowError =>
    ({ kind: "invalid_workflow", issues }),
  config_error: (message: string): WorkflowError =>
    ({ kind: "config_error", message }),
};
```

---

## 10. Provider Interfaces

```typescript
// ── Shell Provider ─────────────────────────────────────────

type ShellProvider = {
  exec: (command: string, opts?: ShellOpts) => Promise<Result<ShellResult, ShellError>>;
};

type ShellOpts = {
  cwd?: string;
  env?: Record<string, string>;
  timeout_ms?: number;
  signal?: AbortSignal;
};

type ShellResult = {
  stdout: string;
  stderr: string;
  exit_code: number;
};

type ShellError = { kind: "shell_spawn_error"; command: string; cause: string };

// ── Checkpoint Provider ────────────────────────────────────

type CheckpointProvider = {
  prompt: (message: string, schema: z.ZodType) => Promise<Result<unknown, CheckpointError>>;
};

type CheckpointError =
  | { kind: "checkpoint_timeout" }
  | { kind: "checkpoint_rejected" }
  | { kind: "checkpoint_invalid_input"; issues: z.ZodIssue[] };

// ── Agent Executor ─────────────────────────────────────────
// (Defined in Section 3.1)
```

---

## 11. Testing Strategy

### 11.1 In-Memory Providers

All three provider types have in-memory implementations for testing:

```typescript
// ── InMemoryShellProvider ──────────────────────────────────

class InMemoryShellProvider implements ShellProvider {
  private responses: Array<{ pattern: RegExp | string; result: ShellResult }> = [];
  executed: Array<{ command: string; opts?: ShellOpts }> = [];

  /** Register a scripted response for commands matching a pattern */
  on(pattern: RegExp | string, result: Partial<ShellResult> & { stdout: string }): void {
    this.responses.push({
      pattern: typeof pattern === "string" ? new RegExp(pattern) : pattern,
      result: { stdout: result.stdout, stderr: result.stderr ?? "", exit_code: result.exit_code ?? 0 },
    });
  }

  async exec(command: string, opts?: ShellOpts): Promise<Result<ShellResult, ShellError>> {
    this.executed.push({ command, opts });
    const match = this.responses.find((r) =>
      typeof r.pattern === "string" ? command.includes(r.pattern) : r.pattern.test(command),
    );
    if (!match) return err({ kind: "shell_spawn_error", command, cause: "no scripted response" });
    return ok(match.result);
  }
}

// ── InMemoryAgentExecutor ──────────────────────────────────

class InMemoryAgentExecutor implements AgentExecutor {
  private responses: Array<{ pattern: RegExp | string; response: Partial<AgentResponse> & { text: string } }> = [];
  private sessions: Map<string, { title?: string }> = new Map();
  prompted: Array<{ session_id: string; opts: PromptOpts }> = [];
  private next_session_id = 1;

  /** Register a scripted response for prompts matching a pattern */
  on(pattern: RegExp | string, response: Partial<AgentResponse> & { text: string }): void {
    this.responses.push({
      pattern: typeof pattern === "string" ? new RegExp(pattern) : pattern,
      response,
    });
  }

  async createSession(opts: CreateSessionOpts): Promise<Result<AgentSession, AgentError>> {
    const id = `test-session-${this.next_session_id++}`;
    this.sessions.set(id, { title: opts.title });
    return ok({ id, created_at: new Date() });
  }

  async prompt(session_id: string, opts: PromptOpts): Promise<Result<AgentResponse, AgentError>> {
    this.prompted.push({ session_id, opts });
    const match = this.responses.find((r) =>
      typeof r.pattern === "string" ? opts.text.includes(r.pattern) : r.pattern.test(opts.text),
    );
    if (!match) return err({ kind: "prompt_failed", session_id, cause: "no scripted response" });
    return ok({
      session_id,
      text: match.response.text,
      metadata: match.response.metadata ?? { duration_ms: 0 },
    });
  }

  async destroySession(): Promise<Result<void, AgentError>> {
    return ok(undefined);
  }
}

// ── InMemoryCheckpointProvider ─────────────────────────────

class InMemoryCheckpointProvider implements CheckpointProvider {
  private responses: Array<{ pattern: RegExp | string; value: unknown }> = [];
  prompted: Array<{ message: string }> = [];

  on(pattern: RegExp | string, value: unknown): void {
    this.responses.push({ pattern: typeof pattern === "string" ? new RegExp(pattern) : pattern, value });
  }

  async prompt(message: string, schema: z.ZodType): Promise<Result<unknown, CheckpointError>> {
    this.prompted.push({ message });
    const match = this.responses.find((r) =>
      typeof r.pattern === "string" ? message.includes(r.pattern) : r.pattern.test(message),
    );
    if (!match) return err({ kind: "checkpoint_rejected" });
    const parsed = schema.safeParse(match.value);
    if (!parsed.success) return err({ kind: "checkpoint_invalid_input", issues: parsed.error.issues });
    return ok(parsed.data);
  }
}
```

### 11.2 How the Engine is Tested

Integration tests run real workflows with in-memory providers:

```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import { defineWorkflow, fn, shell, agent } from "@f0rbit/runbook";
import { InMemoryShellProvider, InMemoryAgentExecutor } from "@f0rbit/runbook/test";
import { createEngine } from "@f0rbit/runbook-server";
import { ok } from "@f0rbit/corpus";
import { z } from "zod";

describe("engine workflow execution", () => {
  let shell_provider: InMemoryShellProvider;
  let agent_executor: InMemoryAgentExecutor;

  beforeEach(() => {
    shell_provider = new InMemoryShellProvider();
    agent_executor = new InMemoryAgentExecutor();
  });

  test("linear pipeline with agent step executes end-to-end", async () => {
    const analyze = agent({
      id: "analyze",
      input: z.object({ code: z.string() }),
      output: z.object({ issues: z.array(z.string()), severity: z.enum(["low", "medium", "high"]) }),
      prompt: (input) => `Analyze this code for issues:\n${input.code}`,
      agent_opts: { agent_type: "plan" },
    });

    const fix = agent({
      id: "fix",
      input: z.object({ issues: z.array(z.string()) }),
      output: z.object({ fixed: z.boolean(), files_changed: z.array(z.string()) }),
      prompt: (input) => `Fix these issues:\n${input.issues.join("\n")}`,
      agent_opts: { agent_type: "build" },
    });

    agent_executor.on(/Analyze/, {
      text: JSON.stringify({ issues: ["unused import"], severity: "low" }),
    });
    agent_executor.on(/Fix/, {
      text: JSON.stringify({ fixed: true, files_changed: ["src/main.ts"] }),
    });

    const wf = defineWorkflow({ id: "review-fix", input: z.object({ code: z.string() }) })
      .pipe(analyze, (wf_input) => ({ code: wf_input.code }))
      .pipe(fix, (_wf, prev) => ({ issues: prev.issues }))
      .done();

    const engine = createEngine({ providers: { agent: agent_executor } });
    const result = await engine.run(wf, { code: "import { unused } from 'foo';" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output.fixed).toBe(true);
      expect(result.value.output.files_changed).toEqual(["src/main.ts"]);
      expect(agent_executor.prompted).toHaveLength(2);
    }
  });
});
```

### 11.3 How the Server API is Tested

Integration tests hit the Hono app directly (no HTTP):

```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import { createServer } from "@f0rbit/runbook-server";
import { InMemoryAgentExecutor, InMemoryShellProvider } from "@f0rbit/runbook/test";
import { defineWorkflow, fn } from "@f0rbit/runbook";
import { ok } from "@f0rbit/corpus";
import { z } from "zod";

describe("server API", () => {
  let app: ReturnType<typeof createServer>;

  beforeEach(() => {
    const simple_wf = defineWorkflow({ id: "echo", input: z.object({ msg: z.string() }) })
      .pipe(
        fn({ id: "echo", input: z.object({ msg: z.string() }), output: z.object({ result: z.string() }),
          run: async (input) => ok({ result: input.msg }) }),
        (wf) => ({ msg: wf.msg }),
      )
      .done();

    app = createServer({
      engine: createEngine({}),
      state: createInMemoryStateStore(),
      workflows: new Map([["echo", simple_wf]]),
    });
  });

  test("POST /workflows/echo/run returns 202 with run_id", async () => {
    const res = await app.request("/workflows/echo/run", {
      method: "POST",
      body: JSON.stringify({ input: { msg: "hello" } }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.run_id).toBeDefined();
  });

  test("GET /workflows lists registered workflows", async () => {
    const res = await app.request("/workflows");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workflows).toHaveLength(1);
    expect(body.workflows[0].id).toBe("echo");
  });
});
```

### 11.4 How Users Test Their Workflows

Users import in-memory providers from `@f0rbit/runbook/test`:

```typescript
import { defineWorkflow, agent } from "@f0rbit/runbook";
import { InMemoryAgentExecutor } from "@f0rbit/runbook/test";
import { createEngine } from "@f0rbit/runbook-server";
import { deploy } from "./workflows/deploy";

test("deploy workflow succeeds when agent approves", async () => {
  const agent_executor = new InMemoryAgentExecutor();
  agent_executor.on(/implement/i, {
    text: JSON.stringify({ files_changed: ["src/deploy.ts"], summary: "deployed", success: true }),
  });
  agent_executor.on(/review/i, {
    text: JSON.stringify({ approved: true, comments: [] }),
  });

  const engine = createEngine({ providers: { agent: agent_executor } });
  const result = await engine.run(deploy, { branch: "main", env: "staging" });
  expect(result.ok).toBe(true);
});
```

### 11.5 What to Test

| Area | Test Type | Count | Package |
|------|-----------|-------|---------|
| Workflow builder type-safe wiring | Unit (compile-time) | 2-3 | core |
| DAG resolution / topological sort | Unit | 2-3 | core |
| Zod schema validation at step boundaries | Unit | 2-3 | core |
| Linear pipeline execution | Integration | 3-4 | server |
| Parallel step execution | Integration | 2-3 | server |
| Agent step with InMemoryAgentExecutor | Integration | 3-4 | server |
| Agent output schema parsing | Integration | 2-3 | server |
| Shell step with InMemoryShellProvider | Integration | 2-3 | server |
| Sub-workflow composition | Integration | 1-2 | server |
| Error propagation (step failure → workflow failure) | Integration | 2-3 | server |
| Server HTTP API (Hono app.request) | Integration | 4-5 | server |
| OpenCode executor mapping | Integration | 2-3 | server |
| CLI commands (via command handlers) | Integration | 3-4 | cli |
| Trace output formatting | Unit | 1-2 | cli |
| Git artifact store (store, list, get, link) | Integration | 4-6 | git-store |
| Server E2E (real HTTP, in-memory providers) | E2E | 2-3 | server |
| OpenCode E2E (real agent, conditional) | E2E | 1-2 | server |

**Total: ~45–52 tests.** Integration-heavy.

### 11.6 Dev Loop

**Fast loop (day-to-day):** `tsc --noEmit --watch` + `bun test --watch`
- Covers: type safety, unit tests, integration tests with in-memory providers, server API via `app.request()`
- Speed: ~3 seconds. Deterministic. Runs in CI.

**Full loop (OpenCode verification):**
```bash
# Terminal 1: OpenCode server
opencode serve --port 4096

# Terminal 2: run conditional E2E tests
OPENCODE_URL=http://localhost:4096 bun test --filter e2e
```
- Covers: real agent executor, real LLM calls, schema validation of non-deterministic output
- Speed: ~30-60s. Non-deterministic. Skipped in CI (no `OPENCODE_URL` env var).
- Uses `describe.skipIf(!OPENCODE_URL)` — graceful skip when env var is absent.
- Asserts **schema conformance** only, not exact output content.

**Manual exploration:**
```bash
# Terminal 1: opencode serve --port 4096
# Terminal 2: OPENCODE_URL=http://localhost:4096 runbook serve
# Terminal 3: runbook run analyze-file --input '{"file_path": "src/index.ts"}'
```

### 11.7 Example Workflow

An `examples/` directory ships with a minimal real workflow for manual exploration and E2E testing:

```
runbook/
├── examples/
│   ├── analyze-file.ts          # fn(read file) → agent(analyze, plan mode)
│   └── runbook.config.ts        # Example config pointing to examples
```

The `analyze-file` workflow:
1. `fn` step: reads a file from disk (pure function, deterministic)
2. `agent` step: sends file content to OpenCode plan agent, expects structured JSON report
3. Output schema: `{ summary: string, issues: Array<{ line, description, severity }>, suggestions: string[] }`

This is the smallest useful workflow that exercises the full path: type-safe wiring → engine dispatch → agent executor → Zod output validation.

### 11.8 Test Directory Structure

```
packages/
├── core/__tests__/
│   └── unit/                    # DAG resolution, schema validation
├── server/__tests__/
│   ├── integration/             # Engine, agent steps, server API (in-memory, CI-safe)
│   └── e2e/                     # Real OpenCode (conditional, manual)
├── cli/__tests__/
│   └── integration/             # CLI command handlers
├── git-store/__tests__/
│   └── integration/             # Git artifact store (uses temp repos)
```

---

## 12. Dependencies

| Package | Purpose | Where | Version |
|---------|---------|-------|---------|
| `zod` | Schema validation | core (peer), server, cli | `^3` |
| `@f0rbit/corpus` | Result types, pipe, error utilities | core, server, cli | `^0.3` |
| `hono` | HTTP server framework | server | `^4` |
| `@opencode-ai/sdk` | OpenCode agent executor | server | latest |
| `typescript` | Type checking | root (dev dep) | `^5` |
| `@types/bun` | Bun type definitions | root (dev dep) | latest |

**No CLI framework** (raw `process.argv`), **no test framework** beyond `bun:test`, **no build tool** beyond `tsc`.

**Bun-only runtime:** This project targets Bun only for v0.1. No build step, no JS compilation. Source `.ts` files are the distribution — consumers must use Bun to run them. This is consistent with the developer's other published packages (`@f0rbit/corpus`, `@f0rbit/ui`). Node.js support is explicitly future scope. Key Bun-specific APIs used: `Bun.spawn` (shell provider), `Bun.serve` (HTTP server), `bun:test` (test runner), native TypeScript imports (no transpilation).

### DECISION NEEDED: `@opencode-ai/sdk` version pinning

The `@opencode-ai/sdk` package is relatively new. Options:
- **Option A**: Pin to specific version and test against it. Pro: stability. Con: may miss API improvements.
- **Option B**: Use `^0.x` range and wrap SDK calls behind our `AgentExecutor` interface so SDK changes don't leak. Pro: flexibility. Con: may break on minor.

**Recommendation: Option B.** The `AgentExecutor` interface already insulates us. Pin the SDK version in lockfile but use `^` in package.json.

### DECISION NEEDED: `zod-to-json-schema` for agent prompt generation

Should we depend on `zod-to-json-schema` to convert Zod output schemas into JSON Schema for agent system prompts? 
- **Option A**: Depend on `zod-to-json-schema` (~80 LOC saved). Standard, well-maintained.
- **Option B**: Write a minimal custom serializer (~80 LOC) for common Zod types. Zero dependencies.

**Recommendation: Option A.** It's a mature, small package that handles edge cases we'd otherwise need to rewrite.

---

## 13. Phased Implementation Plan

### Phase 0: Scaffold (sequential)
> Foundation — creates all project config, workspace structure, and establishes the monorepo.

| Task | Files | Est. LOC | Dependencies |
|------|-------|----------|--------------|
| 0.1: Root workspace config | `package.json`, `tsconfig.json`, `biome.json`, `.gitignore` | ~80 | None |
| 0.2: Core package scaffold | `packages/core/package.json`, `packages/core/src/index.ts` | ~30 | 0.1 |
| 0.3: Server package scaffold | `packages/server/package.json`, `packages/server/src/index.ts` | ~30 | 0.1 |
| 0.4: CLI package scaffold | `packages/cli/package.json`, `packages/cli/src/index.ts` | ~30 | 0.1 |
| 0.5: Git-store package scaffold | `packages/git-store/package.json`, `packages/git-store/src/index.ts` | ~30 | 0.1 |
| 0.6: Examples directory | `examples/analyze-file.ts`, `examples/runbook.config.ts` | ~60 | 0.1 |
| 0.7: Run `bun install` to link workspaces | — | 0 | 0.2–0.6 |

**All sequential** — 0.1 first, then 0.2+0.3+0.4+0.5 in parallel, then 0.6.

**Verification:** `bun install && tsc --noEmit && biome check .`

**Commit:** `feat: scaffold runbook monorepo with core, server, cli, and git-store packages`

---

### Phase 1: Core Types + Step/Workflow Builders (parallel-safe)
> The core SDK — types, errors, step builders, workflow builder. Zero runtime logic.

| Task | Files | Est. LOC | Dependencies | Parallel? |
|------|-------|----------|--------------|-----------|
| 1.1: Core type definitions + error constructors | `packages/core/src/types.ts`, `packages/core/src/errors.ts` | ~250 | Phase 0 | Yes (with 1.2, 1.3) |
| 1.2: Zod schemas (config, trace events, API contracts) | `packages/core/src/schema.ts` | ~150 | Phase 0 | Yes (with 1.1, 1.3) |
| 1.3: Step builders (`fn`, `shell`, `agent`, `checkpoint`) | `packages/core/src/step.ts` | ~180 | Phase 0 | Yes (with 1.1, 1.2) |
| 1.4: Workflow builder (`defineWorkflow`, `pipe`, `parallel`, `done`, `asStep`) | `packages/core/src/workflow.ts` | ~220 | 1.1 (types) | After 1.1 |
| 1.5: Trace types + collector | `packages/core/src/trace.ts` | ~100 | 1.1 (types) | After 1.1 |
| 1.6: Barrel export + `defineConfig` | `packages/core/src/index.ts` | ~40 | 1.1–1.5 | After all |

**Agent A:** `types.ts` + `errors.ts` — All type definitions from Section 2 + Section 9. The `Step<I,O>`, `StepKind` (including `AgentOutputMode`), `StepContext`, `WorkflowBuilder`, `Workflow`, `StepNode`, `AgentExecutor`, `AgentSession`, `PromptOpts`, `AgentResponse`, `AgentEvent`, `TraceEvent`, `Trace`, all error types, all error factory functions.

**Agent B:** `schema.ts` — Zod schemas for: `RunbookConfig`, `ServerConfig`, `ProviderConfig`, `WorkflowInfo`, `RunState`, `TraceEvent` (Zod version of the type union), `AgentStepOpts`. The `defineConfig` schema.

**Agent C:** `step.ts` — Builder functions `fn()`, `shell()`, `agent()`, `checkpoint()`. Each returns a `Step<I, O>` with the appropriate `StepKind`. Pure construction — no execution logic.

**Agent D (after A completes):** `workflow.ts` — `defineWorkflow()` returning `WorkflowBuilder<WI, never>`. `pipe()`, `parallel()`, `done()`, `asStep()`. Builder accumulates `StepNode[]` entries.

**Agent E (after A completes):** `trace.ts` — `TraceCollector` class, `TraceEmitter` interface.

**Agent F (after all):** `index.ts` — Barrel export re-exporting everything users need.

**No shared files between parallel agents.** A/B/C read nothing from each other. D/E depend on A's types but don't modify `types.ts`.

**Verification:** `tsc --noEmit && biome check .`

**Commit:** `feat: implement core type system, step builders, and workflow builder`

---

### Phase 2: Engine + Providers (parallel-safe)
> Server-side execution runtime. The engine, real providers, and in-memory test providers.

| Task | Files | Est. LOC | Dependencies | Parallel? |
|------|-------|----------|--------------|-----------|
| 2.1: Execution engine | `packages/server/src/engine.ts` | ~300 | Phase 1 | Yes (with 2.2, 2.3, 2.4, 2.5) |
| 2.2: Provider interfaces | `packages/server/src/providers/types.ts` | ~80 | Phase 1 | Yes (with 2.1, 2.3, 2.4, 2.5) |
| 2.3: Shell provider (Bun.spawn) | `packages/server/src/providers/shell.ts` | ~80 | Phase 1 | Yes (with 2.1, 2.2, 2.4, 2.5) |
| 2.4: OpenCode executor | `packages/server/src/providers/opencode.ts` | ~180 | Phase 1 | Yes (with 2.1, 2.2, 2.3, 2.5) |
| 2.5: In-memory test providers | `packages/core/src/test.ts` | ~200 | Phase 1 | Yes (with 2.1, 2.2, 2.3, 2.4) |
| 2.6: Run state store | `packages/server/src/state.ts` | ~80 | Phase 1 | Yes (with 2.1) |

**Agent A:** `engine.ts` — `createEngine(opts?)` returning `Engine`. The `run()` method: validate workflow → create trace collector → iterate step nodes → dispatch to providers → validate I/O → emit traces → return Result.

**Agent B:** `providers/types.ts` — Re-exports `ShellProvider`, `CheckpointProvider` interfaces. Declares the `AgentExecutor` re-export for server-side use. (Note: the _interfaces_ live in core/types.ts, but this file provides the server-side type barrel for providers.)

**Agent C:** `providers/shell.ts` — `BunShellProvider` implementing `ShellProvider` using `Bun.spawn`. Wraps in Result.

**Agent D:** `providers/opencode.ts` — `OpenCodeExecutor` implementing `AgentExecutor` using `@opencode-ai/sdk`. Maps OpenCode sessions/prompts to our interface. Includes `createOpencode()` and `createOpencodeClient()` wrappers.

**Agent E:** `core/src/test.ts` — `InMemoryShellProvider`, `InMemoryAgentExecutor`, `InMemoryCheckpointProvider`. Exported via `@f0rbit/runbook/test`.

**Agent F:** `state.ts` — `createInMemoryStateStore()` returning `RunStateStore`. Simple `Map<string, RunState>` wrapper.

**No shared files.** All agents import from `@f0rbit/runbook` (core types) but don't modify core.

**Verification:** `tsc --noEmit && biome check .`

**Commit:** `feat: implement execution engine, providers, and in-memory test helpers`

---

### Phase 3: Server HTTP Layer (parallel-safe)
> Hono routes, server factory, and server entry point.

| Task | Files | Est. LOC | Dependencies | Parallel? |
|------|-------|----------|--------------|-----------|
| 3.1: Workflow routes | `packages/server/src/routes/workflows.ts` | ~100 | Phase 2 | Yes (with 3.2, 3.3) |
| 3.2: Run routes (status, trace, events SSE, checkpoint) | `packages/server/src/routes/runs.ts` | ~150 | Phase 2 | Yes (with 3.1, 3.3) |
| 3.3: Health route | `packages/server/src/routes/health.ts` | ~15 | Phase 2 | Yes (with 3.1, 3.2) |
| 3.4: Server factory (`createServer`) | `packages/server/src/server.ts` | ~60 | 3.1, 3.2, 3.3 | After routes |
| 3.5: Server barrel export | `packages/server/src/index.ts` | ~30 | 3.4 | After 3.4 |

**Agent A:** `routes/workflows.ts` — `GET /workflows`, `POST /workflows/:id/run` handlers.

**Agent B:** `routes/runs.ts` — `GET /runs/:id`, `GET /runs/:id/trace`, `GET /runs/:id/events` (SSE), `POST /runs/:id/checkpoints/:checkpoint_id` (checkpoint resolution).

**Agent C:** `routes/health.ts` — `GET /health`.

**Agent D (after A, B, C):** `server.ts` — `createServer(deps)` composing all routes into a Hono app. `startServer(config)` for standalone use.

**Agent E (after D):** `index.ts` — Barrel export for `createServer`, `createEngine`, `startServer`.

**Verification:** `tsc --noEmit && biome check .`

**Commit:** `feat: implement HTTP server with workflow, run, and health routes`

---

### Phase 3.5: Git Artifact Store (parallel-safe, runs in parallel with Phase 3)
> Git-based artifact storage for workflow traces and agent session data. Depends on Phase 1 (core types, Trace). Can run in parallel with Phase 3 (server HTTP layer).

| Task | Files | Est. LOC | Dependencies | Parallel? |
|------|-------|----------|--------------|-----------|
| 3.5.1: Types | `packages/git-store/src/types.ts` | ~60 | Phase 1 | Yes (with 3.5.2) |
| 3.5.2: Git command wrappers | `packages/git-store/src/git.ts` | ~120 | Phase 1 | Yes (with 3.5.1) |
| 3.5.3: GitArtifactStore implementation | `packages/git-store/src/store.ts` | ~200 | 3.5.1, 3.5.2 | After types + git |
| 3.5.4: Barrel export | `packages/git-store/src/index.ts` | ~15 | 3.5.3 | After store |
| 3.5.5: Integration tests | `packages/git-store/__tests__/integration/git-store.test.ts` | ~200 | 3.5.4 | After barrel |

**Agent A:** `types.ts` — `GitArtifactStore`, `StoreOpts`, `ListOpts`, `StoredRun`, `StoredRunInfo`, `StepArtifacts`, `GitStoreError`. All type definitions from Section 8.2.

**Agent B:** `git.ts` — Low-level wrappers: `hashObject(content)`, `mkTree(entries)`, `updateRef(ref, sha)`, `forEachRef(pattern)`, `catFile(ref, path)`. Each wraps `Bun.spawn` and returns `Result<T, GitStoreError>`.

**Agent C (after A, B):** `store.ts` — `createGitArtifactStore(opts?)` returning `GitArtifactStore`. Implements `store()`, `list()`, `getTrace()`, `getStepArtifacts()`, `linkToCommit()` by composing git.ts wrappers.

**Agent D (after C):** `index.ts` — Barrel export.

**Agent E (after D):** `git-store.test.ts` — Integration tests: init temp repo, store a RunResult, list runs, get trace, get step artifacts, link to commit, error cases.

**Verification:** `tsc --noEmit && bun test packages/git-store && biome check .`

**Commit:** `feat: implement git artifact store for tracking AI session traces`

---

### Phase 4: Tests (parallel-safe)
> Integration tests exercising the full stack.

| Task | Files | Est. LOC | Dependencies | Parallel? |
|------|-------|----------|--------------|-----------|
| 4.1: Engine integration tests | `packages/server/__tests__/integration/engine-execution.test.ts` | ~300 | Phase 2 | Yes (with 4.2, 4.3, 4.4) |
| 4.2: Agent step integration tests | `packages/server/__tests__/integration/opencode-executor.test.ts` | ~180 | Phase 2 | Yes (with 4.1, 4.3, 4.4) |
| 4.3: Server API integration tests | `packages/server/__tests__/integration/server-api.test.ts` | ~200 | Phase 3 | Yes (with 4.1, 4.2, 4.4) |
| 4.4: Core unit tests (DAG, schema validation) | `packages/core/__tests__/unit/dag-resolution.test.ts`, `packages/core/__tests__/unit/schema-validation.test.ts` | ~120 | Phase 1 | Yes (with 4.1, 4.2, 4.3) |
| 4.5: Server E2E smoke test | `packages/server/__tests__/e2e/smoke.test.ts` | ~80 | Phase 3 | Yes (with 4.1–4.4) |
| 4.6: OpenCode E2E (conditional) | `packages/server/__tests__/e2e/opencode.test.ts` | ~60 | Phase 2 | Yes (with 4.1–4.5) |

**Agent A:** `engine-execution.test.ts` — Tests: linear pipeline, parallel steps, sub-workflow composition, error propagation, abort handling, mixed step types (fn + shell + agent).

**Agent B:** `opencode-executor.test.ts` — Tests: agent step with InMemoryAgentExecutor, prompt construction, response parsing, agent output schema validation failure, agent error handling.

**Agent C:** `server-api.test.ts` — Tests: POST run submission, GET workflow listing, GET run status, GET trace, 404 for unknown workflow/run. Uses Hono `app.request()`.

**Agent D:** `dag-resolution.test.ts` + `schema-validation.test.ts` — Unit tests for topological sort, Zod validation at step boundaries, workflow builder type errors.

**Verification:** `tsc --noEmit && bun test && biome check .`

**Commit:** `test: add integration and unit tests for engine, agent steps, server API, and core`

---

### Phase 5: CLI (mixed parallelism)
> Thin client CLI.

| Task | Files | Est. LOC | Dependencies | Parallel? |
|------|-------|----------|--------------|-----------|
| 5.1: HTTP client | `packages/cli/src/client.ts` | ~120 | Phase 3 | Yes (with 5.2, 5.3, 5.4) |
| 5.2: Config loader | `packages/cli/src/config.ts` | ~80 | Phase 1 | Yes (with 5.1, 5.3, 5.4) |
| 5.3: Terminal output formatting | `packages/cli/src/output.ts` | ~120 | Phase 1 | Yes (with 5.1, 5.2, 5.4) |
| 5.4: Command handlers (core) | `packages/cli/src/commands/run.ts`, `status.ts`, `trace.ts`, `list.ts`, `serve.ts` | ~250 | Phase 3 | Yes (with 5.1, 5.2, 5.3, 5.4b) |
| 5.4b: Command handlers (git-store) | `packages/cli/src/commands/history.ts`, `show.ts`, `diff.ts` | ~180 | Phase 3.5 | Yes (with 5.1, 5.2, 5.3, 5.4) |
| 5.5: CLI entry point | `packages/cli/src/index.ts` | ~40 | 5.1–5.4 | After all above |
| 5.6: CLI integration tests | `packages/cli/__tests__/integration/cli-commands.test.ts` | ~150 | 5.5 | After 5.5 |

**Agent A:** `client.ts` — `createRunbookClient(base_url)` implementing the HTTP client interface.

**Agent B:** `config.ts` — `loadConfig(path?)` finds `runbook.config.ts`, dynamically imports, validates with Zod.

**Agent C:** `output.ts` — `formatTrace()`, `formatStepResult()`, `formatError()`, `formatWorkflowList()` — terminal formatting with ANSI codes.

**Agent D:** `commands/{run,status,trace,list,serve}.ts` — Five core command handlers: `handleRun`, `handleStatus`, `handleTrace`, `handleList`, `handleServe`. Each is a standalone function.

**Agent D2:** `commands/{history,show,diff}.ts` — Three git-store command handlers: `handleHistory` (list runs from git refs), `handleShow` (display run/step artifacts), `handleDiff` (diff two runs). These import from `@f0rbit/runbook-git-store`.

**Agent E (after A–D):** `index.ts` — Entry point: parse `process.argv`, dispatch to command handlers.

**Agent F (after E):** `cli-commands.test.ts` — Tests command handlers by calling them directly with mock args, using in-memory providers behind a test server.

**Verification:** `tsc --noEmit && bun test && biome check .`

**Commit:** `feat: implement CLI with run, status, trace, list, and serve commands`

---

### Phase 6: Polish + Barrel Exports (sequential)
> Final cleanup, ensure all exports are clean, full verification.

| Task | Files | Est. LOC | Dependencies |
|------|-------|----------|--------------|
| 6.1: Finalize core barrel exports | `packages/core/src/index.ts` | ~20 (update) | All phases |
| 6.2: Finalize server barrel exports | `packages/server/src/index.ts` | ~20 (update) | All phases |
| 6.3: Verify full test suite, lint, typecheck | All | 0 | All |

**Single agent.** Clean up exports, ensure `@f0rbit/runbook` exports the SDK surface, ensure `@f0rbit/runbook/test` exports in-memory providers, ensure `@f0rbit/runbook-server` exports engine + server factory.

**Verification:** `tsc --noEmit && bun test && biome check . && biome check --fix .`

**Commit:** `chore: finalize barrel exports and polish`

---

## 14. Phase Summary

```
Phase 0: Scaffold (sequential)
├── 0.1: Root workspace config
├── 0.2: Core package scaffold         ← parallel with 0.3, 0.4, 0.5
├── 0.3: Server package scaffold        ← parallel with 0.2, 0.4, 0.5
├── 0.4: CLI package scaffold           ← parallel with 0.2, 0.3, 0.5
├── 0.5: Git-store package scaffold     ← parallel with 0.2, 0.3, 0.4
└── 0.7: bun install
→ Verification: typecheck + lint
→ COMMIT

Phase 1: Core Types + SDK (mixed)
├── Agent A: types.ts + errors.ts       ← parallel with B, C
├── Agent B: schema.ts                  ← parallel with A, C
├── Agent C: step.ts                    ← parallel with A, B
├── Agent D: workflow.ts                ← after A
├── Agent E: trace.ts                   ← after A
└── Agent F: index.ts barrel            ← after all
→ Verification: typecheck + lint
→ COMMIT

Phase 2: Engine + Providers (parallel)
├── Agent A: engine.ts
├── Agent B: providers/types.ts
├── Agent C: providers/shell.ts
├── Agent D: providers/opencode.ts
├── Agent E: core/src/test.ts (in-memory providers)
├── Agent F: state.ts
→ Verification: typecheck + lint
→ COMMIT

Phase 3: Server HTTP Layer (mixed)       ← runs in parallel with Phase 3.5
├── Agent A: routes/workflows.ts        ← parallel with B, C
├── Agent B: routes/runs.ts             ← parallel with A, C
├── Agent C: routes/health.ts           ← parallel with A, B
├── Agent D: server.ts                  ← after A, B, C
└── Agent E: server/index.ts            ← after D
→ Verification: typecheck + lint
→ COMMIT

Phase 3.5: Git Artifact Store (mixed)   ← runs in parallel with Phase 3
├── Agent A: git-store/types.ts         ← parallel with B
├── Agent B: git-store/git.ts           ← parallel with A
├── Agent C: git-store/store.ts         ← after A, B
├── Agent D: git-store/index.ts         ← after C
└── Agent E: git-store integration tests ← after D
→ Verification: typecheck + test + lint
→ COMMIT

Phase 4: Tests (parallel)
├── Agent A: engine integration tests
├── Agent B: agent step integration tests
├── Agent C: server API integration tests
├── Agent D: core unit tests
→ Verification: typecheck + test + lint
→ COMMIT

Phase 5: CLI (mixed)
├── Agent A: HTTP client                ← parallel with B, C, D, D2
├── Agent B: config loader              ← parallel with A, C, D, D2
├── Agent C: output formatting          ← parallel with A, B, D, D2
├── Agent D: command handlers (core)    ← parallel with A, B, C, D2
├── Agent D2: command handlers (git-store) ← parallel with A, B, C, D
├── Agent E: CLI entry point            ← after A, B, C, D, D2
└── Agent F: CLI tests                  ← after E
→ Verification: typecheck + test + lint
→ COMMIT

Phase 6: Polish (sequential)
├── Barrel exports cleanup
→ Verification: full suite
→ COMMIT
```

**Total estimated LOC: ~4,200** (code) + **~1,350** (tests) = **~5,550 LOC**

---

## 15. What Makes This Different

| Feature | GitHub Actions | Temporal | LangChain | **Runbook** |
|---------|---------------|----------|-----------|-------------|
| Type-safe step composition | YAML, no types | Go/Java, runtime | Python, runtime | **Zod schemas, compile-time** |
| AI agent as first-class step | Plugin/action | Custom activity | Yes, but untyped | **Typed agent steps with AgentExecutor pattern** |
| Full coding agent (file edits, shell) | No | No | Limited | **OpenCode sessions with tool calls** |
| Structured traces | Log files | Event history | Callbacks | **Typed event streams with agent events** |
| Testability | Act (slow) | Test framework | Mocking | **In-memory providers, instant** |
| Composable sub-workflows | Reusable workflows | Child workflows | Chains | **Type-safe `.asStep()`** |
| Client/Server | Cloud only | Server required | Local | **Local server + CLI client** |
| Pluggable agent backend | N/A | N/A | Provider pattern | **AgentExecutor interface (analyze/build modes)** |
| Artifact storage | Cloud logs | Temporal history | None | **Git refs — invisible to git log, pushable/pullable** |

---

## 16. Breaking Changes from Original Plan

| Change | Impact | Migration |
|--------|--------|-----------|
| Flat `src/` → monorepo | Complete restructure | N/A (greenfield) |
| `ai()` → `agent()` | Step builder rename | Find/replace `ai(` → `agent(` |
| `AiProvider` → `AgentExecutor` | Different interface shape | `complete(prompt)` → `createSession()` + `prompt()` |
| Single package → 3 packages | Import paths change | `@f0rbit/runbook` (core), `@f0rbit/runbook-server`, `@f0rbit/runbook-cli` |
| CLI executes directly → CLI is HTTP client | CLI no longer runs workflows in-process | Must start server first (`runbook serve`) or use `runbook run` which auto-starts |
| No server → Hono HTTP server | New dependency, new concern | Users who just want the SDK can depend on core only |

Since this is greenfield (no users yet), these are architectural decisions, not breaking changes.

---

## 17. Future Scope (NOT v0.1)

- **Persistence**: Save/resume workflows (needs a state store — SQLite + Drizzle)
- **Conditional branching**: `if()`/`switch()` in the builder
- **Retry policies**: Per-step retry with backoff
- **Workflow visualizer**: Terminal or web DAG visualization
- **Watch mode**: Re-run on file changes
- **Plugin system**: Custom step types beyond fn/shell/agent/checkpoint
- **MCP integration**: Steps that call MCP servers
- **Additional agent executors**: Claude Code, Aider, Goose
- **Remote server**: Deploy runbook server to a remote host (currently localhost-only)
- **Auth**: Token-based authentication for the HTTP API
- **Webhook triggers**: Start workflows from external events
- **Checkpoint via web UI**: Instead of stdin, a web form for checkpoint approvals

---

## Suggested AGENTS.md Updates

When the project is created, establish `AGENTS.md` with:

```markdown
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
```
