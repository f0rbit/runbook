import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok } from "@f0rbit/corpus";
import { defineWorkflow, fn, shell } from "@f0rbit/runbook";
import { InMemoryShellProvider } from "@f0rbit/runbook/test";
import type { StorableRun } from "@f0rbit/runbook-git-store";
import { createGitArtifactStore } from "@f0rbit/runbook-git-store";
import { z } from "zod";
import type { EngineOpts } from "../../src/engine";
import { createEngine } from "../../src/engine";
import type { ServerDeps } from "../../src/server";
import { createServer } from "../../src/server";
import { createInMemoryStateStore } from "../../src/state";

let test_dir: string;

beforeEach(async () => {
	test_dir = await mkdtemp(join(tmpdir(), "runbook-git-int-"));
	const proc = Bun.spawn(["git", "init", test_dir]);
	await proc.exited;
	const email = Bun.spawn(["git", "-C", test_dir, "config", "user.email", "test@test.com"]);
	await email.exited;
	const name = Bun.spawn(["git", "-C", test_dir, "config", "user.name", "Test"]);
	await name.exited;
});

afterEach(async () => {
	await rm(test_dir, { recursive: true, force: true });
});

const EchoSchema = z.object({ message: z.string() });

const echo_step = fn({
	id: "echo",
	input: EchoSchema,
	output: EchoSchema,
	run: async (input) => ok(input),
});

const echo_workflow = defineWorkflow(EchoSchema)
	.pipe(echo_step, (input) => input)
	.done("echo-workflow", EchoSchema);

const FailSchema = z.object({ value: z.string() });

const fail_step = fn({
	id: "fail",
	input: FailSchema,
	output: FailSchema,
	run: async (_input, ctx) => err({ kind: "execution_error", step_id: ctx.step_id, cause: "intentional failure" }),
});

const fail_workflow = defineWorkflow(FailSchema)
	.pipe(fail_step, (input) => input)
	.done("fail-workflow", FailSchema);

const SlowInputSchema = z.object({ value: z.string() });
const SlowOutputSchema = z.object({ stdout: z.string() });

const slow_step = shell({
	id: "slow-shell",
	input: SlowInputSchema,
	output: SlowOutputSchema,
	command: (input) => `echo ${input.value}`,
	parse: (stdout, _code) => ok({ stdout }),
});

const slow_workflow = defineWorkflow(SlowInputSchema)
	.pipe(slow_step, (input) => input)
	.done("slow-workflow", SlowOutputSchema);

async function pollUntil(
	app: ReturnType<typeof createServer>,
	run_id: string,
	predicate: (status: string) => boolean,
	timeout_ms = 2000,
) {
	const start = Date.now();
	while (Date.now() - start < timeout_ms) {
		const res = await app.request(`/runs/${run_id}`);
		const body = await res.json();
		if (predicate(body.status)) return body;
		await Bun.sleep(50);
	}
	throw new Error(`Timed out waiting for run ${run_id} to match predicate`);
}

async function pollGitStore(
	git_store: ReturnType<typeof createGitArtifactStore>,
	predicate: (runs: { run_id: string }[]) => boolean,
	timeout_ms = 3000,
) {
	const start = Date.now();
	while (Date.now() - start < timeout_ms) {
		const result = await git_store.list();
		if (result.ok && predicate(result.value)) return result.value;
		await Bun.sleep(100);
	}
	throw new Error("Timed out waiting for git-store predicate");
}

function setupGitStore(overrides?: Partial<ServerDeps> & { engine_opts?: EngineOpts }) {
	const git_store = overrides?.git_store ?? createGitArtifactStore(test_dir);
	const engine = createEngine(overrides?.engine_opts);
	const state = createInMemoryStateStore();
	const workflows = overrides?.workflows ?? new Map([[echo_workflow.id, echo_workflow]]);
	const app = createServer({ engine, state, workflows, git_store });
	return { app, state, git_store };
}

