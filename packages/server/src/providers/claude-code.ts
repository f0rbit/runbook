import type { Query, Options as SDKOptions } from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Result } from "@f0rbit/corpus";
import { err, ok } from "@f0rbit/corpus";
import type {
	AgentError,
	AgentEvent,
	AgentExecutor,
	AgentResponse,
	AgentSession,
	AgentToolCall,
	CreateSessionOpts,
	PromptOpts,
} from "@f0rbit/runbook";

export type ClaudeCodeExecutorOpts = {
	api_key?: string;
};

type SessionInfo = {
	working_directory?: string;
	system_prompt?: string;
	allowed_tools?: string[];
	disallowed_tools?: string[];
	used: boolean;
	current?: Query;
};

export class ClaudeCodeExecutor implements AgentExecutor {
	private readonly sessions: Map<string, SessionInfo> = new Map();
	private readonly subscribers: Map<string, Set<(event: AgentEvent) => void>> = new Map();

	private constructor(private readonly opts: ClaudeCodeExecutorOpts) {}

	static async create(opts: ClaudeCodeExecutorOpts = {}): Promise<Result<ClaudeCodeExecutor, AgentError>> {
		return ok(new ClaudeCodeExecutor(opts));
	}

	async createSession(opts: CreateSessionOpts): Promise<Result<AgentSession, AgentError>> {
		const id = crypto.randomUUID();
		const allowed = opts.permissions?.filter((p) => p.action === "allow").map((p) => p.permission);
		const disallowed = opts.permissions?.filter((p) => p.action === "deny").map((p) => p.permission);

		this.sessions.set(id, {
			working_directory: opts.working_directory,
			system_prompt: opts.system_prompt,
			allowed_tools: allowed && allowed.length > 0 ? allowed : undefined,
			disallowed_tools: disallowed && disallowed.length > 0 ? disallowed : undefined,
			used: false,
		});

		return ok({ id, created_at: new Date() });
	}

	async prompt(session_id: string, opts: PromptOpts): Promise<Result<AgentResponse, AgentError>> {
		const session = this.sessions.get(session_id);
		if (!session) {
			return err({ kind: "prompt_failed", session_id, cause: `session not found: ${session_id}` });
		}

		const started = Date.now();
		const idle_timeout_ms = opts.timeout_ms ?? 180_000;
		const cwd = session.working_directory ?? opts.working_directory;
		const system_prompt = opts.system_prompt ?? session.system_prompt;

		const sdk_options: SDKOptions = {
			...(cwd ? { cwd } : {}),
			...(system_prompt ? { systemPrompt: system_prompt } : {}),
			...(session.allowed_tools ? { allowedTools: session.allowed_tools } : {}),
			...(session.disallowed_tools ? { disallowedTools: session.disallowed_tools } : {}),
			...(opts.model ? { model: opts.model.model_id } : {}),
			...(opts.agent_type ? { agent: opts.agent_type } : {}),
			...(session.used ? { resume: session_id } : { sessionId: session_id }),
			...(this.opts.api_key ? { env: { ...process.env, ANTHROPIC_API_KEY: this.opts.api_key } } : {}),
		};

		const q = query({ prompt: opts.text, options: sdk_options });
		session.current = q;

		const subscribers = this.subscribers.get(session_id);
		fanout(subscribers, { type: "prompt_sent", session_id, text: opts.text });

		const idle = createIdleClock();
		const drain = drainStream(q, session_id, subscribers, idle);
		const result = await raceCompletion({
			drain,
			query: q,
			signal: opts.signal,
			session_id,
			idle,
			idle_timeout_ms,
		});

		session.used = true;
		session.current = undefined;

		if (!result.ok) {
			fanout(subscribers, { type: "error", session_id, error: result.error });
			return err(result.error);
		}

		const { text, tool_calls, files_changed, tokens_used, duration_api_ms } = result.value;
		const response: AgentResponse = {
			session_id,
			text,
			metadata: {
				files_changed,
				tool_calls,
				tokens_used,
				duration_ms: duration_api_ms ?? Date.now() - started,
			},
		};

		fanout(subscribers, { type: "completed", response });
		return ok(response);
	}

	subscribe(session_id: string, handler: (event: AgentEvent) => void): () => void {
		const set = this.subscribers.get(session_id) ?? new Set();
		set.add(handler);
		this.subscribers.set(session_id, set);
		return () => {
			const current = this.subscribers.get(session_id);
			if (!current) return;
			current.delete(handler);
			if (current.size === 0) this.subscribers.delete(session_id);
		};
	}

	async destroySession(session_id: string): Promise<Result<void, AgentError>> {
		const session = this.sessions.get(session_id);
		if (session?.current) {
			try {
				session.current.close();
			} catch {
				// best-effort cleanup
			}
		}
		this.sessions.delete(session_id);
		this.subscribers.delete(session_id);
		return ok(undefined);
	}

	// SDK has no cheap probe; verifyProviders retries 3x on failure and bad
	// auth fails loudly on first prompt. Stub to avoid spurious init cost.
	async healthCheck(): Promise<Result<void, AgentError>> {
		return ok(undefined);
	}
}

type IdleClock = { poke: () => void; lastAt: () => number };

function createIdleClock(): IdleClock {
	let last = Date.now();
	return {
		poke: () => {
			last = Date.now();
		},
		lastAt: () => last,
	};
}

