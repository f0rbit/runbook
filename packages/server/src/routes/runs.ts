import type { RunState } from "@f0rbit/runbook";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { RunStateStore } from "../state";

export type RunDeps = {
	state: RunStateStore;
};

function serializeRun(run: RunState) {
	const { pending_checkpoints, ...rest } = run;
	return {
		...rest,
		pending_checkpoints: Array.from(pending_checkpoints.keys()),
	};
}

export function runRoutes(deps: RunDeps) {
	const app = new Hono();

	app.get("/runs/:id", (c) => {
		const run = deps.state.get(c.req.param("id"));
		if (!run) return c.json({ error: "run_not_found" }, 404);
		return c.json(serializeRun(run));
	});

	app.get("/runs/:id/trace", (c) => {
		const run = deps.state.get(c.req.param("id"));
		if (!run) return c.json({ error: "run_not_found" }, 404);
		return c.json(run.trace);
	});

	app.get("/runs/:id/events", (c) => {
		const run = deps.state.get(c.req.param("id"));
		if (!run) return c.json({ error: "run_not_found" }, 404);

		return streamSSE(c, async (stream) => {
			for (let i = 0; i < run.trace.events.length; i++) {
				await stream.writeSSE({
					data: JSON.stringify(run.trace.events[i]),
					event: run.trace.events[i].type,
					id: String(i),
				});
			}
		});
	});

	app.post("/runs/:id/checkpoints/:checkpoint_id", async (c) => {
		const run = deps.state.get(c.req.param("id"));
		if (!run) return c.json({ error: "run_not_found" }, 404);

		const checkpoint_id = c.req.param("checkpoint_id");
		const checkpoint = run.pending_checkpoints.get(checkpoint_id);
		if (!checkpoint) return c.json({ error: "checkpoint_not_found" }, 404);

		const body = await c.req.json<{ value?: unknown }>();
		const parsed = checkpoint.schema.safeParse(body.value);
		if (!parsed.success) {
			return c.json({ error: "validation_error", issues: parsed.error.issues }, 400);
		}

		checkpoint.resolve(parsed.data);
		run.pending_checkpoints.delete(checkpoint_id);

		return c.json({ status: "resolved" });
	});

	return app;
}
