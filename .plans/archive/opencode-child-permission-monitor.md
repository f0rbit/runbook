# OpenCode Monitor: Child Session Permission Detection

## Executive Summary

The `monitorActivity()` method and the stale error handler in `OpenCodeExecutor.prompt()` both only check `p.sessionID === session_id` (parent) for pending permissions. When opencode spawns a child session (e.g. `@explore` subagent) and that child hits a permission prompt, the monitor misses it. The parent still reports as "busy" (waiting for child), which resets `last_activity` and delays stale detection. Similarly, the stale error message won't identify the permission if it's on a child session.

**Root cause already fixed**: The session-level permission rules (already applied in `createSession()`) should prevent children from hitting unexpected permission prompts. This plan is a **defense-in-depth improvement** for faster detection and better diagnostics when it does happen.

## Analysis

### Current behavior (lines 196-262, monitor)

1. `permission.list()` → checks `p.sessionID === session_id` (parent only)
2. If no pending: `session.status()` → if parent "busy", resets `last_activity` and `continue`
3. If no pending: check parent `time.updated`
4. If no pending: check child `time.updated`

**Problem**: Step 2 resets activity when parent is "busy". But parent is "busy" because it's waiting for a child that is stuck on a permission prompt. Steps 3-4 check `time.updated` which has stopped advancing (child is blocked), so eventually the stale timeout fires — but only after `stale_timeout_ms` of idle time accumulates from the point the child stalled, not from when we could have detected it via `permission.list()`.

### Current behavior (lines 113-124, stale handler)

Same issue: `perms.find((p: any) => p.sessionID === session_id)` only checks parent. If the pending permission is on a child session, `pending_permission` stays `undefined` and the error message doesn't mention it.

### Fix

Both locations need to check permissions across the session tree (parent + all children). The child session IDs are already discoverable via `session.list()` + filtering on `parentID`.

## Changes

All changes are in one file: `packages/server/src/providers/opencode.ts`

---

### Phase 1: Monitor child-permission detection

**Lines 196-262** — `monitorActivity()` method

**Current**: Permission check only looks at parent session.

**Fix**: After listing permissions, also list sessions to find children, and check if ANY session in the tree has a pending permission.

```
// Replace the permission check block (lines 201-210):

let has_pending_permission = false;
try {
    const perm_result = await this.client.permission.list();
    const perms = perm_result?.data ?? perm_result;
    if (Array.isArray(perms)) {
        // Check parent AND child sessions for pending permissions
        const session_ids = new Set([session_id]);
        try {
            const all_sessions_result = await this.client.session.list({});
            const all_sessions = all_sessions_result?.data ?? all_sessions_result;
            if (Array.isArray(all_sessions)) {
                for (const s of all_sessions) {
                    if (s.parentID === session_id) session_ids.add(s.id);
                }
            }
        } catch {
            // Fall back to parent-only check
        }
        has_pending_permission = perms.some((p: any) => session_ids.has(p.sessionID));
    }
} catch {
    // Permission endpoint may not be available — assume no pending
}
```

**Impact**: When a child session has a pending permission:
- `has_pending_permission = true`
- Step 2 (busy check) is skipped → `last_activity` NOT reset
- Steps 3-4 (time.updated) skipped → stale timeout fires based on last real activity
- Result: stale detection fires within one poll interval (~5s) instead of waiting for `stale_timeout_ms` of inactivity

**Note**: This adds an extra `session.list()` call per monitor tick. The same call already happens in step 4 (line 243), so we could refactor to share the result. However, step 4 is gated behind `!has_pending_permission`, and when we DO have a pending permission we `continue` before reaching it. The duplication only occurs on the no-permission path. For clarity and simplicity, the duplicate call on the no-permission path is acceptable — it's a poll loop hitting a local API every 5s.

**Estimated LOC**: ~15 changed (net +8)

---

### Phase 2: Stale error handler child-permission detection

**Lines 113-124** — stale handler in `prompt()`

**Current**: `perms.find((p: any) => p.sessionID === session_id)` — parent only.

