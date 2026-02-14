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
			return runs.get(run_id);
		},

		update(run_id, patch) {
			const existing = runs.get(run_id);
			if (existing) {
				runs.set(run_id, { ...existing, ...patch });
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
			return controllers.get(run_id);
		},

		removeController(run_id) {
			controllers.delete(run_id);
		},
	};
}
