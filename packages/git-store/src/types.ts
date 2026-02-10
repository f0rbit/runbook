import type { Result } from "@f0rbit/corpus";
import type { AgentResponse, Trace } from "@f0rbit/runbook";

export type GitArtifactStore = {
	store: (run: StorableRun, opts?: StoreOpts) => Promise<Result<StoredRun, GitStoreError>>;
	list: (opts?: ListOpts) => Promise<Result<StoredRunInfo[], GitStoreError>>;
	getTrace: (run_id: string) => Promise<Result<Trace, GitStoreError>>;
	getStepArtifacts: (run_id: string, step_id: string) => Promise<Result<StepArtifacts, GitStoreError>>;
	linkToCommit: (run_id: string, commit_sha: string) => Promise<Result<void, GitStoreError>>;
	push: (opts?: SyncOpts) => Promise<Result<SyncResult, GitStoreError>>;
	pull: (opts?: SyncOpts) => Promise<Result<SyncResult, GitStoreError>>;
};

export type StorableRun = {
	run_id: string;
	workflow_id: string;
	input: unknown;
	output: unknown;
	trace: Trace;
	duration_ms: number;
	steps?: Map<string, StepArtifacts>;
};

export type StoreOpts = { commit_sha?: string; cwd?: string };
export type ListOpts = { limit?: number; workflow_id?: string; cwd?: string };
export type SyncOpts = { remote?: string; cwd?: string };
export type SyncResult = { refs_synced: number; remote: string };
export type StoredRun = { run_id: string; ref: string };
export type StoredRunInfo = {
	run_id: string;
	workflow_id: string;
	status: "success" | "failure";
	started_at: Date;
	duration_ms: number;
	commit_sha?: string;
};

export type StepArtifacts = {
	step_id: string;
	input: unknown;
	output: unknown;
	prompt?: string;
	response?: AgentResponse;
	iterations?: AgentResponse[];
};

export type GitStoreError =
	| { kind: "git_not_found"; cwd: string }
	| { kind: "ref_not_found"; run_id: string }
	| { kind: "git_command_failed"; command: string; stderr: string; exit_code: number }
	| { kind: "parse_error"; path: string; cause: string };