**Fix**: Reuse the child session discovery from the activity summary block (lines 126-143) which already calls `session.list()`. Restructure to discover children first, then check permissions across all session IDs.

```
// Replace lines 113-148 with:

let pending_permission: string | undefined;
let pending_session_id: string | undefined;
let activity_summary = "";
try {
    // Discover session tree first (needed for both permission check and summary)
    const session_result = await this.client.session.get({ sessionID: session_id });
    const session_data = session_result?.data ?? session_result;
    activity_summary += `Session ${session_id} (${session_data?.title ?? "untitled"})`;

    const all_sessions_result = await this.client.session.list({});
    const all_sessions = all_sessions_result?.data ?? all_sessions_result;
    const children = Array.isArray(all_sessions)
        ? all_sessions.filter((s: any) => s.parentID === session_id)
        : [];

    if (children.length > 0) {
        activity_summary += `\n  Child sessions: ${children.map((c: any) => `${c.id.slice(0, 12)} (${c.title?.slice(0, 40) ?? "?"})`).join(", ")}`;
    }

    // Check permissions across entire session tree
    const tree_ids = new Set([session_id, ...children.map((c: any) => c.id)]);
    try {
        const perm_result = await this.client.permission.list();
        const perms = perm_result?.data ?? perm_result;
        if (Array.isArray(perms)) {
            const match = perms.find((p: any) => tree_ids.has(p.sessionID));
            if (match) {
                pending_permission = match.permission;
                pending_session_id = match.sessionID;
            }
        }
    } catch {
        // Best effort
    }
} catch {
    // Best effort
}

const perm_detail = pending_permission
    ? pending_session_id && pending_session_id !== session_id
        ? ` — pending permission "${pending_permission}" on child session ${pending_session_id}`
        : ` — pending permission "${pending_permission}"`
    : "";
const base_msg = `Agent stalled after ${stale_timeout_ms}ms${perm_detail} — inspect with: opencode attach ${session_id}`;
const cause = activity_summary ? `${base_msg}\n  ${activity_summary}` : base_msg;
```

**Impact**: Error message now identifies:
- Which permission is pending
- Whether it's on the parent or a child session
- Which child session ID (for debugging)

**Bonus**: Eliminates duplicate `session.list()` / `session.get()` calls — the current code calls them separately for permission check (lines 116-117) and activity summary (lines 129-139). The refactored version shares the results.

**Estimated LOC**: ~30 changed (net +5, refactored)

---

### Phase 3: Test verification

No new tests needed — `OpenCodeExecutor` is an external-I/O provider that talks to a real opencode server. The codebase correctly doesn't unit-test it (per AGENTS.md: "No mocking — Provider pattern replaces all external dependencies"). The `InMemoryAgentExecutor` is the test double.

Verification:
- `bun run typecheck` — ensure no type regressions
- `bun test` — ensure no existing tests break
- Manual review of the diff

**Estimated LOC**: 0

---

## Task Breakdown

| # | Task | Est. LOC | Depends | Files |
|---|------|----------|---------|-------|
| 1 | Monitor: check child sessions for pending permissions | +8 | — | `opencode.ts:196-262` |
| 2 | Stale handler: check child sessions + improve error message | +5 | — | `opencode.ts:106-153` |
| 3 | Typecheck + test verification | 0 | 1, 2 | — |

Tasks 1 and 2 are in the same file but touch non-overlapping line ranges. They CAN be done by the same coder agent in a single pass (recommended since the file is small and the changes are related).

## Phases

```
Phase 1: Implementation (single coder agent)
├── Task 1: Monitor child-permission detection (lines 196-262)
├── Task 2: Stale handler child-permission detection (lines 106-153)
→ Verification: typecheck, test, commit
```

Single phase. Single coder. ~45 LOC changed total.

## Decisions

No `DECISION NEEDED` items — this is a straightforward improvement within existing patterns.

## Suggested AGENTS.md updates

None — the child-permission pattern is implementation detail of the opencode provider, not an architectural decision worth capturing. The existing notes about permission-aware stale detection are sufficient context.
