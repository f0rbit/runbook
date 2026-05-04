# Server Resilience & Persistence

## Executive Summary

The runbook server stores all run state in-memory (`Map<string, RunState>`). A server restart destroys all run data, checkpoint callbacks, and in-flight execution context. The git-store package exists and is fully functional but the server never calls it.

This plan adds persistence in two independently-shippable phases:

- **Phase 1 (Archive)**: Wire git-store into the server. Completed/failed runs are automatically persisted to `refs/runbook/runs/<run-id>`. Run history survives restarts. The `artifacts.git` config flag is honored.
- **Phase 2 (Checkpoint Resume)**: Runs paused at a checkpoint can resume after a server restart. Uses event-sourcing: replay `step_complete` events to reconstruct `previous_output`, then re-execute from the checkpoint step forward.

**Level 3** (reconnect to in-progress agent sessions mid-step) is explicitly deferred as future work. OpenCode sessions survive restarts and session IDs are in trace events, so it's feasible later.

### Value delivered per phase

| Phase | Survives restart? | Resume? | History? | Breaking? |
|-------|-------------------|---------|----------|-----------|
| 1     | Completed runs    | No      | Yes      | No        |
| 2     | Checkpoint-paused | Yes     | Yes      | Yes (minor) |

---

## Phase 1: Archive Completed Runs to Git-Store

### Problem

The server finishes a workflow run (`executeRunAsync` in `workflows.ts:50-113`), updates the in-memory state store, and never persists anything. The git-store package is complete but unwired. The `artifacts.git` config flag exists in the schema but is never read.

### Design

1. **Wire git-store into `ServerDeps`**. When `config.artifacts?.git` is truthy, `handleServe` creates a `GitArtifactStore` and passes it into `ServerDeps`.

2. **Persist on completion**. In `executeRunAsync`, after the engine's `.then()` handler updates state to `success` or `failure`, call `git_store.store()` with a `StorableRun` built from the final state. This is fire-and-forget with error logging — a failed git-store write should not break the workflow result.

3. **Hydrate on startup**. On server boot (when `artifacts.git` is enabled), read existing runs from git-store via `git_store.list()` + `git_store.getTrace()` and populate the in-memory state store. This gives the server history visibility immediately.

4. **Add `GET /runs/history` route** (or extend `GET /runs` with `?source=git`). Serves runs from git-store for runs that are no longer in memory. The existing `GET /runs` continues to serve in-memory state for active/recent runs.

### File Changes

| File | Change | LOC |
|------|--------|-----|
| `packages/server/src/server.ts` | Add optional `git_store` to `ServerDeps` | ~5 |
| `packages/server/src/routes/workflows.ts` | After run completion, call `git_store.store()` | ~30 |
| `packages/server/src/routes/runs.ts` | Add `GET /runs/history` that reads from git-store | ~25 |
| `packages/cli/src/commands/serve.ts` | Create `GitArtifactStore` when `config.artifacts?.git`, pass to deps | ~15 |
| `packages/server/src/index.ts` | Re-export any new types | ~3 |

### Task Breakdown

#### Task 1A: Add `git_store` to ServerDeps and wire into workflows route

- **Files**: `packages/server/src/server.ts`, `packages/server/src/routes/workflows.ts`
- **LOC**: ~35
- **Parallel safe**: No (foundation for 1B and 1C)
- **Details**:
  - Add `git_store?: GitArtifactStore` to `ServerDeps`
  - Pass `git_store` through to `WorkflowDeps`
  - In `executeRunAsync`, after the `.then()` block sets `status: "success"` or `status: "failure"`:
    ```typescript
    if (deps.git_store) {
      const storable: StorableRun = {
        run_id,
        workflow_id: workflow.id,
        input,
        output: result.ok ? result.value.output : undefined,
        trace: result.ok ? result.value.trace : /* build from trace_events */,
        duration_ms: result.ok ? result.value.duration_ms : 0,
      };
      deps.git_store.store(storable).then((r) => {
        if (!r.ok) console.error(`[runbook] git-store write failed for ${run_id}:`, r.error);
      });
    }
    ```
  - The store call is async fire-and-forget. It must not block the response or error the run.

#### Task 1B: Hydrate state store from git-store on startup

- **Files**: `packages/cli/src/commands/serve.ts`
- **LOC**: ~20
- **Parallel safe**: Yes (independent from 1C)
- **Details**:
  - When `config.artifacts?.git` is truthy, create `createGitArtifactStore(working_directory)`
  - Call `git_store.list()` to get `StoredRunInfo[]`
  - For each, call `git_store.getTrace(run_id)` and populate the state store with a `RunState` constructed from the stored metadata
  - Pass `git_store` into `createServer({ engine, state, workflows, git_store })`
  - If `git_store.list()` fails (e.g., not a git repo), log a warning and continue without hydration

