# Agent Questions — First-Class Support

## Executive Summary

When an opencode agent session asks a question (via the `question` tool), runbook currently auto-rejects it. This plan designs first-class question support: routing agent questions through the engine → server → CLI → user, with per-step configuration for how questions are handled.

**Key design decision: questions are NOT checkpoints.** They are a mid-step interaction within an active agent session. Checkpoints are discrete pipeline steps that pause the entire workflow. Questions are ephemeral interruptions within an agent step that pause only the session. The abstraction is different enough that unifying them would create a leaky, confusing API. Instead, questions get their own lightweight flow that reuses the same server↔CLI polling pattern.

## Architecture

### How it works today

```
opencode session → question tool → question.list() shows pending
stale monitor → polls question.list() → auto-rejects all questions
```

### How it will work

```
opencode session → question tool → question appears in question.list()
stale monitor → polls question.list() → checks step's question_policy
  ├─ "reject" → question.reject() (current behavior)
  ├─ "forward" → emits agent_question trace event + registers PendingQuestion on RunState
  └─ "auto" → question.reply() with preconfigured answers
server → exposes GET /runs/:id (includes pending_questions list)
       → exposes POST /runs/:id/questions/:question_id (answer endpoint)
CLI poll loop → sees pending_questions → renders interactive prompt → POSTs answer
server handler → forwards answer to opencode via question.reply()
stale monitor → detects answered question → resets activity timer
```

### Why not checkpoints?

| Aspect | Checkpoint | Agent Question |
|--------|-----------|----------------|
| Scope | Entire workflow pauses | Only agent session pauses |
| Lifecycle | Discrete pipeline step | Mid-step interruption |
| Schema | Step defines input/output Zod schemas | opencode defines question shape |
| Resume | Requires snapshot replay after restart | No restart — session is still alive |
| Output | Replaces previous step output | Goes back into the same prompt cycle |
| Author control | Step definition | Step option |
| Source | Workflow author creates checkpoint | Agent decides to ask |

Checkpoints are structural. Questions are operational. Trying to model questions as "mini-checkpoints" would:
1. Require the engine to interrupt `executeAgentStep` mid-execution with a checkpoint-like pause — this breaks the clean `prompt() → response` flow
2. Confuse workflow authors: "is this a step that might ask questions, or a checkpoint?"
3. Add complexity to snapshot/resume logic for something that doesn't survive restart anyway

## Detailed Design

### 1. Step-level configuration: `question_policy`

Add an optional `question_policy` field to `AgentStepOpts`:

```typescript
// packages/core/src/types.ts
export type QuestionPolicy =
  | "reject"                    // auto-reject all questions (default, current behavior)
  | "accept-first"             // auto-answer with the first option for every question
  | "forward"                   // forward to user via CLI (timeout fallback: accept-first)
  | { auto: QuestionAutoRule[] } // auto-answer based on rules (fallback: accept-first)

export type QuestionAutoRule = {
  match: string | RegExp;       // match against question header or text
  answers: string[];            // labels to select
};

export type AgentStepOpts = {
  // ... existing fields ...
  question_policy?: QuestionPolicy;
  question_timeout_ms?: number;  // for "forward" policy: timeout before falling back to accept-first
};
```

**Default is `"reject"`** — backwards compatible. Steps that want questions must opt in.

**The accept-first strategy:** When a question has options, select the first option's label for each question in the request. This works well because agents typically put their recommended choice first. If a question has no options (free-text only), reject it instead (can't guess a free-text answer).

**DX for workflow authors:**

```typescript
// Just let the agent decide — pick its first suggestion and keep moving
const explore = agent({
  id: "explore",
  agent_opts: {
    question_policy: "accept-first",
  },
});

// Ask me, but if I don't answer in 30s, accept the first option
const plan_step = agent({
  id: "plan",
  agent_opts: {
    question_policy: "forward",
    question_timeout_ms: 30_000,
  },
});

// Never ask questions during verification
const verify_step = agent({
  id: "verify",
  agent_opts: {
    question_policy: "reject",
  },
});
```

