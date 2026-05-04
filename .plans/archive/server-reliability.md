# Server Reliability & CLI Error Visibility

## Executive Summary

Four issues when running `runbook serve` + `runbook run` locally:

1. Server starts without verifying the agent provider (OpenCode) is reachable — fails silently at runtime
2. `runbook run` poll loop exits on failure but prints nothing useful
3. `runbook status` requires a run-id — should show most recent run when no arg given
4. No `GET /runs` endpoint exists — `runbook status` (no args) needs a way to find the latest run

All fixes are backwards-compatible. No breaking changes.

## Analysis

### Issue 1: No health check on agent provider

`resolveProviders()` creates an `OpenCodeExecutor` via `OpenCodeExecutor.create()` which only builds the SDK client. It never sends a request to verify OpenCode is actually running. The first failure happens deep inside `engine.run()` → `prompt()` which surfaces as a vague `execution_error` wrapped in a `step_failed` workflow error.

**Fix**: Add a `healthCheck()` method to `AgentExecutor` interface. Call it in `handleServe` after `resolveProviders()` with retry logic. If unreachable after retries, exit non-zero with a clear message.

### Issue 2: `runbook run` silent on failure

`handleRun` (run.ts:44-55) polls status, then fetches the trace and prints it. The problem: when a run fails fast, the trace may have events but `formatTrace` only prints step summaries. If the failure is a `config_error` or the engine never started a step, the trace has zero step events → `formatTrace` returns just the header line with no error info.

Additionally, the run's `error` field is never printed — only the trace. A failed run should explicitly print the error from `RunInfo.error`.

**Fix**: After the poll loop, check the final status. If `"failure"`, fetch the run status (which includes the `error` field) and print it with `formatError`. Still print the trace for step-level detail.

### Issue 3: `runbook status` with no args

Currently hard-exits with a usage message. Users want `runbook status` to show the most recent run.

**Fix**:
- Add `GET /runs` endpoint to server that returns all runs (sorted by `started_at` descending)
- Add `listRuns()` to `RunbookClient`
- In `handleStatus`, when no run-id, call `listRuns()`, pick the first (most recent), show it
- If no runs exist, print a helpful message

### Issue 4: Better error output on run failure

`formatRunStatus` shows the error `kind` via `formatErrorKind` but that only prints the discriminator string (e.g. `"step_failed"`). It doesn't drill into the cause.

**Fix**: Replace `formatErrorKind` with `formatError` for the error field in `formatRunStatus`, which already handles all error shapes with cause detail.

---

## Task Breakdown

### Phase 1: Server-side — health check + list runs endpoint

Two independent tasks, both in `packages/server`.

#### Task 1A: `healthCheck()` on `AgentExecutor` + OpenCode implementation
- **Files**: `packages/core/src/types.ts`, `packages/core/src/test.ts`, `packages/server/src/providers/opencode.ts`
- **LOC**: ~40
- **Details**:
  - Add optional `healthCheck?: () => Promise<Result<void, AgentError>>` to `AgentExecutor` type
  - Implement on `OpenCodeExecutor`: call `this.client.session.list()` (or similar lightweight endpoint) to verify connectivity
  - Implement on `InMemoryAgentExecutor`: return `ok(undefined)` always
  - Export a `verifyProviders` function from `packages/server/src/providers/resolve.ts` that calls `agent.healthCheck?.()` with retry logic (3 attempts, exponential backoff: 500ms, 1500ms, 4500ms)

#### Task 1B: `GET /runs` endpoint
- **Files**: `packages/server/src/routes/runs.ts`
- **LOC**: ~15
- **Details**:
  - Add `app.get("/runs", ...)` that returns `{ runs: RunState[] }` sorted by `started_at` descending
  - Reuse `serializeRun` helper already in the file
  - Optional `?status=running` query filter (nice-to-have, skip for now)

