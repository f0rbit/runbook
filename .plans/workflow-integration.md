# Workflow Integration — SDK Gaps + Workflow Definitions

## Executive Summary

Encode the user's AI-assisted development workflow (`workflow.md` patterns 1-4) as executable runbook workflows. This requires fixing 3 critical SDK gaps, making 2 targeted SDK enhancements, and authoring 4 workflow definitions in `~/.config/runbook/`.

**Key insight:** Most of the 9 identified gaps do NOT need SDK changes. The `fn()` step is a powerful escape hatch — conditional branching, dynamic parallelism, and iteration/retry can all be handled inside `fn()` steps that call `engine.run()` recursively or execute imperative loops. The SDK should remain a simple linear pipeline builder. Complexity lives in the workflow definitions, not the framework.

**Estimated total:** ~850 LOC across 4 phases.

---

## 1. Gap Triage — What MUST Be Fixed vs Deferred

### MUST FIX (blocks workflow encoding)

| # | Gap | Why it blocks | Fix |
|---|-----|--------------|-----|
| 2 | **Provider wiring from config** | `handleServe` creates `createEngine({})` with empty providers. No agent executor, no shell provider. Workflows with agent/shell steps fail silently. | Wire `config.providers.agent` → `OpenCodeExecutor.create()`, add `BunShellProvider`, add server-side `CheckpointProvider` |
| 4 | **No skill/prompt file loading** | Agent steps need multi-KB system prompts from markdown files. Inline strings in `agent_opts.system_prompt` don't scale. | Add `system_prompt_file` to `AgentStepOpts` + resolve at engine execution time |
| 5 | **Working directory not wired** | `config.working_directory` exists in types but engine never passes it to shell/agent providers. Shell commands run in wrong cwd, agent sessions don't know the project root. | Thread `working_directory` from config → engine → shell `opts.cwd` + agent `createSession({ working_directory })` |

### SDK ENHANCEMENT (improves ergonomics, not strictly blocking)

| # | Gap | Workaround without fix | Enhancement |
|---|-----|----------------------|-------------|
| 1 | **No global config fallback** | Workflow author passes `--config ~/.config/runbook/runbook.config.ts` explicitly | Add `~/.config/runbook/` to config discovery chain |
| 3 | **`agent_type` only 2 values** | Use `"plan"` for explore (read-only is correct for exploration) | Widen to `string` so custom agent types pass through to executor |

### DEFER (fn() escape hatch handles these)

| # | Gap | How fn() handles it |
|---|-----|-------------------|
| 6 | **No conditional branching** | `fn()` step examines input and calls different sub-workflows via `engine.run()` |
| 7 | **No dynamic parallelization** | `fn()` step reads plan output, spawns N `engine.run()` calls with `Promise.all()` |
| 8 | **No iteration/retry** | `fn()` step runs verify → fix → re-verify in a `while` loop |
| 9 | **Single prompt per agent step** | `fn()` step holds an agent session and calls `executor.prompt()` multiple times |

**Rationale for deferring 6-9:** Adding branching/looping/dynamic-parallel to the builder DSL would be a significant type-system redesign (~2000+ LOC) with questionable ROI. The 4 target workflows can be expressed today with `fn()` steps that contain the control flow. If multiple workflow authors hit the same patterns, we promote them to first-class builder methods later.

---

## 2. Detailed Analysis

### 2.1 Provider Wiring (Gap #2) — CRITICAL

**Current state** (`packages/cli/src/commands/serve.ts:18`):
```typescript
const engine = createEngine({});  // no providers!
```

The config has `providers.agent` as `AgentExecutorConfig` (a serializable description: `{ type: string, base_url?: string, auto_approve?: boolean }`), but nobody instantiates it into an actual `AgentExecutor`. Similarly, no `BunShellProvider` or `CheckpointProvider` is created.

**Fix:** Create a `resolveProviders(config)` function in the server package that:
1. Reads `config.providers.agent` → calls `OpenCodeExecutor.create({ base_url, auto_approve })`
2. Creates `new BunShellProvider()` (always available)
3. Creates a server-side `CheckpointProvider` that integrates with the run state store's `pending_checkpoints` map
4. Returns `EngineOpts.providers`

The checkpoint provider is the subtle part — it needs access to the `RunStateStore` to register pending checkpoints that the HTTP endpoint can resolve. This creates a circular dependency: providers need state store, state store is created alongside server. Solution: create providers after state store, pass state store reference.

**Files touched:**
- `packages/server/src/providers/resolve.ts` (NEW ~60 LOC)
- `packages/server/src/providers/checkpoint.ts` (NEW ~40 LOC)
- `packages/cli/src/commands/serve.ts` (MODIFY ~15 LOC)
- `packages/server/src/index.ts` (MODIFY ~3 LOC — export new modules)

### 2.2 System Prompt File Loading (Gap #4)

**Current state:** `AgentStepOpts.system_prompt` is an inline string. The user's workflow needs agent steps with system prompts loaded from markdown files (e.g., `~/.config/runbook/prompts/planner.md`).

**Design decision:** Resolve file paths at **engine execution time**, not config-load time. Reasons:
- Config files are imported via `import()` — file reads at import time work but are fragile (cwd-dependent)
- Engine execution time has the resolved `working_directory` context
- Allows relative paths resolved against config file location OR absolute paths

