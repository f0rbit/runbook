# Live Agent Event Streaming

## Executive Summary

Make `runbook run` display real-time agent activity (tool calls, subagent spawns, text progress) alongside the existing runbook trace events. Currently the CLI polls `/runs/:id/trace` every 500ms and prints step-level events, but agent sessions appear as a black box — you see `step_start` → minutes pass → `step_complete`. This plan adds OpenCode event streaming into the engine so agent activity shows up as TraceEvents in the existing polling loop.

**Approach**: The OpenCode SDK exposes `/event` (SSE) and `/session/{id}/message` (message listing with parts). During `prompt()`, we subscribe to the global event stream, filter for our session's events, and emit runbook `TraceEvent`s in real-time. The CLI already formats all `agent_*` TraceEvent types — it just never receives them because the executor doesn't emit them today.

## Architecture Analysis

### What exists today

1. **TraceEvent types already defined** (`packages/core/src/types.ts:108-155`):
   - `agent_session_created` — emitted by engine ✓
   - `agent_prompt_sent` — defined but never emitted
   - `agent_tool_call` — defined but never emitted
   - `agent_tool_result` — defined but never emitted
   - `agent_response` — emitted by engine ✓
   - The full `AgentEvent` union (types.ts:108-115) also defines `text_chunk`, `completed`, `error`

2. **CLI formatStepEvent** (`packages/cli/src/output.ts:225-256`) already handles all agent event types:
   - `agent_tool_call` → `⚡ {tool_name}`
   - `agent_tool_result` → `← {tool_name}`
   - `agent_prompt_sent` → `→ prompt sent`
   - `agent_response` → `agent response ({duration})`

3. **AgentExecutor interface** (`types.ts:117-123`) already has an optional `subscribe` method:
   ```ts
   subscribe?: (session_id: string, handler: (event: AgentEvent) => void) => () => void;
   ```
   This was designed for exactly this purpose but never implemented.

4. **OpenCode SDK events** (`@opencode-ai/sdk` v1.1.53):
   - `event.subscribe()` → SSE stream of `Event` union on `/event` endpoint
   - `global.event()` → SSE stream of `GlobalEvent` on `/global/event` endpoint
   - Key event types for agent activity:
     - `message.part.updated` with `part: ToolPart` — tool call state changes (pending → running → completed)
     - `message.part.updated` with `part: TextPart` — text output chunks
     - `message.part.updated` with `part: AgentPart` — subagent spawns
     - `session.status` — idle/busy/retry status changes
     - `session.created` — child session creation (subagents)
     - `file.edited` — file modifications

5. **Engine's executeAgentStep** (`engine.ts:362-456`):
   - Creates session, emits `agent_session_created`
   - Calls `executor.prompt()` — blocking, no intermediate events
   - Emits `agent_response` after prompt returns
   - Never uses `executor.subscribe`

6. **TraceCollector** (`packages/core/src/trace.ts`):
   - Has `emit()` and `onEvent()` listener pattern
   - Engine wires `on_trace` callback → state store updates → CLI polls trace

### Key insight

The plumbing is 90% done. The TraceEvent types exist. The CLI formatting exists. The AgentExecutor interface has `subscribe`. The gap is:
1. `OpenCodeExecutor` doesn't implement `subscribe` or emit events during `prompt()`
2. The engine's `executeAgentStep` doesn't call `subscribe` or emit intermediate events

### OpenCode event mapping

| OpenCode Event | Part Type | → Runbook TraceEvent |
|---|---|---|
| `message.part.updated` | `ToolPart` (state=running) | `agent_tool_call` |
| `message.part.updated` | `ToolPart` (state=completed) | `agent_tool_result` |
| `message.part.updated` | `TextPart` | (skip — too noisy per-token, aggregate on response) |
| `message.part.updated` | `AgentPart` | New: `agent_subagent_spawned` — or reuse `agent_tool_call` with tool="subagent:{name}" |
| `session.created` (child) | — | New: `agent_subagent_spawned` |
| `session.status` (busy→idle) | — | (internal only — used by activity monitor) |
| `file.edited` | — | (skip — already captured in tool_result metadata) |

**DECISION NEEDED**: Should we add a new `agent_subagent_spawned` TraceEvent type, or reuse `agent_tool_call` with a synthetic tool name like `"subagent:{name}"`? Recommendation: reuse `agent_tool_call` to avoid a type change that touches core + schema + CLI. The tool name is already freeform.

## Implementation Plan

### Phase 1: OpenCode executor event streaming (core change)

**Task 1.1: Implement event subscription in OpenCodeExecutor**
- Files: `packages/server/src/providers/opencode.ts`
- ~120 LOC
- Dependencies: none
- Parallel: no (foundation)