**Parallel**: 1A and 1B can run in parallel (they touch different files, except 1A touches types.ts which 1B doesn't need).

### Phase 2: CLI improvements — all in `packages/cli`

Three independent tasks.

#### Task 2A: `handleServe` health check on startup
- **Files**: `packages/cli/src/commands/serve.ts`
- **LOC**: ~25
- **Details**:
  - After `resolveProviders()` succeeds, if `provider_result.value.agent` exists and has `healthCheck`, call `verifyProviders()` (imported from server package)
  - On failure: print `"Agent provider (opencode) is not reachable at <url>. Is OpenCode running?"` + the error cause, then `process.exit(1)`
  - On success: print `"Agent provider: opencode ✓"` before the "listening" message

#### Task 2B: `handleRun` failure output
- **Files**: `packages/cli/src/commands/run.ts`
- **LOC**: ~20
- **Details**:
  - After poll loop exits, fetch final status via `client.getRunStatus()`
  - If status is `"failure"`:
    - Print run status with `formatRunStatus`
    - Print error detail with `formatError(status_result.value.error)` 
    - Print trace (if it has events) for step-level context
    - Exit with code 1
  - If status is `"success"`: print trace as before

#### Task 2C: `handleStatus` default to most recent run + `listRuns` client method
- **Files**: `packages/cli/src/commands/status.ts`, `packages/cli/src/client.ts`
- **LOC**: ~25
- **Details**:
  - Add `listRuns()` to `RunbookClient` — `GET /runs` → `Result<RunInfo[], ClientError>`
  - In `handleStatus`, when no `run_id` arg:
    - Call `client.listRuns()`
    - If empty: print `"No runs found. Start one with: runbook run <workflow>"`
    - If non-empty: show the first (most recent) run with `formatRunStatus`

#### Task 2D: Improve `formatRunStatus` error detail
- **Files**: `packages/cli/src/output.ts`
- **LOC**: ~5
- **Details**:
  - Replace `formatErrorKind(run.error)` call in `formatRunStatus` with `formatError(run.error)` for full cause detail
  - This is a one-liner but impacts all status display

**Parallel**: 2A, 2B, 2C, 2D can all run in parallel (each touches distinct files, except 2C touches `client.ts` which no other task touches, and 2D touches `output.ts` which 2B imports but doesn't modify).

### Phase 3: Tests

#### Task 3A: Server API tests for `GET /runs` and health check
- **Files**: `packages/server/__tests__/integration/server-api.test.ts`
- **LOC**: ~50
- **Details**:
  - Test `GET /runs` returns empty list initially
  - Test `GET /runs` returns runs after submitting a workflow
  - Test runs are sorted by `started_at` descending
  - Test `verifyProviders` with `InMemoryAgentExecutor` (succeeds)
  - Test `verifyProviders` retry logic with a failing executor

#### Task 3B: CLI output tests for failure formatting
- **Files**: `packages/cli/__tests__/output.test.ts` (new or existing)
- **LOC**: ~30
- **Details**:
  - Test `formatRunStatus` with a failed run shows error cause
  - Test `formatError` with `step_failed` + nested `agent_error` shows full chain

**Parallel**: 3A and 3B can run in parallel.

---

## Phase Summary

```
Phase 1: Server-side (parallel)
├── Agent A: Task 1A — healthCheck() on AgentExecutor + verify helper
│   Files: core/src/types.ts, core/src/test.ts, server/src/providers/opencode.ts, server/src/providers/resolve.ts
├── Agent B: Task 1B — GET /runs endpoint
│   Files: server/src/routes/runs.ts
→ Verification: typecheck, test, commit

Phase 2: CLI improvements (parallel)
├── Agent A: Task 2A — handleServe health check
│   Files: cli/src/commands/serve.ts
├── Agent B: Task 2B — handleRun failure output
│   Files: cli/src/commands/run.ts
├── Agent C: Task 2C — handleStatus + listRuns
│   Files: cli/src/commands/status.ts, cli/src/client.ts
├── Agent D: Task 2D — formatRunStatus error detail
│   Files: cli/src/output.ts
→ Verification: typecheck, test, commit

Phase 3: Tests (parallel)
├── Agent A: Task 3A — server API tests
│   Files: server/__tests__/integration/server-api.test.ts
├── Agent B: Task 3B — CLI output tests
│   Files: cli/__tests__/output.test.ts
→ Verification: typecheck, full test suite, commit
```

## Estimated Total LOC: ~210

## Decisions

No `DECISION NEEDED` items — all changes are additive and backwards-compatible:
- `healthCheck` is optional on the interface, so existing implementations don't break
- `GET /runs` is a new endpoint, no existing routes affected
- CLI changes are purely additive output improvements

## Suggested AGENTS.md Updates

After implementation, consider adding:

```markdown
## Provider Health Checks
- `AgentExecutor.healthCheck?()` — optional method, called at server startup
- `verifyProviders()` in server package handles retry logic (3 attempts, exponential backoff)
- Server prints provider status on startup before "listening" message

## Server API
- `GET /runs` — lists all runs sorted by started_at descending (added for CLI `status` default)
- `RunbookClient.listRuns()` — client method for the above
```