**Approach:** Add `system_prompt_file?: string` to `AgentStepOpts`. The engine, when executing an agent step, checks for `system_prompt_file` and reads the file content, prepending it to any inline `system_prompt`. The file path is resolved relative to `working_directory` if relative, or used as-is if absolute.

**Files touched:**
- `packages/core/src/types.ts` (MODIFY ~2 LOC — add field to `AgentStepOpts`)
- `packages/core/src/schema.ts` (MODIFY ~1 LOC — add to Zod schema)
- `packages/server/src/engine.ts` (MODIFY ~15 LOC — file read in `executeAgentStep`)

### 2.3 Working Directory Propagation (Gap #5)

**Current state:** `RunbookConfig.working_directory` exists in the type but is never read by the engine or providers.

**Fix:** Thread it through:
1. `handleServe` reads `config.working_directory` (defaulting to `dirname(config_path)` or `process.cwd()`)
2. Pass to `createEngine({ working_directory, providers })` — add `working_directory?: string` to `EngineOpts`
3. Engine passes to `ShellProvider.exec(command, { cwd: working_directory })` for shell steps
4. Engine passes to `AgentExecutor.createSession({ working_directory })` for agent steps
5. Engine passes to `system_prompt_file` resolution for relative paths

**Files touched:**
- `packages/server/src/engine.ts` (MODIFY ~10 LOC — add to `EngineOpts`, use in dispatch)
- `packages/cli/src/commands/serve.ts` (MODIFY ~3 LOC — pass working_directory)

### 2.4 Global Config Fallback (Gap #1)

**Current state:** Config discovery walks up from cwd looking for `runbook.config.ts`, stops at workspace root.

**Fix:** After the walk-up fails, check `~/.config/runbook/runbook.config.ts` as a final fallback. This is where the user's global workflow definitions live.

**Files touched:**
- `packages/cli/src/config.ts` (MODIFY ~8 LOC — add fallback path)

### 2.5 Agent Type Widening (Gap #3)

**Current state:** `agent_type?: "build" | "plan"` is a closed union.

**Fix:** Change to `agent_type?: string`. The SDK shouldn't limit what the executor backend supports. OpenCode currently has `"build" | "plan"`, but other executors may have different types (e.g., `"explore"`, `"review"`). The string passes through to `PromptOpts.agent_type` which passes through to the executor.

**BREAKING:** This changes the type of `AgentStepOpts.agent_type` and `PromptOpts.agent_type` from `"build" | "plan"` to `string`. Existing code that pattern-matches on these values will still work (strings are subtypes of string), but the Zod schema changes from `z.enum(["build", "plan"])` to `z.string()`.

**Files touched:**
- `packages/core/src/types.ts` (MODIFY ~2 LOC)
- `packages/core/src/schema.ts` (MODIFY ~1 LOC)

---

## 3. SDK Enhancement Phases

### Phase 1: Core Type + Schema Changes (sequential, foundation)

**Task 1.1: Widen agent_type + add system_prompt_file**

Files: `packages/core/src/types.ts`, `packages/core/src/schema.ts`

```typescript
// types.ts — AgentStepOpts (line 10)
// BEFORE:
export type AgentStepOpts = {
  model?: { provider_id: string; model_id: string };
  agent_type?: "build" | "plan";
  timeout_ms?: number;
  system_prompt?: string;
};

// AFTER:
export type AgentStepOpts = {
  model?: { provider_id: string; model_id: string };
  agent_type?: string;
  timeout_ms?: number;
  system_prompt?: string;
  system_prompt_file?: string;
};

// types.ts — PromptOpts (line 83)
// BEFORE:
export type PromptOpts = {
  text: string;
  model?: { provider_id: string; model_id: string };
  agent_type?: "build" | "plan";
  timeout_ms?: number;
};

// AFTER:
export type PromptOpts = {
  text: string;
  model?: { provider_id: string; model_id: string };
  agent_type?: string;
  timeout_ms?: number;
};

// schema.ts — AgentStepOptsSchema (line 5)
// BEFORE:
agent_type: z.enum(["build", "plan"]).optional(),

// AFTER:
agent_type: z.string().optional(),
system_prompt_file: z.string().optional(),
```

~6 LOC changed. No new files.

**Task 1.2: Add working_directory to EngineOpts**

File: `packages/server/src/engine.ts`

```typescript
// BEFORE (line 22):
export type EngineOpts = {
  providers?: {
    shell?: ShellProvider;
    agent?: AgentExecutor;
    checkpoint?: CheckpointProvider;
  };
};

// AFTER:
export type EngineOpts = {
  providers?: {
    shell?: ShellProvider;
    agent?: AgentExecutor;
    checkpoint?: CheckpointProvider;
  };
  working_directory?: string;
};
```

~2 LOC changed.

**Est. total Phase 1: ~8 LOC**

---

### Phase 2: Server Provider Wiring (parallel-safe: 2A, 2B, 2C are independent files)

**Task 2A: Server-side CheckpointProvider** (NEW FILE)

File: `packages/server/src/providers/checkpoint.ts` (~40 LOC)

