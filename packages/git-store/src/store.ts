import type { Result } from "@f0rbit/corpus";
import { err, ok } from "@f0rbit/corpus";
import type { Trace } from "@f0rbit/runbook";
import * as git from "./git";
import type {
	GitArtifactStore,
	GitStoreError,
	ListOpts,
	StepArtifacts,
	StorableRun,
	StoredRun,
	StoredRunInfo,
	StoreOpts,
	SyncOpts,
	SyncResult,
} from "./types";

const REF_PREFIX = "refs/runbook/runs";

const refFor = (run_id: string) => `${REF_PREFIX}/${run_id}`;

const REFSPEC = `${REF_PREFIX}/*:${REF_PREFIX}/*`;

type TreeEntry = { mode: string; type: string; hash: string; name: string };

const blobEntry = (hash: string, name: string): TreeEntry => ({
	mode: "100644",
	type: "blob",
	hash,
	name,
});

const treeEntry = (hash: string, name: string): TreeEntry => ({
	mode: "040000",
	type: "tree",
	hash,
	name,
});

const jsonBlob = async (data: unknown, cwd?: string): Promise<Result<string, GitStoreError>> =>
	git.hashObject(JSON.stringify(data, null, 2), cwd);

const extractSteps = (trace: Trace): Map<string, { input?: unknown; output?: unknown }> => {
	const steps = new Map<string, { input?: unknown; output?: unknown }>();
	for (const event of trace.events) {
		if (event.type === "step_start") {
			const existing = steps.get(event.step_id) ?? {};
			steps.set(event.step_id, { ...existing, input: event.input });
		}
		if (event.type === "step_complete") {
			const existing = steps.get(event.step_id) ?? {};
			steps.set(event.step_id, { ...existing, output: event.output });
		}
	}
	return steps;
};

const buildStepsTree = async (
	trace: Trace,
	explicit_steps: Map<string, StepArtifacts> | undefined,
	cwd?: string,
): Promise<Result<TreeEntry[], GitStoreError>> => {
	const trace_steps = extractSteps(trace);
	const all_step_ids = new Set([...trace_steps.keys(), ...(explicit_steps?.keys() ?? [])]);

	const step_entries: TreeEntry[] = [];

	for (const step_id of all_step_ids) {
		const from_trace = trace_steps.get(step_id);
		const from_explicit = explicit_steps?.get(step_id);

		const entries: TreeEntry[] = [];

		const input_data = from_explicit?.input ?? from_trace?.input;
		if (input_data !== undefined) {
			const input_blob = await jsonBlob(input_data, cwd);
			if (!input_blob.ok) return input_blob;
			entries.push(blobEntry(input_blob.value, "input.json"));
		}

		const output_data = from_explicit?.output ?? from_trace?.output;
		if (output_data !== undefined) {
			const output_blob = await jsonBlob(output_data, cwd);
			if (!output_blob.ok) return output_blob;
			entries.push(blobEntry(output_blob.value, "output.json"));
		}

		if (from_explicit?.prompt) {
			const prompt_blob = await git.hashObject(from_explicit.prompt, cwd);
			if (!prompt_blob.ok) return prompt_blob;
			entries.push(blobEntry(prompt_blob.value, "prompt.txt"));
		}

		if (from_explicit?.response) {
			const response_blob = await jsonBlob(from_explicit.response, cwd);
			if (!response_blob.ok) return response_blob;
			entries.push(blobEntry(response_blob.value, "response.json"));
		}

		if (from_explicit?.iterations?.length) {
			const iterations_blob = await jsonBlob(from_explicit.iterations, cwd);
			if (!iterations_blob.ok) return iterations_blob;
			entries.push(blobEntry(iterations_blob.value, "iterations.json"));
		}

		if (entries.length > 0) {
			const step_tree = await git.mkTree(entries, cwd);
			if (!step_tree.ok) return step_tree;
			step_entries.push(treeEntry(step_tree.value, step_id));
		}
	}

	return ok(step_entries);
};

