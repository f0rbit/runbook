declare const Bun: { file(path: string): { text(): Promise<string> } };
declare const process: { cwd(): string };

import type { Result } from "@f0rbit/corpus";
import { err, ok } from "@f0rbit/corpus";
import type {
	AgentError,
	AgentExecutor,
	AgentResponse,
	CheckpointProvider,
	MapperFn,
	RunResult,
	ShellProvider,
	Step,
	StepContext,
	StepError,
	TraceEvent,
	Workflow,
	WorkflowError,
} from "@f0rbit/runbook";
import { errors, TraceCollector } from "@f0rbit/runbook";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export type EngineOpts = {
	providers?: {
		shell?: ShellProvider;
		agent?: AgentExecutor;
		checkpoint?: CheckpointProvider;
	};
	working_directory?: string;
};

export type RunOpts = {
	run_id?: string;
	signal?: AbortSignal;
	on_trace?: (event: TraceEvent) => void;
};

export type Engine = {
	run: <I, O>(workflow: Workflow<I, O>, input: I, opts?: RunOpts) => Promise<Result<RunResult<O>, WorkflowError>>;
};

export function createEngine(engine_opts: EngineOpts = {}): Engine {
	const engine: Engine = {
		async run<I, O>(workflow: Workflow<I, O>, input: I, opts?: RunOpts): Promise<Result<RunResult<O>, WorkflowError>> {
			const run_id = opts?.run_id ?? crypto.randomUUID();
			const trace = new TraceCollector();

			if (opts?.on_trace) {
				trace.onEvent(opts.on_trace);
			}

			const started = Date.now();
			trace.emit({
				type: "workflow_start",
				workflow_id: workflow.id,
				run_id,
				input,
				timestamp: new Date(),
			});

			const input_parsed = workflow.input.safeParse(input);
			if (!input_parsed.success) {
				const wf_error = errors.invalid_workflow(input_parsed.error.issues.map((i) => i.message));
				trace.emit({
					type: "workflow_error",
					workflow_id: workflow.id,
					run_id,
					error: wf_error,
					duration_ms: Date.now() - started,
					timestamp: new Date(),
				});
				return err(wf_error);
			}

			let previous_output: unknown = input_parsed.data;
			const workflow_input = input_parsed.data;

			for (const node of workflow.steps) {
				if (opts?.signal?.aborted) {
					const step_id = node.type === "sequential" ? node.step.id : (node.branches[0]?.step.id ?? "unknown");
					const step_err = errors.aborted(step_id);
					const wf_error = errors.step_failed(
						step_id,
						step_err,
						trace.toTrace(run_id, workflow.id, "failure", Date.now() - started),
					);
					return err(wf_error);
				}

				if (node.type === "sequential") {
					const result = await executeStep(
						node.step,
						node.mapper,
						workflow_input,
						previous_output,
						{
							workflow_id: workflow.id,
							run_id,
							trace,
							signal: opts?.signal ?? new AbortController().signal,
							engine,
						},
						engine_opts,
					);

					if (!result.ok) {
						const wf_error = errors.step_failed(
							node.step.id,
							result.error,
							trace.toTrace(run_id, workflow.id, "failure", Date.now() - started),
						);
						trace.emit({
							type: "workflow_error",
							workflow_id: workflow.id,
							run_id,
							error: wf_error,
							duration_ms: Date.now() - started,
							timestamp: new Date(),
						});
						return err(wf_error);
					}
					previous_output = result.value;
				} else {
					const parallel_controller = new AbortController();
					const parent_signal = opts?.signal;
					if (parent_signal?.aborted) parallel_controller.abort();
					parent_signal?.addEventListener("abort", () => parallel_controller.abort(), { once: true });

					const branch_results: Result<unknown, StepError>[] = [];
					const branch_promises = node.branches.map(async (branch, i) => {
						const result = await executeStep(
							branch.step,
							branch.mapper,
							workflow_input,
							previous_output,
							{
								workflow_id: workflow.id,
								run_id,
								trace,
								signal: parallel_controller.signal,
								engine,
							},
							engine_opts,
						);
						if (!result.ok) {
							parallel_controller.abort();
						}
						branch_results[i] = result;
						return result;
					});

					await Promise.allSettled(branch_promises);

					const outputs: unknown[] = [];
					for (let i = 0; i < branch_results.length; i++) {
						const result = branch_results[i];
						if (!result.ok) {
							const branch = node.branches[i];
							const wf_error = errors.step_failed(
								branch.step.id,
								result.error,
								trace.toTrace(run_id, workflow.id, "failure", Date.now() - started),
							);
							trace.emit({
								type: "workflow_error",
								workflow_id: workflow.id,
								run_id,
								error: wf_error,
								duration_ms: Date.now() - started,
								timestamp: new Date(),
							});
							return err(wf_error);
						}
						outputs.push(result.value);
					}

					previous_output = outputs;
				}
			}

			const duration_ms = Date.now() - started;
			trace.emit({
				type: "workflow_complete",
				workflow_id: workflow.id,
				run_id,
				output: previous_output,
				duration_ms,
				timestamp: new Date(),
			});

			return ok({
				output: previous_output as O,
				trace: trace.toTrace(run_id, workflow.id, "success", duration_ms),
				duration_ms,
			});
		},
	};
	return engine;
}

