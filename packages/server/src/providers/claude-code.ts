import type { Result } from "@f0rbit/corpus";
import { err, ok } from "@f0rbit/corpus";
import type {
	AgentError,
	AgentEvent,
	AgentExecutor,
	AgentResponse,
	AgentSession,
	CreateSessionOpts,
	PromptOpts,
} from "@f0rbit/runbook";

export type ClaudeCodeExecutorOpts = {
	api_key?: string;
};

export class ClaudeCodeExecutor implements AgentExecutor {
	private constructor(private readonly opts: ClaudeCodeExecutorOpts) {}

	static async create(opts: ClaudeCodeExecutorOpts = {}): Promise<Result<ClaudeCodeExecutor, AgentError>> {
		return ok(new ClaudeCodeExecutor(opts));
	}

	async createSession(_opts: CreateSessionOpts): Promise<Result<AgentSession, AgentError>> {
		return err({ kind: "session_failed", cause: "ClaudeCodeExecutor.createSession: not implemented (Phase 2)" });
	}

	async prompt(session_id: string, _opts: PromptOpts): Promise<Result<AgentResponse, AgentError>> {
		return err({ kind: "prompt_failed", session_id, cause: "ClaudeCodeExecutor.prompt: not implemented (Phase 2)" });
	}

	subscribe(_session_id: string, _handler: (event: AgentEvent) => void): () => void {
		return () => {};
	}

	async destroySession(_session_id: string): Promise<Result<void, AgentError>> {
		return ok(undefined);
	}

	async healthCheck(): Promise<Result<void, AgentError>> {
		return ok(undefined);
	}
}