This provider bridges the engine's synchronous checkpoint flow with the HTTP endpoint. When the engine hits a checkpoint step, the provider creates a `Promise`, registers it in the run state store, and awaits resolution from the HTTP endpoint.

```typescript
// packages/server/src/providers/checkpoint.ts

import type { Result } from "@f0rbit/corpus";
import { ok } from "@f0rbit/corpus";
import type { CheckpointError, CheckpointProvider, RunState } from "@f0rbit/runbook";
import type { z } from "zod";

export type ServerCheckpointDeps = {
  get_run_state: () => RunState | undefined;
};

export function createServerCheckpointProvider(deps: ServerCheckpointDeps): CheckpointProvider {
  return {
    async prompt(message: string, schema: z.ZodType): Promise<Result<unknown, CheckpointError>> {
      const run = deps.get_run_state();
      if (!run) {
        return { ok: false, error: { kind: "checkpoint_rejected", step_id: "unknown" } };
      }

      const checkpoint_id = crypto.randomUUID();

      return new Promise<Result<unknown, CheckpointError>>((outer_resolve) => {
        run.pending_checkpoints.set(checkpoint_id, {
          step_id: "pending",
          schema,
          resolve: (value) => outer_resolve(ok(value)),
          reject: (error) => outer_resolve({ ok: false, error }),
        });
      });
    },
  };
}
```

**Task 2B: Provider resolver** (NEW FILE)

File: `packages/server/src/providers/resolve.ts` (~60 LOC)

```typescript
// packages/server/src/providers/resolve.ts

import type { Result } from "@f0rbit/corpus";
import { err, ok } from "@f0rbit/corpus";
import type {
  AgentExecutor,
  AgentExecutorConfig,
  CheckpointProvider,
  ProviderConfig,
  ShellProvider,
} from "@f0rbit/runbook";
import type { EngineOpts } from "../engine";
import type { RunStateStore } from "../state";
import { OpenCodeExecutor } from "./opencode";
import { BunShellProvider } from "./shell";

export type ResolveProvidersOpts = {
  provider_config?: ProviderConfig;
  state: RunStateStore;
  current_run_id?: string;
};

export type ResolvedProviders = NonNullable<EngineOpts["providers"]>;

export type ResolveError =
  | { kind: "agent_init_failed"; cause: string };

export async function resolveProviders(
  opts: ResolveProvidersOpts,
): Promise<Result<ResolvedProviders, ResolveError>> {
  const shell: ShellProvider = new BunShellProvider();

  let agent: AgentExecutor | undefined;
  const agent_config = opts.provider_config?.agent;
  if (agent_config) {
    const executor_result = await OpenCodeExecutor.create({
      base_url: agent_config.base_url,
      auto_approve: agent_config.auto_approve,
    });
    if (!executor_result.ok) {
      return err({
        kind: "agent_init_failed",
        cause: `Failed to create agent executor: ${executor_result.error.kind}`,
      });
    }
    agent = executor_result.value;
  }

  return ok({ shell, agent });
}
```

Note: The checkpoint provider is created per-run (it needs the run state reference), so it's NOT part of this resolver. Instead, we'll create it in the workflow execution path. See Task 2D.

**Task 2C: System prompt file loading in engine**

File: `packages/server/src/engine.ts` (MODIFY ~20 LOC)

Add file reading in `executeAgentStep`:

```typescript
// In executeAgentStep, before creating the session (around line 350):

// Resolve system prompt (inline + file)
let resolved_system_prompt = agent_opts?.system_prompt ?? "";
if (agent_opts?.system_prompt_file) {
  const file_path = agent_opts.system_prompt_file.startsWith("/")
    ? agent_opts.system_prompt_file
    : `${engine_opts.working_directory ?? process.cwd()}/${agent_opts.system_prompt_file}`;
  try {
    const file_content = await Bun.file(file_path).text();
    resolved_system_prompt = resolved_system_prompt
      ? `${file_content}\n\n${resolved_system_prompt}`
      : file_content;
  } catch (e) {
    return err(errors.execution(
      step.id,
      `Failed to read system_prompt_file "${file_path}": ${e instanceof Error ? e.message : String(e)}`
    ));
  }
}
```

Also wire `working_directory` to shell steps:

```typescript
// In the "shell" case of executeStep (around line 264):
const command = step.kind.command(input_parsed.data);
const shell_result = await shell_provider.exec(command, {
  cwd: engine_opts.working_directory,
});
```

And to agent session creation:

```typescript
// In executeAgentStep, createSession call (around line 355):
const session_result = await executor.createSession({
  title: `runbook:${ctx.workflow_id}:${step.id}`,
  system_prompt: final_system_prompt,
  working_directory: engine_opts.working_directory,
});
```

**Task 2D: Wire providers in handleServe**

File: `packages/cli/src/commands/serve.ts` (MODIFY ~20 LOC)

```typescript
// BEFORE:
const engine = createEngine({});

// AFTER:
import { resolveProviders } from "@f0rbit/runbook-server";

const provider_result = await resolveProviders({
  provider_config: config.providers,
  state,
});
if (!provider_result.ok) {
  console.error("Provider init error:", provider_result.error);
  process.exit(1);
}

const working_directory = config.working_directory ?? process.cwd();
const engine = createEngine({
  providers: provider_result.value,
  working_directory,
});
```

