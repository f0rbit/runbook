import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Trace } from "@f0rbit/runbook";
import type { RunInfo, WorkflowInfo } from "../../src/client";
import { createRunbookClient } from "../../src/client";
import { loadConfig } from "../../src/config";
import { formatError, formatRunStatus, formatTrace, formatWorkflowList } from "../../src/output";

const now = new Date("2025-01-15T10:00:00Z");

const mockWorkflows: WorkflowInfo[] = [
	{ id: "deploy", input_schema: {}, output_schema: {}, step_count: 3 },
	{ id: "test-suite", input_schema: {}, output_schema: {}, step_count: 1 },
];

const mockRunInfo: RunInfo = {
	run_id: "abcdef12-3456-7890-abcd-ef1234567890",
	workflow_id: "deploy",
	status: "success",
	input: { env: "prod" },
	started_at: "2025-01-15T10:00:00Z",
	completed_at: "2025-01-15T10:00:05Z",
};

const mockTrace: Trace = {
	run_id: "abcdef12-3456-7890-abcd-ef1234567890",
	workflow_id: "deploy",
	status: "success",
	duration_ms: 5000,
	events: [
		{ type: "workflow_start", workflow_id: "deploy", run_id: "abcdef12", input: {}, timestamp: now },
		{ type: "step_start", step_id: "build", input: {}, timestamp: now },
		{ type: "step_complete", step_id: "build", output: {}, duration_ms: 2000, timestamp: now },
		{ type: "step_start", step_id: "upload", input: {}, timestamp: now },
		{ type: "step_complete", step_id: "upload", output: {}, duration_ms: 3000, timestamp: now },
		{
			type: "workflow_complete",
			workflow_id: "deploy",
			run_id: "abcdef12",
			output: {},
			duration_ms: 5000,
			timestamp: now,
		},
	],
};

describe("formatWorkflowList", () => {
	test("formats empty list", () => {
		const output = formatWorkflowList([]);
		expect(output).toContain("No workflows found");
	});

	test("formats workflow list with step counts", () => {
		const output = formatWorkflowList(mockWorkflows);
		expect(output).toContain("Workflows:");
		expect(output).toContain("deploy");
		expect(output).toContain("3 steps");
		expect(output).toContain("test-suite");
		expect(output).toContain("1 step");
	});

	test("singular step for count of 1", () => {
		const output = formatWorkflowList([{ id: "single", input_schema: {}, output_schema: {}, step_count: 1 }]);
		expect(output).toContain("1 step");
		expect(output).not.toContain("1 steps");
	});
});

