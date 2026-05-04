# Workflow Integration — Workflow Definitions + Checkpoint Bridge

> **Status (2026-05-04):** Phase 1 (core types/schema) and most of Phase 2 (provider wiring, system_prompt_file loading, working_directory propagation, global config fallback) are shipped. Earlier phases moved to `archive/workflow-integration-shipped.md` if needed for reference; otherwise see git history. This document covers only the remaining forward-looking work.
>
> **Depends on:** `claude-code-migration.md`. The example config and any agent-step `agent_type` defaults must be authored against the Claude Code executor, not OpenCode. Land the migration first.

## Executive Summary

Two pieces remain:

1. **Server-side `CheckpointProvider` bridge** — engine emits checkpoint requests, but no provider is wired to resolve them via the HTTP endpoint. Without this, checkpoint steps cannot complete in a running server.
2. **Example workflows under `examples/workflows/`** — encode the user's four AI-assisted dev patterns (verify, question, simple-change, feature) as runnable workflows, with shared schemas, system-prompt files, and a global `runbook.config.ts` example.

**Estimated total:** ~600 LOC across Phase A (40 LOC) + Phase B (~555 LOC).

---

## Already Shipped (do NOT redo)

Verified against the codebase on 2026-05-04:

- `agent_type` widened to `z.string()` — `packages/core/src/types.ts:16`, `packages/core/src/schema.ts:11`
- `system_prompt_file` field on `AgentStepOpts` + engine file-loading logic — `packages/core/src/types.ts:19`, `packages/server/src/engine.ts:440-452`
- `working_directory` on `EngineOpts`, threaded to shell `cwd` and agent `createSession` — `packages/server/src/engine.ts:32`
- `resolveProviders()` provider resolver — `packages/server/src/providers/resolve.ts:11-36`
- Global config fallback to `~/.config/runbook/runbook.config.ts` — `packages/cli/src/config.ts:49-53`
- Provider wiring in `handleServe` — `packages/cli/src/commands/serve.ts:27-51`
- Engine enhancement tests — `packages/server/__tests__/integration/engine-enhancements.test.ts`
- Provider resolver tests — `packages/server/__tests__/integration/provider-resolve.test.ts`
- Config discovery tests — `packages/cli/__tests__/integration/config-discovery.test.ts`

---

## Phase A: CheckpointProvider Bridge

### A.1: Server-side CheckpointProvider (NEW FILE)

File: `packages/server/src/providers/checkpoint.ts` (~40 LOC)

The engine's checkpoint step expects a `CheckpointProvider.prompt()` to await user response. The HTTP endpoint that resolves checkpoints needs a handle to that pending promise. The provider creates the promise, registers it on the run state's `pending_checkpoints` map, and returns it.

```typescript
import type { Result } from "@f0rbit/corpus";
import { ok } from "@f0rbit/corpus";
import type { CheckpointError, CheckpointProvider, RunState } from "@f0rbit/runbook";
import type { z } from "zod";

export type ServerCheckpointDeps = {
  get_run_state: () => RunState | undefined;
};

export function createServerCheckpointProvider(deps: ServerCheckpointDeps): CheckpointProvider {
  return {
    async prompt(message, schema) {
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

### A.2: Wire into per-run engine construction

The provider is per-run because it needs the run state reference. It cannot live inside `resolveProviders()` (which runs once at server boot). Wire it where `engine.run()` is invoked for a workflow run — `packages/server/src/routes/workflows.ts` — passing the per-run state into `createServerCheckpointProvider`.

### A.3: Export from server package

`packages/server/src/index.ts` — add:

```typescript
export { createServerCheckpointProvider } from "./providers/checkpoint";
export type { ServerCheckpointDeps } from "./providers/checkpoint";
```

### A.4: Test

File: `packages/server/__tests__/integration/checkpoint-provider.test.ts` (~50 LOC)

End-to-end: workflow with checkpoint step → engine awaits → HTTP `POST /runs/:id/checkpoint/:checkpoint_id` resolves → engine continues with parsed value.

**Phase A total: ~95 LOC**

---

## Phase B: Example Workflows

Author the user's four AI-dev patterns as executable workflows. These live in `examples/workflows/` (versioned, testable). Users copy or import them into their own `~/.config/runbook/runbook.config.ts`.

### Structure

```
examples/workflows/
├── runbook.config.ts          # defineConfig with all 4 workflows + claude-code provider
├── feature.ts                 # Pattern 1
├── question.ts                # Pattern 2
├── simple-change.ts           # Pattern 3
├── verify.ts                  # Pattern 4
├── prompts/
│   ├── explorer.md
│   ├── planner.md
│   ├── coder.md
│   └── verifier.md
└── schemas/
    └── common.ts              # Shared Zod schemas