**Task 2E: Global config fallback**

File: `packages/cli/src/config.ts` (MODIFY ~10 LOC)

```typescript
// After the walk-up loop fails (line 48), before returning error:
import { homedir } from "node:os";

const global_config = join(homedir(), ".config", "runbook", "runbook.config.ts");
searched.push(global_config);
if (existsSync(global_config)) {
  return importConfig(global_config);
}

return err({ kind: "config_not_found", searched });
```

**Task 2F: Export new modules**

File: `packages/server/src/index.ts` (MODIFY ~4 LOC)

```typescript
export { resolveProviders } from "./providers/resolve";
export type { ResolvedProviders, ResolveError, ResolveProvidersOpts } from "./providers/resolve";
export { createServerCheckpointProvider } from "./providers/checkpoint";
export type { ServerCheckpointDeps } from "./providers/checkpoint";
```

**Est. total Phase 2: ~160 LOC (100 new, 60 modified)**

---

### Phase 3: Workflow Definitions (parallel-safe: each workflow is independent)

This phase creates the actual workflow definitions that encode the user's development patterns. These live in `~/.config/runbook/` as the user's global runbook config.

**Structure:**
```
~/.config/runbook/
├── runbook.config.ts          # Global config with all workflows
├── workflows/
│   ├── feature.ts             # Pattern 1: Feature / Refactor
│   ├── question.ts            # Pattern 2: Codebase Questions
│   ├── simple-change.ts       # Pattern 3: Simple Changes
│   └── verify.ts              # Pattern 4: Standalone Verification
├── prompts/
│   ├── explorer.md            # System prompt for explore agent
│   ├── planner.md             # System prompt for planner agent
│   ├── coder.md               # System prompt for coder agent
│   └── verifier.md            # System prompt for verification agent
└── schemas/
    └── common.ts              # Shared Zod schemas across workflows
```

**DECISION NEEDED:** Where should these workflow files live during development?
- Option A: In the runbook repo under `workflows/` (versioned, testable, but couples user config to the repo)
- Option B: In `~/.config/runbook/` only (user-owned, not versioned with the project)
- Option C: In the runbook repo under `examples/workflows/` for reference, user copies to `~/.config/runbook/`

**Recommendation: Option C.** Author them in `examples/workflows/` so they're versioned and testable within this repo. The global config at `~/.config/runbook/runbook.config.ts` imports from these files. Users can customize by copying and editing.

**Task 3A: Shared schemas** (`examples/workflows/schemas/common.ts`, ~50 LOC)

```typescript
import { z } from "zod";

// Input for workflows that operate on a codebase
export const CodebaseInputSchema = z.object({
  task: z.string().describe("What the user wants to do"),
  working_directory: z.string().optional().describe("Project root, defaults to cwd"),
  config_path: z.string().optional().describe("Path to AGENTS.md or similar context file"),
});
export type CodebaseInput = z.infer<typeof CodebaseInputSchema>;

// Output from the explore agent
export const ExplorationResultSchema = z.object({
  summary: z.string(),
  relevant_files: z.array(z.string()),
  patterns: z.array(z.string()),
  conventions: z.array(z.string()),
});
export type ExplorationResult = z.infer<typeof ExplorationResultSchema>;

// Output from the planner agent
export const PlanSchema = z.object({
  plan_file: z.string().describe("Path to the generated .plans/ file"),
  phases: z.array(z.object({
    name: z.string(),
    tasks: z.array(z.object({
      id: z.string(),
      description: z.string(),
      files: z.array(z.string()),
      parallel_safe: z.boolean(),
    })),
  })),
  breaking_changes: z.array(z.string()),
});
export type Plan = z.infer<typeof PlanSchema>;

// Output from a coder agent (build mode)
export const CoderOutputSchema = z.object({
  files_changed: z.array(z.string()).optional(),
  success: z.boolean(),
  duration_ms: z.number(),
});
export type CoderOutput = z.infer<typeof CoderOutputSchema>;

// Output from verification
export const VerificationResultSchema = z.object({
  typecheck: z.object({ passed: z.boolean(), output: z.string() }),
  test: z.object({ passed: z.boolean(), output: z.string() }),
  lint: z.object({ passed: z.boolean(), output: z.string() }),
  all_passed: z.boolean(),
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

// Checkpoint: user approves/rejects plan
export const PlanApprovalSchema = z.object({
  approved: z.boolean(),
  notes: z.string().optional(),
});
export type PlanApproval = z.infer<typeof PlanApprovalSchema>;

// Checkpoint: user approves/rejects phase
export const PhaseApprovalSchema = z.object({
  approved: z.boolean(),
  notes: z.string().optional(),
});
export type PhaseApproval = z.infer<typeof PhaseApprovalSchema>;
```

**Task 3B: Verify workflow** (`examples/workflows/verify.ts`, ~80 LOC)

The simplest workflow — Pattern 4. Three parallel shell steps.

