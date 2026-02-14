import { describe, expect, test } from "bun:test";
import { ok } from "@f0rbit/corpus";
import { defineWorkflow, fn } from "@f0rbit/runbook";
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
