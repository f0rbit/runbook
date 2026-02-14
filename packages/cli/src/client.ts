import type { Result } from "@f0rbit/corpus";
import { err, ok } from "@f0rbit/corpus";
import type { ClientError, Trace } from "@f0rbit/runbook";

export type WorkflowInfo = {
	id: string;
	input_schema: Record<string, unknown>;
	output_schema: Record<string, unknown>;
	step_count: number;
};

export type RunInfo = {
	run_id: string;
	workflow_id: string;
	status: "pending" | "running" | "success" | "failure";
	input: unknown;
	output?: unknown;
	error?: unknown;
	started_at: string;
	completed_at?: string;
};

export type RunbookClient = {
	listWorkflows: () => Promise<Result<WorkflowInfo[], ClientError>>;
	listRuns: () => Promise<Result<RunInfo[], ClientError>>;
	submitRun: (workflow_id: string, input: unknown) => Promise<Result<{ run_id: string }, ClientError>>;
	getRunStatus: (run_id: string) => Promise<Result<RunInfo, ClientError>>;
	getRunTrace: (run_id: string) => Promise<Result<Trace, ClientError>>;
	resolveCheckpoint: (run_id: string, checkpoint_id: string, value: unknown) => Promise<Result<void, ClientError>>;
};

export function createRunbookClient(base_url: string): RunbookClient {
	async function request<T>(path: string, opts?: RequestInit): Promise<Result<T, ClientError>> {
		try {
			const res = await fetch(`${base_url}${path}`, opts);
			if (!res.ok) {
				const body = await res.text();
				return err({ kind: "http_error", status: res.status, body });
			}
			const data = await res.json();
			return ok(data as T);
		} catch (e) {
			if (e instanceof TypeError && e.message.includes("fetch")) {
				return err({ kind: "connection_refused", url: base_url, cause: e.message });
			}
			return err({ kind: "parse_error", cause: e instanceof Error ? e.message : String(e) });
		}
	}

	return {
		async listWorkflows() {
			const result = await request<{ workflows: WorkflowInfo[] }>("/workflows");
			if (!result.ok) return result;
			return ok(result.value.workflows);
		},

		async listRuns() {
			const result = await request<{ runs: RunInfo[] }>("/runs");
			if (!result.ok) return result;
			return ok(result.value.runs);
		},

		async submitRun(workflow_id, input) {
			return request<{ run_id: string }>(`/workflows/${workflow_id}/run`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ input }),
			});
		},

		async getRunStatus(run_id) {
			return request<RunInfo>(`/runs/${run_id}`);
		},

		async getRunTrace(run_id) {
			const result = await request<{ trace: Trace }>(`/runs/${run_id}/trace`);
			if (!result.ok) return result;
			return ok(result.value.trace);
		},

		async resolveCheckpoint(run_id, checkpoint_id, value) {
			const result = await request<{ status: string }>(`/runs/${run_id}/checkpoints/${checkpoint_id}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ value }),
			});
			if (!result.ok) return result;
			return ok(undefined);
		},
	};
}