const buildTopTree = async (
	run: StorableRun,
	commit_sha: string | undefined,
	cwd?: string,
): Promise<Result<string, GitStoreError>> => {
	const trace_blob = await jsonBlob(run.trace, cwd);
	if (!trace_blob.ok) return trace_blob;

	const workflow_start = run.trace.events.find((e) => e.type === "workflow_start");
	const started_at = workflow_start?.timestamp ?? new Date();

	const metadata = {
		workflow_id: run.workflow_id,
		input: run.input,
		output: run.output,
		duration_ms: run.duration_ms,
		started_at,
		...(commit_sha ? { commit_sha } : {}),
	};

	const meta_blob = await jsonBlob(metadata, cwd);
	if (!meta_blob.ok) return meta_blob;

	const top_entries: TreeEntry[] = [
		blobEntry(trace_blob.value, "trace.json"),
		blobEntry(meta_blob.value, "metadata.json"),
	];

	const step_entries = await buildStepsTree(run.trace, run.steps, cwd);
	if (!step_entries.ok) return step_entries;

	if (step_entries.value.length > 0) {
		const steps_tree = await git.mkTree(step_entries.value, cwd);
		if (!steps_tree.ok) return steps_tree;
		top_entries.push(treeEntry(steps_tree.value, "steps"));
	}

	return git.mkTree(top_entries, cwd);
};