### 2. Question types

```typescript
// packages/core/src/types.ts

export type AgentQuestion = {
  id: string;                   // question request ID (from opencode)
  session_id: string;           // which session asked
  step_id: string;              // which workflow step this belongs to
  questions: Array<{
    question: string;           // full question text
    header: string;             // short label (max 30 chars)
    options: Array<{
      label: string;
      description: string;
    }>;
    multiple?: boolean;         // allow multi-select
    custom?: boolean;           // allow free-text (default: true)
  }>;
  asked_at: Date;
};

export type PendingQuestion = {
  question: AgentQuestion;
  resolve: (answers: string[][]) => void;  // one answer array per question
  reject: () => void;
};
```

### 3. RunState changes

```typescript
// packages/core/src/types.ts
export type RunState = {
  // ... existing fields ...
  pending_questions: Map<string, PendingQuestion>;
};
```

### 4. Trace events

Two new trace event types:

```typescript
// packages/core/src/types.ts — add to TraceEvent union
| { type: "agent_question_asked"; step_id: string; session_id: string; question: AgentQuestion; timestamp: Date }
| { type: "agent_question_answered"; step_id: string; session_id: string; question_id: string; answers: string[][]; timestamp: Date }
```

### 5. OpenCode executor changes

The key insight: question handling lives in the **stale monitor**, not in `prompt()`. The monitor already polls `question.list()` every 5 seconds. Instead of always rejecting, it checks the step's question policy.

**Problem:** The stale monitor doesn't know what step or policy is active. It only has `session_id`.

**Solution:** Pass question policy and callbacks into the monitor via `PromptOpts`. The executor's `prompt()` method receives the policy and sets up the forwarding.

```typescript
// packages/core/src/types.ts — extend PromptOpts
export type PromptOpts = {
  // ... existing fields ...
  question_policy?: QuestionPolicy;
  on_question?: (question: AgentQuestion) => Promise<string[][] | null>;
  // returns answers or null (reject). Promise because it waits for user.
};
```

The engine's `executeAgentStep` creates the `on_question` callback:

```typescript
// In engine.ts executeAgentStep():
const on_question = async (question: AgentQuestion): Promise<string[][] | null> => {
  // Emit trace event
  ctx.trace.emit({
    type: "agent_question_asked",
    step_id: step.id,
    session_id: session.id,
    question,
    timestamp: new Date(),
  });

  // Create a promise that the server can resolve via HTTP
  return new Promise((resolve) => {
    // Register on RunState (via a new QuestionProvider, similar to CheckpointProvider)
    question_provider.register(question, resolve);
  });
};
```

**In the stale monitor** (`monitorActivity`):