describe("formatRunStatus", () => {
	test("formats success run", () => {
		const output = formatRunStatus(mockRunInfo);
		expect(output).toContain("abcdef12");
		expect(output).toContain("deploy");
		expect(output).toContain("success");
		expect(output).toContain("Duration");
	});

	test("formats running run without duration", () => {
		const running: RunInfo = {
			run_id: "11111111-2222-3333-4444-555555555555",
			workflow_id: "test-suite",
			status: "running",
			input: {},
			started_at: "2025-01-15T10:00:00Z",
		};
		const output = formatRunStatus(running);
		expect(output).toContain("11111111");
		expect(output).toContain("running");
		expect(output).not.toContain("Duration");
	});

	test("formats failure run with error", () => {
		const failed: RunInfo = {
			run_id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
			workflow_id: "deploy",
			status: "failure",
			input: {},
			error: {
				kind: "step_failed",
				step_id: "deploy-step",
				error: { kind: "execution_error", step_id: "deploy-step", cause: "deploy failed" },
				trace: { run_id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", workflow_id: "deploy", events: [] },
			},
			started_at: "2025-01-15T10:00:00Z",
			completed_at: "2025-01-15T10:00:02Z",
		};
		const output = formatRunStatus(failed);
		expect(output).toContain("failure");
		expect(output).toContain("Error");
	});
});

describe("formatTrace", () => {
	test("formats trace with step summaries", () => {
		const output = formatTrace(mockTrace);
		expect(output).toContain("deploy");
		expect(output).toContain("abcdef12");
		expect(output).toContain("build");
		expect(output).toContain("upload");
	});

	test("formats trace with no steps", () => {
		const empty_trace: Trace = {
			run_id: "abcdef12-3456-7890-abcd-ef1234567890",
			workflow_id: "empty",
			status: "success",
			duration_ms: 0,
			events: [],
		};
		const output = formatTrace(empty_trace);
		expect(output).toContain("empty");
		expect(output).toContain("abcdef12");
	});

	test("formats trace with errored step", () => {
		const error_trace: Trace = {
			run_id: "abcdef12-3456-7890-abcd-ef1234567890",
			workflow_id: "failing",
			status: "failure",
			duration_ms: 1000,
			events: [
				{ type: "step_start", step_id: "bad-step", input: {}, timestamp: now },
				{
					type: "step_error",
					step_id: "bad-step",
					error: { kind: "execution_error", step_id: "bad-step", cause: "boom" },
					duration_ms: 500,
					timestamp: now,
				},
			],
		};
		const output = formatTrace(error_trace);
		expect(output).toContain("bad-step");
		expect(output).toContain("boom");
	});

	test("formats trace with skipped step", () => {
		const skip_trace: Trace = {
			run_id: "abcdef12-3456-7890-abcd-ef1234567890",
			workflow_id: "conditional",
			status: "success",
			duration_ms: 100,
			events: [{ type: "step_skipped", step_id: "optional", reason: "condition not met", timestamp: now }],
		};
		const output = formatTrace(skip_trace);
		expect(output).toContain("optional");
		expect(output).toContain("skipped");
	});
});

describe("formatError", () => {
	test("formats http_error", () => {
		const output = formatError({ kind: "http_error", status: 404, body: "not found" });
		expect(output).toContain("404");
		expect(output).toContain("not found");
	});

	test("formats connection_refused", () => {
		const output = formatError({ kind: "connection_refused", url: "http://localhost:4400", cause: "ECONNREFUSED" });
		expect(output).toContain("Connection refused");
		expect(output).toContain("localhost:4400");
	});

	test("formats parse_error", () => {
		const output = formatError({ kind: "parse_error", cause: "unexpected token" });
		expect(output).toContain("Parse error");
		expect(output).toContain("unexpected token");
	});

	test("formats step_failed workflow error", () => {
		const output = formatError({
			kind: "step_failed",
			step_id: "deploy",
			error: { kind: "execution_error", step_id: "deploy", cause: "connection timeout" },
			trace: mockTrace,
		});
		expect(output).toContain("Step failed");
		expect(output).toContain("deploy");
		expect(output).toContain("connection timeout");
	});

	test("formats invalid_workflow error", () => {
		const output = formatError({ kind: "invalid_workflow", issues: ["no steps", "bad schema"] });
		expect(output).toContain("Invalid workflow");
		expect(output).toContain("no steps");
		expect(output).toContain("bad schema");
	});

	test("formats config_error", () => {
		const output = formatError({ kind: "config_error", message: "missing field" });
		expect(output).toContain("Config error");
		expect(output).toContain("missing field");
	});

	test("formats plain Error object", () => {
		const output = formatError(new Error("something broke"));
		expect(output).toContain("Error");
		expect(output).toContain("something broke");
	});

	test("formats unknown error", () => {
		const output = formatError("raw string error");
		expect(output).toContain("raw string error");
	});
});

describe("createRunbookClient", () => {
	test("connection refused returns error result", async () => {
		const client = createRunbookClient("http://localhost:19999");
		const result = await client.listWorkflows();
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(["connection_refused", "parse_error"]).toContain(result.error.kind);
		}
	});

	test("http error returns error result", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: () => new Response("not found", { status: 404 }),
		});

		try {
			const client = createRunbookClient(`http://localhost:${server.port}`);
			const result = await client.listWorkflows();
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.kind).toBe("http_error");
				if (result.error.kind === "http_error") {
					expect(result.error.status).toBe(404);
				}
			}
		} finally {
			server.stop(true);
		}
	});

	test("listWorkflows parses response", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: () =>
				Response.json({
					workflows: [{ id: "wf-1", input_schema: {}, output_schema: {}, step_count: 2 }],
				}),
		});

		try {
			const client = createRunbookClient(`http://localhost:${server.port}`);
			const result = await client.listWorkflows();
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toHaveLength(1);
				expect(result.value[0].id).toBe("wf-1");
			}
		} finally {
			server.stop(true);
		}
	});

	test("submitRun returns run_id", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: () => Response.json({ run_id: "test-run-123" }),
		});

		try {
			const client = createRunbookClient(`http://localhost:${server.port}`);
			const result = await client.submitRun("my-workflow", { key: "value" });
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.run_id).toBe("test-run-123");
			}
		} finally {
			server.stop(true);
		}
	});

	test("getRunStatus parses run info", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: () => Response.json(mockRunInfo),
		});

		try {
			const client = createRunbookClient(`http://localhost:${server.port}`);
			const result = await client.getRunStatus("some-id");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.run_id).toBe(mockRunInfo.run_id);
				expect(result.value.status).toBe("success");
			}
		} finally {
			server.stop(true);
		}
	});

	test("getRunTrace parses trace", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: () => Response.json({ trace: mockTrace }),
		});

		try {
			const client = createRunbookClient(`http://localhost:${server.port}`);
			const result = await client.getRunTrace("some-id");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.run_id).toBe(mockTrace.run_id);
				expect(result.value.events).toHaveLength(mockTrace.events.length);
			}
		} finally {
			server.stop(true);
		}
	});
});

describe("loadConfig", () => {
	test("returns error when no config found and no global config", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "runbook-test-"));
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ private: true }));

		// If global config exists, loadConfig will succeed (expected behavior)
		const global_config = join(homedir(), ".config", "runbook", "runbook.config.ts");
		const global_exists = existsSync(global_config);

		const original_cwd = process.cwd();
		process.chdir(tmp);
		try {
			const result = await loadConfig();
			if (global_exists) {
				// Global config found — this is correct behavior
				expect(result.ok).toBe(true);
			} else {
				expect(result.ok).toBe(false);
				if (!result.ok) {
					expect(result.error.kind).toBe("config_not_found");
				}
			}
		} finally {
			process.chdir(original_cwd);
		}
	});

	test("returns error for explicit nonexistent path", async () => {
		const result = await loadConfig("/tmp/nonexistent/runbook.config.ts");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("config_not_found");
		}
	});

	test("loads config from explicit path", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "runbook-test-"));
		const config_path = join(tmp, "runbook.config.ts");
		writeFileSync(config_path, "export default { workflows: [] };");

		const result = await loadConfig(config_path);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.workflows).toEqual([]);
		}
	});
});
