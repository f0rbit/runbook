import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createGitArtifactStore } from "../../src/store";
import type { StorableRun } from "../../src/types";

let test_dir: string;

beforeEach(async () => {
	test_dir = await mkdtemp(join(tmpdir(), "runbook-test-"));
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

function makeMockRun(overrides?: Partial<StorableRun>): StorableRun {
	const run_id = overrides?.run_id ?? crypto.randomUUID();
	const workflow_id = overrides?.workflow_id ?? "test-workflow";
	return {
		run_id,
		workflow_id,
		input: overrides?.input ?? { test: true },
		output: overrides?.output ?? { result: "ok" },
		duration_ms: overrides?.duration_ms ?? 100,
		trace: overrides?.trace ?? {
			run_id,
			workflow_id,
			events: [
				{ type: "workflow_start", workflow_id, run_id, input: { test: true }, timestamp: new Date() },
				{ type: "step_start", step_id: "step-1", input: { test: true }, timestamp: new Date() },
				{ type: "step_complete", step_id: "step-1", output: { result: "ok" }, duration_ms: 50, timestamp: new Date() },
				{
					type: "workflow_complete",
					workflow_id,
					run_id,
					output: { result: "ok" },
					duration_ms: 100,
					timestamp: new Date(),
				},
			],
			status: "success",
			duration_ms: 100,
		},
		...overrides,
	};
}

describe("git-store", () => {
	test("store saves a run and returns StoredRun", async () => {
		const store = createGitArtifactStore(test_dir);
		const run = makeMockRun();
		const result = await store.store(run);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.run_id).toBe(run.run_id);
		expect(result.value.ref).toBe(`refs/runbook/runs/${run.run_id}`);
	});

	test("list returns stored runs", async () => {
		const store = createGitArtifactStore(test_dir);
		const run1 = makeMockRun();
		const run2 = makeMockRun();

		await store.store(run1);
		await store.store(run2);

		const result = await store.list();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.length).toBe(2);

		const run_ids = result.value.map((r) => r.run_id);
		expect(run_ids).toContain(run1.run_id);
		expect(run_ids).toContain(run2.run_id);
	});

	test("list filters by workflow_id", async () => {
		const store = createGitArtifactStore(test_dir);
		const run_a = makeMockRun({ workflow_id: "workflow-a" });
		const run_b = makeMockRun({ workflow_id: "workflow-b" });
		const run_a2 = makeMockRun({ workflow_id: "workflow-a" });

		await store.store(run_a);
		await store.store(run_b);
		await store.store(run_a2);

		const result = await store.list({ workflow_id: "workflow-a" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.length).toBe(2);
		expect(result.value.every((r) => r.workflow_id === "workflow-a")).toBe(true);
	});

	test("list respects limit", async () => {
		const store = createGitArtifactStore(test_dir);
		await store.store(makeMockRun());
		await store.store(makeMockRun());
		await store.store(makeMockRun());

		const result = await store.list({ limit: 2 });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.length).toBe(2);
	});

	test("getTrace retrieves stored trace", async () => {
		const store = createGitArtifactStore(test_dir);
		const run = makeMockRun();
		await store.store(run);

		const result = await store.getTrace(run.run_id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.run_id).toBe(run.run_id);
		expect(result.value.workflow_id).toBe(run.workflow_id);
		expect(result.value.status).toBe("success");
		expect(result.value.duration_ms).toBe(100);
		expect(result.value.events.length).toBe(4);
	});

	test("getStepArtifacts retrieves step data", async () => {
		const store = createGitArtifactStore(test_dir);
		const run = makeMockRun();
		await store.store(run);

		const result = await store.getStepArtifacts(run.run_id, "step-1");
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.step_id).toBe("step-1");
		expect(result.value.input).toEqual({ test: true });
		expect(result.value.output).toEqual({ result: "ok" });
	});

	test("getTrace with unknown run_id returns ref_not_found error", async () => {
		const store = createGitArtifactStore(test_dir);

		const result = await store.getTrace("nonexistent-id");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe("ref_not_found");
		if (result.error.kind !== "ref_not_found") return;
		expect(result.error.run_id).toBe("nonexistent-id");
	});

	test("store in non-git directory returns git_not_found error", async () => {
		const non_git_dir = await mkdtemp(join(tmpdir(), "runbook-nogit-"));
		try {
			const store = createGitArtifactStore(non_git_dir);
			const run = makeMockRun();
			const result = await store.store(run);

			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error.kind).toBe("git_not_found");
		} finally {
			await rm(non_git_dir, { recursive: true, force: true });
		}
	});
});