```diff
 // Current: auto-reject all questions
-try {
-  const question_result = await this.client.question.list();
-  const questions = question_result?.data ?? question_result;
-  if (Array.isArray(questions)) {
-    for (const q of questions) {
-      if (session_ids.has(q.sessionID)) {
-        try {
-          await this.client.question.reject({ requestID: q.id });
-        } catch {}
-      }
-    }
-  }
-} catch {}

 // New: policy-based question handling
+try {
+  const question_result = await this.client.question.list();
+  const questions = question_result?.data ?? question_result;
+  if (Array.isArray(questions)) {
+    for (const q of questions) {
+      if (!session_ids.has(q.sessionID)) continue;
+      if (handled_questions.has(q.id)) continue;
+
+      const policy = opts.question_policy ?? "reject";
+      if (policy === "reject") {
+        await this.client.question.reject({ requestID: q.id });
+        handled_questions.add(q.id);
+      } else if (policy === "accept-first") {
+        const answers = acceptFirstAnswers(q);
+        if (answers) {
+          await this.client.question.reply({ requestID: q.id, answers });
+          last_activity = Date.now();
+        } else {
+          await this.client.question.reject({ requestID: q.id });
+        }
+        handled_questions.add(q.id);
+      } else if (policy === "forward" && opts.on_question) {
+        handled_questions.add(q.id);
+        // Don't await — this runs async, answer comes back later
+        opts.on_question(toAgentQuestion(q, step_id)).then(async (answers) => {
+          if (answers) {
+            await this.client.question.reply({ requestID: q.id, answers });
+            last_activity = Date.now();
+          } else {
+            // Timeout or explicit reject — fall back to accept-first
+            const fallback = acceptFirstAnswers(q);
+            if (fallback) {
+              await this.client.question.reply({ requestID: q.id, answers: fallback });
+              last_activity = Date.now();
+            } else {
+              await this.client.question.reject({ requestID: q.id });
+            }
+          }
+        });
+      } else if (typeof policy === "object" && "auto" in policy) {
+        const auto_answers = matchAutoRules(q, policy.auto);
+        if (auto_answers) {
+          await this.client.question.reply({ requestID: q.id, answers: auto_answers });
+          last_activity = Date.now();
+        } else {
+          // No rule matched — fall back to accept-first
+          const fallback = acceptFirstAnswers(q);
+          if (fallback) {
+            await this.client.question.reply({ requestID: q.id, answers: fallback });
+            last_activity = Date.now();
+          } else {
+            await this.client.question.reject({ requestID: q.id });
+          }
+        }
+        handled_questions.add(q.id);
+      }
+    }
+  }
+} catch {}
+
+// Helper: pick the first option for each question in the request
+function acceptFirstAnswers(q: QuestionRequest): string[][] | null {
+  const answers: string[][] = [];
+  for (const question of q.questions) {
+    if (question.options.length > 0) {
+      answers.push([question.options[0].label]);
+    } else {
+      // Free-text only question with no options — can't auto-answer
+      return null;
+    }
+  }
+  return answers;
+}
```

**Critical stale timer interaction:** When a question is forwarded, the stale timer must NOT fire while waiting for user input. The monitor detects forwarded-but-unanswered questions and treats them like active work (resets `last_activity`).

### 6. QuestionProvider interface

Similar to `CheckpointProvider`, but for mid-step question forwarding:

```typescript
// packages/core/src/types.ts
export type QuestionProvider = {
  register: (question: AgentQuestion, resolve: (answers: string[][] | null) => void) => void;
};
```

This is NOT a new provider that workflow authors configure. It's an internal interface between the engine and the server, created per-run (like `createServerCheckpointProvider`).

```typescript
// packages/server/src/providers/question.ts
export function createServerQuestionProvider(opts: {
  register: (question_id: string, pending: PendingQuestion) => void;
}): QuestionProvider {
  return {
    register(question, resolve) {
      opts.register(question.id, {
        question,
        resolve: (answers) => resolve(answers),
        reject: () => resolve(null),
      });
    },
  };
}
```

### 7. Server routes

Add question answer endpoint to `runs.ts`:

```typescript
// POST /runs/:id/questions/:question_id
app.post("/runs/:id/questions/:question_id", async (c) => {
  const run = deps.state.get(c.req.param("id"));
  if (!run) return c.json({ error: "run_not_found" }, 404);

  const question_id = c.req.param("question_id");
  const pending = run.pending_questions.get(question_id);
  if (!pending) return c.json({ error: "question_not_found" }, 404);

  const body = await c.req.json<{ answers?: string[][]; reject?: boolean }>();
  if (body.reject) {
    pending.reject();
  } else if (body.answers) {
    pending.resolve(body.answers);
  } else {
    return c.json({ error: "must provide answers or reject" }, 400);
  }

  run.pending_questions.delete(question_id);
  return c.json({ status: "answered" });
});
```

The `GET /runs/:id` response already serializes `pending_checkpoints` as an array of IDs. Add `pending_questions` the same way — but include the full question data since the CLI needs it to render the prompt:

