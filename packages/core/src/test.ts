import type { Result } from "@f0rbit/corpus";
import { err, ok } from "@f0rbit/corpus";
import type { z } from "zod";
import type {
	AgentError,
	AgentExecutor,
	AgentResponse,
	AgentSession,
	CheckpointError,
	CheckpointProvider,
	CreateSessionOpts,
	PromptOpts,
	ShellError,
	ShellOpts,
	ShellProvider,
	ShellResult,
} from "./types";

export class InMemoryShellProvider implements ShellProvider {
	private responses: Array<{ pattern: RegExp; result: ShellResult }> = [];
	executed: Array<{ command: string; opts?: ShellOpts }> = [];

	on(pattern: RegExp | string, result: Partial<ShellResult> & { stdout: string }): void {
		this.responses.push({
			pattern: typeof pattern === "string" ? new RegExp(pattern) : pattern,
			result: { stdout: result.stdout, stderr: result.stderr ?? "", exit_code: result.exit_code ?? 0 },
		});
	}

	async exec(command: string, opts?: ShellOpts): Promise<Result<ShellResult, ShellError>> {
		this.executed.push({ command, opts });
		const match = this.responses.find((r) => r.pattern.test(command));
		if (!match) return err({ kind: "shell_spawn_error", command, cause: "no scripted response" });
		return ok(match.result);
	}
}

export class InMemoryAgentExecutor implements AgentExecutor {
	private responses: Array<{ pattern: RegExp; response: AgentResponse }> = [];
	private sessions: Map<string, { title?: string }> = new Map();
	prompted: Array<{ session_id: string; opts: PromptOpts }> = [];
	private next_session_id = 1;

	on(pattern: RegExp | string, response: Partial<AgentResponse> & { text: string }): void {
		this.responses.push({
			pattern: typeof pattern === "string" ? new RegExp(pattern) : pattern,
			response: {
				session_id: "",
				text: response.text,
				metadata: response.metadata ?? { duration_ms: 0 },
			},
		});
	}

	async createSession(opts: CreateSessionOpts): Promise<Result<AgentSession, AgentError>> {
		const id = `test-session-${this.next_session_id++}`;
		this.sessions.set(id, { title: opts.title });
		return ok({ id, created_at: new Date() });
	}

	async prompt(session_id: string, opts: PromptOpts): Promise<Result<AgentResponse, AgentError>> {
		this.prompted.push({ session_id, opts });
		const match = this.responses.find((r) => r.pattern.test(opts.text));
		if (!match) return err({ kind: "prompt_failed", session_id, cause: "no scripted response" });
		return ok({ ...match.response, session_id });
	}

	async destroySession(_session_id: string): Promise<Result<void, AgentError>> {
		return ok(undefined);
	}
}

export class InMemoryCheckpointProvider implements CheckpointProvider {
	private responses: Array<{ pattern: RegExp; value: unknown }> = [];
	prompted: Array<{ message: string }> = [];

	on(pattern: RegExp | string, value: unknown): void {
		this.responses.push({
			pattern: typeof pattern === "string" ? new RegExp(pattern) : pattern,
			value,
		});
	}

	async prompt(message: string, schema: z.ZodType): Promise<Result<unknown, CheckpointError>> {
		this.prompted.push({ message });
		const match = this.responses.find((r) => r.pattern.test(message));
		if (!match) return err({ kind: "checkpoint_rejected", step_id: "unknown" });
		const parsed = schema.safeParse(match.value);
		if (!parsed.success)
			return err({ kind: "checkpoint_invalid_input", step_id: "unknown", issues: parsed.error.issues });
		return ok(parsed.data);
	}
}