describe("git-store integration", () => {
	test("completed run is persisted to git-store", async () => {
		const { app, git_store } = setupGitStore();

		const submit = await app.request("/workflows/echo-workflow/run", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: { message: "hello" } }),
		});
		expect(submit.status).toBe(202);
		const { run_id } = await submit.json();

		await pollUntil(app, run_id, (s) => s === "success");

		const stored_runs = await pollGitStore(git_store, (runs) => runs.length === 1);
		expect(stored_runs[0].run_id).toBe(run_id);
		expect(stored_runs[0].workflow_id).toBe("echo-workflow");
		expect(stored_runs[0].status).toBe("success");

		const trace_result = await git_store.getTrace(run_id);
		expect(trace_result.ok).toBe(true);
		if (!trace_result.ok) return;
		expect(trace_result.value.events.length).toBeGreaterThan(0);
		expect(trace_result.value.run_id).toBe(run_id);
	});

	test("failed run is persisted to git-store", async () => {
		const { app, git_store } = setupGitStore({
			workflows: new Map([[fail_workflow.id, fail_workflow]]),
		});

		const submit = await app.request("/workflows/fail-workflow/run", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: { value: "fail-me" } }),
		});
		expect(submit.status).toBe(202);
		const { run_id } = await submit.json();

		await pollUntil(app, run_id, (s) => s === "failure");

		const stored_runs = await pollGitStore(git_store, (runs) => runs.length === 1);
		expect(stored_runs[0].run_id).toBe(run_id);
		expect(stored_runs[0].status).toBe("failure");
	});

	test("cancelled run is NOT persisted to git-store", async () => {
		const shell_provider = new InMemoryShellProvider();
		shell_provider.exec_delay_ms = 5000;
		shell_provider.on(/.*/, { stdout: "done" });

		const { app, git_store } = setupGitStore({
			workflows: new Map([[slow_workflow.id, slow_workflow]]),
			engine_opts: { providers: { shell: shell_provider } },
		});

		const submit = await app.request("/workflows/slow-workflow/run", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: { value: "slow" } }),
		});
		expect(submit.status).toBe(202);
		const { run_id } = await submit.json();

		// Wait for run to start executing
		await Bun.sleep(50);

		const cancel = await app.request(`/runs/${run_id}/cancel`, { method: "POST" });
		expect(cancel.status).toBe(200);

		// Wait for any async operations to settle
		await Bun.sleep(300);

		const list_result = await git_store.list();
		expect(list_result.ok).toBe(true);
		if (!list_result.ok) return;
		expect(list_result.value.length).toBe(0);
	});

	test("GET /runs/history returns runs from git-store", async () => {
		const { app, git_store } = setupGitStore();

		const mock_run: StorableRun = {
			run_id: "mock-run-123",
			workflow_id: "echo-workflow",
			input: { message: "stored" },
			output: { message: "stored" },
			duration_ms: 42,
			trace: {
				run_id: "mock-run-123",
				workflow_id: "echo-workflow",
				events: [
					{
						type: "workflow_start",
						workflow_id: "echo-workflow",
						run_id: "mock-run-123",
						input: { message: "stored" },
						timestamp: new Date(),
					},
					{
						type: "workflow_complete",
						workflow_id: "echo-workflow",
						run_id: "mock-run-123",
						output: { message: "stored" },
						duration_ms: 42,
						timestamp: new Date(),
					},
				],
				status: "success",
				duration_ms: 42,
			},
		};

		const store_result = await git_store.store(mock_run);
		expect(store_result.ok).toBe(true);

		const res = await app.request("/runs/history");
		expect(res.status).toBe(200);

		const body = await res.json();
		expect(body.source).toBe("git");
		expect(body.runs.length).toBe(1);
		expect(body.runs[0].run_id).toBe("mock-run-123");
		expect(body.runs[0].workflow_id).toBe("echo-workflow");
	});

	test("GET /runs/history returns empty when no git_store", async () => {
		const engine = createEngine();
		const state = createInMemoryStateStore();
		const workflows = new Map([[echo_workflow.id, echo_workflow]]);
		const app = createServer({ engine, state, workflows });

		const res = await app.request("/runs/history");
		expect(res.status).toBe(200);

		const body = await res.json();
		expect(body).toEqual({ runs: [], source: "git" });
	});

	test("git-store write failure does not break run result", async () => {
		const non_git_dir = await mkdtemp(join(tmpdir(), "runbook-nogit-"));
		try {
			const broken_git_store = createGitArtifactStore(non_git_dir);
			const { app } = setupGitStore({ git_store: broken_git_store });

			const submit = await app.request("/workflows/echo-workflow/run", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ input: { message: "resilient" } }),
			});
			expect(submit.status).toBe(202);
			const { run_id } = await submit.json();

			const final_state = await pollUntil(app, run_id, (s) => s === "success");
			expect(final_state.status).toBe("success");
			expect(final_state.output).toEqual({ message: "resilient" });
		} finally {
			await rm(non_git_dir, { recursive: true, force: true });
		}
	});
});