type StepExecContext = {
	workflow_id: string;
	run_id: string;
	trace: TraceCollector;
	signal: AbortSignal;
	engine: Engine;
};

async function executeStep(
	step: Step<any, any>,
	mapper: MapperFn,
	workflow_input: unknown,
	previous_output: unknown,
	ctx_base: StepExecContext,
	engine_opts: EngineOpts,
): Promise<Result<unknown, StepError>> {
	const step_started = Date.now();

	let step_input: unknown;
	try {
		step_input = mapper(workflow_input, previous_output);
	} catch (e) {
		const err_result = errors.execution(step.id, `Mapper failed: ${e instanceof Error ? e.message : String(e)}`);
		ctx_base.trace.emit({
			type: "step_error",
			step_id: step.id,
			error: err_result,
			duration_ms: Date.now() - step_started,
			timestamp: new Date(),
		});
		return err(err_result);
	}

	const input_parsed = step.input.safeParse(step_input);
	if (!input_parsed.success) {
		const err_result = errors.validation(step.id, input_parsed.error.issues);
		ctx_base.trace.emit({
			type: "step_error",
			step_id: step.id,
			error: err_result,
			duration_ms: Date.now() - step_started,
			timestamp: new Date(),
		});
		return err(err_result);
	}

	ctx_base.trace.emit({
		type: "step_start",
		step_id: step.id,
		input: input_parsed.data,
		timestamp: new Date(),
	});

	const ctx: StepContext = {
		workflow_id: ctx_base.workflow_id,
		step_id: step.id,
		run_id: ctx_base.run_id,
		trace: ctx_base.trace,
		signal: ctx_base.signal,
		engine: ctx_base.engine,
	};

	let result: Result<unknown, StepError>;

	switch (step.kind.kind) {
		case "fn": {
			try {
				result = await step.kind.run(input_parsed.data, ctx);
			} catch (e) {
				result = err(errors.execution(step.id, e instanceof Error ? e.message : String(e)));
			}
			break;
		}

		case "shell": {
			const shell_provider = engine_opts.providers?.shell;
			if (!shell_provider) {
				result = err(errors.execution(step.id, "No shell provider configured"));
				break;
			}
			const command = step.kind.command(input_parsed.data);
			const shell_result = await shell_provider.exec(command, {
				cwd: engine_opts.working_directory,
				signal: ctx_base.signal,
			});
			if (!shell_result.ok) {
				result = err(errors.shell(step.id, command, -1, shell_result.error.cause));
				break;
			}
			result = step.kind.parse(shell_result.value.stdout, shell_result.value.exit_code);
			break;
		}

		case "agent": {
			const executor = engine_opts.providers?.agent;
			if (!executor) {
				result = err(errors.execution(step.id, "No agent executor configured"));
				break;
			}
			result = await executeAgentStep(step, input_parsed.data, ctx, executor, engine_opts);
			break;
		}

		case "checkpoint": {
			const checkpoint_provider = engine_opts.providers?.checkpoint;
			if (!checkpoint_provider) {
				result = err(errors.execution(step.id, "No checkpoint provider configured"));
				break;
			}
			const prompt_text = step.kind.prompt(input_parsed.data);
			ctx_base.trace.emit({
				type: "checkpoint_waiting",
				step_id: step.id,
				prompt: prompt_text,
				timestamp: new Date(),
			});
			const cp_result = await checkpoint_provider.prompt(prompt_text, step.output);
			if (!cp_result.ok) {
				result = err(errors.checkpoint_rejected(step.id));
				break;
			}
			result = ok(cp_result.value);
			break;
		}
	}

	if (result!.ok) {
		const output_parsed = step.output.safeParse(result!.value);
		if (!output_parsed.success) {
			const err_result = errors.validation(step.id, output_parsed.error.issues);
			ctx_base.trace.emit({
				type: "step_error",
				step_id: step.id,
				error: err_result,
				duration_ms: Date.now() - step_started,
				timestamp: new Date(),
			});
			return err(err_result);
		}
		ctx_base.trace.emit({
			type: "step_complete",
			step_id: step.id,
			output: output_parsed.data,
			duration_ms: Date.now() - step_started,
			timestamp: new Date(),
		});
		return ok(output_parsed.data);
	}

	ctx_base.trace.emit({
		type: "step_error",
		step_id: step.id,
		error: result!.error,
		duration_ms: Date.now() - step_started,
		timestamp: new Date(),
	});
	return result!;
}