```typescript
import { ok, err } from "@f0rbit/corpus";
import { defineWorkflow, fn, shell } from "@f0rbit/runbook";
import { z } from "zod";
import { VerificationResultSchema } from "./schemas/common";

const TypecheckOutputSchema = z.object({ passed: z.boolean(), output: z.string() });
const TestOutputSchema = z.object({ passed: z.boolean(), output: z.string() });
const LintOutputSchema = z.object({ passed: z.boolean(), output: z.string() });

const typecheck = shell({
  id: "typecheck",
  input: z.object({}),
  output: TypecheckOutputSchema,
  command: () => "tsc --noEmit 2>&1 || true",
  parse: (stdout, code) => ok({ passed: code === 0, output: stdout }),
});

const test_step = shell({
  id: "test",
  input: z.object({}),
  output: TestOutputSchema,
  command: () => "bun test 2>&1 || true",
  parse: (stdout, code) => ok({ passed: code === 0, output: stdout }),
});

const lint = shell({
  id: "lint",
  input: z.object({}),
  output: LintOutputSchema,
  command: () => "biome check . 2>&1 || true",
  parse: (stdout, code) => ok({ passed: code === 0, output: stdout }),
});

const merge_results = fn({
  id: "merge_verification",
  input: z.tuple([TypecheckOutputSchema, TestOutputSchema, LintOutputSchema]),
  output: VerificationResultSchema,
  run: async ([tc, test, lt]) => ok({
    typecheck: tc,
    test,
    lint: lt,
    all_passed: tc.passed && test.passed && lt.passed,
  }),
});

export const verify = defineWorkflow(z.object({}))
  .parallel(
    [typecheck, () => ({})] as const,
    [test_step, () => ({})] as const,
    [lint, () => ({})] as const,
  )
  .pipe(merge_results, (_wi, prev) => prev)
  .done("verify", VerificationResultSchema);
```

**Task 3C: Question workflow** (`examples/workflows/question.ts`, ~40 LOC)

Pattern 2 — simplest agent workflow.

```typescript
import { agent, defineWorkflow } from "@f0rbit/runbook";
import { z } from "zod";

const AnswerSchema = z.object({
  answer: z.string(),
  relevant_files: z.array(z.string()),
  confidence: z.enum(["high", "medium", "low"]),
});

const explore = agent({
  id: "explore",
  input: z.object({ question: z.string() }),
  output: AnswerSchema,
  prompt: (input) => input.question,
  mode: "analyze",
  agent_opts: {
    agent_type: "plan",
    system_prompt_file: "prompts/explorer.md",
  },
});

export const question = defineWorkflow(z.object({ question: z.string() }))
  .pipe(explore, (wi) => ({ question: wi.question }))
  .done("question", AnswerSchema);
```

**Task 3D: Simple-change workflow** (`examples/workflows/simple-change.ts`, ~60 LOC)

Pattern 3 — coder agent + verify sub-workflow + commit.

```typescript
import { ok, err } from "@f0rbit/corpus";
import { agent, defineWorkflow, fn, shell } from "@f0rbit/runbook";
import { z } from "zod";
import { CodebaseInputSchema, CoderOutputSchema } from "./schemas/common";
import { verify } from "./verify";

const code = agent({
  id: "code",
  input: z.object({ task: z.string() }),
  output: CoderOutputSchema,
  prompt: (input) => input.task,
  mode: "build",
  agent_opts: {
    agent_type: "build",
    system_prompt_file: "prompts/coder.md",
  },
});

const commit = shell({
  id: "commit",
  input: z.object({ message: z.string() }),
  output: z.object({ sha: z.string() }),
  command: (input) => `git add -A && git commit -m "${input.message}" && git rev-parse --short HEAD`,
  parse: (stdout, code) => {
    if (code !== 0) return err({ kind: "shell_error", step_id: "commit", command: "git commit", code, stderr: stdout });
    return ok({ sha: stdout.trim().split("\n").pop() ?? "" });
  },
});

export const simple_change = defineWorkflow(CodebaseInputSchema)
  .pipe(code, (wi) => ({ task: wi.task }))
  .pipe(verify.asStep(), () => ({}))
  .pipe(commit, (wi) => ({ message: wi.task }))
  .done("simple-change", z.object({ sha: z.string() }));
```

**Task 3E: Feature workflow** (`examples/workflows/feature.ts`, ~200 LOC)

Pattern 1 — the complex one. Uses `fn()` for dynamic phase iteration.

