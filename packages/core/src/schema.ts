import { z } from "zod";

export const AgentStepOptsSchema = z.object({
	model: z.object({ provider_id: z.string(), model_id: z.string() }).optional(),
	agent_type: z.string().optional(),
	timeout_ms: z.number().positive().optional(),
	system_prompt: z.string().optional(),
	system_prompt_file: z.string().optional(),
});

export const ServerConfigSchema = z.object({
	port: z.number().int().positive().optional(),
});

export const AgentExecutorConfigSchema = z.object({
	type: z.string(),
	base_url: z.string().url().optional(),
	auto_approve: z.boolean().optional(),
});

export const ProviderConfigSchema = z.object({
	agent: AgentExecutorConfigSchema.optional(),
});

export const ArtifactsConfigSchema = z.object({
	git: z.boolean().optional(),
});

export const RunbookConfigSchema = z.object({
	server: ServerConfigSchema.optional(),
	providers: ProviderConfigSchema.optional(),
	artifacts: ArtifactsConfigSchema.optional(),
	working_directory: z.string().optional(),
});

export const WorkflowInfoSchema = z.object({
	id: z.string(),
	input_schema: z.record(z.unknown()),
	output_schema: z.record(z.unknown()),
	step_count: z.number(),
});

const timestamp = z.coerce.date();
const duration_ms = z.number();

const WorkflowStartSchema = z.object({
	type: z.literal("workflow_start"),
	workflow_id: z.string(),
	run_id: z.string(),
	input: z.unknown(),
	timestamp,
});

const WorkflowCompleteSchema = z.object({
	type: z.literal("workflow_complete"),
	output: z.unknown(),
	duration_ms,
	timestamp,
});

const WorkflowErrorSchema = z.object({
	type: z.literal("workflow_error"),
	error: z.unknown(),
	duration_ms,
	timestamp,
});

const StepStartSchema = z.object({
	type: z.literal("step_start"),
	step_id: z.string(),
	input: z.unknown(),
	timestamp,
});

const StepCompleteSchema = z.object({
	type: z.literal("step_complete"),
	step_id: z.string(),
	output: z.unknown(),
	duration_ms,
	timestamp,
});

const StepErrorSchema = z.object({
	type: z.literal("step_error"),
	step_id: z.string(),
	error: z.unknown(),
	duration_ms,
	timestamp,
});

const StepSkippedSchema = z.object({
	type: z.literal("step_skipped"),
	step_id: z.string(),
	reason: z.string(),
	timestamp,
});

const AgentSessionCreatedSchema = z.object({
	type: z.literal("agent_session_created"),
	step_id: z.string(),
	session_id: z.string(),
	timestamp,
});

const AgentPromptSentSchema = z.object({
	type: z.literal("agent_prompt_sent"),
	step_id: z.string(),
	session_id: z.string(),
	prompt: z.string(),
	timestamp,
});

const AgentToolCallSchema = z.object({
	type: z.literal("agent_tool_call"),
	step_id: z.string(),
	session_id: z.string(),
	tool: z.string(),
	args: z.record(z.unknown()),
	timestamp,
});

const AgentToolResultSchema = z.object({
	type: z.literal("agent_tool_result"),
	step_id: z.string(),
	session_id: z.string(),
	tool: z.string(),
	result: z.string(),
	timestamp,
});

const AgentResponseSchema = z.object({
	type: z.literal("agent_response"),
	step_id: z.string(),
	session_id: z.string(),
	response: z.unknown(),
	timestamp,
});

const CheckpointWaitingSchema = z.object({
	type: z.literal("checkpoint_waiting"),
	step_id: z.string(),
	checkpoint_id: z.string(),
	prompt: z.string(),
	timestamp,
});

const CheckpointResolvedSchema = z.object({
	type: z.literal("checkpoint_resolved"),
	step_id: z.string(),
	checkpoint_id: z.string(),
	input: z.unknown(),
	timestamp,
});

export const TraceEventSchema = z.discriminatedUnion("type", [
	WorkflowStartSchema,
	WorkflowCompleteSchema,
	WorkflowErrorSchema,
	StepStartSchema,
	StepCompleteSchema,
	StepErrorSchema,
	StepSkippedSchema,
	AgentSessionCreatedSchema,
	AgentPromptSentSchema,
	AgentToolCallSchema,
	AgentToolResultSchema,
	AgentResponseSchema,
	CheckpointWaitingSchema,
	CheckpointResolvedSchema,
]);

export const TraceSchema = z.object({
	run_id: z.string(),
	workflow_id: z.string(),
	events: z.array(TraceEventSchema),
	status: z.enum(["success", "failure"]),
	duration_ms: z.number(),
});

export const RunStateSchema = z.object({
	run_id: z.string(),
	workflow_id: z.string(),
	status: z.enum(["pending", "running", "success", "failure"]),
	input: z.unknown(),
	output: z.unknown().optional(),
	error: z.unknown().optional(),
	started_at: z.coerce.date(),
	completed_at: z.coerce.date().optional(),
});

// Pass-through for type safety in runbook.config.ts
// The actual RunbookConfig type (with workflows array) is in types.ts
// This validates only the serializable subset
export function defineConfig<
	T extends {
		workflows: unknown[];
		server?: z.infer<typeof ServerConfigSchema>;
		providers?: z.infer<typeof ProviderConfigSchema>;
		artifacts?: z.infer<typeof ArtifactsConfigSchema>;
		working_directory?: string;
	},
>(config: T): T {
	return config;
}
