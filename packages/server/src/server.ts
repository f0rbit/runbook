import type { Workflow } from "@f0rbit/runbook";
import type { GitArtifactStore } from "@f0rbit/runbook-git-store";
import { Hono } from "hono";
import type { Engine } from "./engine";
import { healthRoutes } from "./routes/health";
import { runRoutes } from "./routes/runs";
import { workflowRoutes } from "./routes/workflows";
import type { RunStateStore } from "./state";

export type ServerDeps = {
	engine: Engine;
	state: RunStateStore;
	// biome-ignore lint/suspicious/noExplicitAny: workflows accept arbitrary input/output types
	workflows: Map<string, Workflow<any, any>>;
	git_store?: GitArtifactStore;
};

export function createServer(deps: ServerDeps) {
	const app = new Hono();
	app.route("/", healthRoutes());
	app.route("/", workflowRoutes(deps));
	app.route("/", runRoutes(deps));
	return app;
}