```typescript
import { ok, err, type Result } from "@f0rbit/corpus";
import {
  agent,
  checkpoint,
  defineWorkflow,
  fn,
  type AgentExecutor,
  type ShellProvider,
  type StepContext,
  type StepError,
} from "@f0rbit/runbook";
import { createEngine } from "@f0rbit/runbook-server";
import { z } from "zod";
import {
  CodebaseInputSchema,
  CoderOutputSchema,
  ExplorationResultSchema,
  PlanApprovalSchema,
  PlanSchema,
  VerificationResultSchema,
} from "./schemas/common";
import { verify } from "./verify";

// Step 1: Explore the codebase
const explore = agent({
  id: "explore",
  input: z.object({ task: z.string(), context_file: z.string().optional() }),
  output: ExplorationResultSchema,
  prompt: (input) => {
    let prompt = `Thoroughly explore this codebase to understand how to: ${input.task}`;
    if (input.context_file) {
      prompt += `\n\nRead ${input.context_file} first for project context.`;
    }
    return prompt;
  },
  mode: "analyze",
  agent_opts: {
    agent_type: "plan",
    system_prompt_file: "prompts/explorer.md",
  },
});

// Step 2: Create a plan
const plan = agent({
  id: "plan",
  input: z.object({
    task: z.string(),
    exploration: ExplorationResultSchema,
  }),
  output: PlanSchema,
  prompt: (input) => [
    `Create an implementation plan for: ${input.task}`,
    "",
    "## Codebase Context",
    `Summary: ${input.exploration.summary}`,
    `Relevant files: ${input.exploration.relevant_files.join(", ")}`,
    `Patterns: ${input.exploration.patterns.join(", ")}`,
    `Conventions: ${input.exploration.conventions.join(", ")}`,
  ].join("\n"),
  mode: "analyze",
  agent_opts: {
    agent_type: "plan",
    system_prompt_file: "prompts/planner.md",
  },
});

// Step 3: Checkpoint — user reviews plan
const approve_plan = checkpoint({
  id: "approve_plan",
  input: PlanSchema,
  output: PlanApprovalSchema,
  prompt: (input) => [
    `Review the plan at: ${input.plan_file}`,
    "",
    `${input.phases.length} phases, ${input.phases.reduce((sum, p) => sum + p.tasks.length, 0)} tasks`,
    input.breaking_changes.length > 0
      ? `\nBREAKING CHANGES:\n${input.breaking_changes.map((c) => `  - ${c}`).join("\n")}`
      : "",
    "",
    "Approve this plan?",
  ].join("\n"),
});

// Step 4: Execute phases (the complex fn() step)
// This is where conditional branching, dynamic parallelism, and
// iteration/retry all live — inside a single fn() step.
const ExecutePhasesInputSchema = z.object({
  plan: PlanSchema,
  task: z.string(),
});
const ExecutePhasesOutputSchema = z.object({
  phases_completed: z.number(),
  total_files_changed: z.array(z.string()),
  commits: z.array(z.string()),
});

const execute_phases = fn({
  id: "execute_phases",
  input: ExecutePhasesInputSchema,
  output: ExecutePhasesOutputSchema,
  run: async (input, ctx): Promise<Result<z.infer<typeof ExecutePhasesOutputSchema>, StepError>> => {
    const all_files: string[] = [];
    const all_commits: string[] = [];
    let phases_done = 0;

    for (const phase of input.plan.phases) {
      // For each phase, run coders (parallel where safe)
      // This is a simplified version — a real implementation would
      // create sub-agent sessions for each task. For now, we batch
      // all tasks in a phase into a single coder prompt.
      const task_descriptions = phase.tasks
        .map((t) => `- ${t.description} (files: ${t.files.join(", ")})`)
        .join("\n");

      ctx.trace.emit({
        type: "step_start",
        step_id: `phase:${phase.name}`,
        input: { phase: phase.name, tasks: phase.tasks.length },
        timestamp: new Date(),
      });

      // In a full implementation, this would use engine.run() with
      // dynamically constructed workflows per phase. For v0.1, we
      // emit the phase structure and let a single coder handle it.

      phases_done++;
    }

    return ok({
      phases_completed: phases_done,
      total_files_changed: all_files,
      commits: all_commits,
    });
  },
});

export const feature = defineWorkflow(CodebaseInputSchema)
  .pipe(explore, (wi) => ({
    task: wi.task,
    context_file: wi.config_path,
  }))
  .pipe(plan, (wi, prev) => ({
    task: wi.task,
    exploration: prev,
  }))
  .pipe(approve_plan, (_wi, prev) => prev)
  .pipe(execute_phases, (wi, prev) => ({
    plan: prev as unknown as z.infer<typeof PlanSchema>,  // checkpoint output is PlanApproval, but we need plan
    // NOTE: This is a design issue — the checkpoint output replaces
    // the previous step's output. We need the plan from step 2, but
    // step 3's output is PlanApproval. Solutions:
    // A) Store plan in workflow input (pass through)
    // B) Have checkpoint pass through its input as part of output
    // C) Use fn() to merge plan + approval
    // Going with workaround: make the fn() step receive both via a merge step
    task: wi.task,
  }))
  .done("feature", ExecutePhasesOutputSchema);

// NOTE: The above has a type issue with the checkpoint step replacing
// the plan output. The real implementation needs a merge step between
// approve_plan and execute_phases. See Phase 3 implementation notes.
```

**Implementation note on the feature workflow:** The checkpoint step `approve_plan` outputs `PlanApproval`, which loses the `Plan` data from step 2. We need a pattern to carry data forward past checkpoints. Two clean options:

**Option A (recommended):** Add a `fn()` merge step between plan and approve_plan that bundles the plan into the checkpoint input, and the checkpoint prompt extracts what it needs while passing data through:

```typescript
// The merge pattern:
.pipe(plan, ...)                    // output: Plan
.pipe(merge_plan_for_approval, ...) // fn that returns { plan: Plan, ... }
.pipe(approve_plan, ...)            // checkpoint that outputs { approved, notes, plan }
.pipe(execute_phases, ...)          // receives plan from checkpoint output
```

