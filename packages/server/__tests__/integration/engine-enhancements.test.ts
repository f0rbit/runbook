import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { ok } from "@f0rbit/corpus";
import { agent, defineWorkflow, shell } from "@f0rbit/runbook";
import { InMemoryAgentExecutor, InMemoryShellProvider } from "@f0rbit/runbook/test";
import { z } from "zod";
import { createEngine } from "../../src/engine";

describe("engine enhancements", () => {
	describe("system_prompt_file", () => {
		test("loads file content and prepends to system_prompt", async () => {
			const tmp = mkdtempSync(join(tmpdir(), "runbook-prompt-"));
			writeFileSync(join(tmp, "prompt.md"), "You are a helpful assistant.");

			const agent_executor = new InMemoryAgentExecutor();
			agent_executor.on(/./, { text: '{"result": "ok"}' });

			const step = agent({
				id: "test_step",
				input: z.object({ task: z.string() }),
				output: z.object({ result: z.string() }),
				prompt: (input) => input.task,
				mode: "analyze",
				agent_opts: {
					system_prompt_file: join(tmp, "prompt.md"),
					system_prompt: "Additional instructions.",
				},
			});

			const workflow = defineWorkflow(z.object({ task: z.string() }))
				.pipe(step, (wi) => wi)
				.done("prompt-file-test", z.object({ result: z.string() }));

			const engine = createEngine({
				providers: { agent: agent_executor },
			});
			const result = await engine.run(workflow, { task: "hello" });
			expect(result.ok).toBe(true);

			// Verify the session was created with merged system prompt
			expect(agent_executor.created_sessions.length).toBe(1);
			const session_opts = agent_executor.created_sessions[0].opts;
			expect(session_opts.system_prompt).toContain("You are a helpful assistant.");
			expect(session_opts.system_prompt).toContain("Additional instructions.");
			// File content should come first
			const file_idx = session_opts.system_prompt!.indexOf("You are a helpful assistant.");
			const inline_idx = session_opts.system_prompt!.indexOf("Additional instructions.");
			expect(file_idx).toBeLessThan(inline_idx);
		});

		test("uses file content alone when no inline system_prompt", async () => {
			const tmp = mkdtempSync(join(tmpdir(), "runbook-prompt-"));
			writeFileSync(join(tmp, "prompt.md"), "File-only prompt.");

			const agent_executor = new InMemoryAgentExecutor();
			agent_executor.on(/./, { text: '{"result": "ok"}' });

			const step = agent({
				id: "test_step",
				input: z.object({ task: z.string() }),
				output: z.object({ result: z.string() }),
				prompt: (input) => input.task,
				mode: "analyze",
				agent_opts: {
					system_prompt_file: join(tmp, "prompt.md"),
				},
			});

			const workflow = defineWorkflow(z.object({ task: z.string() }))
				.pipe(step, (wi) => wi)
				.done("file-only-test", z.object({ result: z.string() }));

			const engine = createEngine({
				providers: { agent: agent_executor },
			});
			await engine.run(workflow, { task: "hello" });

			const session_opts = agent_executor.created_sessions[0].opts;
			expect(session_opts.system_prompt).toContain("File-only prompt.");
		});

		test("returns error when system_prompt_file not found", async () => {
			const agent_executor = new InMemoryAgentExecutor();

			const step = agent({
				id: "test_step",
				input: z.object({ task: z.string() }),
				output: z.object({ result: z.string() }),
				prompt: (input) => input.task,
				mode: "analyze",
				agent_opts: {
					system_prompt_file: "/tmp/nonexistent-prompt-file-12345.md",
				},
			});

			const workflow = defineWorkflow(z.object({ task: z.string() }))
				.pipe(step, (wi) => wi)
				.done("missing-file-test", z.object({ result: z.string() }));

			const engine = createEngine({
				providers: { agent: agent_executor },
			});
			const result = await engine.run(workflow, { task: "hello" });
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.kind).toBe("step_failed");
				if (result.error.kind === "step_failed") {
					expect(result.error.error.kind).toBe("execution_error");
				}
			}
		});

		test("resolves relative paths against working_directory", async () => {
			const tmp = mkdtempSync(join(tmpdir(), "runbook-prompt-"));
			writeFileSync(join(tmp, "my-prompt.md"), "Resolved prompt.");

			const agent_executor = new InMemoryAgentExecutor();
			agent_executor.on(/./, { text: '{"result": "ok"}' });

			const step = agent({
				id: "test_step",
				input: z.object({ task: z.string() }),
				output: z.object({ result: z.string() }),
				prompt: (input) => input.task,
				mode: "analyze",
				agent_opts: {
					system_prompt_file: "my-prompt.md",  // relative path
				},
			});

			const workflow = defineWorkflow(z.object({ task: z.string() }))
				.pipe(step, (wi) => wi)
				.done("relative-path-test", z.object({ result: z.string() }));

			const engine = createEngine({
				providers: { agent: agent_executor },
				working_directory: tmp,  // resolve relative to this
			});
			const result = await engine.run(workflow, { task: "hello" });
			expect(result.ok).toBe(true);

			const session_opts = agent_executor.created_sessions[0].opts;
			expect(session_opts.system_prompt).toContain("Resolved prompt.");
		});
	});

	describe("working_directory propagation", () => {
		test("passes working_directory to shell provider as cwd", async () => {
			const shell_provider = new InMemoryShellProvider();
			shell_provider.on(/./, { stdout: "ok" });

			const step = shell({
				id: "test_shell",
				input: z.object({ cmd: z.string() }),
				output: z.object({ result: z.string() }),
				command: (input) => input.cmd,
				parse: (stdout) => ok({ result: stdout.trim() }),
			});

			const workflow = defineWorkflow(z.object({ cmd: z.string() }))
				.pipe(step, (wi) => wi)
				.done("cwd-test", z.object({ result: z.string() }));

			const engine = createEngine({
				providers: { shell: shell_provider },
				working_directory: "/tmp/test-project",
			});
			await engine.run(workflow, { cmd: "echo hi" });

			expect(shell_provider.executed.length).toBe(1);
			expect(shell_provider.executed[0].opts?.cwd).toBe("/tmp/test-project");
		});

		test("passes working_directory to agent session creation", async () => {
			const agent_executor = new InMemoryAgentExecutor();
			agent_executor.on(/./, { text: '{"result": "ok"}' });

			const step = agent({
				id: "test_agent",
				input: z.object({ task: z.string() }),
				output: z.object({ result: z.string() }),
				prompt: (input) => input.task,
				mode: "analyze",
			});

			const workflow = defineWorkflow(z.object({ task: z.string() }))
				.pipe(step, (wi) => wi)
				.done("wd-agent-test", z.object({ result: z.string() }));

			const engine = createEngine({
				providers: { agent: agent_executor },
				working_directory: "/tmp/test-project",
			});
			await engine.run(workflow, { task: "hello" });

			expect(agent_executor.created_sessions.length).toBe(1);
			expect(agent_executor.created_sessions[0].opts.working_directory).toBe("/tmp/test-project");
		});
	});
});
