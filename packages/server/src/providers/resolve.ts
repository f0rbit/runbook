import type { Result } from "@f0rbit/corpus";
import { err, ok } from "@f0rbit/corpus";
import type { AgentExecutor, ProviderConfig, ShellProvider } from "@f0rbit/runbook";
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

export type VerifyError = { kind: "health_check_failed"; cause: string; attempts: number };

export async function verifyProviders(
	providers: ResolvedProviders,
	opts?: { max_retries?: number; base_delay_ms?: number },
): Promise<Result<void, VerifyError>> {
	const agent = providers.agent;
	if (!agent?.healthCheck) return ok(undefined);

	const max_retries = opts?.max_retries ?? 3;
	const base_delay = opts?.base_delay_ms ?? 500;

	for (let attempt = 1; attempt <= max_retries; attempt++) {
		const result = await agent.healthCheck();
		if (result.ok) return ok(undefined);

		if (attempt < max_retries) {
			const delay = base_delay * 3 ** (attempt - 1);
			await new Promise((r) => setTimeout(r, delay));
		} else {
			return err({
				kind: "health_check_failed" as const,
				cause: "cause" in result.error ? result.error.cause : result.error.kind,
				attempts: max_retries,
			});
		}
	}

	return ok(undefined);
}
