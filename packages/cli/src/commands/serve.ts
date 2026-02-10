import type { Workflow } from "@f0rbit/runbook";
import { createEngine, createInMemoryStateStore, createServer, resolveProviders } from "@f0rbit/runbook-server";
import { loadConfig } from "../config";

export async function handleServe(args: string[]): Promise<void> {
	const port_idx = args.indexOf("--port");
	const explicit_port = port_idx !== -1 ? parseInt(args[port_idx + 1], 10) : undefined;

	const config_result = await loadConfig();
	if (!config_result.ok) {
		console.error("Config error:", config_result.error);
		process.exit(1);
	}

	const config = config_result.value;
	const port = explicit_port ?? config.server?.port ?? 4400;

	const provider_result = await resolveProviders(config.providers);
	if (!provider_result.ok) {
		console.error("Provider init error:", provider_result.error);
		process.exit(1);
	}

	const working_directory = config.working_directory ?? process.cwd();
	const engine = createEngine({
		providers: provider_result.value,
		working_directory,
	});
	const state = createInMemoryStateStore();
	const workflows = new Map<string, Workflow<unknown, unknown>>(
		(config.workflows ?? []).map((wf: Workflow<unknown, unknown>) => [wf.id, wf] as const),
	);

	const app = createServer({ engine, state, workflows });
	Bun.serve({ fetch: app.fetch, port });
	console.log(`Runbook server listening on http://localhost:${port}`);
}
