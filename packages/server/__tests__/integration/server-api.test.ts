import { describe, expect, test } from "bun:test";
import { ok } from "@f0rbit/corpus";
import { defineWorkflow, fn, shell, type Workflow } from "@f0rbit/runbook";
import { InMemoryShellProvider } from "@f0rbit/runbook/test";
import { z } from "zod";
import { createEngine } from "../../src/engine";
import { createServer } from "../../src/server";
import { createInMemoryStateStore } from "../../src/state";

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

function setup() {
	const engine = createEngine();
	const state = createInMemoryStateStore();
	const workflows = new Map([[echo_workflow.id, echo_workflow]]);
	const app = createServer({ engine, state, workflows });
	return { app, state };
}

describe("server api", () => {
	test("GET /health returns ok", async () => {
		const { app } = setup();
		const res = await app.request("/health");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "ok" });
	});

	test("GET /workflows lists registered workflows", async () => {
		const { app } = setup();
		const res = await app.request("/workflows");
		expect(res.status).toBe(200);

		const body = await res.json();
		expect(body.workflows).toBeArrayOfSize(1);
		expect(body.workflows[0].id).toBe("echo-workflow");
		expect(body.workflows[0].step_count).toBe(1);
	});

	test("POST /workflows/:id/run returns 202 with run_id", async () => {
		const { app } = setup();
		const res = await app.request("/workflows/echo-workflow/run", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: { message: "hello" } }),
		});
		expect(res.status).toBe(202);

		const body = await res.json();
		expect(body.run_id).toBeString();
	});

	test("POST /workflows/:id/run with unknown workflow returns 404", async () => {
		const { app } = setup();
		const res = await app.request("/workflows/nonexistent/run", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: {} }),
		});
		expect(res.status).toBe(404);

		const body = await res.json();
		expect(body.error).toBe("workflow_not_found");
	});

	test("GET /runs/:id returns run state", async () => {
		const { app } = setup();

		const submit = await app.request("/workflows/echo-workflow/run", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: { message: "hello" } }),
		});
		const { run_id } = await submit.json();

		await Bun.sleep(50);

		const res = await app.request(`/runs/${run_id}`);
		expect(res.status).toBe(200);

		const body = await res.json();
		expect(body.run_id).toBe(run_id);
		expect(body.workflow_id).toBe("echo-workflow");
		expect(["running", "success"]).toContain(body.status);
	});

	test("GET /runs/:id with unknown run returns 404", async () => {
		const { app } = setup();
		const res = await app.request("/runs/nonexistent");
		expect(res.status).toBe(404);

		const body = await res.json();
		expect(body.error).toBe("run_not_found");
	});

	test("GET /runs/:id/trace returns trace with events", async () => {
		const { app } = setup();

		const submit = await app.request("/workflows/echo-workflow/run", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: { message: "trace-test" } }),
		});
		const { run_id } = await submit.json();

		await Bun.sleep(100);

		const res = await app.request(`/runs/${run_id}/trace`);
		expect(res.status).toBe(200);

		const body = await res.json();
		const trace = body.trace;
		expect(trace.run_id).toBe(run_id);
		expect(trace.workflow_id).toBe("echo-workflow");
		expect(trace.events.length).toBeGreaterThan(0);
		expect(trace.status).toBe("success");

		const event_types = trace.events.map((e: { type: string }) => e.type);
		expect(event_types).toContain("workflow_start");
		expect(event_types).toContain("workflow_complete");
	});
});

describe("GET /runs", () => {
	test("returns empty list when no runs exist", async () => {
		const { app } = setup();
		const res = await app.request("/runs");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.runs).toEqual([]);
	});

	test("returns runs sorted by started_at descending", async () => {
		const { app } = setup();

		// Submit two runs
		const res1 = await app.request("/workflows/echo-workflow/run", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: { message: "first" } }),
		});
		const { run_id: id1 } = await res1.json();

		// Small delay to ensure different timestamps
		await new Promise((r) => setTimeout(r, 50));

		const res2 = await app.request("/workflows/echo-workflow/run", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: { message: "second" } }),
		});
		const { run_id: id2 } = await res2.json();

		const list_res = await app.request("/runs");
		const body = await list_res.json();
		expect(body.runs.length).toBeGreaterThanOrEqual(2);
		// Most recent should be first
		const ids = body.runs.map((r: any) => r.run_id);
		expect(ids.indexOf(id2)).toBeLessThan(ids.indexOf(id1));
	});
});

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

function setupWithSlowWorkflow() {
	const shell_provider = new InMemoryShellProvider();
	shell_provider.exec_delay_ms = 5000;
	shell_provider.on(/.*/, { stdout: "done" });

	const engine = createEngine({ providers: { shell: shell_provider } });
	const state = createInMemoryStateStore();
	const workflows = new Map<string, Workflow<any, any>>([
		[echo_workflow.id, echo_workflow],
		[slow_workflow.id, slow_workflow],
	]);
	const app = createServer({ engine, state, workflows });
	return { app, state };
}

describe("cancel", () => {
	test("POST /runs/:id/cancel on unknown run returns 404", async () => {
		const { app } = setup();
		const res = await app.request("/runs/nonexistent/cancel", { method: "POST" });
		expect(res.status).toBe(404);
	});

	test("POST /runs/:id/cancel on completed run returns 409", async () => {
		const { app } = setup();

		const submit = await app.request("/workflows/echo-workflow/run", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: { message: "done" } }),
		});
		const { run_id } = await submit.json();

		// Poll until completed
		for (let i = 0; i < 20; i++) {
			await Bun.sleep(50);
			const poll = await app.request(`/runs/${run_id}`);
			const body = await poll.json();
			if (body.status === "success") break;
		}

		const res = await app.request(`/runs/${run_id}/cancel`, { method: "POST" });
		expect(res.status).toBe(409);
	});

	test("POST /runs/:id/cancel on running run returns cancelled status", async () => {
		const { app } = setupWithSlowWorkflow();

		const submit = await app.request("/workflows/slow-workflow/run", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: { value: "hello" } }),
		});
		const { run_id } = await submit.json();

		// Wait for run to start executing
		await Bun.sleep(50);

		const res = await app.request(`/runs/${run_id}/cancel`, { method: "POST" });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("cancelled");

		// Verify GET /runs/:id shows cancelled status
		await Bun.sleep(100);
		const get_res = await app.request(`/runs/${run_id}`);
		expect(get_res.status).toBe(200);
		const get_body = await get_res.json();
		expect(get_body.status).toBe("cancelled");
	});
});