#### Task 1C: Git-store history route

- **Files**: `packages/server/src/routes/runs.ts`
- **LOC**: ~25
- **Parallel safe**: Yes (independent from 1B)
- **Details**:
  - Add `git_store?: GitArtifactStore` to `RunDeps`
  - Add `GET /runs/history` route:
    - If no `git_store`, return `{ runs: [], source: "git" }` 
    - Otherwise call `git_store.list()` and return the `StoredRunInfo[]`
  - This gives CLI commands like `runbook history` a server-backed data source instead of needing direct git access

#### Task 1D: Server index exports + re-exports

- **Files**: `packages/server/src/index.ts`
- **LOC**: ~3
- **Parallel safe**: Yes
- **Details**: Re-export any new types added (minimal)

### Phase 1 Execution Plan

```
Phase 1A: Foundation (sequential)
├── Task 1A: git_store in ServerDeps + persist on completion
→ Verification: typecheck, test, commit

Phase 1B: Hydrate + History (parallel)
├── Agent A: Task 1B — hydrate on startup
├── Agent B: Task 1C — GET /runs/history route
├── Agent C: Task 1D — re-exports
→ Verification: typecheck, test, commit
```

---

## Phase 2: Checkpoint Resume via Event-Sourcing

### Problem

When a workflow is paused at a checkpoint step, the engine is blocked on a `Promise` (in `checkpoint.ts:15`). The `resolve`/`reject` callbacks are closures held in the `PendingCheckpoint` object stored in `RunState.pending_checkpoints`. These closures are not serializable. If the server restarts, the Promise, the callbacks, and the engine's entire call stack are gone.

Additionally, the `feature` workflow uses a module-level `execution_context` closure to carry plan data across a checkpoint boundary. This pattern is inherently non-serializable.

### Design: Event-Sourced Replay

The trace event stream already contains everything needed to reconstruct state up to a checkpoint:

1. `workflow_start` — contains the input
2. `step_complete` (per completed step) — contains each step's output  
3. `checkpoint_waiting` — marks where execution paused

**Resume algorithm:**
1. Load the run's trace from git-store (or from the hydrated state store)
2. Find the last `checkpoint_waiting` event — this identifies the step where execution paused
3. Extract `step_complete` outputs for all steps that ran before the checkpoint
4. Walk the workflow's `steps[]` array. For each step that has a matching `step_complete` event, skip execution and use the stored output as `previous_output`
5. When reaching the checkpoint step, execute it fresh (the server creates a new checkpoint Promise, the CLI submits the response via `POST /checkpoints/:id`)
6. Continue normal execution from there

**Key insight**: The engine doesn't need to "resume" — it re-runs from scratch but short-circuits completed steps using stored outputs. The trace is the source of truth.

### Handling the `execution_context` Closure Pattern

The `feature` workflow's `execution_context` module-level variable carries `plan_data` across a checkpoint. This breaks replay because:
- Step N (explore/plan agent) stores data in `execution_context`
- Checkpoint step pauses
- Step N+2 (fn step) reads `execution_context` to drive phase execution

**Solution**: The `fn()` step that reads `execution_context` should instead read from `previous_output` chain. The pipe mapper receives `(workflow_input, previous_output)` — the plan data should flow through the pipeline, not through a side-channel.

This is a **BREAKING CHANGE** for any workflow that uses the `execution_context` closure pattern. The fix:
- The checkpoint step's output schema should include the plan data (or be `z.any()` passthrough)
- The `pipe()` mapper after the checkpoint should extract plan data from `previous_output`
- Remove the module-level `execution_context` variable

This is a design constraint that users must adopt: **all state that needs to survive a checkpoint must flow through the pipeline** (via step inputs/outputs), not through closures.

### New Types

```typescript
// packages/core/src/types.ts

/** Snapshot of a run's progress, sufficient to resume after restart */
export type RunSnapshot = {
  run_id: string;
  workflow_id: string;
  input: unknown;
  /** Map of step_id -> output for completed steps */
  completed_steps: Map<string, unknown>;
  /** The step_id where execution should resume */
  resume_at: string;
  /** The checkpoint prompt (for re-registering) */
  checkpoint_prompt?: string;
  /** Original trace events (for continuity) */
  trace_events: TraceEvent[];
};
```

### Engine Changes