```

### B.1: Shared schemas — `examples/workflows/schemas/common.ts` (~50 LOC)

`CodebaseInputSchema`, `ExplorationResultSchema`, `PlanSchema`, `CoderOutputSchema`, `VerificationResultSchema`, `PlanApprovalSchema`, `PhaseApprovalSchema`. Source of truth for inter-workflow types.

### B.2: Verify workflow — `examples/workflows/verify.ts` (~80 LOC)

Pattern 4. Three parallel shell steps (`tsc --noEmit`, `bun test`, `biome check .`) → fn merge step → `VerificationResult`. Simplest entry point and reused as a sub-step by `simple-change` and `feature` via `verify.asStep()`.

### B.3: Question workflow — `examples/workflows/question.ts` (~40 LOC)

Pattern 2. Single agent step with `system_prompt_file: "prompts/explorer.md"`. Output: `{ answer, relevant_files, confidence }`.

### B.4: Simple-change workflow — `examples/workflows/simple-change.ts` (~60 LOC)

Pattern 3. `code` (agent) → `verify.asStep()` → `commit` (shell). End-to-end change with verification + commit.

### B.5: Feature workflow — `examples/workflows/feature.ts` (~200 LOC)

Pattern 1. `explore` → `plan` → `merge_plan_for_approval` (fn) → `approve_plan` (checkpoint) → `execute_phases` (fn).

**Two open design questions:**

1. **Checkpoint data pass-through.** The `approve_plan` checkpoint outputs `PlanApproval`, which loses the `Plan` from the previous step. Recommend a `merge_plan_for_approval` fn step that bundles `{ plan, summary }` into the checkpoint input; the checkpoint output then carries the plan forward as `{ approval, plan }`. Cleaner than closure-capture.

2. **`execute_phases` complexity.** The full pattern (dynamic sub-engine per phase, parallel coder dispatch, verify-fix-retry loop) is ~300 LOC on top. Recommend shipping a simplified version first: phases run sequentially, one coder per phase, no retry. Promote to first-class builder methods later if multiple workflows want them.

### B.6: Prompt files — `examples/workflows/prompts/*.md` (~100 LOC total)

`explorer.md`, `planner.md`, `coder.md`, `verifier.md`. Starter system prompts for each agent role. Designed for the Claude Code executor — agent type strings (`"build"`, `"plan"`, etc.) must match what claude-code-migration ships.

### B.7: Global config example — `examples/workflows/runbook.config.ts` (~25 LOC)

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
      type: "claude-code",
      // claude-code-migration defines the exact config shape
    },
  },
});
```

> The current `examples/runbook.config.ts` is commented out and references `type: "opencode"`. Replace it (or remove it) with this populated version once the migration lands.

### B.8: Workflow definition tests — `examples/workflows/__tests__/workflow-definitions.test.ts` (~80 LOC)

Run each workflow end-to-end with in-memory providers:

- `verify`: script tsc/bun-test/biome stdouts; assert merged output.
- `question`: script agent response; assert parsed answer.
- `simple-change`: script agent + git shells; assert commit SHA in output.
- `feature`: script a 1-phase plan; assert checkpoint resolution + phase completion.

### B.9: `InMemoryAgentExecutor.created_sessions` enhancement (~15 LOC)

`packages/core/src/test.ts` — track session creation opts so workflow tests can assert on `system_prompt`, `working_directory`, and `agent_type` passed at session creation. Already required for B.8 assertions, and for any future test that wants to verify session config.

**Phase B total: ~650 LOC**

---

## Execution Order

```
Phase A: CheckpointProvider bridge (sequential)
├── A.1: provider implementation
├── A.2: wire into per-run engine
├── A.3: exports
├── A.4: integration test
→ Verification: typecheck, test, lint, commit

Phase B: Example workflows (parallel after B.1, B.9)
├── B.1: shared schemas (must be first)
├── B.9: InMemoryAgentExecutor enhancement (in parallel with B.1)
├── Then parallel:
│   ├── Agent A: B.2 (verify) + B.3 (question)
│   ├── Agent B: B.4 (simple-change) + B.5 (feature)
│   ├── Agent C: B.6 (prompt files) + B.7 (global config)
├── B.8: workflow definition tests (after B.2-B.7)
→ Verification: typecheck, test, lint, commit
```

---

## Decisions Needed

1. **Checkpoint pass-through pattern** — recommend the merge-step pattern (Option A in original plan). Confirm before implementing B.5.
2. **`execute_phases` scope** — recommend simplified sequential version for v0.1; defer dynamic-parallel + retry loop. Confirm before implementing B.5.
3. **Workflow file location** — recommend `examples/workflows/` (versioned, testable; users copy or import). Decided unless flagged.

---

## Out of Scope

- The four deferred SDK gaps (conditional branching, dynamic parallelization, iteration/retry, multi-prompt agent steps) — all expressible inside `fn()` today; promote to first-class only if multiple authors hit the same pattern.
- OpenCode-specific workflow examples — the migration replaces OpenCode entirely. All examples target Claude Code.