```typescript
function serializeRun(run: RunState) {
  const { pending_checkpoints, pending_questions, ...rest } = run;
  return {
    ...rest,
    pending_checkpoints: Array.from(pending_checkpoints.keys()),
    pending_questions: Array.from(pending_questions.values()).map((pq) => pq.question),
  };
}
```

### 8. CLI client changes

Add to `RunbookClient`:

```typescript
// packages/cli/src/client.ts
answerQuestion: (
  run_id: string,
  question_id: string,
  answers: string[][],
) => Promise<Result<void, ClientError>>;

rejectQuestion: (
  run_id: string,
  question_id: string,
) => Promise<Result<void, ClientError>>;
```

### 9. CLI output — question rendering

The `handleRun` poll loop already checks for `pending_checkpoints`. Add a similar check for `pending_questions`:

```typescript
// In the poll loop:
const pending_questions = status_result.value.pending_questions ?? [];
for (const question of pending_questions) {
  if (answered_questions.has(question.id)) continue;
  answered_questions.add(question.id);

  console.log("");
  console.log("\x1b[36m━━━ Agent Question ━━━\x1b[0m");

  for (let qi = 0; qi < question.questions.length; qi++) {
    const q = question.questions[qi];
    console.log(`\x1b[1m${q.header}\x1b[0m`);
    console.log(q.question);

    if (q.options.length > 0) {
      for (const [oi, opt] of q.options.entries()) {
        console.log(`  ${oi + 1}. ${opt.label} — ${opt.description}`);
      }
    }

    // Prompt for selection
    const answer = await promptQuestionAnswer(q);
    answers[qi] = answer;
  }

  await client.answerQuestion(run_id, question.id, answers);
  console.log("\x1b[36m━━━━━━━━━━━━━━━━━━━━━━\x1b[0m");
}
```

**Question prompt UX:**

```
━━━ Agent Question ━━━
Database Strategy
Which database should this feature use?
  1. SQLite — lightweight, file-based
  2. PostgreSQL — full-featured, production-ready
  3. None — use in-memory only

Select [1-3, or type custom]: █
━━━━━━━━━━━━━━━━━━━━━━
```

For multi-select:
```
Select [1-3, comma-separated, or type custom]: █
```

### 10. Question timeout

`question_timeout_ms` on `AgentStepOpts` only applies to `"forward"` policy. When the timeout fires before the user answers, the fallback is **accept-first** (not reject). This means: "ask me, but if I'm not paying attention, just go with your best suggestion."

Implementation: the `on_question` callback wraps the Promise with `Promise.race`. A `null` return signals timeout, which the monitor dispatch handles by calling `acceptFirstAnswers()`:

```typescript
const on_question = async (question: AgentQuestion): Promise<string[][] | null> => {
  const user_promise = new Promise<string[][] | null>((resolve) => {
    question_provider.register(question, resolve);
  });

  if (!question_timeout_ms) return user_promise;

  const timeout_promise = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), question_timeout_ms);
  });

  return Promise.race([user_promise, timeout_promise]);
};
```

### 11. Session permission changes

Currently, sessions are created with `{ permission: "question", pattern: "*", action: "deny" }`. When `question_policy` is not `"reject"`, this permission should be removed so questions can actually be asked:

```typescript
// In OpenCodeExecutor.createSession():
const session_permissions = [
  ...base_permissions,
  // Only deny questions if policy is "reject" (or unset)
];
// The question deny permission is added/omitted based on opts
```

**Problem:** `createSession` doesn't know the question policy — it's on `AgentStepOpts`, not `CreateSessionOpts`.

**Solution:** Add `question_policy` to `CreateSessionOpts`:

```typescript
export type CreateSessionOpts = {
  // ... existing fields ...
  question_policy?: QuestionPolicy;
};
```

The engine passes it through from `agent_opts.question_policy`. The OpenCode executor uses it to decide whether to add the deny permission.

### 12. Testing — InMemoryAgentExecutor

The `InMemoryAgentExecutor` needs to support scripted questions for testing:

```typescript
export class InMemoryAgentExecutor implements AgentExecutor {
  // ... existing fields ...
  private scripted_questions: Array<{
    pattern: RegExp;
    questions: AgentQuestion["questions"];
    delay_ms?: number;  // delay before "asking" the question
  }> = [];
  asked_questions: AgentQuestion[] = [];

  onQuestion(pattern: RegExp | string, questions: AgentQuestion["questions"]): void {
    this.scripted_questions.push({
      pattern: typeof pattern === "string" ? new RegExp(pattern) : pattern,
      questions,
    });
  }

  async prompt(session_id: string, opts: PromptOpts): Promise<Result<AgentResponse, AgentError>> {
    this.prompted.push({ session_id, opts });

    // Check for scripted questions BEFORE returning the response
    const question_match = this.scripted_questions.find((sq) => sq.pattern.test(opts.text));
    if (question_match && opts.on_question) {
      const question: AgentQuestion = {
        id: `test-question-${this.asked_questions.length + 1}`,
        session_id,
        step_id: "", // filled by engine
        questions: question_match.questions,
        asked_at: new Date(),
      };
      this.asked_questions.push(question);

      // Fire the question callback, wait for answer, then return response
      const answers = await opts.on_question(question);
      // answers flow back — now return the scripted response
    }

    // ... existing response matching logic ...
  }
}
```

**Test example:**

```typescript
test("agent question is forwarded and answered", async () => {
  const agent_exec = new InMemoryAgentExecutor();
  const checkpoint_provider = new InMemoryCheckpointProvider();

  // Script: when prompted with "explore", ask a question, then respond
  agent_exec.onQuestion(/explore/, [{
    question: "Which database?",
    header: "DB Choice",
    options: [
      { label: "SQLite", description: "lightweight" },
      { label: "Postgres", description: "production" },
    ],
  }]);
  agent_exec.on(/explore/, { text: '{"summary": "explored with SQLite"}' });

  // Script the question answer
  const question_provider = new InMemoryQuestionProvider();
  question_provider.on(/DB Choice/, [["SQLite"]]);  // auto-answer

  // ... run workflow, assert question was asked and answered
});
```

### 13. Trace event display

Add formatting for question events in `output.ts`:

```typescript
case "agent_question_asked": {
  const q = event.question;
  const headers = q.questions.map((q) => q.header).join(", ");
  return `${logPrefix(ts, "WARN")}    ${YELLOW}?${RESET} ${event.step_id}: agent asks: ${headers}`;
}
case "agent_question_answered": {
  const flat = event.answers.flat().join(", ");
  return `${logPrefix(ts, "INFO")}    ${GREEN}→${RESET} ${event.step_id}: answered: ${flat}`;
}
```

## Integration Point Analysis

### Packages affected

| Package | Files | Nature of change |
|---------|-------|-----------------|
| `core` | `types.ts`, `schema.ts`, `test.ts` | New types, trace events, test provider |
| `server` | `engine.ts`, `providers/opencode.ts`, `providers/question.ts` (new), `routes/runs.ts`, `state.ts` | Engine wiring, question forwarding, HTTP endpoint |
| `cli` | `client.ts`, `commands/run.ts`, `output.ts` | Client method, poll loop, rendering |

### Breaking changes

**BREAKING: `RunState` gains `pending_questions` field.** Any code that constructs `RunState` manually (state store, tests) needs updating. This is an additive change but the Map must be initialized.

**BREAKING: `serializeRun` output shape changes.** The `GET /runs/:id` response gains a `pending_questions` field. Existing CLI versions will ignore it (forward-compatible), but any custom consumers of the API will see a new field.

**Non-breaking:** `AgentStepOpts.question_policy` is optional, defaults to `"reject"`. All existing workflows behave identically.

**Non-breaking:** `PromptOpts.on_question` and `question_policy` are optional. Existing `InMemoryAgentExecutor` usage is unaffected.

**Non-breaking:** `CreateSessionOpts.question_policy` is optional. Existing session creation is unaffected.

## Task Breakdown

### Phase 1: Core types & schemas (sequential — foundation)

**Task 1.1: Core types** (~50 LOC)
- Files: `packages/core/src/types.ts`
- Add: `QuestionPolicy`, `QuestionAutoRule`, `AgentQuestion`, `PendingQuestion`, `QuestionProvider`
- Extend: `AgentStepOpts` (add `question_policy`, `question_timeout_ms`), `CreateSessionOpts` (add `question_policy`), `PromptOpts` (add `question_policy`, `on_question`), `RunState` (add `pending_questions`)
- Add: Two new `TraceEvent` variants (`agent_question_asked`, `agent_question_answered`)

**Task 1.2: Zod schemas** (~30 LOC)
- Files: `packages/core/src/schema.ts`
- Add: `AgentQuestionSchema`, `AgentQuestionAskedSchema`, `AgentQuestionAnsweredSchema`
- Extend: `TraceEventSchema` discriminated union, `AgentStepOptsSchema`
- Dependencies: Task 1.1

**Task 1.3: State store** (~10 LOC)
- Files: `packages/server/src/state.ts`
- Initialize `pending_questions: new Map()` in `create()`
- Dependencies: Task 1.1

→ **Verification**: typecheck

### Phase 2: Engine & provider wiring (sequential — core flow)

**Task 2.1: Server question provider** (~30 LOC, new file)
- Files: `packages/server/src/providers/question.ts` (new)
- `createServerQuestionProvider()` — bridges engine questions to RunState pending_questions
- Pattern matches `createServerCheckpointProvider()`
- Dependencies: Phase 1

**Task 2.2: Engine — question callback wiring** (~40 LOC)
- Files: `packages/server/src/engine.ts`
- In `executeAgentStep()`: read `question_policy` from `agent_opts`, construct `on_question` callback, pass to `executor.prompt()` via `PromptOpts`
- Wire question timeout via `Promise.race`
- Emit `agent_question_asked` and `agent_question_answered` trace events
- Dependencies: Task 2.1

**Task 2.3: OpenCode executor — policy-based question handling** (~80 LOC)
- Files: `packages/server/src/providers/opencode.ts`
- `createSession()`: conditionally omit `question: deny` permission based on `question_policy`
- `monitorActivity()`: replace auto-reject block with policy dispatch (reject/forward/auto)
- Add `handled_questions` set to prevent duplicate forwarding
- Forward questions via `on_question` callback from `PromptOpts`
- Reset `last_activity` when question is answered (prevent stale timeout during user think time)
- Dependencies: Task 2.2

→ **Verification**: typecheck, existing tests pass

### Phase 3: Server routes & CLI (parallel)

**Task 3.1: Server route — question answer endpoint** (~30 LOC)
- Files: `packages/server/src/routes/runs.ts`
- Add `POST /runs/:id/questions/:question_id`
- Update `serializeRun()` to include `pending_questions`
- Dependencies: Phase 2

**Task 3.2: CLI client** (~20 LOC)
- Files: `packages/cli/src/client.ts`
- Add `answerQuestion()` and `rejectQuestion()` methods
- Add `pending_questions` to `RunInfo` type
- Dependencies: Phase 2
- Parallel: yes (with 3.1, 3.3)

**Task 3.3: CLI output formatting** (~30 LOC)
- Files: `packages/cli/src/output.ts`
- Add `agent_question_asked` and `agent_question_answered` formatting to `formatStepEvent()`
- Dependencies: Phase 1 (types only)
- Parallel: yes (with 3.1, 3.2)

**Task 3.4: CLI run command — question poll loop** (~60 LOC)
- Files: `packages/cli/src/commands/run.ts`
- Add question detection in poll loop (parallel to checkpoint detection)
- Render interactive question prompt with options/multi-select/custom
- `promptQuestionAnswer()` helper function
- Dependencies: Tasks 3.2, 3.3

→ **Verification**: typecheck, full test suite

### Phase 4: In-memory test provider & tests (sequential)

**Task 4.1: InMemoryAgentExecutor question support** (~50 LOC)
- Files: `packages/core/src/test.ts`
- Add `onQuestion()` scripting method
- Add `asked_questions` tracking array
- Modify `prompt()` to fire `on_question` for matching scripted questions
- Dependencies: Phase 1

**Task 4.2: Integration tests** (~120 LOC)
- Files: `packages/server/__tests__/integration/engine-questions.test.ts` (new)
- Test: question with "reject" policy is auto-rejected (existing behavior)
- Test: question with "forward" policy emits trace event and waits for answer
- Test: question timeout falls back to reject
- Test: question with "auto" policy matches rules and auto-answers
- Test: multiple questions in one request
- Test: question during parallel step execution
- Dependencies: Task 4.1

→ **Verification**: typecheck, full test suite, lint

### Phase 5: Workflow update — opt-in on explore/plan steps

**Task 5.1: Update feature workflow** (~5 LOC)
- Files: `~/.config/runbook/workflows/feature.ts`
- Add `question_policy: "forward"` to explore and plan agent steps
- Dependencies: Phase 1 (type only)

This is optional / user-config and may be done separately.

## Estimated total effort

| Phase | LOC | Parallel? |
|-------|-----|-----------|
| Phase 1: Core types | ~90 | No (foundation) |
| Phase 2: Engine wiring | ~150 | No (sequential) |
| Phase 3: Server + CLI | ~140 | Partially (3.1-3.3 parallel, 3.4 depends) |
| Phase 4: Tests | ~170 | No (sequential) |
| Phase 5: Workflow config | ~5 | N/A |
| **Total** | **~555** | |

## Decisions Made

### 1. Timeout fallback is accept-first, not reject
When `"forward"` policy times out, the system picks the first option for each question rather than rejecting. Rationale: if the agent asked a question with options, its first option is typically the recommended default. Rejecting wastes the agent's work.

### 2. Accept-first is a standalone policy
`"accept-first"` works as a fire-and-forget mode — the agent asks, runbook immediately picks the first option, agent continues. No user interaction, no blocking. Good for steps where you trust the agent's judgment but want it to have an escape hatch for ambiguity.

### 3. Free-text-only questions fall back to reject
If a question has no options (only custom free-text input), `accept-first` can't guess an answer. These are rejected. The agent should handle the rejection gracefully (proceed with its best judgment).

### 4. Forwarded questions block the stale timer
While waiting for user input on a forwarded question, the stale timer does not fire. Use `question_timeout_ms` to set an upper bound on wait time.

## Open Questions

### 1. Should auto rules support regex?
The `QuestionAutoRule.match` field could be a simple string (substring match on question header) or a regex. Regex is more powerful but harder to serialize in config files. **Recommendation: start with string substring match, add regex later if needed.**

### 2. Concurrent questions from parallel steps
opencode fires one question at a time per session. But parallel agent steps could have concurrent questions from different sessions. The CLI should handle these in FIFO order. **No design issue, just noting the behavior.**

## Suggested AGENTS.md updates

After implementation, add:

```markdown
## Agent Questions
- `question_policy` on `AgentStepOpts` controls how agent questions are handled: "reject" (default), "forward", or auto-answer rules
- Questions are NOT checkpoints — they're mid-step interruptions within an active agent session
- `pending_questions` on `RunState` works like `pending_checkpoints` — Map<string, PendingQuestion>
- The stale monitor in OpenCodeExecutor handles question detection and policy dispatch
- `InMemoryAgentExecutor.onQuestion()` scripts questions for testing; `asked_questions` tracks them
- Forwarded questions reset the stale timer — a question waiting for user input is not "stalled"
- `POST /runs/:id/questions/:question_id` answers questions; CLI polls and renders interactive prompts
```
