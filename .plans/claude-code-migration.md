# Claude Code Migration

Replace OpenCode with Claude Code as the **only** agent executor. No dual-provider phase, no compatibility shim. OpenCode is fully extinct after this plan lands.

## Executive Summary

`@f0rbit/runbook` currently exposes a single `AgentExecutor` implementation (`OpenCodeExecutor`) that talks to a locally-running OpenCode HTTP server via `@opencode-ai/sdk/v2/client`. We are deleting that implementation in its entirety and replacing it with a `ClaudeCodeExecutor` that is a first-class native integration with Claude Code.

The `AgentExecutor` interface itself is **not changing** — the contract (`createSession`, `prompt`, `subscribe?`, `destroySession?`, `healthCheck?`) is provider-agnostic and already a good fit. The schema is also already permissive (`type: z.string()`) so no schema bump is needed for the new provider's `type: "claude-code"` discriminator.

The only architectural decision worth surfacing is **how** the new `ClaudeCodeExecutor` talks to Claude Code. See [DECISION NEEDED](#decision-needed-claude-code-integration-approach) below.

---

## Current State (what exists today)

```
runbook server
├── resolveProviders()                         ← string-literal switch on agent.type
│     └─ if "opencode" → dynamic import("./opencode")
└── providers/opencode.ts (505 LOC)            ← OpenCodeExecutor class
      ├── createSession    → client.session.create(...)
      ├── prompt           → client.session.prompt + activity monitor (5s poll, 180s stale)
      ├── subscribe        → 3s poll over session.messages, dedupe by part.id
      ├── destroySession   → session.abort + session.delete
      └── healthCheck      → session.list({})

dependencies
└── @opencode-ai/sdk : "*"  ← runtime peer; dynamic-imported

surfaces leaking provider name
├── packages/server/src/index.ts          (re-exports OpenCodeExecutor*)
├── packages/server/src/engine.ts:708     (error message mentions `opencode attach`)
├── packages/cli/src/commands/serve.ts    (banner + diagnostic mention "opencode")
├── packages/server/__tests__/.../provider-resolve.test.ts (one OpenCode test)
└── README.md / USECASE.md / AGENTS.md    (narrative copy)
```

## Target State

```
runbook server
├── resolveProviders()                         ← string-literal switch on agent.type
│     └─ if "claude-code" → dynamic import("./claude-code")
└── providers/claude-code.ts                   ← ClaudeCodeExecutor class (~250-350 LOC)
      ├── createSession    → SDK session init / process spawn / API session_id mint
      ├── prompt           → streaming send + completion-driven idle timeout
      ├── subscribe        → real-time stream fan-out (SSE / stdout / streaming SDK)
      ├── destroySession   → cleanup live process / detach SSE stream
      └── healthCheck      → cheap reachability probe

dependencies
└── @anthropic-ai/claude-agent-sdk : "<pinned>"  ← if option (1) — see DECISION below
```

No `OpenCodeExecutor` class, no `@opencode-ai/sdk` dep, no string `"opencode"` anywhere in source, tests, or docs. Historical files under `.plans/` keep their references — they're history.

---

## DECISION NEEDED: Claude Code Integration Approach

Three viable approaches. **Recommendation: Option 1 (Claude Agent SDK)**.

### Option 1 — Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) **[recommended]**

Anthropic's official headless SDK for spawning Claude Code programmatically. Real SSE streaming of message/tool events, session_id management, native subagent + MCP support, prompt caching built in.

**Pros**
- Highest-fidelity replacement for what `OpenCodeExecutor` did. Sessions, tool calls, multi-agent — all native.
- Streaming is push-based, so we **delete the polling code** (`monitorActivity` + `consumeEvents`). `subscribe` becomes a thin adapter from the SDK's event stream to our `AgentEvent` discriminated union.
- "Native first-class" intent maps directly: this is the SDK Claude Code itself uses.
- Prompt caching is automatic — better economics than rolling our own.
- Test ergonomics: tests gate on `process.env.ANTHROPIC_API_KEY` (consistent with how OpenCode tests gated on `OPENCODE_URL`). `InMemoryAgentExecutor` continues to cover all unit/integration tests — the SDK is only exercised by the gated real-provider test.

**Cons**
- New runtime dep. The SDK is fairly new and tracks Claude Code's evolution; we'll need to pin a version and bump deliberately.
- Bun compatibility needs a smoke test up front (Anthropic's SDKs are Node-first; usually run fine on Bun, but verify).

### Option 2 — Subprocess (`spawn("claude", ["--print", "--output-format", "stream-json"])`)

Invoke the user's locally-installed `claude` CLI. Parse stream-json line-by-line.

**Pros**
- Zero new SDK dep. Uses whatever CLI is installed.
- Decouples from SDK API churn.

**Cons**
- Coupled to CLI flag stability (which Anthropic explicitly warns against using as a programmatic API).
- Bun.spawn lifecycle, signal handling, EPIPE on close, and stream-json parsing are all things we'd own.
- We currently have a "providers manage external I/O, never `Bun.spawn` directly from the engine" rule. Spawning the CLI inside a provider doesn't break that rule (the provider IS the boundary), but it does pull process management complexity into the codebase.
- We'd reimplement what the SDK already gives us.

### Option 3 — Direct Anthropic Messages API (`@anthropic-ai/sdk`)

Bypass Claude Code entirely.

**Pros**
- Bare-metal control. No middle layer.

**Cons**
- We'd be reimplementing the agent loop, tool use, MCP, subagents, file editing — basically rebuilding Claude Code badly.
- Violates the "claude-code native" intent. This is "Anthropic Messages API integration", not "Claude Code integration".
- **Don't do this** unless the user wants something fundamentally different from what Claude Code provides.

### Recommendation

**Option 1 (Claude Agent SDK).** Best fit for the existing `AgentExecutor` shape, lets us delete polling code rather than port it, and is the only option that genuinely earns the "claude-code native" label. The rest of this plan assumes Option 1; if the user picks Option 2 the work splits roughly the same way but the `prompt`/`subscribe` task becomes "stream-json parser" instead of "SDK event adapter".

---

## File-Level Breakdown — Deletions

| Path | What | LOC removed |
|---|---|---|
| `packages/server/src/providers/opencode.ts` | Entire file (`OpenCodeExecutor` + helpers) | ~505 |
| `packages/server/src/providers/resolve.ts` | The `if "opencode"` branch (lines 19-32) | ~14 |
| `packages/server/src/index.ts` | `OpenCodeExecutor`, `OpenCodeExecutorOpts` re-exports (lines 7-8) | 2 |
| `packages/server/src/engine.ts:708` | `opencode attach {session_id}` in timeout error message | 1 |
| `packages/cli/src/commands/serve.ts:36,42` | `opencode @ {url}` banner + "opencode serve" diagnostic | 2 |
| `packages/server/package.json:12` | `@opencode-ai/sdk: "*"` dep | 1 |
| `packages/server/__tests__/integration/provider-resolve.test.ts:36-47` | "returns error when opencode executor fails to initialize" test | ~12 |

**Total deletion: ~537 LOC + 1 dep.**

`bun install` after the dep removal will prune `@opencode-ai/sdk` from `bun.lock`.

## File-Level Breakdown — New Code

| Path | Public surface | LOC est |
|---|---|---|
| `packages/server/src/providers/claude-code.ts` | `class ClaudeCodeExecutor implements AgentExecutor`, `type ClaudeCodeExecutorOpts` | ~250-350 |
| `packages/server/src/providers/resolve.ts` | New `if "claude-code"` branch (parallels old structure) | +14 |
| `packages/server/src/index.ts` | New re-exports `ClaudeCodeExecutor`, `ClaudeCodeExecutorOpts` | +2 |
| `packages/server/src/engine.ts:708` | New error msg: `Agent timed out after {timeout_ms}ms — session: {session_id}` (provider-neutral) | 1 |
| `packages/cli/src/commands/serve.ts:36,42` | Banner: `Checking agent provider (claude-code)...`; diagnostic: link to setup docs | 2 |
| `packages/server/package.json` | Add `@anthropic-ai/claude-agent-sdk` dep (Option 1) | 1 |
| `packages/server/__tests__/integration/provider-resolve.test.ts` | New "creates claude-code executor when configured" test | ~14 |
| `packages/server/__tests__/integration/claude-code-provider.test.ts` | New gated real-provider test (`describe.skipIf(!process.env.ANTHROPIC_API_KEY)`) | ~80-120 |

**Total addition: ~360-500 LOC + 1 dep.**

Net: roughly break-even. Should land smaller than current OpenCode because polling logic goes away.

---

## AgentExecutor Method Mapping (Option 1 — SDK)

`createSession`
```
SDK: const session = await sdk.startSession({
  cwd: opts.working_directory,
  systemPrompt: opts.system_prompt,
  // permissions: opts.permissions mapped to SDK shape;
  //   "question" auto-deny is no longer needed — the SDK is non-interactive by default.
});
return ok({ id: session.id, created_at: new Date() });
```
Cache `working_directory` per session_id only if the SDK doesn't already track it. Likely unnecessary.

`prompt`
```
SDK: const stream = sdk.prompt(session_id, opts.text, { signal: opts.signal });

// Drain the stream, accumulate text + tool_calls + files_changed.
// The SDK emits "message", "tool_use", "tool_result" events that we
// translate into AgentEvent and forward to subscribers (see subscribe).
// stream resolves with the final response shape.
//
// If opts.timeout_ms elapses with no event, we abort the SDK call via
// AbortController and return { kind: "timeout", session_id, timeout_ms }.
// Note: this is a real "no events" timeout, not OpenCode's "stale activity"
// timeout — there's no need for activity polling because the SDK pushes events.

return ok({ session_id, text, metadata: { files_changed, tool_calls, tokens_used, duration_ms } });
```

`subscribe`
```
Maintain Map<session_id, Set<handler>>. When prompt() drains the SDK stream,
fan out events directly to registered handlers. No polling, no dedupe.
Returns unsubscribe function.
```

`destroySession`
```
SDK: await sdk.endSession(session_id);  // or equivalent cleanup
return ok(undefined);
```

`healthCheck`
```
Cheap probe — e.g. SDK init or models.list. Same retry semantics as today
(verifyProviders already implements 3x exponential backoff, no changes).
```

---

## Decisions on the 5 OpenCode-Specific Behaviors

| # | OpenCode behavior | Claude Code | Why |
|---|---|---|---|
| 1 | Activity monitor with stale detection (5s poll, 180s timeout, auto-reject pending questions) | **DROP** | SDK pushes events. Idle timeout is just `if (timeSinceLastEvent > timeout_ms) abort`. No questions exist in non-interactive SDK mode. |
| 2 | 3s polling event subscription with part.id dedupe | **REPLACE** with stream fan-out | SDK gives a real event stream. `subscribe` becomes a thin pub/sub layer over it. ~50 LOC instead of ~100. |
| 3 | Auto-deny `"question"` permission | **DROP** | The SDK is non-interactive by default. There's no "ask the human" channel to deny. Runbook's checkpoint steps remain the human-input mechanism, unchanged. |
| 4 | Health check via `session.list({})` | **KEEP** (different call) | Same shape, different SDK method. Probably `sdk.health()` or a no-op session create. |
| 5 | Working-directory cache `Map<session_id, directory>` | **DROP** if SDK tracks it; otherwise **KEEP** | Implementation detail. Decide while writing the file — likely unneeded. |

---

## Documentation Updates

Wording-level only — no architectural copy beyond what's already there.

`README.md:280`
- before: `agent: { type: "opencode" },`
- after: `agent: { type: "claude-code" },`

`USECASE.md:37`
- before: "OpenCode is the first implementation; Claude Code, Aider, and others can be added behind the same interface without changing workflow definitions."
- after: "Claude Code is the bundled implementation; Aider, Goose, and others can be added behind the same interface without changing workflow definitions."

`USECASE.md:143`
- before: "...four step types (fn, shell, agent, checkpoint), in-memory state, and git artifact storage. OpenCode is the first agent executor."
- after: "...four step types (fn, shell, agent, checkpoint), in-memory state, and git artifact storage. Claude Code is the bundled agent executor."

`USECASE.md:151` (planned-features bullet) — drop "Claude Code" from the list since it's now bundled. Replace with: "Additional agent executors — Aider, Goose, Cursor behind the same AgentExecutor interface".

`USECASE.md:5` — already lists Claude Code first; no change needed beyond confirming the order reads naturally without OpenCode being implied as the bundled choice. (Optionally keep OpenCode in the list of "agents people use" — it's accurate as ecosystem context.)

`AGENTS.md:28`
- before: "OpenCode is the first implementation via `@opencode-ai/sdk`"
- after: "Claude Code is the bundled implementation via `@anthropic-ai/claude-agent-sdk`"

`AGENTS.md:78`
- before: "Always creates `BunShellProvider`; creates `OpenCodeExecutor` when `agent.type === \"opencode\"`"
- after: "Always creates `BunShellProvider`; creates `ClaudeCodeExecutor` when `agent.type === \"claude-code\"`"

**Do NOT edit `.plans/*.md`.** Those files are history.

---

## Test Plan

### Deleted
- `packages/server/__tests__/integration/provider-resolve.test.ts:36-47` ("returns error when opencode executor fails to initialize") — the test exists to confirm error propagation through `resolveProviders` for the only string-literal branch. Replace with the equivalent claude-code test, not a literal port.

### Updated
- `packages/core/__tests__/unit/schema-validation.test.ts:9` — already uses `type: "claude-code"`. **No change needed.** This is one of the few places already future-proof.

### New
1. `packages/server/__tests__/integration/provider-resolve.test.ts` — new test "creates claude-code executor when configured". Mirrors deleted opencode test in shape.
2. `packages/server/__tests__/integration/claude-code-provider.test.ts` — gated real-provider test:
   ```ts
   describe.skipIf(!process.env.ANTHROPIC_API_KEY)("ClaudeCodeExecutor (real)", () => {
     test("creates session, prompts, gets response", async () => { ... });
     test("subscribe receives streamed events", async () => { ... });
     test("destroySession cleans up", async () => { ... });
     test("healthCheck succeeds with valid auth", async () => { ... });
   });
   ```
   Mirrors what OpenCode integration testing did. The env var name is your call — `ANTHROPIC_API_KEY` matches Anthropic conventions; `CLAUDE_CODE_*` would be more provider-specific. Recommend `ANTHROPIC_API_KEY` since that's what the SDK reads anyway.

### Unchanged
- All engine tests, server-api tests, git-store tests use `InMemoryAgentExecutor` from `@f0rbit/runbook/test`. **The in-memory executor is provider-agnostic and does not change.** This is the single biggest win of the existing architecture — the refactor blast radius into the test suite is minimal.

### Test gate naming convention to add to AGENTS.md
"Real-provider integration tests are gated via `describe.skipIf(!process.env.<PROVIDER_ENV_VAR>)`. For Claude Code: `ANTHROPIC_API_KEY`."

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Claude Agent SDK has Bun compatibility issues | Low-Med | High (would block Option 1 entirely) | Phase 1 includes a Bun smoke test before committing to the SDK. If it fails, fall back to Option 2. |
| SDK event shape differs from our `AgentEvent` union | Med | Low (just adapter code) | Adapter layer in `subscribe` handles translation; `AgentEvent` is our domain type and stays put. |
| Permissions semantics differ | Med | Low | Map runbook `AgentPermission` to whatever the SDK accepts; document gaps; permissions are advisory in the runbook flow anyway (checkpoint steps are the real human gate). |
| User's existing config breaks at runtime | High | Low | Single-line config change in `~/.config/runbook/runbook.config.ts` (handled by orchestrator after this plan ships). |
| `@opencode-ai/sdk` cached in `bun.lock` after removal | Low | Low | `bun install` after dep removal regenerates lockfile cleanly. |

## Rollback Strategy

This is a single-version breaking release. Rollback = revert the merge. There is no graceful per-phase rollback because OpenCode and Claude Code are mutually exclusive by design (no dual-provider phase). If Phase 2 (provider implementation) doesn't pan out, abandon the branch and re-plan; the phase 1 deletions are tied to phase 2 implementation in the same merge.

---

## Phases

Phases are designed for parallel execution where safe. **One phase = one commit.**

### Phase 1 — Foundation: dep + provider scaffolding (sequential, single coder)

This phase is sequential because everything depends on it. Use a `coder` (not `coder-fast`) — it includes the SDK Bun smoke test which requires judgement.

- Task 1.1 `<TBD-devpad-id>` — Add `@anthropic-ai/claude-agent-sdk` to `packages/server/package.json` (replacing `@opencode-ai/sdk`). Run `bun install`. Write a 20-line spike that imports the SDK, starts a session, sends one prompt, and prints the response. Confirm it runs under Bun. **If it fails, STOP and surface to user — Option 1 is dead.** ~30 LOC + lockfile.
- Task 1.2 `<TBD-devpad-id>` — Create `packages/server/src/providers/claude-code.ts` with the `ClaudeCodeExecutor` class skeleton: constructor, `static async create()`, all five `AgentExecutor` methods stubbed as `return err({ kind: "connection_failed", cause: "not implemented" })`. Wire types from `@f0rbit/runbook`. **Don't implement yet.** ~80 LOC.

**Verification coder**: `bun run typecheck && bun test`. Tests should still pass — no consumer is using the new provider yet. Commit: `feat(server): scaffold ClaudeCodeExecutor provider`.

### Phase 2 — Implementation (parallel coder-fast in worktrees, where independent)

These three tasks each touch different methods on the same file. We have a choice:

**Option A — single coder, sequential within file** (safer, recommended for first implementation):
- Single `coder` agent implements all `ClaudeCodeExecutor` methods in one pass.

**Option B — three coder-fast in worktrees, merged later** (faster, riskier):
- Worktree A: `createSession` + `destroySession` + `healthCheck` (the lifecycle methods)
- Worktree B: `prompt` (streaming + timeout)
- Worktree C: `subscribe` (event fan-out)
- Verification coder merges, resolves the inevitable import/typing overlaps.

**Recommendation: Option A** for this phase. The methods share state (session map, SDK client) and parallel agents will create merge friction without much speed win — it's all one ~250-LOC file.

- Task 2.1 `<TBD-devpad-id>` — Implement all `ClaudeCodeExecutor` methods per the [mapping section](#agentexecutor-method-mapping-option-1--sdk). ~250 LOC.

**Verification coder**: `bun run typecheck && bun test`. Commit: `feat(server): implement ClaudeCodeExecutor against claude-agent-sdk`.

### Phase 3 — Wire-up (parallel coder-fast in worktrees)

Independent files, safely parallelizable.

- Task 3.1 `<TBD-devpad-id>` — Worktree A: `packages/server/src/providers/resolve.ts` — replace the `if "opencode"` branch with `if "claude-code"` calling the new executor. ~14 LOC.
- Task 3.2 `<TBD-devpad-id>` — Worktree B: `packages/server/src/index.ts` — swap `OpenCodeExecutor` re-exports for `ClaudeCodeExecutor`. 2 LOC.
- Task 3.3 `<TBD-devpad-id>` — Worktree C: `packages/server/src/engine.ts:708` — replace `opencode attach` reference with provider-neutral wording. 1 LOC.
- Task 3.4 `<TBD-devpad-id>` — Worktree D: `packages/cli/src/commands/serve.ts:36,42` — banner + diagnostic copy update. 2 LOC.

**Verification coder**: merge worktrees, `bun run typecheck && bun test && biome check`. Commit: `feat(server,cli): wire claude-code through resolveProviders and CLI surfaces`.

### Phase 4 — Extinction (parallel coder-fast in worktrees)

Pure deletions. Safely parallel.

- Task 4.1 `<TBD-devpad-id>` — Worktree A: Delete `packages/server/src/providers/opencode.ts`. ~505 LOC removed.
- Task 4.2 `<TBD-devpad-id>` — Worktree B: Update `packages/server/__tests__/integration/provider-resolve.test.ts` — delete the OpenCode test (lines 36-47), add the equivalent claude-code test. Net change: ~0 LOC.

**Verification coder**: merge, `bun install` (prunes `@opencode-ai/sdk`), `bun run typecheck && bun test && biome check`. Commit: `chore(server): remove OpenCode executor and tests`.

### Phase 5 — Tests + Docs (parallel coder-fast in worktrees)

- Task 5.1 `<TBD-devpad-id>` — Worktree A: Add `packages/server/__tests__/integration/claude-code-provider.test.ts` — gated real-provider test suite (4 tests). ~100 LOC.
- Task 5.2 `<TBD-devpad-id>` — Worktree B: Update `README.md:280` (config example), `USECASE.md:37,143,151` (narrative), `AGENTS.md:28,78` (architecture). Wording-level only.

**Verification coder**: merge, `bun run typecheck && bun test && biome check`. Run the gated test locally if `ANTHROPIC_API_KEY` is set. Commit: `docs,test: claude-code provider tests and narrative updates`.

---

## Suggested Commit Boundaries (one phase = one commit)

1. `feat(server): scaffold ClaudeCodeExecutor provider`
2. `feat(server): implement ClaudeCodeExecutor against claude-agent-sdk`
3. `feat(server,cli): wire claude-code through resolveProviders and CLI surfaces`
4. `chore(server): remove OpenCode executor and tests`
5. `docs,test: claude-code provider tests and narrative updates`

If the user prefers a single migration commit, phases 3-5 can collapse into one — but keep phases 1-2 separate so the Bun-compat smoke test for the SDK lands as its own reviewable unit. Phase 4 (deletions) can also stand alone as a particularly clean revert point.

---

## Skipped (per user direction)

- `~/.config/runbook/runbook.config.ts` migration — orchestrator handles after this lands.
- `.plans/*.md` historical files — leave alone.
- Dual-provider phase — explicitly out of scope; no compatibility with OpenCode.

---

## Suggested AGENTS.md Updates

After this plan lands, propose the following edits to the user (do not write directly):

### Section "Key Architecture Decisions" (line 28)
- before: "OpenCode is the first implementation via `@opencode-ai/sdk`"
- after: "Claude Code is the bundled implementation via `@anthropic-ai/claude-agent-sdk`"

### Section "Provider Wiring" (line 78)
- before: "Always creates `BunShellProvider`; creates `OpenCodeExecutor` when `agent.type === \"opencode\"`"
- after: "Always creates `BunShellProvider`; creates `ClaudeCodeExecutor` when `agent.type === \"claude-code\"`"

### New section to add under "Testing"
> **Real-provider gating.** Real-provider integration tests are gated via `describe.skipIf(!process.env.<VAR>)`. For Claude Code, the gating var is `ANTHROPIC_API_KEY` (matches the SDK's own auth lookup). In-memory tests via `InMemoryAgentExecutor` cover all non-gated paths and are provider-agnostic — they do not change when the bundled provider changes.

### New section to add under "Key Architecture Decisions"
> **Streaming over polling.** Agent providers should expose push-based event streams via `subscribe`. The bundled Claude Code provider uses the SDK's native event stream; do not introduce polling loops in new providers unless the underlying API offers no streaming alternative.

---

## Open Questions for User Approval

1. **DECISION NEEDED**: Confirm Option 1 (Claude Agent SDK) vs Option 2 (subprocess) vs Option 3 (Messages API). Recommendation is Option 1.
2. **Env var name** for gated real-provider tests: `ANTHROPIC_API_KEY` (recommended, matches SDK) vs `CLAUDE_CODE_API_KEY` (more provider-specific).
3. **Commit granularity**: 5 commits (one per phase) vs collapsed to 2-3. Recommendation is 5 — they're each individually revertable.
