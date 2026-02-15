declare const Bun: { sleep(ms: number): Promise<void> };

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
			const sdk = await import("@opencode-ai/sdk/v2/client");

			const create_client = sdk.createOpencodeClient;
			if (!create_client) {
				return err({ kind: "connection_failed", cause: "createOpencodeClient not found in SDK" });
			}
			const client = create_client(opts.base_url ? { baseUrl: opts.base_url } : {});
			return ok(new OpenCodeExecutor(client));
		} catch (e) {
			return err({
				kind: "connection_failed",
				cause: e instanceof Error ? e.message : String(e),
			});
		}
	}

	async createSession(opts: CreateSessionOpts): Promise<Result<AgentSession, AgentError>> {
		try {
			// runbook agent sessions are non-interactive — human input uses checkpoint steps
			const base_permissions = opts.permissions ?? [];
			const session_permissions = [
				...base_permissions,
				{ permission: "question", pattern: "*", action: "deny" as const },
			];

			const result = await this.client.session.create({
				title: opts.title ?? "runbook-session",
				permission: session_permissions,
				...(opts.working_directory ? { directory: opts.working_directory } : {}),
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
				sessionID: session_id,
				parts: [{ type: "text" as const, text: opts.text }],
				...(opts.model ? { model: { providerID: opts.model.provider_id, modelID: opts.model.model_id } } : {}),
				...(opts.agent_type ? { agent: opts.agent_type } : {}),
				...(opts.system_prompt ? { system: opts.system_prompt } : {}),
			});

			// Race: normal completion vs stale detection
			const result = await Promise.race([
				prompt_promise.then((r: any) => ({ type: "prompt" as const, data: r })),
				monitor_promise.then(() => ({ type: "stale" as const, data: null })),
			]);

			monitor_active = false;

			if (result.type === "stale") {
				try {
					await this.client.session.abort({ sessionID: session_id });
				} catch {
					// Session may already be finished
				}

				// Check if stale due to pending permission request (parent + children)
				let pending_permission: string | undefined;
				let pending_session_id: string | undefined;
				let activity_summary = "";
				try {
					const session_result = await this.client.session.get({ sessionID: session_id });
					const session_data = session_result?.data ?? session_result;
					activity_summary += `Session ${session_id} (${session_data?.title ?? "untitled"})`;

					const all_sessions_result = await this.client.session.list({});
					const all_sessions = all_sessions_result?.data ?? all_sessions_result;
					const children = Array.isArray(all_sessions)
						? all_sessions.filter((s: any) => s.parentID === session_id)
						: [];

					if (children.length > 0) {
						activity_summary += `\n  Child sessions: ${children.map((c: any) => `${c.id.slice(0, 12)} (${c.title?.slice(0, 40) ?? "?"})`).join(", ")}`;
					}

					// Check permissions across entire session tree
					const tree_ids = new Set([session_id, ...children.map((c: any) => c.id)]);
					try {
						const perm_result = await this.client.permission.list();
						const perms = perm_result?.data ?? perm_result;
						if (Array.isArray(perms)) {
							const match = perms.find((p: any) => tree_ids.has(p.sessionID));
							if (match) {
								pending_permission = match.permission;
								pending_session_id = match.sessionID;
							}
						}
					} catch {
						// Best effort
					}
				} catch {
					// Best effort
				}

				const perm_detail = pending_permission
					? pending_session_id && pending_session_id !== session_id
						? ` — pending permission "${pending_permission}" on child session ${pending_session_id}`
						: ` — pending permission "${pending_permission}"`
					: "";
				const base_msg = `Agent stalled after ${stale_timeout_ms}ms${perm_detail} — inspect with: opencode attach ${session_id}`;
				const cause = activity_summary ? `${base_msg}\n  ${activity_summary}` : base_msg;

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
				// Discover child sessions — used by permission check, question auto-reject, and child activity check
				const session_ids = new Set([session_id]);
				let child_sessions: any[] = [];
				try {
					const all_sessions_result = await this.client.session.list({});
					const all_sessions = all_sessions_result?.data ?? all_sessions_result;
					if (Array.isArray(all_sessions)) {
						child_sessions = all_sessions.filter((s: any) => s.parentID === session_id);
						for (const s of child_sessions) session_ids.add(s.id);
					}
				} catch {
					// Fall back to parent-only
				}

				// Check for pending permission requests — if the session is waiting
				// for permission approval, it reports as "busy" but is actually stuck.
				// Don't reset last_activity in that case so the stale timeout fires.
				let has_pending_permission = false;
				try {
					const perm_result = await this.client.permission.list();
					const perms = perm_result?.data ?? perm_result;
					if (Array.isArray(perms)) {
						has_pending_permission = perms.some((p: any) => session_ids.has(p.sessionID));
					}
				} catch {
					// Permission endpoint may not be available — assume no pending
				}

				// Auto-reject any pending questions from this session tree
				try {
					const question_result = await this.client.question.list();
					const questions = question_result?.data ?? question_result;
					if (Array.isArray(questions)) {
						for (const q of questions) {
							if (session_ids.has(q.sessionID)) {
								try {
									await this.client.question.reject({ requestID: q.id });
								} catch {
									// Best effort — question may already be resolved
								}
							}
						}
					}
				} catch {
					// Question endpoint may not be available
				}

				// Check session status — if busy and no pending permissions, actively working
				if (!has_pending_permission) {
					try {
						const status_result = await this.client.session.status({});
						const status_map = status_result?.data ?? status_result;
						const session_status = status_map?.[session_id];
						if (session_status?.type === "busy") {
							last_activity = Date.now();
							continue;
						}
					} catch {
						// Status endpoint may not be available — fall through to time check
					}
				}

				// Check time.updated on parent session
				const session_result = await this.client.session.get({ sessionID: session_id });
				const session_data = session_result?.data ?? session_result;
				const parent_updated = session_data?.time?.updated;

				if (parent_updated && !has_pending_permission) {
					const updated_ms = typeof parent_updated === "number" ? parent_updated : new Date(parent_updated).getTime();
					if (updated_ms > last_activity) {
						last_activity = updated_ms;
						continue;
					}
				}

				// Check child sessions' activity
				if (!has_pending_permission) {
					for (const s of child_sessions) {
						const child_updated = s.time?.updated;
						if (child_updated) {
							const child_ms = typeof child_updated === "number" ? child_updated : new Date(child_updated).getTime();
							if (child_ms > last_activity) {
								last_activity = child_ms;
							}
						}
					}
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
				await this.client.session.abort({ sessionID: session_id });
			} catch {
				// Session may already be finished — continue to delete
			}

			await this.client.session.delete({ sessionID: session_id });
			return ok(undefined);
		} catch (e) {
			return err({
				kind: "session_failed",
				cause: `Failed to destroy session ${session_id}: ${e instanceof Error ? e.message : String(e)}`,
			});
		}
	}

	subscribe(session_id: string, handler: (event: AgentEvent) => void): () => void {
		const controller = new AbortController();
		this.consumeEvents(session_id, handler, controller.signal);
		return () => controller.abort();
	}

	private async consumeEvents(
		session_id: string,
		handler: (event: AgentEvent) => void,
		signal: AbortSignal,
	): Promise<void> {
		const seen_parts = new Set<string>();
		const child_ids = new Set<string>();

		while (!signal.aborted) {
			await Bun.sleep(3000);
			if (signal.aborted) break;

			try {
				const sessions_to_check = [session_id, ...child_ids];

				for (const sid of sessions_to_check) {
					const messages = await this.getSessionMessages(sid);
					for (const msg of messages) {
						for (const part of msg.parts ?? []) {
							const part_id = part.id ?? `${msg.id}_${part.type}_${part.tool}`;

							if (part.type === "text" && part.content) {
								const key = `${part_id}_text`;
								if (seen_parts.has(key)) continue;
								seen_parts.add(key);

								handler({
									type: "text_chunk",
									session_id: sid,
									chunk: part.content,
								});
							}

							if (part.type === "tool" && part.state) {
								const status = part.state.status;
								if (status === "running" || status === "completed") {
									const key = `${part_id}_${status}`;
									if (seen_parts.has(key)) continue;
									seen_parts.add(key);

									if (status === "running") {
										handler({
											type: "tool_call",
											session_id: sid,
											call: {
												tool: part.tool ?? "unknown",
												args: (part.state.input as Record<string, unknown>) ?? {},
											},
										});
									} else {
										handler({
											type: "tool_result",
											session_id: sid,
											tool: part.tool ?? "unknown",
											result:
												typeof part.state.output === "string"
													? part.state.output
													: JSON.stringify(part.state.output ?? ""),
										});
									}
								}
							}
						}
					}
				}

				// Discover child sessions
				try {
					const all_sessions_result = await this.client.session.list({});
					const all_sessions = all_sessions_result?.data ?? all_sessions_result;
					if (Array.isArray(all_sessions)) {
						for (const s of all_sessions) {
							if (s.parentID === session_id && !child_ids.has(s.id)) {
								child_ids.add(s.id);
								handler({
									type: "tool_call",
									session_id,
									call: {
										tool: `subagent:${s.title ?? "unknown"}`,
										args: {},
									},
								});
							}
						}
					}
				} catch {
					// Best effort
				}
			} catch {
				// Transient error — keep polling
			}
		}
	}

	private async getSessionMessages(session_id: string): Promise<any[]> {
		try {
			const result = await this.client.session.messages({ sessionID: session_id });
			const messages = result?.data ?? result;
			return Array.isArray(messages) ? messages : [];
		} catch {
			return [];
		}
	}

	async healthCheck(): Promise<Result<void, AgentError>> {
		try {
			await this.client.session.list({});
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
		.map((p: any) => p.text ?? p.content ?? "")
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