**Option B:** Use a closure in the `execute_phases` fn() step to capture the plan from an outer scope. Less clean but simpler.

**DECISION NEEDED:** Which pattern for carrying data past checkpoints? Recommend Option A (explicit merge step) as it keeps the pipeline type-safe and auditable.

**Task 3F: Prompt files** (`examples/workflows/prompts/*.md`, ~100 LOC total)

These are starter system prompts. The user will customize them.

- `prompts/explorer.md` — Instructions for the explore agent (read-only analysis, output JSON)
- `prompts/planner.md` — Instructions for the planner agent (create .plans/ file, output structured phases)
- `prompts/coder.md` — Instructions for the coder agent (implement code changes)
- `prompts/verifier.md` — Instructions for the verification agent (typecheck, test, lint, fix)

**Task 3G: Global config** (`examples/workflows/runbook.config.ts`, ~25 LOC)

```typescript
import { defineConfig } from "@f0rbit/runbook";
import { feature } from "./feature";
import { question } from "./question";
import { simple_change } from "./simple-change";
import { verify } from "./verify";

export default defineConfig({
  workflows: [feature, question, simple_change, verify],
  providers: {
    agent: {
      type: "opencode",
      base_url: process.env.OPENCODE_URL,
    },
  },
});
```

**Est. total Phase 3: ~555 LOC**

---

### Phase 4: Tests

**Task 4A: Engine enhancement tests** (~80 LOC)

File: `packages/server/__tests__/integration/engine-enhancements.test.ts`

Tests for the new engine behaviors:

1. **system_prompt_file loading:** Create a temp file, define an agent step with `system_prompt_file` pointing to it, verify the file content is prepended to the system prompt passed to `InMemoryAgentExecutor.createSession()`.

2. **working_directory propagation to shell:** Define a shell step, set `working_directory` on engine opts, verify `InMemoryShellProvider.executed[0].opts.cwd` matches.

3. **working_directory propagation to agent:** Define an agent step, set `working_directory`, verify the `createSession` call received it (extend InMemoryAgentExecutor to capture `CreateSessionOpts`).

4. **system_prompt_file + inline system_prompt merge:** Both specified — file content prepended, inline appended.

5. **system_prompt_file not found:** Returns execution error, not crash.

```typescript
import { beforeEach, describe, expect, test } from "bun:test";
import { ok } from "@f0rbit/corpus";
import { agent, defineWorkflow, shell } from "@f0rbit/runbook";
import { InMemoryAgentExecutor, InMemoryShellProvider } from "@f0rbit/runbook/test";
import { z } from "zod";
import { createEngine } from "../../src/engine";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";

describe("engine enhancements", () => {
  test("system_prompt_file is loaded and prepended to system_prompt", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "runbook-test-"));
    writeFileSync(join(tmp, "prompt.md"), "You are a helpful assistant.");

    const agent_executor = new InMemoryAgentExecutor();
    agent_executor.on(/./, { text: '{"result": "ok"}' });

    const step = agent({
      id: "test_step",
      input: z.string(),
      output: z.object({ result: z.string() }),
      prompt: (s) => s,
      mode: "analyze",
      agent_opts: {
        system_prompt_file: join(tmp, "prompt.md"),
        system_prompt: "Additional instructions.",
      },
    });

    const workflow = defineWorkflow(z.string())
      .pipe(step, (wi) => wi)
      .done("prompt-file-test", z.object({ result: z.string() }));

    const engine = createEngine({
      providers: { agent: agent_executor },
    });
    const result = await engine.run(workflow, "hello");
    expect(result.ok).toBe(true);
    // Verify the session was created with merged system prompt
    // (Need to expose created sessions from InMemoryAgentExecutor)
  });

  test("working_directory is passed to shell provider", async () => {
    const shell_provider = new InMemoryShellProvider();
    shell_provider.on(/./, { stdout: "ok" });

    const step = shell({
      id: "test_shell",
      input: z.string(),
      output: z.string(),
      command: (s) => `echo ${s}`,
      parse: (stdout) => ok(stdout.trim()),
    });

    const workflow = defineWorkflow(z.string())
      .pipe(step, (wi) => wi)
      .done("cwd-test", z.string());

    const engine = createEngine({
      providers: { shell: shell_provider },
      working_directory: "/tmp/test-project",
    });
    await engine.run(workflow, "hello");

    expect(shell_provider.executed[0].opts?.cwd).toBe("/tmp/test-project");
  });
});
```

**Task 4B: Provider resolver tests** (~40 LOC)

File: `packages/server/__tests__/integration/provider-resolve.test.ts`

Test that `resolveProviders` creates correct provider instances from config. Uses `InMemoryAgentExecutor` since we can't test real OpenCode in CI.

**Task 4C: Config fallback tests** (~30 LOC)

File: `packages/cli/__tests__/integration/config-discovery.test.ts`

Test that config discovery:
1. Finds `~/.config/runbook/runbook.config.ts` when no local config exists
2. Local config takes precedence over global
3. Explicit `--config` takes precedence over both

**Task 4D: Workflow definition tests** (~80 LOC)

File: `examples/workflows/__tests__/workflow-definitions.test.ts`

