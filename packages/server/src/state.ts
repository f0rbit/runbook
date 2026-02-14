import type { RunState } from "@f0rbit/runbook";

export type RunStateStore = {
	create: (run_id: string, workflow_id: string, input: unknown) => void;
	get: (run_id: string) => RunState | undefined;
	update: (run_id: string, patch: Partial<RunState>) => void;
	list: () => RunState[];
	createController: (run_id: string) => AbortController;
	getController: (run_id: string) => AbortController | undefined;
	removeController: (run_id: string) => void;
};

function findByPrefix<T>(map: Map<string, T>, prefix: string): T | undefined {
	const exact = map.get(prefix);
	if (exact) return exact;

	let match: T | undefined;
	let count = 0;
	for (const [id, value] of map) {
		if (id.startsWith(prefix)) {
			match = value;
			count++;
			if (count > 1) return undefined;
		}
	}
	return match;
}

function findKeyByPrefix(map: Map<string, unknown>, prefix: string): string | undefined {
	if (map.has(prefix)) return prefix;

	let matched_key: string | undefined;
	let count = 0;
	for (const id of map.keys()) {
		if (id.startsWith(prefix)) {
			matched_key = id;
			count++;
			if (count > 1) return undefined;
		}
	}
	return matched_key;
}

export function createInMemoryStateStore(): RunStateStore {
	const runs = new Map<string, RunState>();
	const controllers = new Map<string, AbortController>();

	return {
		create(run_id, workflow_id, input) {
			runs.set(run_id, {
				run_id,
				workflow_id,
				status: "pending",
				input,
				trace: { run_id, workflow_id, events: [], status: "success", duration_ms: 0 },
				started_at: new Date(),
				pending_checkpoints: new Map(),
			});
		},

		get(run_id) {
			return findByPrefix(runs, run_id);
		},

		update(run_id, patch) {
			const key = findKeyByPrefix(runs, run_id);
			const existing = key ? runs.get(key) : undefined;
			if (key && existing) {
				runs.set(key, { ...existing, ...patch });
			}
		},

		list() {
			return Array.from(runs.values());
		},

		createController(run_id) {
			const controller = new AbortController();
			controllers.set(run_id, controller);
			return controller;
		},

		getController(run_id) {
			return findByPrefix(controllers, run_id);
		},

		removeController(run_id) {
			const key = findKeyByPrefix(controllers, run_id);
			if (key) controllers.delete(key);
		},
	};
}
