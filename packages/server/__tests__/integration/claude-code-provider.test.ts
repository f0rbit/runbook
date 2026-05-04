import { describe, expect, test } from "bun:test";
import { ClaudeCodeExecutor } from "../../src/providers/claude-code";

describe.skipIf(!process.env.ANTHROPIC_API_KEY)("ClaudeCodeExecutor (real)", () => {
	test("creates session, prompts, gets response", async () => {
		const executor_result = await ClaudeCodeExecutor.create();
		expect(executor_result.ok).toBe(true);
		if (!executor_result.ok) return;

		const executor = executor_result.value;
		const session_result = await executor.createSession({
			working_directory: process.cwd(),
			system_prompt: "Be concise.",
		});
		expect(session_result.ok).toBe(true);
		if (!session_result.ok) return;

		const session_id = session_result.value.id;
		const prompt_result = await executor.prompt(session_id, {
			text: "Reply with just the word 'hello'.",
			timeout_ms: 30000,
		});
		expect(prompt_result.ok).toBe(true);
		if (!prompt_result.ok) return;

		const response = prompt_result.value;
		expect(response.text.length).toBeGreaterThan(0);
		expect(response.text.toLowerCase()).toContain("hello");
	});

	test("subscribe receives streamed events", async () => {
		const executor_result = await ClaudeCodeExecutor.create();
		expect(executor_result.ok).toBe(true);
		if (!executor_result.ok) return;

		const executor = executor_result.value;
		const session_result = await executor.createSession({
			working_directory: process.cwd(),
		});
		expect(session_result.ok).toBe(true);
		if (!session_result.ok) return;

		const session_id = session_result.value.id;
		const events: any[] = [];

		const unsubscribe = executor.subscribe(session_id, (event) => {
			events.push(event);
		});

		const prompt_result = await executor.prompt(session_id, {
			text: "Say 'test'.",
			timeout_ms: 30000,
		});
		expect(prompt_result.ok).toBe(true);

		unsubscribe();

		expect(events.length).toBeGreaterThan(0);
		const event_types = events.map((e) => e.type);
		expect(event_types).toContain("prompt_sent");
		expect(event_types.some((t) => t === "text_chunk" || t === "tool_call")).toBe(true);
	});

	test("destroySession cleans up", async () => {
		const executor_result = await ClaudeCodeExecutor.create();
		expect(executor_result.ok).toBe(true);
		if (!executor_result.ok) return;

		const executor = executor_result.value;
		const session_result = await executor.createSession({
			working_directory: process.cwd(),
		});
		expect(session_result.ok).toBe(true);
		if (!session_result.ok) return;

		const session_id = session_result.value.id;

		const prompt_result = await executor.prompt(session_id, {
			text: "Hello.",
			timeout_ms: 30000,
		});
		expect(prompt_result.ok).toBe(true);

		const destroy_result = await executor.destroySession(session_id);
		expect(destroy_result.ok).toBe(true);

		const second_prompt = await executor.prompt(session_id, {
			text: "Another prompt.",
			timeout_ms: 5000,
		});
		expect(second_prompt.ok).toBe(false);
		if (!second_prompt.ok) {
			expect(second_prompt.error.kind).toBe("prompt_failed");
		}
	});

	test("healthCheck succeeds", async () => {
		const executor_result = await ClaudeCodeExecutor.create();
		expect(executor_result.ok).toBe(true);
		if (!executor_result.ok) return;

		const executor = executor_result.value;
		const health = await executor.healthCheck();
		expect(health.ok).toBe(true);
	});
});