```typescript
// packages/server/src/engine.ts — new field in RunOpts
export type RunOpts = {
  run_id?: string;
  signal?: AbortSignal;
  on_trace?: (event: TraceEvent) => void;
  checkpoint?: CheckpointProvider;
  /** If set, skip steps whose output is already known */
  snapshot?: RunSnapshot;
};
```

In `createEngine().run()`:
- If `opts.snapshot` is provided, before executing each step, check if `snapshot.completed_steps.has(step.id)`
- If yes, emit a `step_skipped` trace event with `reason: "replayed from snapshot"`, set `previous_output = snapshot.completed_steps.get(step.id)`, and continue to the next step
- If no, execute normally

This is a ~15 line change to the main `for (const node of workflow.steps)` loop.

### Server Changes

```typescript
// packages/server/src/routes/workflows.ts — new endpoint
app.post("/workflows/:id/resume/:run_id", async (c) => {
  // 1. Load run from state store (hydrated from git) or git-store
  // 2. Build RunSnapshot from trace events
  // 3. Call engine.run() with snapshot
  // 4. Return 202 with run_id
});
```

```typescript
// Helper: build snapshot from trace
function buildSnapshot(run: RunState): RunSnapshot | null {
  const checkpoint_event = run.trace.events
    .filter(e => e.type === "checkpoint_waiting")
    .at(-1);
  if (!checkpoint_event) return null;

  const completed = new Map<string, unknown>();
  for (const event of run.trace.events) {
    if (event.type === "step_complete") {
      completed.set(event.step_id, event.output);
    }
  }

  return {
    run_id: run.run_id,
    workflow_id: run.workflow_id,
    input: run.input,
    completed_steps: completed,
    resume_at: checkpoint_event.step_id,
    checkpoint_prompt: checkpoint_event.prompt,
    trace_events: run.trace.events,
  };
}
```

### Persistence at Checkpoint

In addition to persisting on completion (Phase 1), we also persist when a checkpoint is reached. The `on_trace` callback detects `checkpoint_waiting` events and triggers a git-store write with what's known so far. This ensures the checkpoint state survives a restart even if the run never completed.

### CLI Changes

```typescript
// packages/cli/src/commands/run.ts or new resume.ts
// runbook resume <run-id>
// 1. POST /workflows/:workflow_id/resume/:run_id
// 2. Poll as usual
```

### File Changes

| File | Change | LOC |
|------|--------|-----|
| `packages/core/src/types.ts` | Add `RunSnapshot` type | ~15 |
| `packages/core/src/index.ts` | Export `RunSnapshot` | ~1 |
| `packages/server/src/engine.ts` | Add `snapshot` to `RunOpts`, skip-logic in run loop | ~25 |
| `packages/server/src/routes/workflows.ts` | Add `POST /workflows/:id/resume/:run_id`, `buildSnapshot()` helper, persist at checkpoint | ~50 |
| `packages/server/src/routes/runs.ts` | Possibly extend run state serialization for snapshot info | ~5 |
| `packages/cli/src/commands/resume.ts` | New `runbook resume` command | ~30 |
| `packages/cli/src/client.ts` | Add `resumeRun()` method | ~10 |
| `packages/cli/src/index.ts` | Wire `resume` command | ~5 |

### Task Breakdown

#### Task 2A: `RunSnapshot` type + engine skip-logic

- **Files**: `packages/core/src/types.ts`, `packages/core/src/index.ts`, `packages/server/src/engine.ts`
- **LOC**: ~40
- **Parallel safe**: No (foundation for everything else in Phase 2)
- **Details**:
  - Add `RunSnapshot` to core types
  - Add `snapshot?: RunSnapshot` to `RunOpts`
  - In the engine's step loop, before executing each step:
    ```typescript
    if (opts?.snapshot?.completed_steps.has(step.id)) {
      const stored_output = opts.snapshot.completed_steps.get(step.id);
      trace.emit({ type: "step_skipped", step_id: step.id, reason: "replayed from snapshot", timestamp: new Date() });
      previous_output = stored_output;
      continue;
    }
    ```
  - For parallel nodes, check each branch independently

#### Task 2B: Resume route + snapshot builder + checkpoint persistence

- **Files**: `packages/server/src/routes/workflows.ts`
- **LOC**: ~55
- **Parallel safe**: Yes (after 2A)
- **Details**:
  - Add `buildSnapshot(run: RunState): RunSnapshot | null` helper
  - Add `POST /workflows/:id/resume/:run_id` route
  - In `executeRunAsync`, modify the `on_trace` callback to detect `checkpoint_waiting` events and trigger a git-store write

