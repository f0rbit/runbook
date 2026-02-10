import type { Result } from "@f0rbit/corpus";
import { err, ok } from "@f0rbit/corpus";
import type { AgentExecutor, AgentExecutorConfig, ProviderConfig, ShellProvider } from "@f0rbit/runbook";
import type { EngineOpts } from "../engine";
import { BunShellProvider } from "./shell";

export type ResolvedProviders = NonNullable<EngineOpts["providers"]>;

export type ResolveError = { kind: "agent_init_failed"; cause: string };

export async function resolveProviders(
	provider_config?: ProviderConfig,
): Promise<Result<ResolvedProviders, ResolveError>> {
	const shell: ShellProvider = new BunShellProvider();

	let agent: AgentExecutor | undefined;
	const agent_config = provider_config?.agent;

	if (agent_config && agent_config.type === "opencode") {
		// Dynamic import to avoid hard dependency when no agent config
		const { OpenCodeExecutor } = await import("./opencode");
		const executor_result = await OpenCodeExecutor.create({
			base_url: agent_config.base_url,
			auto_approve: agent_config.auto_approve,
		});
		if (!executor_result.ok) {
			return err({
				kind: "agent_init_failed" as const,
				cause: `Failed to create OpenCode executor: ${executor_result.error.kind} - ${"cause" in executor_result.error ? executor_result.error.cause : "unknown"}`,
			});
		}
		agent = executor_result.value;
	}

	return ok({ shell, agent });
}