Add event subscription to `OpenCodeExecutor.prompt()` that:
1. Before calling `this.client.session.prompt()`, start subscribing to OpenCode's event stream via `this.client.event.subscribe()`
2. Filter events by `sessionID` matching our session (plus child sessions)
3. The `subscribe` call returns an async iterable (SSE stream). Consume it in a background async loop.
4. Map `message.part.updated` events with `ToolPart` to `AgentEvent` callbacks:
   - `ToolPart` with `state.status === "running"` → `{ type: "tool_call", session_id, call: { tool, args, result: undefined } }`
   - `ToolPart` with `state.status === "completed"` → `{ type: "tool_result", session_id, tool, result: state.output }`
   - `AgentPart` → `{ type: "tool_call", session_id, call: { tool: "subagent:" + name, args: {} } }`
5. Track child session IDs from `session.created` events where `parentID === our_session_id`
6. Clean up SSE subscription when prompt completes (AbortController)

Implementation approach for `subscribe`:
```ts
// Add to OpenCodeExecutor
subscribe(session_id: string, handler: (event: AgentEvent) => void): () => void {
    const controller = new AbortController();
    // Start consuming the SSE stream in background
    this.consumeEvents(session_id, handler, controller.signal);
    return () => controller.abort();
}

private async consumeEvents(session_id: string, handler: (event: AgentEvent) => void, signal: AbortSignal) {
    const child_ids = new Set<string>();
    try {
        const { stream } = await this.client.event.subscribe({ signal });
        for await (const event of stream) {
            if (signal.aborted) break;
            // Map and filter events for this session
            const mapped = this.mapOpenCodeEvent(event, session_id, child_ids);
            if (mapped) handler(mapped);
        }
    } catch {
        // Stream ended or aborted — expected
    }
}
```

**Alternative approach (simpler, recommended)**: Instead of implementing `subscribe` on the executor, emit events directly during `prompt()` by accepting a callback parameter. But the interface already defines `subscribe` so let's use it.

**Actually, simplest approach**: Add an `on_event` callback to `prompt()`. But this changes the `AgentExecutor` interface. Let's stick with `subscribe`.

### Phase 2: Engine wiring — emit agent events during step execution

**Task 2.1: Wire subscribe into executeAgentStep**
- Files: `packages/server/src/engine.ts`
- ~30 LOC
- Dependencies: Task 1.1
- Parallel: no (depends on 1.1)

In `executeAgentStep()`, after creating the session, call `executor.subscribe?.()` to register an event handler that emits TraceEvents through `ctx.trace`:

```ts
// After session created, before prompt
const unsubscribe = executor.subscribe?.(session.id, (event: AgentEvent) => {
    switch (event.type) {
        case "tool_call":
            ctx.trace.emit({
                type: "agent_tool_call",
                step_id: step.id,
                session_id: session.id,
                call: event.call,
                timestamp: new Date(),
            });
            break;
        case "tool_result":
            ctx.trace.emit({
                type: "agent_tool_result",
                step_id: step.id,
                session_id: session.id,
                tool: event.tool,
                result: event.result,
                timestamp: new Date(),
            });
            break;
        // text_chunk and others — skip for now
    }
});

// ... existing prompt call ...

unsubscribe?.();
```

Also emit `agent_prompt_sent` which is currently defined but never emitted:
```ts
ctx.trace.emit({
    type: "agent_prompt_sent",
    step_id: step.id,
    session_id: session.id,
    text: final_prompt_text,
    timestamp: new Date(),
});
```

### Phase 3: CLI enhancements (optional, low priority)

The CLI **already works** — `formatStepEvent` handles all agent trace event types. The polling loop in `handleRun` will automatically pick up the new events from the trace.

However, two improvements would make the output nicer:

**Task 3.1: Add `--live` flag to `runbook status` for continuous polling**
- Files: `packages/cli/src/commands/status.ts`
- ~40 LOC
- Dependencies: none (independent)
- Parallel: yes (independent of 1.1/2.1)

Add a `--live` flag that makes `status` poll like `run` does:
```
runbook status <run-id> --live
```
This reuses the same polling + formatStepEvent pattern from `handleRun`.

**Task 3.2: Improve agent event formatting**
- Files: `packages/cli/src/output.ts`
- ~20 LOC
- Dependencies: none
- Parallel: yes