#### Task 2C: CLI resume command

- **Files**: `packages/cli/src/commands/resume.ts` (new), `packages/cli/src/client.ts`, `packages/cli/src/index.ts`
- **LOC**: ~45
- **Parallel safe**: Yes (after 2A, parallel with 2B)
- **Details**:
  - Add `resumeRun(workflow_id, run_id)` to `RunbookClient`
  - Create `handleResume(args)` command handler
  - Wire into CLI's command dispatch

#### Task 2D: Tests for snapshot replay + resume flow

- **Files**: `packages/server/__tests__/integration/engine-resume.test.ts` (new)
- **LOC**: ~100
- **Parallel safe**: Yes (after 2A and 2B)
- **Details**:
  - Test: engine with snapshot skips completed steps and uses stored outputs
  - Test: engine emits `step_skipped` events for replayed steps
  - Test: checkpoint step after replay creates a fresh checkpoint Promise
  - Test: `buildSnapshot` correctly extracts completed steps from trace
  - Test: full resume flow via server API (POST run → checkpoint → restart → POST resume → complete)

### Phase 2 Execution Plan

```
Phase 2A: Foundation (sequential)
├── Task 2A: RunSnapshot type + engine skip-logic
→ Verification: typecheck, test, commit

Phase 2B: Resume infrastructure (parallel)
├── Agent A: Task 2B — resume route + snapshot builder
├── Agent B: Task 2C — CLI resume command
→ Verification: typecheck, test, commit

Phase 2C: Tests (sequential)
├── Task 2D: Integration tests for resume flow
→ Verification: typecheck, full test suite, commit
```

---

## Phase 3: Tests for Phase 1

### Task 3A: Git-store integration in server tests

- **Files**: `packages/server/__tests__/integration/git-store-integration.test.ts` (new)
- **LOC**: ~80
- **Parallel safe**: Yes
- **Details**:
  - Test: completed run is persisted to git-store when `git_store` is in deps
  - Test: `GET /runs/history` returns stored runs
  - Test: hydration populates state store on startup
  - Test: git-store write failure doesn't break the run result
  - Uses temp git repos (same pattern as existing git-store tests)

### Execution

```
Phase 3: Tests (after Phase 1)
├── Task 3A: git-store integration tests
→ Verification: typecheck, full test suite, commit
```

---

## Future Work (Level 3: Mid-Step Resume)

Not in scope for this plan, but noted for feasibility:

- **Agent session reconnection**: OpenCode sessions survive restarts. The `agent_session_created` trace event contains the session ID. A Level 3 implementation would:
  1. Detect the in-progress agent step from the trace
  2. Call `executor.prompt()` with the existing session ID (not `createSession`)
  3. Wait for the response and continue

- **Shell step reconnection**: Not feasible — shell processes don't survive server restarts. The step would need to re-run.

- **fn() step reconnection**: Not feasible — arbitrary async functions can't be resumed mid-execution.

The architecture from Phase 2 (snapshot + skip) makes Level 3 a natural extension: add `"step_in_progress"` to the snapshot and teach the engine to reconnect rather than skip or re-execute.

---

## Breaking Changes

1. **`execution_context` closure pattern** (Phase 2): Workflows that use module-level closures to carry state across checkpoint boundaries must refactor to pass data through the pipeline via `pipe()` mappers. This affects the `feature` workflow definition at `~/.config/runbook/`.

   **Migration path**: Modify the checkpoint step's output schema to include the plan data. The `pipe()` mapper after the checkpoint extracts plan data from `previous_output` instead of reading `execution_context`.

2. **`RunState.status` enum** (Phase 2): A new `"resuming"` status may be added to distinguish resumed runs from fresh ones. This is additive (not removing values) but consumers matching on the enum exhaustively will need to handle it.

   **Migration path**: Add `"resuming"` to the `z.enum([...])` in `RunStateSchema` and the `RunState` type. Existing `"running"` matches still work — `"resuming"` transitions to `"running"` once replay completes.

3. **`ServerDeps` type** (Phase 1): Adds optional `git_store` field. Non-breaking — existing callers don't need to provide it.

---

## Dependency Graph

```
Phase 1A (Task 1A) ─────────────────┐
                                     ├── Phase 1B (Tasks 1B, 1C, 1D) ── Phase 3 (Task 3A)
                                     │
Phase 2A (Task 2A) ──── Phase 2B (Tasks 2B, 2C) ──── Phase 2C (Task 2D)
```

