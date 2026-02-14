import type { Workflow } from "@f0rbit/runbook";
import {
	createEngine,
	createInMemoryStateStore,
	createServer,
	resolveProviders,
	verifyProviders,
} from "@f0rbit/runbook-server";
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

	// Verify agent provider connectivity
	if (provider_result.value.agent) {
		const agent_url = config.providers?.agent?.base_url ?? "local";
		console.log(`Checking agent provider (opencode @ ${agent_url})...`);
		const verify_result = await verifyProviders(provider_result.value);
		if (!verify_result.ok) {
			console.error(
				`Agent provider unreachable after ${verify_result.error.attempts} attempts: ${verify_result.error.cause}`,
			);
			console.error("Is OpenCode running? Start it with: opencode serve");
			process.exit(1);
		}
		console.log("Agent provider: connected");
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