type DrainOk = {
	text: string;
	tool_calls: AgentToolCall[];
	files_changed: string[];
	tokens_used?: { input: number; output: number };
	duration_api_ms?: number;
};

async function drainStream(
	q: Query,
	session_id: string,
	subscribers: Set<(event: AgentEvent) => void> | undefined,
	idle: IdleClock,
): Promise<Result<DrainOk, AgentError>> {
	const text_parts: string[] = [];
	const tool_calls: AgentToolCall[] = [];
	const tool_call_index: Map<string, AgentToolCall> = new Map();
	const files_changed: Set<string> = new Set();
	let tokens_used: { input: number; output: number } | undefined;
	let duration_api_ms: number | undefined;
	let final_result_text: string | undefined;
	let error_kind: AgentError | undefined;

	for await (const message of q) {
		idle.poke();

		if (message.type === "assistant") {
			for (const block of message.message.content) {
				if (block.type === "text") {
					if (block.text) {
						fanout(subscribers, { type: "text_chunk", session_id, chunk: block.text });
						text_parts.push(block.text);
					}
				} else if (block.type === "tool_use") {
					const call: AgentToolCall = {
						tool: block.name,
						args: (block.input as Record<string, unknown>) ?? {},
					};
					tool_call_index.set(block.id, call);
					tool_calls.push(call);
					recordFileChange(call, files_changed);
					fanout(subscribers, { type: "tool_call", session_id, call: { tool: call.tool, args: call.args } });
				}
			}
		} else if (message.type === "user") {
			const content = message.message.content;
			if (Array.isArray(content)) {
				for (const block of content) {
					if (typeof block === "object" && block !== null && (block as { type?: string }).type === "tool_result") {
						const tr = block as { tool_use_id?: string; content?: unknown };
						const result_text = stringifyToolResult(tr.content);
						const call = tr.tool_use_id ? tool_call_index.get(tr.tool_use_id) : undefined;
						if (call) call.result = result_text;
						fanout(subscribers, {
							type: "tool_result",
							session_id,
							tool: call?.tool ?? "unknown",
							result: result_text,
						});
					}
				}
			}
		} else if (message.type === "result") {
			duration_api_ms = message.duration_ms;
			tokens_used = {
				input: message.usage.input_tokens ?? 0,
				output: message.usage.output_tokens ?? 0,
			};
			if (message.subtype === "success") {
				final_result_text = message.result;
			} else {
				error_kind = {
					kind: "prompt_failed",
					session_id,
					cause: `${message.subtype}: ${message.errors.join("; ")}`,
				};
			}
		}
	}

	if (error_kind) return err(error_kind);

	const text = final_result_text ?? text_parts.join("");
	return ok({
		text,
		tool_calls,
		files_changed: Array.from(files_changed),
		tokens_used,
		duration_api_ms,
	});
}

type RaceArgs<T> = {
	drain: Promise<Result<T, AgentError>>;
	query: Query;
	signal: AbortSignal | undefined;
	session_id: string;
	idle: IdleClock;
	idle_timeout_ms: number;
};

async function raceCompletion<T>(args: RaceArgs<T>): Promise<Result<T, AgentError>> {
	const { drain, query: q, signal, session_id, idle, idle_timeout_ms } = args;

	const timeout_promise = new Promise<Result<T, AgentError>>((resolve) => {
		const tick = Math.max(250, Math.min(1000, Math.floor(idle_timeout_ms / 4)));
		const timer = setInterval(() => {
			if (Date.now() - idle.lastAt() > idle_timeout_ms) {
				clearInterval(timer);
				try {
					q.close();
				} catch {
					// best effort
				}
				resolve(err({ kind: "timeout", session_id, timeout_ms: idle_timeout_ms }));
			}
		}, tick);
		drain.finally(() => clearInterval(timer));
	});

	const abort_promise = new Promise<Result<T, AgentError>>((resolve) => {
		if (!signal) return;
		const onAbort = () => {
			try {
				q.close();
			} catch {
				// best effort
			}
			resolve(err({ kind: "prompt_failed", session_id, cause: "aborted by signal" }));
		};
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});

	const drain_safe = drain.catch<Result<T, AgentError>>((e: unknown) => {
		const cause = e instanceof Error ? e.message : String(e);
		return err({ kind: "prompt_failed", session_id, cause });
	});

	return Promise.race([drain_safe, timeout_promise, abort_promise]);
}

function recordFileChange(call: AgentToolCall, sink: Set<string>): void {
	const file_tools = ["write", "edit", "create", "patch"];
	const lower = call.tool.toLowerCase();
	if (!file_tools.some((t) => lower.includes(t))) return;
	const args = call.args as { path?: string; file_path?: string; file?: string };
	const path = args.path ?? args.file_path ?? args.file;
	if (path) sink.add(path);
}

function stringifyToolResult(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c) => {
				if (typeof c === "string") return c;
				if (typeof c === "object" && c !== null && (c as { type?: string }).type === "text") {
					return (c as { text?: string }).text ?? "";
				}
				return JSON.stringify(c);
			})
			.join("");
	}
	return JSON.stringify(content ?? "");
}

function fanout(subscribers: Set<(event: AgentEvent) => void> | undefined, event: AgentEvent): void {
	if (!subscribers) return;
	for (const handler of subscribers) {
		try {
			handler(event);
		} catch {
			// per-handler error must not break fan-out
		}
	}
}
