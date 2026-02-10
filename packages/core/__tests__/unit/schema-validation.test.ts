import { describe, expect, test } from "bun:test";
import type { TraceEvent } from "@f0rbit/runbook";
import { errors, RunbookConfigSchema, TraceCollector, TraceEventSchema, WorkflowInfoSchema } from "@f0rbit/runbook";

describe("RunbookConfigSchema", () => {
	test("validates valid config", () => {
		const result = RunbookConfigSchema.safeParse({
			server: { port: 3000 },
			providers: { agent: { type: "claude-code" } },
			artifacts: { git: true },
			working_directory: "/tmp/test",
		});

		expect(result.success).toBe(true);
	});

	test("validates minimal config", () => {
		const result = RunbookConfigSchema.safeParse({});
		expect(result.success).toBe(true);
	});

	test("rejects invalid port", () => {
		const result = RunbookConfigSchema.safeParse({
			server: { port: -1 },
		});

		expect(result.success).toBe(false);
	});
});

describe("TraceEventSchema", () => {
	test("validates workflow_start event", () => {
		const result = TraceEventSchema.safeParse({
			type: "workflow_start",
			workflow_id: "wf-1",
			run_id: "run-1",
			input: { name: "test" },
			timestamp: new Date().toISOString(),
		});

		expect(result.success).toBe(true);
	});

	test("rejects unknown event type", () => {
		const result = TraceEventSchema.safeParse({
			type: "unknown_event",
			data: "foo",
			timestamp: new Date().toISOString(),
		});

		expect(result.success).toBe(false);
	});
});

describe("WorkflowInfoSchema", () => {
	test("validates valid API response shape", () => {
		const result = WorkflowInfoSchema.safeParse({
			id: "my-workflow",
			input_schema: { type: "object" },
			output_schema: { type: "string" },
			step_count: 3,
		});

		expect(result.success).toBe(true);
	});

	test("rejects missing fields", () => {
		const result = WorkflowInfoSchema.safeParse({
			id: "my-workflow",
		});

		expect(result.success).toBe(false);
	});
});

describe("errors factory", () => {
	test("creates validation error with correct shape", () => {
		const err = errors.validation("step-1", [{ code: "custom", message: "bad", path: ["x"] }]);

		expect(err.kind).toBe("validation_error");
		expect(err.step_id).toBe("step-1");
		if (err.kind === "validation_error") {
			expect(err.issues).toHaveLength(1);
		}
	});

	test("creates execution error", () => {
		const err = errors.execution("step-2", "something broke");

		expect(err.kind).toBe("execution_error");
		expect(err.step_id).toBe("step-2");
		if (err.kind === "execution_error") {
			expect(err.cause).toBe("something broke");
		}
	});

	test("creates shell error with all fields", () => {
		const err = errors.shell("step-3", "ls -la", 127, "not found");

		expect(err.kind).toBe("shell_error");
		expect(err.step_id).toBe("step-3");
		if (err.kind === "shell_error") {
			expect(err.command).toBe("ls -la");
			expect(err.code).toBe(127);
			expect(err.stderr).toBe("not found");
		}
	});

	test("creates timeout error", () => {
		const err = errors.timeout("step-4", 5000);

		expect(err.kind).toBe("timeout");
		expect(err.step_id).toBe("step-4");
		if (err.kind === "timeout") {
			expect(err.timeout_ms).toBe(5000);
		}
	});

	test("creates workflow-level errors", () => {
		const inv = errors.invalid_workflow(["no steps", "bad input"]);
		expect(inv.kind).toBe("invalid_workflow");
		if (inv.kind === "invalid_workflow") {
			expect(inv.issues).toEqual(["no steps", "bad input"]);
		}

		const cfg = errors.config_error("missing provider");
		expect(cfg.kind).toBe("config_error");
		if (cfg.kind === "config_error") {
			expect(cfg.message).toBe("missing provider");
		}
	});
});

describe("TraceCollector", () => {
	test("emits and collects events", () => {
		const collector = new TraceCollector();

		const event1: TraceEvent = {
			type: "workflow_start",
			workflow_id: "wf-1",
			run_id: "run-1",
			input: { x: 1 },
			timestamp: new Date(),
		};

		const event2: TraceEvent = {
			type: "step_start",
			step_id: "step-1",
			input: "hello",
			timestamp: new Date(),
		};

		collector.emit(event1);
		collector.emit(event2);

		expect(collector.events).toHaveLength(2);
		expect(collector.events[0].type).toBe("workflow_start");
		expect(collector.events[1].type).toBe("step_start");
	});

	test("toTrace produces correct output", () => {
		const collector = new TraceCollector();

		const event: TraceEvent = {
			type: "workflow_start",
			workflow_id: "wf-1",
			run_id: "run-1",
			input: {},
			timestamp: new Date(),
		};

		collector.emit(event);

		const trace = collector.toTrace("run-1", "wf-1", "success", 42);

		expect(trace.run_id).toBe("run-1");
		expect(trace.workflow_id).toBe("wf-1");
		expect(trace.status).toBe("success");
		expect(trace.duration_ms).toBe(42);
		expect(trace.events).toHaveLength(1);
	});

	test("toTrace returns a copy of events", () => {
		const collector = new TraceCollector();

		const event: TraceEvent = {
			type: "workflow_start",
			workflow_id: "wf-1",
			run_id: "run-1",
			input: {},
			timestamp: new Date(),
		};

		collector.emit(event);
		const trace = collector.toTrace("run-1", "wf-1", "success", 0);

		// Emitting more events should not affect the trace
		collector.emit({
			type: "step_start",
			step_id: "s",
			input: null,
			timestamp: new Date(),
		});

		expect(trace.events).toHaveLength(1);
		expect(collector.events).toHaveLength(2);
	});

	test("onEvent notifies listeners", () => {
		const collector = new TraceCollector();
		const received: TraceEvent[] = [];

		collector.onEvent((ev) => received.push(ev));

		const event: TraceEvent = {
			type: "workflow_start",
			workflow_id: "wf-1",
			run_id: "run-1",
			input: {},
			timestamp: new Date(),
		};

		collector.emit(event);

		expect(received).toHaveLength(1);
		expect(received[0]).toBe(event);
	});
});
