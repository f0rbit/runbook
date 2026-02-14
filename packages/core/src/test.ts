import type { Result } from "@f0rbit/corpus";
import { err, ok } from "@f0rbit/corpus";
import type { z } from "zod";
import type {
	AgentError,
	AgentEvent,
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
	exec_delay_ms = 0;

	on(pattern: RegExp | string, result: Partial<ShellResult> & { stdout: string }): void {
		this.responses.push({
			pattern: typeof pattern === "string" ? new RegExp(pattern) : pattern,
			result: { stdout: result.stdout, stderr: result.stderr ?? "", exit_code: result.exit_code ?? 0 },
		});
	}

	async exec(command: string, opts?: ShellOpts): Promise<Result<ShellResult, ShellError>> {
		this.executed.push({ command, opts });
		if (this.exec_delay_ms > 0) {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, this.exec_delay_ms);
				opts?.signal?.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						reject(new Error("aborted"));
					},
					{ once: true },
				);
			}).catch(() => {});
			if (opts?.signal?.aborted) {
				return err({ kind: "shell_spawn_error", command, cause: "aborted" });
			}
		}
		const match = this.responses.find((r) => r.pattern.test(command));
		if (!match) return err({ kind: "shell_spawn_error", command, cause: "no scripted response" });
		return ok(match.result);
	}
}

export class InMemoryAgentExecutor implements AgentExecutor {
	private responses: Array<{ pattern: RegExp; response: AgentResponse }> = [];
	private sessions: Map<string, { title?: string }> = new Map();
	event_handlers: Map<string, Array<(event: AgentEvent) => void>> = new Map();
	prompted: Array<{ session_id: string; opts: PromptOpts }> = [];
	created_sessions: Array<{ id: string; opts: CreateSessionOpts }> = [];
	destroyed_sessions: string[] = [];
	prompt_delay_ms = 0;
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
		this.created_sessions.push({ id, opts });
		return ok({ id, created_at: new Date() });
	}

	async prompt(session_id: string, opts: PromptOpts): Promise<Result<AgentResponse, AgentError>> {
		this.prompted.push({ session_id, opts });
		if (this.prompt_delay_ms > 0) {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, this.prompt_delay_ms);
				opts.signal?.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						reject(new Error("aborted"));
					},
					{ once: true },
				);
			}).catch(() => {});
			if (opts.signal?.aborted) {
				return err({ kind: "prompt_failed", session_id, cause: "aborted" });
			}
		}
		const match = this.responses.find((r) => r.pattern.test(opts.text));
		if (!match) return err({ kind: "prompt_failed", session_id, cause: "no scripted response" });
		return ok({ ...match.response, session_id });
	}

	subscribe(session_id: string, handler: (event: AgentEvent) => void): () => void {
		const handlers = this.event_handlers.get(session_id) ?? [];
		handlers.push(handler);
		this.event_handlers.set(session_id, handlers);
		return () => {
			const h = this.event_handlers.get(session_id);
			if (h)
				this.event_handlers.set(
					session_id,
					h.filter((x) => x !== handler),
				);
		};
	}

	emitEvent(session_id: string, event: AgentEvent): void {
		for (const handler of this.event_handlers.get(session_id) ?? []) {
			handler(event);
		}
	}

	async destroySession(session_id: string): Promise<Result<void, AgentError>> {
		this.destroyed_sessions.push(session_id);
		return ok(undefined);
	}

	async healthCheck(): Promise<Result<void, AgentError>> {
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
