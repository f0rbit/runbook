import { describe, expect, test } from "bun:test";
import { ok } from "@f0rbit/corpus";
import type { RunSnapshot, TraceEvent, Workflow } from "@f0rbit/runbook";
import { checkpoint, defineWorkflow, fn } from "@f0rbit/runbook";
import { InMemoryCheckpointProvider } from "@f0rbit/runbook/test";
import { z } from "zod";
import { createEngine } from "../../src/engine";
import { createServer } from "../../src/server";
import { createInMemoryStateStore } from "../../src/state";

describe("engine snapshot resume", () => {
	test("engine skips completed steps and uses stored outputs", async () => {
		const step_a = fn({
			id: "step_a",
			input: z.number(),
			output: z.number(),
			run: async (n) => ok(n * 2),
		});

		const step_b = fn({
			id: "step_b",
			input: z.number(),
			output: z.number(),
			run: async (n) => ok(n + 10),
		});

		const step_c = fn({
			id: "step_c",
			input: z.number(),
			output: z.string(),
			run: async (n) => ok(`result: ${n}`),
		});

		const workflow = defineWorkflow(z.number())
			.pipe(step_a, (wi) => wi)
			.pipe(step_b, (_wi, prev) => prev)
			.pipe(step_c, (_wi, prev) => prev)
			.done("skip-test", z.string());

		const snapshot: RunSnapshot = {
			run_id: "original-run",
			workflow_id: "skip-test",
			input: 5,
			completed_steps: new Map([
				["step_a", 10],
				["step_b", 20],
			]),
			resume_at: "step_c",
			trace_events: [],
		};

		const collected_events: TraceEvent[] = [];
		const engine = createEngine();
		const result = await engine.run(workflow, 5, {
			snapshot,
			on_trace: (e) => collected_events.push(e),
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.output).toBe("result: 20");

		const skipped = collected_events.filter((e) => e.type === "step_skipped");
		expect(skipped).toHaveLength(2);
		expect(skipped.map((e) => e.type === "step_skipped" && e.step_id)).toEqual(["step_a", "step_b"]);

		const step_c_start = collected_events.find((e) => e.type === "step_start" && e.step_id === "step_c");
		expect(step_c_start).toBeDefined();

		const step_c_complete = collected_events.find((e) => e.type === "step_complete" && e.step_id === "step_c");
		expect(step_c_complete).toBeDefined();
	});

	test("engine emits step_skipped events with correct reason", async () => {
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
			.done("reason-test", z.number());

		const snapshot: RunSnapshot = {
			run_id: "original-run",
			workflow_id: "reason-test",
			input: 5,
			completed_steps: new Map([["step_a", 6]]),
			resume_at: "step_b",
			trace_events: [],
		};

		const collected_events: TraceEvent[] = [];
		const engine = createEngine();
		await engine.run(workflow, 5, {
			snapshot,
			on_trace: (e) => collected_events.push(e),
		});

		const skipped = collected_events.find((e) => e.type === "step_skipped");
		expect(skipped).toBeDefined();
		expect(skipped?.type === "step_skipped" && skipped.step_id).toBe("step_a");
		expect(skipped?.type === "step_skipped" && skipped.reason).toBe("replayed from snapshot");
	});

	test("engine runs checkpoint step fresh after skipping earlier steps", async () => {
		const step_a = fn({
			id: "step_a",
			input: z.number(),
			output: z.number(),
			run: async (n) => ok(n * 2),
		});

		const ApprovalSchema = z.object({ approved: z.boolean() });

		const cp_step = checkpoint({
			id: "approval",
			input: z.number(),
			output: ApprovalSchema,
			prompt: (n) => `Approve value: ${n}?`,
		});

		const step_b = fn({
			id: "step_b",
			input: ApprovalSchema,
			output: z.string(),
			run: async (input) => ok(`approved: ${input.approved}`),
		});

		const workflow = defineWorkflow(z.number())
			.pipe(step_a, (wi) => wi)
			.pipe(cp_step, (_wi, prev) => prev)
			.pipe(step_b, (_wi, prev) => prev)
			.done("cp-resume-test", z.string());

		const snapshot: RunSnapshot = {
			run_id: "original-run",
			workflow_id: "cp-resume-test",
			input: 5,
			completed_steps: new Map([["step_a", 10]]),
			resume_at: "approval",
			trace_events: [],
		};

		const checkpoint_provider = new InMemoryCheckpointProvider();
		checkpoint_provider.on(/.*/, { approved: true });

		const collected_events: TraceEvent[] = [];
		const engine = createEngine({ providers: { checkpoint: checkpoint_provider } });
		const result = await engine.run(workflow, 5, {
			snapshot,
			on_trace: (e) => collected_events.push(e),
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.output).toBe("approved: true");

		const skipped = collected_events.filter((e) => e.type === "step_skipped");
		expect(skipped).toHaveLength(1);
		expect(skipped[0].type === "step_skipped" && skipped[0].step_id).toBe("step_a");

		const cp_waiting = collected_events.find((e) => e.type === "checkpoint_waiting");
		expect(cp_waiting).toBeDefined();

		const step_b_complete = collected_events.find((e) => e.type === "step_complete" && e.step_id === "step_b");
		expect(step_b_complete).toBeDefined();
	});

	test("engine skips parallel node when all branches are in snapshot", async () => {
		const uppercase = fn({
			id: "upper",
			input: z.string(),
			output: z.string(),
			run: async (s) => ok(s.toUpperCase()),
		});

		const length = fn({
			id: "len",
			input: z.string(),
			output: z.number(),
			run: async (s) => ok(s.length),
		});

		const merge = fn({
			id: "merge",
			input: z.tuple([z.string(), z.number()]),
			output: z.string(),
			run: async ([s, n]) => ok(`${s}:${n}`),
		});

		const workflow = defineWorkflow(z.string())
			.parallel([uppercase, (wi) => wi] as const, [length, (wi) => wi] as const)
			.pipe(merge, (_wi, prev) => prev)
			.done("parallel-skip-test", z.string());

		const snapshot: RunSnapshot = {
			run_id: "original-run",
			workflow_id: "parallel-skip-test",
			input: "hello",
			completed_steps: new Map<string, unknown>([
				["upper", "HELLO"],
				["len", 5],
			]),
			resume_at: "merge",
			trace_events: [],
		};

		const collected_events: TraceEvent[] = [];
		const engine = createEngine();
		const result = await engine.run(workflow, "hello", {
			snapshot,
			on_trace: (e) => collected_events.push(e),
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.output).toBe("HELLO:5");

		const skipped = collected_events.filter((e) => e.type === "step_skipped");
		expect(skipped).toHaveLength(2);
		const skipped_ids = skipped.map((e) => e.type === "step_skipped" && e.step_id);
		expect(skipped_ids).toContain("upper");
		expect(skipped_ids).toContain("len");

		const merge_start = collected_events.find((e) => e.type === "step_start" && e.step_id === "merge");
		expect(merge_start).toBeDefined();
	});

	test("engine runs parallel node normally when some branches missing from snapshot", async () => {
		const uppercase = fn({
			id: "upper",
			input: z.string(),
			output: z.string(),
			run: async (s) => ok(s.toUpperCase()),
		});

		const length = fn({
			id: "len",
			input: z.string(),
			output: z.number(),
			run: async (s) => ok(s.length),
		});

		const workflow = defineWorkflow(z.string())
			.parallel([uppercase, (wi) => wi] as const, [length, (wi) => wi] as const)
			.done("partial-parallel-test", z.tuple([z.string(), z.number()]));

		const snapshot: RunSnapshot = {
			run_id: "original-run",
			workflow_id: "partial-parallel-test",
			input: "hello",
			completed_steps: new Map([["upper", "HELLO"]]),
			resume_at: "len",
			trace_events: [],
		};

		const collected_events: TraceEvent[] = [];
		const engine = createEngine();
		const result = await engine.run(workflow, "hello", {
			snapshot,
			on_trace: (e) => collected_events.push(e),
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.output).toEqual(["HELLO", 5]);

		const skipped = collected_events.filter((e) => e.type === "step_skipped");
		expect(skipped).toHaveLength(0);

		const starts = collected_events.filter((e) => e.type === "step_start");
		expect(starts).toHaveLength(2);
	});
});

describe("server resume api", () => {
	const ApprovalSchema = z.object({ approved: z.boolean() });

	function createCheckpointWorkflow() {
		const step_a = fn({
			id: "compute",
			input: z.number(),
			output: z.number(),
			run: async (n) => ok(n * 2),
		});

		const cp_step = checkpoint({
			id: "approval",
			input: z.number(),
			output: ApprovalSchema,
			prompt: (n) => `Approve value: ${n}?`,
		});

		const step_b = fn({
			id: "finalize",
			input: ApprovalSchema,
			output: z.number(),
			run: async (input) => ok(input.approved ? 1 : 0),
		});

		return defineWorkflow(z.number())
			.pipe(step_a, (wi) => wi)
			.pipe(cp_step, (_wi, prev) => prev)
			.pipe(step_b, (_wi, prev) => prev)
			.done("checkpoint-wf", z.number());
	}

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
		const cp_wf = createCheckpointWorkflow();
		const workflows = new Map<string, Workflow<any, any>>([
			[echo_workflow.id, echo_workflow],
			[cp_wf.id, cp_wf],
		]);
		const app = createServer({ engine, state, workflows });
		return { app, state, cp_wf };
	}

	async function pollRunStatus(
		app: ReturnType<typeof createServer>,
		run_id: string,
		target_status: string | string[],
		max_ms = 3000,
	) {
		const targets = Array.isArray(target_status) ? target_status : [target_status];
		const deadline = Date.now() + max_ms;
		while (Date.now() < deadline) {
			const res = await app.request(`/runs/${run_id}`);
			const body = await res.json();
			if (targets.includes(body.status)) return body;
			await Bun.sleep(30);
		}
		throw new Error(`Run ${run_id} did not reach status ${targets.join("|")} within ${max_ms}ms`);
	}

	async function pollPendingCheckpoints(app: ReturnType<typeof createServer>, run_id: string, max_ms = 3000) {
		const deadline = Date.now() + max_ms;
		while (Date.now() < deadline) {
			const res = await app.request(`/runs/${run_id}`);
			const body = await res.json();
			if (body.pending_checkpoints && body.pending_checkpoints.length > 0) {
				return body.pending_checkpoints as string[];
			}
			await Bun.sleep(30);
		}
		throw new Error(`Run ${run_id} did not produce pending checkpoints within ${max_ms}ms`);
	}

	test("POST /resume returns 202 with new run_id", async () => {
		const { app } = setup();

		const submit = await app.request("/workflows/checkpoint-wf/run", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: 21 }),
		});
		const { run_id } = await submit.json();

		const checkpoint_ids = await pollPendingCheckpoints(app, run_id);
		expect(checkpoint_ids.length).toBeGreaterThan(0);

		const resume_res = await app.request(`/workflows/checkpoint-wf/resume/${run_id}`, {
			method: "POST",
		});
		expect(resume_res.status).toBe(202);

		const resume_body = await resume_res.json();
		expect(resume_body.run_id).toBeString();
		expect(resume_body.resumed_from).toBe(run_id);
		expect(resume_body.run_id).not.toBe(run_id);
	});

	test("POST /resume returns 404 for unknown workflow", async () => {
		const { app } = setup();

		const res = await app.request("/workflows/nonexistent/resume/some-id", {
			method: "POST",
		});
		expect(res.status).toBe(404);

		const body = await res.json();
		expect(body.error).toBe("workflow_not_found");
	});

	test("POST /resume returns 404 for unknown run", async () => {
		const { app } = setup();

		const res = await app.request("/workflows/checkpoint-wf/resume/nonexistent", {
			method: "POST",
		});
		expect(res.status).toBe(404);

		const body = await res.json();
		expect(body.error).toBe("run_not_found");
	});

	test("POST /resume returns 409 when no checkpoint in trace", async () => {
		const { app } = setup();

		const submit = await app.request("/workflows/echo-workflow/run", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: { message: "hello" } }),
		});
		const { run_id } = await submit.json();

		await pollRunStatus(app, run_id, "success");

		const res = await app.request(`/workflows/echo-workflow/resume/${run_id}`, {
			method: "POST",
		});
		expect(res.status).toBe(409);

		const body = await res.json();
		expect(body.error).toBe("no_checkpoint_found");
	});

	test("full resume flow: run → checkpoint → resume → complete", async () => {
		const { app } = setup();

		// 1. Submit the first run
		const submit1 = await app.request("/workflows/checkpoint-wf/run", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: 21 }),
		});
		const { run_id: run_id_1 } = await submit1.json();

		// 2. Wait for checkpoint
		const cp_ids_1 = await pollPendingCheckpoints(app, run_id_1);

		// 3. Resolve the checkpoint
		const resolve_res = await app.request(`/runs/${run_id_1}/checkpoints/${cp_ids_1[0]}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ value: { approved: true } }),
		});
		expect(resolve_res.status).toBe(200);

		// 4. Wait for original run to complete
		const final_1 = await pollRunStatus(app, run_id_1, "success");
		expect(final_1.output).toBe(1);

		// 5. Submit a second run (will also hit checkpoint)
		const submit2 = await app.request("/workflows/checkpoint-wf/run", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: 21 }),
		});
		const { run_id: run_id_2 } = await submit2.json();

		// 6. Wait for checkpoint on second run
		await pollPendingCheckpoints(app, run_id_2);

		// 7. Instead of resolving, resume from second run
		const resume_res = await app.request(`/workflows/checkpoint-wf/resume/${run_id_2}`, {
			method: "POST",
		});
		expect(resume_res.status).toBe(202);
		const { run_id: resumed_run_id } = await resume_res.json();

		// 8. The resumed run gets a new checkpoint provider; wait for its checkpoint
		const cp_ids_resumed = await pollPendingCheckpoints(app, resumed_run_id);

		// 9. Resolve the resumed run's checkpoint
		const resolve_resumed = await app.request(`/runs/${resumed_run_id}/checkpoints/${cp_ids_resumed[0]}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ value: { approved: true } }),
		});
		expect(resolve_resumed.status).toBe(200);

		// 10. Wait for resumed run to complete
		const final_resumed = await pollRunStatus(app, resumed_run_id, "success");
		expect(final_resumed.output).toBe(1);

		// 11. Verify the resumed run's trace has step_skipped for compute
		const trace_res = await app.request(`/runs/${resumed_run_id}/trace`);
		const { trace } = await trace_res.json();
		const skipped = trace.events.filter((e: TraceEvent) => e.type === "step_skipped");
		expect(skipped.length).toBeGreaterThanOrEqual(1);
		expect(skipped.some((e: TraceEvent) => e.type === "step_skipped" && e.step_id === "compute")).toBe(true);
	});
});
