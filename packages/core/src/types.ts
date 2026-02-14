import type { Result } from "@f0rbit/corpus";
import type { z } from "zod";

// --- Step types ---

export type AgentOutputMode = "analyze" | "build";

export type AgentPermission = {
	permission: string;
	pattern: string;
	action: "allow" | "deny" | "ask";
};

export type AgentStepOpts = {
	model?: { provider_id: string; model_id: string };
	agent_type?: string;
	timeout_ms?: number;
	system_prompt?: string;
	system_prompt_file?: string;
	permissions?: AgentPermission[];
};

export type StepKind =
	| { kind: "fn"; run: (input: any, ctx: StepContext) => Promise<Result<any, StepError>> }
	| { kind: "shell"; command: (input: any) => string; parse: (stdout: string, code: number) => Result<any, StepError> }
	| { kind: "agent"; prompt: (input: any) => string; mode: AgentOutputMode; agent_opts?: AgentStepOpts }
	| { kind: "checkpoint"; prompt: (input: any) => string };

export type Step<I, O> = {
	id: string;
	input: z.ZodType<I>;
	output: z.ZodType<O>;
	kind: StepKind;
	description?: string;
};

export type StepContext = {
	workflow_id: string;
	step_id: string;
	run_id: string;
	trace: TraceEmitter;
	signal: AbortSignal;
	engine: EngineHandle;
	working_directory: string;
};

// --- Workflow types ---

export type MapperFn = (workflow_input: any, previous_output: any) => any;

export type StepNode =
	| { type: "sequential"; step: Step<any, any>; mapper: MapperFn }
	| { type: "parallel"; branches: Array<{ step: Step<any, any>; mapper: MapperFn }> };

export type ParallelStepDef<WI, PrevO, I, O> = [Step<I, O>, (workflow_input: WI, previous_output: PrevO) => I];

export type ParallelOutputTuple<T extends readonly ParallelStepDef<any, any, any, any>[]> = {
	[K in keyof T]: T[K] extends ParallelStepDef<any, any, any, infer O> ? O : never;
};

export type WorkflowBuilder<WI, LastO> = {
	pipe: <I, O>(step: Step<I, O>, mapper: (workflow_input: WI, previous_output: LastO) => I) => WorkflowBuilder<WI, O>;
	parallel: <T extends readonly ParallelStepDef<WI, LastO, any, any>[]>(
		...defs: T
	) => WorkflowBuilder<WI, ParallelOutputTuple<T>>;
	done: (id: string, output: z.ZodType<LastO>) => Workflow<WI, LastO>;
};

export type Workflow<I, O> = {
	id: string;
	input: z.ZodType<I>;
	output: z.ZodType<O>;
	steps: StepNode[];
	asStep: () => Step<I, O>;
};

// --- Agent Executor types ---

export type CreateSessionOpts = {
	title?: string;
	system_prompt?: string;
	working_directory?: string;
	permissions?: AgentPermission[];
};

export type AgentSession = {
	id: string;
	created_at: Date;
};

export type PromptOpts = {
	text: string;
	system_prompt?: string;
	model?: { provider_id: string; model_id: string };
	agent_type?: string;
	timeout_ms?: number;
	signal?: AbortSignal;
};

export type AgentToolCall = {
	tool: string;
	args: Record<string, unknown>;
	result?: string;
};

export type AgentResponse = {
	session_id: string;
	text: string;
	metadata: {
		files_changed?: string[];
		tool_calls?: AgentToolCall[];
		tokens_used?: { input: number; output: number };
		duration_ms: number;
	};
};

export type AgentEvent =
	| { type: "session_created"; session: AgentSession }
	| { type: "prompt_sent"; session_id: string; text: string }
	| { type: "tool_call"; session_id: string; call: AgentToolCall }
	| { type: "tool_result"; session_id: string; tool: string; result: string }
	| { type: "text_chunk"; session_id: string; chunk: string }
	| { type: "completed"; response: AgentResponse }
	| { type: "error"; session_id: string; error: AgentError };

export type AgentExecutor = {
	createSession: (opts: CreateSessionOpts) => Promise<Result<AgentSession, AgentError>>;
	prompt: (session_id: string, opts: PromptOpts) => Promise<Result<AgentResponse, AgentError>>;
	subscribe?: (session_id: string, handler: (event: AgentEvent) => void) => () => void;
	destroySession?: (session_id: string) => Promise<Result<void, AgentError>>;
	healthCheck?: () => Promise<Result<void, AgentError>>;
};

// --- Trace types ---