async function executeAgentStep(
	step: Step<any, any>,
	input: unknown,
	ctx: StepContext,
	executor: AgentExecutor,
	engine_opts: EngineOpts,
): Promise<Result<unknown, StepError>> {
	if (step.kind.kind !== "agent") return err(errors.execution(step.id, "not an agent step"));

	const { mode, agent_opts } = step.kind;
	const prompt_text = step.kind.prompt(input);

	// Resolve system_prompt_file if specified
	let file_prompt: string | undefined;
	if (agent_opts?.system_prompt_file) {
		const file_path = agent_opts.system_prompt_file.startsWith("/")
			? agent_opts.system_prompt_file
			: `${engine_opts.working_directory ?? process.cwd()}/${agent_opts.system_prompt_file}`;
		try {
			file_prompt = await Bun.file(file_path).text();
		} catch (e) {
			return err(
				errors.execution(
					step.id,
					`Failed to read system_prompt_file "${file_path}": ${e instanceof Error ? e.message : String(e)}`,
				),
			);
		}
	}

	const base_prompt = [file_prompt, agent_opts?.system_prompt].filter(Boolean).join("\n\n");
	const system_prompt =
		mode === "analyze"
			? [base_prompt, formatOutputSchemaPrompt(step.output)].filter(Boolean).join("\n\n")
			: base_prompt || undefined;

	const session_result = await executor.createSession({
		title: `runbook:${ctx.workflow_id}:${step.id}`,
		system_prompt,
		working_directory: engine_opts.working_directory,
	});
	if (!session_result.ok) return err(errors.agent(step.id, agentErrorMessage(session_result.error)));

	const session = session_result.value;
	ctx.trace.emit({
		type: "agent_session_created",
		step_id: step.id,
		session,
		timestamp: new Date(),
	});

	const final_prompt_text =
		mode === "analyze"
			? `${prompt_text}\n\nIMPORTANT: Your final response MUST be a JSON object matching the required schema. Do not include any other text outside the JSON.`
			: prompt_text;

	const timeout_ms = agent_opts?.timeout_ms ?? 180_000;

	const prompt_promise = executor.prompt(session.id, {
		text: final_prompt_text,
		system_prompt,
		model: agent_opts?.model,
		agent_type: agent_opts?.agent_type,
		timeout_ms,
		signal: ctx.signal,
	});

	const timeout_promise = new Promise<null>((resolve) => {
		const id = setTimeout(() => resolve(null), timeout_ms);
		prompt_promise.finally(() => clearTimeout(id));
	});
	const response_result = await Promise.race([prompt_promise, timeout_promise]);

	if (response_result === null) {
		executor.destroySession?.(session.id).catch(() => {});
		return err(errors.timeout(step.id, timeout_ms));
	}

	// Clean up session (fire-and-forget)
	executor.destroySession?.(session.id).catch(() => {});

	if (!response_result.ok) return err(errors.agent(step.id, agentErrorMessage(response_result.error)));

	const response: AgentResponse = response_result.value;
	ctx.trace.emit({
		type: "agent_response",
		step_id: step.id,
		response,
		timestamp: new Date(),
	});

	if (mode === "build") {
		const output_candidate = {
			...response.metadata,
			success: (response.metadata as Record<string, unknown>).success ?? true,
		};
		const parsed = step.output.safeParse(output_candidate);
		if (!parsed.success) return err(errors.validation(step.id, parsed.error.issues));
		return ok(parsed.data);
	}

	const json_result = extractJson(response.text);
	if (!json_result.ok) return err(errors.agent_parse(step.id, response.text, []));

	const parsed = step.output.safeParse(json_result.value);
	if (!parsed.success) return err(errors.agent_parse(step.id, response.text, parsed.error.issues));

	return ok(parsed.data);
}

function formatOutputSchemaPrompt(schema: z.ZodType): string {
	const json_schema = JSON.stringify(zodToJsonSchema(schema), null, 2);
	return `You MUST respond with a JSON object matching this schema:\n\`\`\`json\n${json_schema}\n\`\`\`\nRespond with ONLY the JSON object, no other text.`;
}

function extractJson(text: string): Result<unknown, string> {
	try {
		return ok(JSON.parse(text));
	} catch {
		// fall through
	}

	const json_match = text.match(/\{[\s\S]*\}/);
	if (json_match) {
		try {
			return ok(JSON.parse(json_match[0]));
		} catch {
			// fall through
		}
	}

	const array_match = text.match(/\[[\s\S]*\]/);
	if (array_match) {
		try {
			return ok(JSON.parse(array_match[0]));
		} catch {
			// fall through
		}
	}

	return err("No valid JSON found in response text");
}

function agentErrorMessage(error: AgentError): string {
	switch (error.kind) {
		case "connection_failed":
			return error.cause;
		case "session_failed":
			return error.cause;
		case "prompt_failed":
			return error.cause;
		case "timeout":
			return `Agent timed out after ${error.timeout_ms}ms`;
	}
}
