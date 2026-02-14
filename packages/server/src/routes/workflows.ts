import type { RunSnapshot, RunState, TraceEvent, Workflow } from "@f0rbit/runbook";
import type { GitArtifactStore, StorableRun } from "@f0rbit/runbook-git-store";
import { Hono } from "hono";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Engine } from "../engine";
import { createServerCheckpointProvider } from "../providers/checkpoint";
import type { RunStateStore } from "../state";

export type WorkflowDeps = {
	engine: Engine;
	state: RunStateStore;
	workflows: Map<string, Workflow<any, any>>;
	git_store?: GitArtifactStore;
};

export function workflowRoutes(deps: WorkflowDeps) {
	const app = new Hono();

	app.get("/workflows", (c) => {
		const items = Array.from(deps.workflows.values()).map((w) => ({
			id: w.id,
			input_schema: zodToJsonSchema(w.input),
			output_schema: zodToJsonSchema(w.output),
			step_count: w.steps.length,
		}));
		return c.json({ workflows: items });
	});

	app.post("/workflows/:id/run", async (c) => {
		const workflow = deps.workflows.get(c.req.param("id"));
		if (!workflow) {
			return c.json({ error: "workflow_not_found" }, 404);
		}

		const body = await c.req.json<{ input?: unknown }>();
		const parsed = workflow.input.safeParse(body.input);
		if (!parsed.success) {
			return c.json({ error: "validation_error", issues: parsed.error.issues }, 400);
		}

		const run_id = crypto.randomUUID();
		deps.state.create(run_id, workflow.id, parsed.data);

		executeRunAsync(deps, workflow, parsed.data, run_id);

		return c.json({ run_id }, 202);
	});

	app.post("/workflows/:id/resume/:run_id", async (c) => {
		const workflow = deps.workflows.get(c.req.param("id"));
		if (!workflow) {
			return c.json({ error: "workflow_not_found" }, 404);
		}

		const run_id = c.req.param("run_id");
		const existing_run = deps.state.get(run_id);
		if (!existing_run) {
			return c.json({ error: "run_not_found" }, 404);
		}

		const snapshot = buildSnapshot(existing_run);
		if (!snapshot) {
			return c.json({ error: "no_checkpoint_found", message: "Run has no checkpoint to resume from" }, 409);
		}

		const new_run_id = crypto.randomUUID();
		deps.state.create(new_run_id, workflow.id, existing_run.input);

		executeRunAsync(deps, workflow, existing_run.input, new_run_id, snapshot);

		return c.json({ run_id: new_run_id, resumed_from: run_id }, 202);
	});

	return app;
}

function buildSnapshot(run: RunState): RunSnapshot | null {
	const checkpoint_event = run.trace.events
		.filter((e): e is Extract<TraceEvent, { type: "checkpoint_waiting" }> => e.type === "checkpoint_waiting")
		.at(-1);
	if (!checkpoint_event) return null;

	const completed = new Map<string, unknown>();
	for (const event of run.trace.events) {
		if (event.type === "step_complete") {
			completed.set(event.step_id, event.output);
		}
	}

	return {
		run_id: run.run_id,
		workflow_id: run.workflow_id,
		input: run.input,
		completed_steps: completed,
		resume_at: checkpoint_event.step_id,
		checkpoint_prompt: checkpoint_event.prompt,
		trace_events: run.trace.events,
	};
}

function executeRunAsync(
	deps: WorkflowDeps,
	workflow: Workflow<any, any>,
	input: unknown,
	run_id: string,
	snapshot?: RunSnapshot,
) {
	const trace_events: TraceEvent[] = [];
	const controller = deps.state.createController(run_id);

	deps.state.update(run_id, { status: "running" });

	const checkpoint = createServerCheckpointProvider({
		register: (checkpoint_id, pending) => {
			const run = deps.state.get(run_id);
			if (run) {
				run.pending_checkpoints.set(checkpoint_id, pending);
			}
		},
	});

	deps.engine
		.run(workflow, input, {
			run_id,
			signal: controller.signal,
			checkpoint,
			snapshot,
			on_trace: (event: TraceEvent) => {
				trace_events.push(event);
				const run = deps.state.get(run_id);
				if (run) {
					deps.state.update(run_id, {
						trace: { ...run.trace, events: [...trace_events] },
					});
				}

				if (event.type === "checkpoint_waiting" && deps.git_store) {
					const current_run = deps.state.get(run_id);
					if (current_run) {
						const storable: StorableRun = {
							run_id,
							workflow_id: workflow.id,
							input,
							output: undefined,
							trace: current_run.trace,
							duration_ms: current_run.trace.duration_ms,
						};
						deps.git_store.store(storable).then((r) => {
							if (!r.ok) console.error(`[runbook] git-store checkpoint write failed for ${run_id}:`, r.error);
						});
					}
				}
			},
		})
		.then((result) => {
			deps.state.removeController(run_id);
			const run = deps.state.get(run_id);
			const already_cancelled = run?.status === "cancelled";

			if (already_cancelled) {
				deps.state.update(run_id, { completed_at: new Date() });
			} else if (!result.ok && result.error.kind === "step_failed" && result.error.error.kind === "aborted") {
				deps.state.update(run_id, {
					status: "cancelled",
					error: result.error,
					trace: result.error.trace,
					completed_at: new Date(),
				});
			} else if (!result.ok) {
				deps.state.update(run_id, {
					status: "failure",
					error: result.error,
					trace:
						result.error.kind === "step_failed"
							? result.error.trace
							: { run_id, workflow_id: workflow.id, events: trace_events, status: "failure", duration_ms: 0 },
					completed_at: new Date(),
				});
			} else {
				deps.state.update(run_id, {
					status: "success",
					output: result.value.output,
					trace: result.value.trace,
					completed_at: new Date(),
				});
			}

			if (deps.git_store && !already_cancelled) {
				const final_run = deps.state.get(run_id);
				if (final_run) {
					const storable: StorableRun = {
						run_id,
						workflow_id: workflow.id,
						input,
						output: final_run.output,
						trace: final_run.trace,
						duration_ms: final_run.trace.duration_ms,
					};
					deps.git_store.store(storable).then((r) => {
						if (!r.ok) console.error(`[runbook] git-store write failed for ${run_id}:`, r.error);
					});
				}
			}
		});
}