Integration tests that run each workflow end-to-end with in-memory providers:

1. **verify workflow:** Script shell responses for tsc/bun test/biome, assert merged output.
2. **question workflow:** Script agent response, assert parsed output.
3. **simple-change workflow:** Script agent build response + shell responses for git, assert commit SHA output.

The feature workflow is too complex for a unit-level integration test — it requires multi-step agent interactions. Test it with a simplified 1-phase plan.

**Task 4E: InMemoryAgentExecutor enhancement** (~15 LOC)

File: `packages/core/src/test.ts` (MODIFY)

Add `created_sessions` tracking to `InMemoryAgentExecutor` so tests can assert on `system_prompt` and `working_directory` passed to `createSession()`:

```typescript
// Add to InMemoryAgentExecutor:
created_sessions: Array<{ id: string; opts: CreateSessionOpts }> = [];

// In createSession():
this.created_sessions.push({ id, opts });
```

**Est. total Phase 4: ~245 LOC**

---

## 4. Phase Summary

| Phase | Tasks | Est. LOC | Dependencies | Parallelizable |
|-------|-------|---------|-------------|---------------|
| 1 | 1.1, 1.2 | ~8 | None | Sequential (foundation) |
| 2 | 2A, 2B, 2C, 2D, 2E, 2F | ~160 | Phase 1 | 2A, 2B parallel; 2C, 2D, 2E, 2F after |
| 3 | 3A-3G | ~555 | Phase 2 | 3A first, then 3B-3G parallel |
| 4 | 4A-4E | ~245 | Phase 2 (4A-4C), Phase 3 (4D) | 4A, 4B, 4C parallel; 4D after Phase 3 |
| **Total** | | **~968** | | |

### Execution Order

```
Phase 1: Core type changes (sequential)
├── Task 1.1: Widen agent_type + add system_prompt_file
├── Task 1.2: Add working_directory to EngineOpts
→ Verification: typecheck, commit

Phase 2: Server provider wiring (mixed parallel)
├── Agent A: Task 2A (checkpoint provider) + Task 2B (provider resolver)  [NEW files, parallel-safe]
├── Agent B: Task 2C (engine system_prompt_file + working_dir) + Task 2E (config fallback)
├── After both: Task 2D (wire in handleServe) + Task 2F (exports)
→ Verification: typecheck, test existing suite, commit

Phase 3: Workflow definitions (parallel after 3A)
├── Task 3A: Shared schemas (must be first)
├── Then parallel:
│   ├── Agent A: Task 3B (verify) + Task 3C (question)
│   ├── Agent B: Task 3D (simple-change) + Task 3E (feature)
│   ├── Agent C: Task 3F (prompt files) + Task 3G (config)
→ Verification: typecheck, commit

Phase 4: Tests (parallel, then sequential)
├── Agent A: Task 4A (engine tests) + Task 4E (InMemoryAgentExecutor enhancement)
├── Agent B: Task 4B (provider resolver tests) + Task 4C (config tests)
├── After Phase 3: Agent C: Task 4D (workflow definition tests)
→ Verification: typecheck, test ALL, lint, commit
```

---

## 5. Decisions Needed

1. **Workflow file location:** Recommend `examples/workflows/` in repo, user copies to `~/.config/runbook/`. See Task 3 preamble.

2. **Checkpoint data pass-through pattern:** How to carry `Plan` data past the `approve_plan` checkpoint. Recommend merge-step pattern (Option A). See Task 3E notes.

3. **Feature workflow complexity:** The `execute_phases` fn() step is a placeholder. The full implementation (dynamic sub-engine runs per phase, parallel coder dispatch, verify-fix-retry loops) is ~300 additional LOC. Should we implement the full loop in this milestone, or ship a simplified version that executes phases sequentially with a single coder per phase?

---

## 6. Breaking Changes

- `AgentStepOpts.agent_type` changes from `"build" | "plan"` to `string` — existing code using literal values still works, but code that exhaustively matches on the union will need updating.
- `PromptOpts.agent_type` same change.
- `AgentStepOptsSchema` changes from `z.enum(["build", "plan"])` to `z.string()` — any code validating against this schema that expects the enum will accept wider values.

All are non-destructive widening changes. No runtime breakage.

---

## 7. Suggested AGENTS.md Updates

After this milestone, add:

```markdown
## Workflow Definitions
- Example workflows live in `examples/workflows/` — verify, question, simple-change, feature
- Global config fallback: `~/.config/runbook/runbook.config.ts` is checked after local config walk-up fails
- System prompts for agent steps can be loaded from files via `agent_opts.system_prompt_file`
- The `fn()` step is the escape hatch for control flow (branching, loops, dynamic parallelism)
- Data past checkpoints requires a merge-step pattern to preserve upstream outputs

## Provider Wiring
- `resolveProviders()` in server package creates real provider instances from config
- `createServerCheckpointProvider()` bridges engine checkpoint flow with HTTP endpoint
- `working_directory` flows from config → engine → shell cwd + agent session

## Testing Enhancements
- `InMemoryAgentExecutor.created_sessions` tracks session creation opts for assertions
- Workflow definition tests in `examples/workflows/__tests__/` use in-memory providers
```
