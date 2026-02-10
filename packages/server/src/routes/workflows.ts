import type { TraceEvent, Workflow } from "@f0rbit/runbook";
import { Hono } from "hono";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Engine } from "../engine";
import type { RunStateStore } from "../state";

export type WorkflowDeps = {
	engine: Engine;
	state: RunStateStore;
	workflows: Map<string, Workflow<any, any>>;
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
		return c.json(items);
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

	return app;
}

function executeRunAsync(deps: WorkflowDeps, workflow: Workflow<any, any>, input: unknown, run_id: string) {
	const trace_events: TraceEvent[] = [];

	deps.state.update(run_id, { status: "running" });

	deps.engine
		.run(workflow, input, {
			run_id,
			on_trace: (event: TraceEvent) => {
				trace_events.push(event);
				const run = deps.state.get(run_id);
				if (run) {
					deps.state.update(run_id, {
						trace: { ...run.trace, events: [...trace_events] },
					});
				}
			},
		})
		.then((result) => {
			if (result.ok) {
				deps.state.update(run_id, {
					status: "success",
					output: result.value.output,
					trace: result.value.trace,
					completed_at: new Date(),
				});
			} else {
				deps.state.update(run_id, {
					status: "failure",
					error: result.error,
					trace:
						result.error.kind === "step_failed"
							? result.error.trace
							: { run_id, workflow_id: workflow.id, events: trace_events, status: "failure", duration_ms: 0 },
					completed_at: new Date(),
				});
			}
		});
}
