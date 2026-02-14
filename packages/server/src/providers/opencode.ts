import type { Result } from "@f0rbit/corpus";
import { err, ok } from "@f0rbit/corpus";
import type {
	AgentError,
	AgentExecutor,
	AgentResponse,
	AgentSession,
	AgentToolCall,
	CreateSessionOpts,
	PromptOpts,
} from "@f0rbit/runbook";

export type OpenCodeExecutorOpts = {
	base_url?: string;
	auto_approve?: boolean;
};

export class OpenCodeExecutor implements AgentExecutor {
	private client: any;

	private constructor(client: any) {
		this.client = client;
	}

	static async create(opts: OpenCodeExecutorOpts = {}): Promise<Result<OpenCodeExecutor, AgentError>> {
		try {
			const sdk = await import("@opencode-ai/sdk");

			if (opts.base_url) {
				const create_client = sdk.createOpencodeClient;
				if (!create_client) {
					return err({ kind: "connection_failed", cause: "createOpencodeClient not found in SDK" });
				}
				const client = create_client({ baseUrl: opts.base_url });
				return ok(new OpenCodeExecutor(client));
			}

			const create_fn = sdk.createOpencode;
			if (!create_fn) {
				return err({ kind: "connection_failed", cause: "createOpencode not found in SDK" });
			}
			const instance = await create_fn();
			return ok(new OpenCodeExecutor(instance.client));
		} catch (e) {
			return err({
				kind: "connection_failed",
				cause: e instanceof Error ? e.message : String(e),
			});
		}
	}

	async createSession(opts: CreateSessionOpts): Promise<Result<AgentSession, AgentError>> {
		try {
			const result = await this.client.session.create({
				body: { title: opts.title ?? "runbook-session" },
			});

			const session = result?.data ?? result;
			const id = session?.id;
			if (!id) {
				return err({ kind: "session_failed", cause: "No session ID in response" });
			}

			return ok({
				id,
				created_at: session.time?.created ? new Date(session.time.created) : new Date(),
			});
		} catch (e) {
			return err({
				kind: "session_failed",
				cause: e instanceof Error ? e.message : String(e),
			});
		}
	}

	async prompt(session_id: string, opts: PromptOpts): Promise<Result<AgentResponse, AgentError>> {
		try {
			const started = Date.now();

			const result = await this.client.session.prompt({
				path: { id: session_id },
				body: {
					parts: [{ type: "text" as const, text: opts.text }],
					...(opts.model ? { model: { providerID: opts.model.provider_id, modelID: opts.model.model_id } } : {}),
					...(opts.agent_type ? { agent: opts.agent_type } : {}),
				},
			});

			const response = result?.data ?? result;
			const parts: any[] = response?.parts ?? [];
			const info: any = response?.info ?? {};

			const text = extractText(parts);
			const tool_calls = extractToolCalls(parts);
			const files_changed = extractFilesChanged(tool_calls);

			return ok({
				session_id,
				text,
				metadata: {
					files_changed,
					tool_calls,
					tokens_used: info.tokens ? { input: info.tokens.input, output: info.tokens.output } : undefined,
					duration_ms: Date.now() - started,
				},
			});
		} catch (e) {
			return err({
				kind: "prompt_failed",
				session_id,
				cause: e instanceof Error ? e.message : String(e),
			});
		}
	}

	async destroySession(_session_id: string): Promise<Result<void, AgentError>> {
		return ok(undefined);
	}

	async healthCheck(): Promise<Result<void, AgentError>> {
		try {
			await this.client.session.list();
			return ok(undefined);
		} catch (e) {
			return err({
				kind: "connection_failed",
				cause: e instanceof Error ? e.message : String(e),
			});
		}
	}
}

function extractText(parts: any[]): string {
	return parts
		.filter((p: any) => p.type === "text")
		.map((p: any) => p.text ?? "")
		.join("\n");
}

function extractToolCalls(parts: any[]): AgentToolCall[] {
	return parts
		.filter((p: any) => p.type === "tool" && p.state)
		.map((p: any) => ({
			tool: p.tool ?? "unknown",
			args: p.state?.input ?? {},
			result: p.state?.output,
		}));
}

function extractFilesChanged(tool_calls: AgentToolCall[]): string[] {
	const file_tools = ["write", "edit", "create", "patch"];
	return [
		...new Set(
			tool_calls
				.filter((tc) => file_tools.some((ft) => tc.tool.includes(ft)))
				.map((tc) => (tc.args as any)?.path ?? (tc.args as any)?.file ?? "")
				.filter(Boolean),
		),
	];
}