Phase 1 and Phase 2 are independently shippable. Phase 2 depends on Phase 1 at runtime (it reads from git-store) but the code changes are largely independent — Phase 2's engine changes don't touch Phase 1's git-store wiring.

**Recommended order**: Phase 1 → Phase 3 → Phase 2 (ship archival first, validate, then add resume).

---

## Estimated Total LOC

| Phase | LOC |
|-------|-----|
| Phase 1 (Archive) | ~100 |
| Phase 2 (Resume) | ~240 |
| Phase 3 (Tests for Phase 1) | ~80 |
| Phase 2D (Tests for Phase 2) | ~100 |
| **Total** | **~520** |

---

## JSON Plan Output

```json
{
  "plan_file": ".plans/server-resilience-v2.md",
  "phases": [
    {
      "name": "Phase 1A: Git-Store Foundation",
      "tasks": [
        {
          "id": "1A",
          "description": "Add git_store to ServerDeps and persist completed runs on workflow finish",
          "files": [
            "packages/server/src/server.ts",
            "packages/server/src/routes/workflows.ts"
          ],
          "parallel_safe": false
        }
      ]
    },
    {
      "name": "Phase 1B: Hydrate + History",
      "tasks": [
        {
          "id": "1B",
          "description": "Hydrate in-memory state store from git-store on server startup",
          "files": [
            "packages/cli/src/commands/serve.ts"
          ],
          "parallel_safe": true
        },
        {
          "id": "1C",
          "description": "Add GET /runs/history route reading from git-store",
          "files": [
            "packages/server/src/routes/runs.ts"
          ],
          "parallel_safe": true
        },
        {
          "id": "1D",
          "description": "Update server index exports for new types",
          "files": [
            "packages/server/src/index.ts"
          ],
          "parallel_safe": true
        }
      ]
    },
    {
      "name": "Phase 2A: Snapshot Foundation",
      "tasks": [
        {
          "id": "2A",
          "description": "Add RunSnapshot type to core and snapshot-based skip logic to engine run loop",
          "files": [
            "packages/core/src/types.ts",
            "packages/core/src/index.ts",
            "packages/server/src/engine.ts"
          ],
          "parallel_safe": false
        }
      ]
    },
    {
      "name": "Phase 2B: Resume Infrastructure",
      "tasks": [
        {
          "id": "2B",
          "description": "Add POST /workflows/:id/resume/:run_id route, buildSnapshot helper, and checkpoint persistence trigger",
          "files": [
            "packages/server/src/routes/workflows.ts"
          ],
          "parallel_safe": true
        },
        {
          "id": "2C",
          "description": "Add runbook resume CLI command with client method",
          "files": [
            "packages/cli/src/commands/resume.ts",
            "packages/cli/src/client.ts",
            "packages/cli/src/index.ts"
          ],
          "parallel_safe": true
        }
      ]
    },
    {
      "name": "Phase 3: Tests",
      "tasks": [
        {
          "id": "3A",
          "description": "Integration tests for git-store archival, hydration, and history route",
          "files": [
            "packages/server/__tests__/integration/git-store-integration.test.ts"
          ],
          "parallel_safe": true
        },
        {
          "id": "2D",
          "description": "Integration tests for snapshot replay, resume flow, and buildSnapshot",
          "files": [
            "packages/server/__tests__/integration/engine-resume.test.ts"
          ],
          "parallel_safe": true
        }
      ]
    }
  ],
  "breaking_changes": [
    "Workflows using module-level closures (execution_context pattern) to carry state across checkpoints must refactor to pass data through pipe() mappers instead",
    "RunState.status enum gains 'resuming' value — exhaustive matches need updating"
  ]
}
```

---

## Suggested AGENTS.md Updates

After implementation, add:

```markdown
## Persistence & Resilience
- `ServerDeps.git_store` — optional `GitArtifactStore`, created when `config.artifacts.git` is truthy
- Completed runs are automatically archived to git-store (fire-and-forget, errors logged not thrown)
- On startup with `artifacts.git`, server hydrates in-memory state from git-store history
- `GET /runs/history` — reads from git-store, separate from `GET /runs` (in-memory)
- `RunSnapshot` type enables checkpoint resume via event-sourced replay
- Engine `RunOpts.snapshot` causes completed steps to be skipped (output read from snapshot)
- Checkpoint-paused runs persist to git-store on `checkpoint_waiting` event
- `POST /workflows/:id/resume/:run_id` — rebuilds snapshot from trace, re-runs with skip logic
- **Convention**: All state that must survive a checkpoint MUST flow through pipe() mappers, not module-level closures
```
