import { describe, expect, test } from "bun:test";
import { formatError, formatRunStatus } from "../src/output";

describe("formatRunStatus", () => {
	test("shows error detail for failed run", () => {
		const run = {
			run_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			workflow_id: "feature",
			status: "failure" as const,
			input: {},
			error: {
				kind: "step_failed" as const,
				step_id: "explore",
				error: {
					kind: "agent_error" as const,
					step_id: "explore",
					cause: "Agent timed out after 30000ms",
				},
				trace: { run_id: "test", workflow_id: "feature", events: [], status: "failure" as const, duration_ms: 0 },
			},
			started_at: "2026-02-14T00:00:00.000Z",
		};

		const output = formatRunStatus(run);
		expect(output).toContain("feature");
		expect(output).toContain("failure");
		// Should contain detailed error, not just "step_failed"
		expect(output).toContain("Step failed");
		expect(output).toContain("explore");
	});

	test("shows status for successful run", () => {
		const run = {
			run_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			workflow_id: "verify",
			status: "success" as const,
			input: {},
			started_at: "2026-02-14T00:00:00.000Z",
			completed_at: "2026-02-14T00:00:05.000Z",
		};

		const output = formatRunStatus(run);
		expect(output).toContain("verify");
		expect(output).toContain("success");
		expect(output).toContain("5.0s");
	});
});

describe("formatError", () => {
	test("formats step_failed with nested cause", () => {
		const error = {
			kind: "step_failed" as const,
			step_id: "code",
			error: {
				kind: "execution_error" as const,
				step_id: "code",
				cause: "No agent executor configured",
			},
			trace: { run_id: "test", workflow_id: "test", events: [], status: "failure" as const, duration_ms: 0 },
		};

		const output = formatError(error);
		expect(output).toContain("Step failed");
		expect(output).toContain("code");
		expect(output).toContain("No agent executor configured");
	});

	test("formats connection_refused", () => {
		const error = {
			kind: "connection_refused" as const,
			url: "http://localhost:4400",
			cause: "Connection refused",
		};

		const output = formatError(error);
		expect(output).toContain("Connection refused");
		expect(output).toContain("http://localhost:4400");
	});
});
