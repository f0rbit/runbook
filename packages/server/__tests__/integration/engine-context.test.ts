import { describe, expect, test } from "bun:test";
import { ok } from "@f0rbit/corpus";
import { defineWorkflow, fn, shell, agent } from "@f0rbit/runbook";
import { InMemoryShellProvider, InMemoryAgentExecutor } from "@f0rbit/runbook/test";
import { z } from "zod";
import { createEngine } from "../../src/engine";

describe("ctx.engine — sub-workflow execution", () => {
	test("fn() step can run a sub-workflow via ctx.engine", async () => {
		const shell_provider = new InMemoryShellProvider();
		shell_provider.on(/echo/, { stdout: "hello world" });

		const inner_step = shell({
			id: "inner_shell",
			input: z.object({ cmd: z.string() }),
			output: z.object({ result: z.string() }),
			command: (input) => input.cmd,
			parse: (stdout) => ok({ result: stdout.trim() }),
		});

		const inner_workflow = defineWorkflow(z.object({ cmd: z.string() }))
			.pipe(inner_step, (wi) => wi)
			.done("inner", z.object({ result: z.string() }));

		const outer_step = fn({
			id: "orchestrator",
			input: z.object({ task: z.string() }),
			output: z.object({ result: z.string() }),
			run: async (input, ctx) => {
				const result = await ctx.engine.run(inner_workflow, { cmd: `echo ${input.task}` });
				if (!result.ok) {
					return { ok: false as const, error: { kind: "execution_error" as const, step_id: ctx.step_id, cause: "sub-workflow failed" } };
				}
				return ok(result.value.output);
			},
		});

		const outer_workflow = defineWorkflow(z.object({ task: z.string() }))
			.pipe(outer_step, (wi) => wi)
			.done("outer", z.object({ result: z.string() }));

		const engine = createEngine({
			providers: { shell: shell_provider },
		});

		const result = await engine.run(outer_workflow, { task: "test" });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.output.result).toBe("hello world");
		}
		// Verify the shell provider was used (proving providers are inherited)
		expect(shell_provider.executed.length).toBe(1);
	});

	test("sub-workflow inherits agent executor from parent", async () => {
		const agent_executor = new InMemoryAgentExecutor();
		agent_executor.on(/./, { text: '{"answer": "42"}' });

		const inner_step = agent({
			id: "inner_agent",
			input: z.object({ question: z.string() }),
			output: z.object({ answer: z.string() }),
			prompt: (input) => input.question,
			mode: "analyze",
		});

		const inner_workflow = defineWorkflow(z.object({ question: z.string() }))
			.pipe(inner_step, (wi) => wi)
			.done("inner_agent_wf", z.object({ answer: z.string() }));

		const outer_step = fn({
			id: "dispatcher",
			input: z.object({ q: z.string() }),
			output: z.object({ answer: z.string() }),
			run: async (input, ctx) => {
				const result = await ctx.engine.run(inner_workflow, { question: input.q });
				if (!result.ok) {
					return { ok: false as const, error: { kind: "execution_error" as const, step_id: ctx.step_id, cause: "sub failed" } };
				}
				return ok(result.value.output);
			},
		});

		const outer_workflow = defineWorkflow(z.object({ q: z.string() }))
			.pipe(outer_step, (wi) => wi)
			.done("outer_agent", z.object({ answer: z.string() }));

		const engine = createEngine({
			providers: { agent: agent_executor },
		});

		const result = await engine.run(outer_workflow, { q: "what is the meaning?" });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.output.answer).toBe("42");
		}
		expect(agent_executor.prompted.length).toBe(1);
	});

	test("nested sub-workflows work (3 levels deep)", async () => {
		const shell_provider = new InMemoryShellProvider();
		shell_provider.on(/./, { stdout: "deep result" });

		const leaf_step = shell({
			id: "leaf",
			input: z.object({}),
			output: z.object({ value: z.string() }),
			command: () => "echo deep",
			parse: (stdout) => ok({ value: stdout.trim() }),
		});

		const leaf_wf = defineWorkflow(z.object({}))
			.pipe(leaf_step, () => ({}))
			.done("leaf_wf", z.object({ value: z.string() }));

		const mid_step = fn({
			id: "mid",
			input: z.object({}),
			output: z.object({ value: z.string() }),
			run: async (_input, ctx) => {
				const result = await ctx.engine.run(leaf_wf, {});
				if (!result.ok) return { ok: false as const, error: { kind: "execution_error" as const, step_id: "mid", cause: "leaf failed" } };
				return ok(result.value.output);
			},
		});

		const mid_wf = defineWorkflow(z.object({}))
			.pipe(mid_step, () => ({}))
			.done("mid_wf", z.object({ value: z.string() }));

		const top_step = fn({
			id: "top",
			input: z.object({}),
			output: z.object({ value: z.string() }),
			run: async (_input, ctx) => {
				const result = await ctx.engine.run(mid_wf, {});
				if (!result.ok) return { ok: false as const, error: { kind: "execution_error" as const, step_id: "top", cause: "mid failed" } };
				return ok(result.value.output);
			},
		});

		const top_wf = defineWorkflow(z.object({}))
			.pipe(top_step, () => ({}))
			.done("top_wf", z.object({ value: z.string() }));

		const engine = createEngine({
			providers: { shell: shell_provider },
		});

		const result = await engine.run(top_wf, {});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.output.value).toBe("deep result");
		}
		expect(shell_provider.executed.length).toBe(1);
	});

	test("sub-workflow can run parallel steps using parent providers", async () => {
		const shell_provider = new InMemoryShellProvider();
		shell_provider.on(/tsc/, { stdout: "types ok", exit_code: 0 });
		shell_provider.on(/test/, { stdout: "tests ok", exit_code: 0 });

		const tc_step = shell({
			id: "tc",
			input: z.object({}),
			output: z.object({ result: z.string() }),
			command: () => "tsc --noEmit",
			parse: (stdout) => ok({ result: stdout.trim() }),
		});

		const test_step = shell({
			id: "test",
			input: z.object({}),
			output: z.object({ result: z.string() }),
			command: () => "bun test",
			parse: (stdout) => ok({ result: stdout.trim() }),
		});

		const merge = fn({
			id: "merge",
			input: z.tuple([z.object({ result: z.string() }), z.object({ result: z.string() })]),
			output: z.object({ combined: z.string() }),
			run: async ([a, b]) => ok({ combined: `${a.result} + ${b.result}` }),
		});

		const inner_wf = defineWorkflow(z.object({}))
			.parallel(
				[tc_step, () => ({})] as const,
				[test_step, () => ({})] as const,
			)
			.pipe(merge, (_wi, prev) => prev)
			.done("parallel_inner", z.object({ combined: z.string() }));

		const outer_step = fn({
			id: "run_verify",
			input: z.object({}),
			output: z.object({ combined: z.string() }),
			run: async (_input, ctx) => {
				const result = await ctx.engine.run(inner_wf, {});
				if (!result.ok) return { ok: false as const, error: { kind: "execution_error" as const, step_id: "run_verify", cause: "inner failed" } };
				return ok(result.value.output);
			},
		});

		const outer_wf = defineWorkflow(z.object({}))
			.pipe(outer_step, () => ({}))
			.done("outer_parallel", z.object({ combined: z.string() }));

		const engine = createEngine({
			providers: { shell: shell_provider },
		});

		const result = await engine.run(outer_wf, {});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.output.combined).toBe("types ok + tests ok");
		}
		expect(shell_provider.executed.length).toBe(2);
	});
});
