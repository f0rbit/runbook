import { describe, expect, test } from "bun:test";
import { err, ok } from "@f0rbit/corpus";
import type { AgentEvent, TraceEvent } from "@f0rbit/runbook";
import { agent, checkpoint, defineWorkflow, fn, shell } from "@f0rbit/runbook";
import { InMemoryAgentExecutor, InMemoryCheckpointProvider, InMemoryShellProvider } from "@f0rbit/runbook/test";
import { z } from "zod";
import { createEngine } from "../../src/engine";

describe("engine execution", () => {
	test("linear pipeline with fn steps executes end-to-end", async () => {
		const double = fn({
			id: "double",
			input: z.number(),
			output: z.number(),
			run: async (n) => ok(n * 2),
		});

		const add_ten = fn({
			id: "add_ten",
			input: z.number(),
			output: z.number(),
			run: async (n) => ok(n + 10),
		});

		const to_string = fn({
			id: "to_string",
			input: z.number(),
			output: z.string(),
			run: async (n) => ok(`result: ${n}`),
		});

		const workflow = defineWorkflow(z.number())
			.pipe(double, (wi) => wi)
			.pipe(add_ten, (_wi, prev) => prev)
			.pipe(to_string, (_wi, prev) => prev)
			.done("linear-pipeline", z.string());

		const engine = createEngine();
		const result = await engine.run(workflow, 5);

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.output).toBe("result: 20");
		expect(result.value.trace.status).toBe("success");
		expect(result.value.trace.events.some((e) => e.type === "workflow_start")).toBe(true);
		expect(result.value.trace.events.some((e) => e.type === "workflow_complete")).toBe(true);
	});

	test("shell step executes with InMemoryShellProvider", async () => {
		const shell_provider = new InMemoryShellProvider();
		shell_provider.on(/ls/, { stdout: "file1.ts\nfile2.ts\nfile3.ts" });

		const list_files = shell({
			id: "list_files",
			input: z.string(),
			output: z.array(z.string()),
			command: (dir) => `ls ${dir}`,
			parse: (stdout, code) => {
				if (code !== 0) return err({ kind: "shell_error", step_id: "list_files", command: "ls", code, stderr: "" });
				return ok(stdout.trim().split("\n"));
			},
		});

		const workflow = defineWorkflow(z.string())
			.pipe(list_files, (wi) => wi)
			.done("shell-test", z.array(z.string()));

		const engine = createEngine({ providers: { shell: shell_provider } });
		const result = await engine.run(workflow, "/src");

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.output).toEqual(["file1.ts", "file2.ts", "file3.ts"]);
		expect(shell_provider.executed).toHaveLength(1);
		expect(shell_provider.executed[0].command).toBe("ls /src");
	});

	test("agent step (analyze mode) parses JSON from response", async () => {
		const agent_executor = new InMemoryAgentExecutor();
		agent_executor.on(/analyze/, {
			text: JSON.stringify({ summary: "all good", score: 95 }),
		});

		const analysis_schema = z.object({ summary: z.string(), score: z.number() });

		const analyze_step = agent({
			id: "analyze_code",
			input: z.string(),
			output: analysis_schema,
			prompt: (code) => `analyze this code: ${code}`,
			mode: "analyze",
		});

		const workflow = defineWorkflow(z.string())
			.pipe(analyze_step, (wi) => wi)
			.done("analyze-test", analysis_schema);

		const engine = createEngine({ providers: { agent: agent_executor } });
		const result = await engine.run(workflow, "function foo() {}");

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.output).toEqual({ summary: "all good", score: 95 });
		expect(agent_executor.prompted).toHaveLength(1);
	});

	test("agent step (build mode) extracts from metadata", async () => {
		const agent_executor = new InMemoryAgentExecutor();
		agent_executor.on(/build/, {
			text: "Done building the feature",
			metadata: {
				files_changed: ["src/index.ts", "src/utils.ts"],
				duration_ms: 1500,
			},
		});

		const build_output_schema = z.object({
			files_changed: z.array(z.string()),
			duration_ms: z.number(),
			success: z.boolean(),
		});

		const build_step = agent({
			id: "build_feature",
			input: z.string(),
			output: build_output_schema,
			prompt: (task) => `build this: ${task}`,
			mode: "build",
		});

		const workflow = defineWorkflow(z.string())
			.pipe(build_step, (wi) => wi)
			.done("build-test", build_output_schema);

		const engine = createEngine({ providers: { agent: agent_executor } });
		const result = await engine.run(workflow, "add login page");

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.output.files_changed).toEqual(["src/index.ts", "src/utils.ts"]);
		expect(result.value.output.success).toBe(true);
		expect(result.value.output.duration_ms).toBe(1500);
	});

	test("parallel steps execute concurrently", async () => {
		const uppercase = fn({
			id: "uppercase",
			input: z.string(),
			output: z.string(),
			run: async (s) => ok(s.toUpperCase()),
		});

		const length = fn({
			id: "length",
			input: z.string(),
			output: z.number(),
			run: async (s) => ok(s.length),
		});

		const workflow = defineWorkflow(z.string())
			.parallel([uppercase, (wi) => wi] as const, [length, (wi) => wi] as const)
			.done("parallel-test", z.tuple([z.string(), z.number()]));

		const engine = createEngine();
		const result = await engine.run(workflow, "hello");

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.output).toEqual(["HELLO", 5]);
	});

	test("step validation failure returns error", async () => {
		const strict_step = fn({
			id: "strict_step",
			input: z.number().min(0),
			output: z.number(),
			run: async (n) => ok(n),
		});

		const workflow = defineWorkflow(z.string())
			.pipe(strict_step, () => -1 as any)
			.done("validation-fail", z.number());

		const engine = createEngine();
		const result = await engine.run(workflow, "anything");

		expect(result.ok).toBe(false);
		if (result.ok) return;

		expect(result.error.kind).toBe("step_failed");
		if (result.error.kind !== "step_failed") return;
		expect(result.error.error.kind).toBe("validation_error");
	});

	test("step execution failure propagates", async () => {
		const failing_step = fn({
			id: "failing_step",
			input: z.string(),
			output: z.string(),
			run: async () => err({ kind: "execution_error", step_id: "failing_step", cause: "something broke" }),
		});

		const workflow = defineWorkflow(z.string())
			.pipe(failing_step, (wi) => wi)
			.done("failure-test", z.string());

		const engine = createEngine();
		const result = await engine.run(workflow, "go");

		expect(result.ok).toBe(false);
		if (result.ok) return;

		expect(result.error.kind).toBe("step_failed");
		if (result.error.kind !== "step_failed") return;
		expect(result.error.step_id).toBe("failing_step");
		expect(result.error.error.kind).toBe("execution_error");
	});

	test("checkpoint step with InMemoryCheckpointProvider", async () => {
		const checkpoint_provider = new InMemoryCheckpointProvider();
		checkpoint_provider.on(/approve/, { approved: true, note: "looks good" });

		const approval_schema = z.object({ approved: z.boolean(), note: z.string() });

		const approve_step = checkpoint({
			id: "approve_deploy",
			input: z.string(),
			output: approval_schema,
			prompt: (env) => `approve deploy to ${env}?`,
		});

		const workflow = defineWorkflow(z.string())
			.pipe(approve_step, (wi) => wi)
			.done("checkpoint-test", approval_schema);

		const engine = createEngine({ providers: { checkpoint: checkpoint_provider } });
		const result = await engine.run(workflow, "production");

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.output).toEqual({ approved: true, note: "looks good" });
		expect(checkpoint_provider.prompted).toHaveLength(1);
		expect(checkpoint_provider.prompted[0].message).toBe("approve deploy to production?");
	});

	test("trace captures all events", async () => {
		const step_a = fn({
			id: "step_a",
			input: z.number(),
			output: z.number(),
			run: async (n) => ok(n + 1),
		});

		const step_b = fn({
			id: "step_b",
			input: z.number(),
			output: z.number(),
			run: async (n) => ok(n * 2),
		});

		const workflow = defineWorkflow(z.number())
			.pipe(step_a, (wi) => wi)
			.pipe(step_b, (_wi, prev) => prev)
			.done("trace-test", z.number());

		const collected_events: TraceEvent[] = [];
		const engine = createEngine();
		const result = await engine.run(workflow, 3, {
			on_trace: (e) => collected_events.push(e),
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const event_types = collected_events.map((e) => e.type);

		expect(event_types[0]).toBe("workflow_start");
		expect(event_types.filter((t) => t === "step_start")).toHaveLength(2);
		expect(event_types.filter((t) => t === "step_complete")).toHaveLength(2);
		expect(event_types[event_types.length - 1]).toBe("workflow_complete");

		expect(result.value.trace.events).toHaveLength(collected_events.length);
	});

	test("abort signal cancels execution", async () => {
		const abort_controller = new AbortController();

		const slow_step = fn({
			id: "slow_step",
			input: z.number(),
			output: z.number(),
			run: async (n, _ctx) => {
				await new Promise((resolve) => setTimeout(resolve, 100));
				return ok(n);
			},
		});

		const after_step = fn({
			id: "after_step",
			input: z.number(),
			output: z.number(),
			run: async (n) => ok(n + 1),
		});

		const workflow = defineWorkflow(z.number())
			.pipe(slow_step, (wi) => wi)
			.pipe(after_step, (_wi, prev) => prev)
			.done("abort-test", z.number());

		const engine = createEngine();

		// Abort after slow_step starts but before after_step
		setTimeout(() => abort_controller.abort(), 50);

		const result = await engine.run(workflow, 1, { signal: abort_controller.signal });

		// The engine checks abort between steps, so slow_step may complete
		// but the workflow should ultimately fail with aborted
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe("step_failed");
		if (result.error.kind !== "step_failed") return;
		expect(result.error.error.kind).toBe("aborted");
	});

	describe("cancellation", () => {
		test("cancel during shell step", async () => {
			const shell_provider = new InMemoryShellProvider();
			shell_provider.exec_delay_ms = 100;
			shell_provider.on(/echo/, { stdout: "hello" });

			const echo_step = shell({
				id: "echo_step",
				input: z.string(),
				output: z.string(),
				command: (s) => `echo ${s}`,
				parse: (stdout, code) => {
					if (code !== 0) return err({ kind: "shell_error", step_id: "echo_step", command: "echo", code, stderr: "" });
					return ok(stdout.trim());
				},
			});

			const workflow = defineWorkflow(z.string())
				.pipe(echo_step, (wi) => wi)
				.done("cancel-shell-test", z.string());

			const controller = new AbortController();
			const engine = createEngine({ providers: { shell: shell_provider } });

			setTimeout(() => controller.abort(), 20);

			const result = await engine.run(workflow, "hi", { signal: controller.signal });

			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error.kind).toBe("step_failed");
			if (result.error.kind !== "step_failed") return;
			expect(["shell_error", "aborted"]).toContain(result.error.error.kind);
		});

		test("cancel during agent step", async () => {
			const agent_executor = new InMemoryAgentExecutor();
			agent_executor.prompt_delay_ms = 100;
			agent_executor.on(/analyze/, {
				text: JSON.stringify({ result: "done" }),
			});

			const analyze_step = agent({
				id: "analyze_step",
				input: z.string(),
				output: z.object({ result: z.string() }),
				prompt: (s) => `analyze ${s}`,
				mode: "analyze",
			});

			const workflow = defineWorkflow(z.string())
				.pipe(analyze_step, (wi) => wi)
				.done("cancel-agent-test", z.object({ result: z.string() }));

			const controller = new AbortController();
			const engine = createEngine({ providers: { agent: agent_executor } });

			setTimeout(() => controller.abort(), 20);

			const result = await engine.run(workflow, "code", { signal: controller.signal });

			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error.kind).toBe("step_failed");
			if (result.error.kind !== "step_failed") return;
			expect(agent_executor.destroyed_sessions).toHaveLength(0);
		});

		test("destroySession called on normal agent completion", async () => {
			const agent_executor = new InMemoryAgentExecutor();
			agent_executor.on(/analyze/, {
				text: JSON.stringify({ result: "done" }),
			});

			const analyze_step = agent({
				id: "analyze_normal",
				input: z.string(),
				output: z.object({ result: z.string() }),
				prompt: (s) => `analyze ${s}`,
				mode: "analyze",
			});

			const workflow = defineWorkflow(z.string())
				.pipe(analyze_step, (wi) => wi)
				.done("normal-agent-test", z.object({ result: z.string() }));

			const engine = createEngine({ providers: { agent: agent_executor } });
			const result = await engine.run(workflow, "code");

			expect(result.ok).toBe(true);
			if (!result.ok) return;

			// Wait for fire-and-forget destroySession to complete
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(agent_executor.destroyed_sessions).toHaveLength(1);
		});

		test("cancel propagates to parallel branches", async () => {
			const shell_provider = new InMemoryShellProvider();
			shell_provider.exec_delay_ms = 100;
			shell_provider.on(/branch_a/, { stdout: "a" });
			shell_provider.on(/branch_b/, { stdout: "b" });

			const branch_a = shell({
				id: "branch_a",
				input: z.string(),
				output: z.string(),
				command: (s) => `branch_a ${s}`,
				parse: (stdout, code) => {
					if (code !== 0)
						return err({ kind: "shell_error", step_id: "branch_a", command: "branch_a", code, stderr: "" });
					return ok(stdout.trim());
				},
			});

			const branch_b = shell({
				id: "branch_b",
				input: z.string(),
				output: z.string(),
				command: (s) => `branch_b ${s}`,
				parse: (stdout, code) => {
					if (code !== 0)
						return err({ kind: "shell_error", step_id: "branch_b", command: "branch_b", code, stderr: "" });
					return ok(stdout.trim());
				},
			});

			const workflow = defineWorkflow(z.string())
				.parallel([branch_a, (wi) => wi] as const, [branch_b, (wi) => wi] as const)
				.done("cancel-parallel-test", z.tuple([z.string(), z.string()]));

			const controller = new AbortController();
			const engine = createEngine({ providers: { shell: shell_provider } });

			setTimeout(() => controller.abort(), 20);

			const result = await engine.run(workflow, "go", { signal: controller.signal });

			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error.kind).toBe("step_failed");
		});
	});

	describe("agent event streaming", () => {
		test("agent_prompt_sent appears in trace", async () => {
			const agent_executor = new InMemoryAgentExecutor();
			agent_executor.on(/.*/, { text: '{"result": "ok"}' });

			const step = agent({
				id: "analyze",
				input: z.object({ task: z.string() }),
				output: z.object({ result: z.string() }),
				prompt: (input) => `Analyze: ${input.task}`,
				mode: "analyze",
			});

			const workflow = defineWorkflow(z.object({ task: z.string() }))
				.pipe(step, (wi) => wi)
				.done("test-wf", z.object({ result: z.string() }));

			const engine = createEngine({ providers: { agent: agent_executor } });
			const result = await engine.run(workflow, { task: "test" });

			expect(result.ok).toBe(true);
			if (!result.ok) return;

			const events = result.value.trace.events;
			const prompt_sent = events.find((e) => e.type === "agent_prompt_sent");
			expect(prompt_sent).toBeDefined();
			expect(prompt_sent?.type === "agent_prompt_sent" && prompt_sent.text).toContain("Analyze: test");
		});

		test("subscribe is called and cleaned up for agent steps", async () => {
			const agent_executor = new InMemoryAgentExecutor();
			agent_executor.on(/.*/, { text: '{"result": "ok"}' });

			let subscribed_session_id: string | null = null;
			let unsubscribed = false;

			const original_subscribe = agent_executor.subscribe.bind(agent_executor);
			agent_executor.subscribe = (session_id: string, handler: (event: AgentEvent) => void) => {
				subscribed_session_id = session_id;
				const unsub = original_subscribe(session_id, handler);
				return () => {
					unsubscribed = true;
					unsub();
				};
			};

			const step = agent({
				id: "analyze",
				input: z.object({ task: z.string() }),
				output: z.object({ result: z.string() }),
				prompt: (input) => `Analyze: ${input.task}`,
				mode: "analyze",
			});

			const workflow = defineWorkflow(z.object({ task: z.string() }))
				.pipe(step, (wi) => wi)
				.done("subscribe-test", z.object({ result: z.string() }));

			const engine = createEngine({ providers: { agent: agent_executor } });
			await engine.run(workflow, { task: "test" });

			expect(subscribed_session_id).not.toBeNull();
			expect(unsubscribed).toBe(true);
		});

		test("emitted agent events appear in trace", async () => {
			const agent_executor = new InMemoryAgentExecutor();
			agent_executor.prompt_delay_ms = 50;
			agent_executor.on(/.*/, { text: '{"result": "ok"}' });

			const step = agent({
				id: "analyze",
				input: z.object({ task: z.string() }),
				output: z.object({ result: z.string() }),
				prompt: (input) => `Analyze: ${input.task}`,
				mode: "analyze",
			});

			const workflow = defineWorkflow(z.object({ task: z.string() }))
				.pipe(step, (wi) => wi)
				.done("events-test", z.object({ result: z.string() }));

			const engine = createEngine({ providers: { agent: agent_executor } });

			const run_promise = engine.run(workflow, { task: "test" });

			// Wait for engine to subscribe, then emit events during prompt delay
			await Bun.sleep(10);
			const session_id = agent_executor.created_sessions[0]?.id;
			if (session_id) {
				agent_executor.emitEvent(session_id, {
					type: "tool_call",
					session_id,
					call: { tool: "read", args: { path: "/foo.ts" } },
				});
			}

			const result = await run_promise;
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			const tool_calls = result.value.trace.events.filter((e) => e.type === "agent_tool_call");
			expect(tool_calls.length).toBeGreaterThanOrEqual(1);
		});
	});
});