Enhance `formatStepEvent` for richer agent output:
- `agent_tool_call`: Show truncated args preview: `⚡ edit /src/foo.ts`  (extract file path from common tool args)
- `agent_tool_result`: Show result preview or just completion status
- Add indentation level for agent events (they're sub-events of steps)

### Phase 4: InMemoryAgentExecutor test support

**Task 4.1: Add subscribe support to InMemoryAgentExecutor**
- Files: `packages/core/src/test.ts`
- ~30 LOC
- Dependencies: none
- Parallel: yes (independent)

Add `subscribe` method and an `emitEvent` helper so tests can simulate agent events:
```ts
class InMemoryAgentExecutor {
    private event_handlers: Map<string, ((event: AgentEvent) => void)[]> = new Map();
    
    subscribe(session_id: string, handler: (event: AgentEvent) => void): () => void {
        const handlers = this.event_handlers.get(session_id) ?? [];
        handlers.push(handler);
        this.event_handlers.set(session_id, handlers);
        return () => {
            const h = this.event_handlers.get(session_id);
            if (h) this.event_handlers.set(session_id, h.filter(x => x !== handler));
        };
    }
    
    emitEvent(session_id: string, event: AgentEvent): void {
        for (const handler of this.event_handlers.get(session_id) ?? []) {
            handler(event);
        }
    }
}
```

**Task 4.2: Add integration tests for agent event streaming**
- Files: `packages/server/__tests__/integration/engine-execution.test.ts`
- ~60 LOC
- Dependencies: Task 2.1, Task 4.1
- Parallel: no (depends on 2.1 and 4.1)

Test that:
1. When `InMemoryAgentExecutor` emits events during prompt, they appear in the trace
2. Events have correct `step_id` and `session_id`
3. `agent_prompt_sent` appears in trace before `agent_response`
4. Events are properly timestamped and ordered

## Phase Summary

### Phase 1 — Foundation (sequential)
- **Task 1.1**: OpenCode executor event subscription (~120 LOC)
- → **Verification**: typecheck, existing tests pass, commit

### Phase 2 — Engine wiring (sequential, depends on Phase 1)
- **Task 2.1**: Wire subscribe into engine's executeAgentStep (~30 LOC)
- → **Verification**: typecheck, existing tests pass, commit

### Phase 3 — Test infrastructure + tests (parallel)
- **Task 4.1**: InMemoryAgentExecutor subscribe support (~30 LOC)
- **Task 4.2**: Integration tests for agent events (~60 LOC)
- → **Verification**: typecheck, all tests pass, commit

### Phase 4 — CLI polish (parallel, optional)
- **Task 3.1**: `--live` flag for `runbook status` (~40 LOC)
- **Task 3.2**: Improved agent event formatting (~20 LOC)
- → **Verification**: typecheck, all tests pass, commit

**Total estimated LOC**: ~300

## Risk Assessment

1. **SSE stream consumption during prompt()**: The OpenCode SDK's `event.subscribe()` returns an async iterable SSE stream. Starting this in parallel with the blocking `prompt()` call requires careful lifecycle management — the SSE consumer must not leak if prompt finishes or errors. Mitigation: AbortController pattern, same as activity monitor.

2. **Event volume**: Tool calls happen frequently in agent sessions. A complex agent task may produce 50-100+ tool call events. These all go into the trace event array and get polled by the CLI. For a single run this is fine. At scale (which we're not at yet), the trace array could get large. Acceptable for v0.1.

3. **Existing tests**: The engine tests use `InMemoryAgentExecutor` which doesn't have `subscribe`. Since `subscribe` is optional (`subscribe?.()`), all existing tests will work unchanged. The engine calls `executor.subscribe?.()` — if undefined, it's a no-op.

4. **OpenCode SSE connection**: The global event stream connects to `/event` on the OpenCode server. If the connection fails or isn't available, we gracefully skip — agent events just won't appear, same as today. No functionality regression.

## BREAKING changes

None. All changes are additive:
- New optional behavior in executor
- Engine uses optional `subscribe` method (backwards compatible)
- CLI already handles all event types
- InMemoryAgentExecutor gains new optional method

## Decision Points

1. **DECISION NEEDED**: Subagent representation — use `agent_tool_call` with `tool: "subagent:{name}"` vs new TraceEvent type. Recommendation: reuse existing type.

2. **DECISION NEEDED**: Should `text_chunk` events be streamed? They're per-token and very high volume. Recommendation: skip in v1, aggregate text in `agent_response`. Can add later with a `--verbose` flag.

3. **DECISION NEEDED**: Phase 4 (CLI polish) — implement now or defer? The core functionality works without it since formatStepEvent already handles all types. Recommendation: implement, it's small and improves UX.

## Suggested AGENTS.md updates

After implementation:
- Add note about `executor.subscribe` pattern: "OpenCodeExecutor subscribes to `/event` SSE during prompt() to stream tool_call and tool_result events into the trace"
- Add note about InMemoryAgentExecutor.emitEvent() for simulating agent events in tests
- Update test count after new tests are added