export const createGitArtifactStore = (default_cwd?: string): GitArtifactStore => {
	const resolveCwd = (override?: string) => override ?? default_cwd;

	const store = async (run: StorableRun, opts?: StoreOpts): Promise<Result<StoredRun, GitStoreError>> => {
		const cwd = resolveCwd(opts?.cwd);

		const is_repo = await git.isGitRepo(cwd);
		if (!is_repo) {
			return err({ kind: "git_not_found", cwd: cwd ?? "." });
		}

		const tree_sha = await buildTopTree(run, opts?.commit_sha, cwd);
		if (!tree_sha.ok) return tree_sha;

		const ref = refFor(run.run_id);
		const update = await git.updateRef(ref, tree_sha.value, cwd);
		if (!update.ok) return update;

		return ok({ run_id: run.run_id, ref });
	};

	const list = async (opts?: ListOpts): Promise<Result<StoredRunInfo[], GitStoreError>> => {
		const cwd = resolveCwd(opts?.cwd);
		const format = "%(refname:short)";
		const refs = await git.forEachRef(`${REF_PREFIX}/`, format, cwd);
		if (!refs.ok) return refs;

		const infos: StoredRunInfo[] = [];

		for (const ref_name of refs.value) {
			const run_id = ref_name.replace(`${REF_PREFIX.replace("refs/", "")}/`, "");
			const full_ref = `${REF_PREFIX}/${run_id}`;

			const meta_raw = await git.catFile(full_ref, "metadata.json", cwd);
			if (!meta_raw.ok) continue;

			try {
				const meta = JSON.parse(meta_raw.value);

				if (opts?.workflow_id && meta.workflow_id !== opts.workflow_id) continue;

				infos.push({
					run_id,
					workflow_id: meta.workflow_id,
					status: meta.output != null ? "success" : "failure",
					started_at: new Date(meta.started_at),
					duration_ms: meta.duration_ms,
					...(meta.commit_sha ? { commit_sha: meta.commit_sha } : {}),
				});
			} catch {}
		}

		const sorted = infos.sort((a, b) => b.started_at.getTime() - a.started_at.getTime());

		return ok(opts?.limit ? sorted.slice(0, opts.limit) : sorted);
	};

	const getTrace = async (run_id: string): Promise<Result<Trace, GitStoreError>> => {
		const cwd = resolveCwd();
		const ref = refFor(run_id);
		const raw = await git.catFile(ref, "trace.json", cwd);
		if (!raw.ok) {
			if (raw.error.kind === "git_command_failed") {
				return err({ kind: "ref_not_found", run_id });
			}
			return raw;
		}

		try {
			return ok(JSON.parse(raw.value) as Trace);
		} catch (e) {
			return err({
				kind: "parse_error",
				path: `${ref}:trace.json`,
				cause: String(e),
			});
		}
	};

	const getStepArtifacts = async (run_id: string, step_id: string): Promise<Result<StepArtifacts, GitStoreError>> => {
		const cwd = resolveCwd();
		const ref = refFor(run_id);
		const prefix = `steps/${step_id}`;

		const input_raw = await git.catFile(ref, `${prefix}/input.json`, cwd);
		const output_raw = await git.catFile(ref, `${prefix}/output.json`, cwd);

		if (!input_raw.ok && !output_raw.ok) {
			return err({ kind: "ref_not_found", run_id });
		}

		const artifacts: StepArtifacts = {
			step_id,
			input: input_raw.ok ? JSON.parse(input_raw.value) : undefined,
			output: output_raw.ok ? JSON.parse(output_raw.value) : undefined,
		};

		const prompt_raw = await git.catFile(ref, `${prefix}/prompt.txt`, cwd);
		if (prompt_raw.ok) {
			artifacts.prompt = prompt_raw.value;
		}

		const response_raw = await git.catFile(ref, `${prefix}/response.json`, cwd);
		if (response_raw.ok) {
			artifacts.response = JSON.parse(response_raw.value);
		}

		const iterations_raw = await git.catFile(ref, `${prefix}/iterations.json`, cwd);
		if (iterations_raw.ok) {
			artifacts.iterations = JSON.parse(iterations_raw.value);
		}

		return ok(artifacts);
	};

	const linkToCommit = async (run_id: string, commit_sha: string): Promise<Result<void, GitStoreError>> => {
		const cwd = resolveCwd();
		const ref = refFor(run_id);

		const meta_raw = await git.catFile(ref, "metadata.json", cwd);
		if (!meta_raw.ok) {
			return err({ kind: "ref_not_found", run_id });
		}

		let metadata: Record<string, unknown>;
		try {
			metadata = JSON.parse(meta_raw.value);
		} catch (e) {
			return err({
				kind: "parse_error",
				path: `${ref}:metadata.json`,
				cause: String(e),
			});
		}

		metadata.commit_sha = commit_sha;

		const new_meta_blob = await jsonBlob(metadata, cwd);
		if (!new_meta_blob.ok) return new_meta_blob;

		const trace_raw = await git.catFile(ref, "trace.json", cwd);
		if (!trace_raw.ok) return trace_raw;
		const trace_blob = await git.hashObject(trace_raw.value, cwd);
		if (!trace_blob.ok) return trace_blob;

		const top_entries: TreeEntry[] = [
			blobEntry(trace_blob.value, "trace.json"),
			blobEntry(new_meta_blob.value, "metadata.json"),
		];

		const steps_tree_result = await git.catFile(ref, "steps", cwd);
		if (steps_tree_result.ok) {
			const step_lines = steps_tree_result.value.split("\n").filter(Boolean);
			for (const line of step_lines) {
				const parts = line.split(/\s+/);
				if (parts.length >= 4) {
					const [mode, type, hash, ...name_parts] = parts;
					top_entries.push({ mode, type, hash, name: name_parts.join(" ") });
				}
			}

			if (top_entries.length > 2) {
				const steps_entries = top_entries.splice(2);
				const steps_tree = await git.mkTree(steps_entries, cwd);
				if (!steps_tree.ok) return steps_tree;
				top_entries.push(treeEntry(steps_tree.value, "steps"));
			}
		}

		const new_tree = await git.mkTree(top_entries, cwd);
		if (!new_tree.ok) return new_tree;

		const update = await git.updateRef(ref, new_tree.value, cwd);
		if (!update.ok) return update;

		return ok(undefined);
	};

	const push = async (opts?: SyncOpts): Promise<Result<SyncResult, GitStoreError>> => {
		const cwd = resolveCwd(opts?.cwd);
		const remote = opts?.remote ?? "origin";

		const result = await git.pushRefs(remote, REFSPEC, cwd);
		if (!result.ok) return result;

		const refs = await git.forEachRef(`${REF_PREFIX}/`, "%(refname)", cwd);
		const refs_synced = refs.ok ? refs.value.length : 0;

		return ok({ refs_synced, remote });
	};

	const pull = async (opts?: SyncOpts): Promise<Result<SyncResult, GitStoreError>> => {
		const cwd = resolveCwd(opts?.cwd);
		const remote = opts?.remote ?? "origin";

		const result = await git.fetchRefs(remote, REFSPEC, cwd);
		if (!result.ok) return result;

		const refs = await git.forEachRef(`${REF_PREFIX}/`, "%(refname)", cwd);
		const refs_synced = refs.ok ? refs.value.length : 0;

		return ok({ refs_synced, remote });
	};

	return { store, list, getTrace, getStepArtifacts, linkToCommit, push, pull };
};