export type TraceEvent =
	| { type: "workflow_start"; workflow_id: string; run_id: string; input: unknown; timestamp: Date }
	| {
			type: "workflow_complete";
			workflow_id: string;
			run_id: string;
			output: unknown;
			duration_ms: number;
			timestamp: Date;
	  }
	| {
			type: "workflow_error";
			workflow_id: string;
			run_id: string;
			error: WorkflowError;
			duration_ms: number;
			timestamp: Date;
	  }
	| { type: "step_start"; step_id: string; input: unknown; timestamp: Date }
	| { type: "step_complete"; step_id: string; output: unknown; duration_ms: number; timestamp: Date }
	| { type: "step_error"; step_id: string; error: StepError; duration_ms: number; timestamp: Date }
	| { type: "step_skipped"; step_id: string; reason: string; timestamp: Date }
	| { type: "agent_session_created"; step_id: string; session: AgentSession; timestamp: Date }
	| { type: "agent_prompt_sent"; step_id: string; session_id: string; text: string; timestamp: Date }
	| { type: "agent_tool_call"; step_id: string; session_id: string; call: AgentToolCall; timestamp: Date }
	| { type: "agent_tool_result"; step_id: string; session_id: string; tool: string; result: string; timestamp: Date }
	| { type: "agent_text"; step_id: string; session_id: string; text: string; timestamp: Date }
	| { type: "agent_response"; step_id: string; response: AgentResponse; timestamp: Date }
	| { type: "checkpoint_waiting"; step_id: string; prompt: string; timestamp: Date }
	| { type: "checkpoint_resolved"; step_id: string; value: unknown; timestamp: Date };

export type TraceEmitter = {
	emit: (event: TraceEvent) => void;
};

export type Trace = {
	run_id: string;
	workflow_id: string;
	events: TraceEvent[];
	status: "success" | "failure";
	duration_ms: number;
};

// --- Provider types ---

export type ShellOpts = {
	cwd?: string;
	env?: Record<string, string>;
	timeout_ms?: number;
	signal?: AbortSignal;
};

export type ShellResult = {
	stdout: string;
	stderr: string;
	exit_code: number;
};

export type ShellError = {
	kind: "shell_spawn_error";
	command: string;
	cause: string;
};

export type ShellProvider = {
	exec: (command: string, opts?: ShellOpts) => Promise<Result<ShellResult, ShellError>>;
};

export type CheckpointError =
	| { kind: "checkpoint_timeout"; step_id: string; timeout_ms: number }
	| { kind: "checkpoint_rejected"; step_id: string }
	| { kind: "checkpoint_invalid_input"; step_id: string; issues: z.ZodIssue[] };

export type CheckpointProvider = {
	prompt: (message: string, schema: z.ZodType) => Promise<Result<unknown, CheckpointError>>;
};

// --- Error types ---

export type StepError =
	| { kind: "validation_error"; step_id: string; issues: z.ZodIssue[] }
	| { kind: "execution_error"; step_id: string; cause: string }
	| { kind: "timeout"; step_id: string; timeout_ms: number }
	| { kind: "aborted"; step_id: string }
	| { kind: "shell_error"; step_id: string; command: string; code: number; stderr: string }
	| { kind: "agent_error"; step_id: string; cause: string }
	| { kind: "agent_parse_error"; step_id: string; raw_output: string; issues: z.ZodIssue[] }
	| { kind: "checkpoint_rejected"; step_id: string };

export type WorkflowError =
	| { kind: "step_failed"; step_id: string; error: StepError; trace: Trace }
	| { kind: "invalid_workflow"; issues: string[] }
	| { kind: "config_error"; message: string };

export type AgentError =
	| { kind: "connection_failed"; cause: string }
	| { kind: "session_failed"; cause: string }
	| { kind: "prompt_failed"; session_id: string; cause: string }
	| { kind: "timeout"; session_id: string; timeout_ms: number };

export type ClientError =
	| { kind: "http_error"; status: number; body: string }
	| { kind: "connection_refused"; url: string; cause: string }
	| { kind: "parse_error"; cause: string };

// --- Config types ---

export type AgentExecutorConfig = {
	type: string;
	base_url?: string;
	auto_approve?: boolean;
};

export type ProviderConfig = {
	shell?: ShellProvider;
	agent?: AgentExecutorConfig;
	checkpoint?: CheckpointProvider;
};

export type ServerConfig = {
	port?: number;
};

export type RunbookConfig = {
	workflows: Workflow<any, any>[];
	server?: ServerConfig;
	providers?: ProviderConfig;
	artifacts?: { git?: boolean };
	working_directory?: string;
};

// --- Run state types ---

export type PendingCheckpoint = {
	step_id: string;
	schema: z.ZodType;
	resolve: (value: unknown) => void;
	reject: (error: CheckpointError) => void;
};

export type RunState = {
	run_id: string;
	workflow_id: string;
	status: "pending" | "running" | "success" | "failure" | "cancelled";
	input: unknown;
	output?: unknown;
	error?: WorkflowError;
	trace: Trace;
	started_at: Date;
	completed_at?: Date;
	pending_checkpoints: Map<string, PendingCheckpoint>;
};

export type RunResult<O> = {
	output: O;
	trace: Trace;
	duration_ms: number;
};

export type EngineHandle = {
	run: <I, O>(
		workflow: Workflow<I, O>,
		input: I,
		opts?: { run_id?: string; signal?: AbortSignal; on_trace?: (event: TraceEvent) => void },
	) => Promise<Result<RunResult<O>, WorkflowError>>;
};
