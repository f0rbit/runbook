# Run Cancellation

## Summary

Wire up end-to-end run cancellation: CLI `cancel` command → HTTP `POST /runs/:id/cancel` → engine abort signal → in-flight shell/agent termination → session cleanup. The skeleton (AbortSignal on RunOpts, abort check between steps, error factories) exists but nothing is connected. This plan fills every gap.

## Affected Packages

| Package | Scope |
|---------|-------|
| `packages/core` | Add `"cancelled"` to RunState.status, add signal to PromptOpts, update InMemory providers |
| `packages/server` | Store AbortController per run, pass signal to shell/agent, call destroySession, add cancel endpoint |
| `packages/cli` | Add `cancelRun` client method, `cancel` command handler, update help text |

## Integration Point Analysis

### Type-level changes that cascade
- `RunState.status` gains `"cancelled"` — used by: state store, serialization in `runs.ts`, CLI `RunInfo.status`, `output.ts` status formatting
- `PromptOpts` gains optional `signal?: AbortSignal` — used by: `AgentExecutor.prompt()`, `InMemoryAgentExecutor.prompt()`, `OpenCodeExecutor.prompt()`
- `RunStateStore` gains `getController(run_id)` / stores `AbortController` alongside `RunState`

### No breaking changes
- `"cancelled"` is additive to the status union
- `signal` on `PromptOpts` is optional
- All existing tests pass without modification (they don't set or check `"cancelled"`)

## Detailed Task Breakdown

---

### Phase 1: Foundation — Types & In-Memory Providers

Sequential. All later phases depend on these type changes.

#### Task 1.1: Add `"cancelled"` to RunState.status + signal to PromptOpts
**Files:** `packages/core/src/types.ts`
**LOC:** ~5
**Changes:**
- `RunState.status`: add `"cancelled"` to union → `"pending" | "running" | "success" | "failure" | "cancelled"`
- `PromptOpts`: add `signal?: AbortSignal`

#### Task 1.2: Update InMemoryAgentExecutor to respect signal & track destroySession
**Files:** `packages/core/src/test.ts`
**LOC:** ~25
**Changes:**
- `InMemoryAgentExecutor.prompt()`: check `opts.signal?.aborted` before returning, return `err({ kind: "prompt_failed", session_id, cause: "aborted" })` if aborted
- Add a configurable delay (`prompt_delay_ms`) to InMemoryAgentExecutor so tests can abort mid-prompt
- `InMemoryAgentExecutor.destroySession()`: record call in `destroyed_sessions: string[]` array (for test assertions)
- `InMemoryShellProvider.exec()`: check `opts?.signal?.aborted` before returning, add configurable delay (`exec_delay_ms`) for testing abort during shell

#### Task 1.3: Update CLI output for `"cancelled"` status
**Files:** `packages/cli/src/output.ts`, `packages/cli/src/client.ts`
**LOC:** ~8
**Changes:**
- `statusColor("cancelled")` → YELLOW (or RED, user preference — using YELLOW to distinguish from hard failure)
- `statusIcon("cancelled")` → `⊘` (cancel symbol)
- `RunInfo.status` type: add `"cancelled"` to the union

---

### Phase 2: Engine Signal Propagation

Sequential within phase (engine changes are tightly coupled), but Phase 2 is independent from Task 1.3.

#### Task 2.1: Pass signal to shell provider
**Files:** `packages/server/src/engine.ts`
**LOC:** ~3
**Changes:**
- In `executeStep` case `"shell"`: pass `signal` from `ctx_base.signal` into shell exec opts
- Before: `shell_provider.exec(command, { cwd: engine_opts.working_directory })`
- After: `shell_provider.exec(command, { cwd: engine_opts.working_directory, signal: ctx_base.signal })`

#### Task 2.2: Pass signal to agent executor + call destroySession
**Files:** `packages/server/src/engine.ts`
**LOC:** ~30
**Changes:**
- In `executeAgentStep`: pass signal into `executor.prompt()` opts → `{ ...opts, signal: ctx.signal }`
- After `executor.prompt()` returns (success or failure): call `executor.destroySession?.(session.id)` for cleanup
  - On abort specifically: call destroySession before returning the error
  - On normal completion: call destroySession after extracting the response (fire-and-forget, don't block on result)
  - Log destroySession failures to trace but don't fail the step

#### Task 2.3: Abort propagation in parallel branches
**Files:** `packages/server/src/engine.ts`
**LOC:** ~15
**Changes:**
- Currently parallel uses `Promise.all` with no abort on first failure
- Change to: when any branch fails, abort remaining branches
- Implementation: create a child `AbortController` per parallel group, linked to parent signal. On first branch failure, call `child_controller.abort()`
- Use `Promise.allSettled` + check results, so we don't lose error info from racing branches

---

### Phase 3: Server Cancel Infrastructure

Can partially parallelize (3.1 and 3.2 touch different files).

#### Task 3.1: Store AbortController per run in state
**Files:** `packages/server/src/state.ts`
**LOC:** ~15
**Changes:**
- Add `controllers: Map<string, AbortController>` alongside runs map
- New methods on `RunStateStore`:
  - `createController(run_id): AbortController` — creates, stores, and returns a new AbortController
  - `getController(run_id): AbortController | undefined`
- No changes to `RunState` type itself — controller is server-internal, not serialized

#### Task 3.2: Wire AbortController into workflow execution
**Files:** `packages/server/src/routes/workflows.ts`
**LOC:** ~8
**Changes:**
- In `executeRunAsync`: create controller via `deps.state.createController(run_id)`, pass `controller.signal` to `engine.run()`
- On run completion (success or failure): clean up controller reference (optional, prevents memory leak for long-lived servers)
- On abort result: set status to `"cancelled"` instead of `"failure"`

#### Task 3.3: Add `POST /runs/:id/cancel` endpoint
**Files:** `packages/server/src/routes/runs.ts`
**LOC:** ~20
**Changes:**
- New route: `app.post("/runs/:id/cancel", ...)`
- Lookup run — 404 if not found
- Check status — 409 if not `"running"` (can't cancel a completed/pending run; for pending, we could cancel but it's an edge case — keep it simple)
- Get controller from state store, call `controller.abort()`
- Update status to `"cancelled"` immediately (engine will also set it, but this ensures instant feedback)
- Return `{ status: "cancelled" }`

---

### Phase 4: OpenCode Session Cleanup

Independent from Phase 3, but logically follows Phase 2.

#### Task 4.1: Implement destroySession in OpenCodeExecutor
**Files:** `packages/server/src/providers/opencode.ts`
**LOC:** ~25
**Changes:**
- `destroySession(session_id)`:
  1. Call `this.client.session.abort({ path: { id: session_id } })` — stops in-flight work
  2. Call `this.client.session.delete({ path: { id: session_id } })` — cleans up server-side
  3. Wrap both in try/catch → return `err()` on failure, `ok()` on success
  4. If abort fails (session already finished), still attempt delete

---

### Phase 5: CLI Cancel Command

Depends on Phase 3 (server endpoint must exist).

#### Task 5.1: Add `cancelRun` to RunbookClient
**Files:** `packages/cli/src/client.ts`
**LOC:** ~10
**Changes:**
- New method: `cancelRun(run_id: string): Promise<Result<void, ClientError>>`
- `POST /runs/${run_id}/cancel` — returns ok on 200, err on 404/409

#### Task 5.2: Add `handleCancel` command
**Files:** `packages/cli/src/commands/cancel.ts` (new file)
**LOC:** ~30
**Changes:**
- `handleCancel(args: string[], base_url: string)`
- If `args[0]` is a run ID: cancel that run
- If no args: fetch latest running run via `listRuns()`, cancel it (like `status` does for latest)
- Print result with formatted output

#### Task 5.3: Wire cancel command into CLI entry point
**Files:** `packages/cli/src/index.ts`
**LOC:** ~8
**Changes:**
- Import `handleCancel`
- Add `case "cancel":` to switch
- Add `cancel [run-id]` to help text

---

### Phase 6: Tests

Can parallelize test writing across files, but all depend on Phases 1-3 being complete.

#### Task 6.1: Engine cancellation tests
**Files:** `packages/server/__tests__/integration/engine-execution.test.ts`
**LOC:** ~80
**Tests:**
- **Cancel during shell step**: Use InMemoryShellProvider with delay, abort signal mid-execution, verify shell error returned
- **Cancel during agent step**: Use InMemoryAgentExecutor with delay, abort signal mid-prompt, verify agent error + destroySession called
- **Cancel propagates to parallel branches**: Start parallel workflow, abort, verify all branches get cancelled
- **destroySession called on normal completion**: Run agent step to completion, verify destroySession was called

#### Task 6.2: Server cancel API tests
**Files:** `packages/server/__tests__/integration/server-api.test.ts`
**LOC:** ~60
**Tests:**
- **POST /runs/:id/cancel on running run**: Submit slow workflow, cancel, verify 200 + status becomes "cancelled"
- **POST /runs/:id/cancel on unknown run**: Returns 404
- **POST /runs/:id/cancel on completed run**: Returns 409
- **Cancel during run shows cancelled in GET /runs/:id**: Submit, cancel, poll, verify status field

#### Task 6.3: CLI cancel command test (optional, lower priority)
**Files:** Could be tested via the client methods directly
**LOC:** ~20
**Tests:**
- Client `cancelRun` calls correct endpoint
- `handleCancel` with no args fetches latest running run

---

## Phase Execution Plan

```
Phase 1: Foundation (sequential — all types)
├── Task 1.1: RunState.status + PromptOpts signal  (core/types.ts)
├── Task 1.2: InMemory providers                    (core/test.ts)
├── Task 1.3: CLI output for cancelled              (cli/output.ts, cli/client.ts)
→ Verification: typecheck, existing tests pass, commit

Phase 2: Engine Signal Propagation (sequential — single file)
├── Task 2.1: Shell signal passthrough              (server/engine.ts)
├── Task 2.2: Agent signal + destroySession         (server/engine.ts)
├── Task 2.3: Parallel branch abort                 (server/engine.ts)
→ Verification: typecheck, existing tests pass, commit

Phase 3: Server Cancel Infrastructure (parallel where noted)
├── Task 3.1: State store AbortController     [Agent A] (server/state.ts)
├── Task 3.2: Wire controller in workflows    [Agent A] (server/routes/workflows.ts) — depends on 3.1
├── Task 3.3: Cancel endpoint                 [Agent B] (server/routes/runs.ts) — depends on 3.1
→ Verification: typecheck, existing tests pass, commit

Phase 4: OpenCode Cleanup (parallel with Phase 5)
├── Task 4.1: OpenCodeExecutor.destroySession [Agent A] (server/providers/opencode.ts)
→ Verification: typecheck, commit

Phase 5: CLI Cancel Command (parallel with Phase 4)
├── Task 5.1: Client cancelRun method         [Agent B] (cli/client.ts)
├── Task 5.2: handleCancel command            [Agent B] (cli/commands/cancel.ts — new)
├── Task 5.3: Wire into CLI entry point       [Agent B] (cli/index.ts)
→ Verification: typecheck, commit

Phase 6: Tests
├── Task 6.1: Engine cancellation tests       [Agent A] (server/__tests__/...)
├── Task 6.2: Server cancel API tests         [Agent B] (server/__tests__/...)
→ Verification: full test suite, lint, commit
```

## Key Design Decisions

### 1. Cancel sets `"cancelled"` immediately, engine also detects abort
The cancel endpoint sets `status: "cancelled"` right away so a polling CLI sees the update instantly. The engine's abort check will also produce an `aborted` error which the `executeRunAsync` handler maps to `"cancelled"`. The immediate status set is idempotent — worst case it gets set twice.

### 2. destroySession is called on ALL completions, not just abort
Agent sessions should be cleaned up regardless. This prevents orphaned OpenCode sessions. The call is fire-and-forget (we log but don't fail the step if cleanup fails).

### 3. Parallel abort uses child AbortControllers
Each parallel group gets its own `AbortController` whose signal is linked to the parent run signal. On first branch failure, the child controller aborts remaining branches. This is cleaner than racing promises.

### 4. InMemory providers get configurable delay
Rather than complex async coordination in tests, we add a simple `prompt_delay_ms` / `exec_delay_ms` property. Tests set a delay, then abort before it elapses. This is deterministic and avoids flaky timing.

### 5. No `"cancelled"` on Trace.status
`Trace.status` stays `"success" | "failure"` — a cancelled trace is a failed trace from the engine's perspective. Only `RunState.status` distinguishes cancellation from error. This avoids changing the Trace type which is used in git-store serialization.

## Estimated Total LOC
~330 lines of production code + ~160 lines of tests ≈ **~490 lines total**

## Suggested AGENTS.md Updates

After implementation, add:

```markdown
## Cancellation
- `POST /runs/:id/cancel` aborts a running workflow
- `AbortController` per run stored in `RunStateStore` (not on `RunState` — it's server-internal)
- Engine passes signal to shell (via `ShellOpts.signal`) and agent (via `PromptOpts.signal`)
- `destroySession` is called after every agent step (success, failure, or abort)
- `RunState.status: "cancelled"` is distinct from `"failure"` — `Trace.status` stays `"success" | "failure"`
- Parallel branches get child AbortControllers linked to the parent run signal
```
