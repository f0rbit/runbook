declare const Bun: { sleep(ms: number): Promise<void> };

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
			const stale_timeout_ms = opts.timeout_ms ?? 180_000;

			// Activity monitor runs in parallel — detects when the session has
			// stalled (no time.updated change for stale_timeout_ms).
			let monitor_active = true;
			const monitor_promise = this.monitorActivity(session_id, stale_timeout_ms, () => monitor_active, opts.signal);

			// Blocking prompt handles response collection
			const prompt_promise = this.client.session.prompt({
				path: { id: session_id },
				body: {
					parts: [{ type: "text" as const, text: opts.text }],
					...(opts.model ? { model: { providerID: opts.model.provider_id, modelID: opts.model.model_id } } : {}),
					...(opts.agent_type ? { agent: opts.agent_type } : {}),
					...(opts.system_prompt ? { system: opts.system_prompt } : {}),
					// runbook agent sessions are non-interactive — human input uses checkpoint steps
					tools: { question: false },
				},
			});

			// Race: normal completion vs stale detection
			const result = await Promise.race([
				prompt_promise.then((r: any) => ({ type: "prompt" as const, data: r })),
				monitor_promise.then(() => ({ type: "stale" as const, data: null })),
			]);

			monitor_active = false;

			if (result.type === "stale") {
				try {
					await this.client.session.abort({ path: { id: session_id } });
				} catch {
					// Session may already be finished
				}

				// Collect session activity summary for debugging
				let activity_summary = "";
				try {
					const session_result = await this.client.session.get({ path: { id: session_id } });
					const session_data = session_result?.data ?? session_result;
					activity_summary += `Session ${session_id} (${session_data?.title ?? "untitled"})`;

					const all_sessions_result = await this.client.session.list();
					const all_sessions = all_sessions_result?.data ?? all_sessions_result;
					if (Array.isArray(all_sessions)) {
						const children = all_sessions.filter((s: any) => s.parentID === session_id);
						if (children.length > 0) {
							activity_summary += `\n  Child sessions: ${children.map((c: any) => `${c.id.slice(0, 12)} (${c.title?.slice(0, 40) ?? "?"})`).join(", ")}`;
						}
					}
				} catch {
					// Best effort
				}

				const cause = activity_summary
					? `Agent stalled after ${stale_timeout_ms}ms — inspect with: opencode attach ${session_id}\n  ${activity_summary}`
					: `Agent stalled after ${stale_timeout_ms}ms — inspect with: opencode attach ${session_id}`;

				// Don't destroy — leave session alive for debugging
				return err({ kind: "prompt_failed", session_id, cause });
			}

			const response = result.data?.data ?? result.data;
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

	// Polls session status, parent time.updated, and child session activity.
	// Resolves when no activity has been observed for stale_timeout_ms.
	// Returns (never resolves) if the prompt finishes first (monitor_active → false).
	private async monitorActivity(
		session_id: string,
		stale_timeout_ms: number,
		is_active: () => boolean,
		signal?: AbortSignal,
	): Promise<void> {
		let last_activity = Date.now();

		while (is_active()) {
			await Bun.sleep(5000);
			if (!is_active() || signal?.aborted) return;

			try {
				// Check session status first — if busy, the session is actively working
				try {
					const status_result = await this.client.session.status();
					const status_map = status_result?.data ?? status_result;
					const session_status = status_map?.[session_id];
					if (session_status?.type === "busy") {
						last_activity = Date.now();
						continue;
					}
				} catch {
					// Status endpoint may not be available — fall through to time check
				}

				// Check time.updated on parent session
				const session_result = await this.client.session.get({ path: { id: session_id } });
				const session_data = session_result?.data ?? session_result;
				const parent_updated = session_data?.time?.updated;

				if (parent_updated) {
					const updated_ms = typeof parent_updated === "number" ? parent_updated : new Date(parent_updated).getTime();
					if (updated_ms > last_activity) {
						last_activity = updated_ms;
						continue;
					}
				}

				// Check child sessions' activity
				try {
					const all_sessions_result = await this.client.session.list();
					const all_sessions = all_sessions_result?.data ?? all_sessions_result;
					if (Array.isArray(all_sessions)) {
						for (const s of all_sessions) {
							if (s.parentID === session_id) {
								const child_updated = s.time?.updated;
								if (child_updated) {
									const child_ms =
										typeof child_updated === "number" ? child_updated : new Date(child_updated).getTime();
									if (child_ms > last_activity) {
										last_activity = child_ms;
									}
								}
							}
						}
					}
				} catch {
					// List may fail — that's ok, we still have the parent check
				}
			} catch {
				// Transient error — keep polling
			}

			const idle_ms = Date.now() - last_activity;
			if (idle_ms > stale_timeout_ms) return;
		}
	}

	async destroySession(session_id: string): Promise<Result<void, AgentError>> {
		try {
			try {
				await this.client.session.abort({ path: { id: session_id } });
			} catch {
				// Session may already be finished — continue to delete
			}

			await this.client.session.delete({ path: { id: session_id } });
			return ok(undefined);
		} catch (e) {
			return err({
				kind: "session_failed",
				cause: `Failed to destroy session ${session_id}: ${e instanceof Error ? e.message : String(e)}`,
			});
		}
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
