import type { z } from "zod";
import type { StepError, Trace, WorkflowError } from "./types";

export const errors = {
	validation: (step_id: string, issues: z.ZodIssue[]): StepError => ({ kind: "validation_error", step_id, issues }),

	execution: (step_id: string, cause: string): StepError => ({ kind: "execution_error", step_id, cause }),

	shell: (step_id: string, command: string, code: number, stderr: string): StepError => ({
		kind: "shell_error",
		step_id,
		command,
		code,
		stderr,
	}),

	agent: (step_id: string, cause: string): StepError => ({ kind: "agent_error", step_id, cause }),

	agent_parse: (step_id: string, raw_output: string, issues: z.ZodIssue[]): StepError => ({
		kind: "agent_parse_error",
		step_id,
		raw_output,
		issues,
	}),

	timeout: (step_id: string, timeout_ms: number): StepError => ({ kind: "timeout", step_id, timeout_ms }),

	aborted: (step_id: string): StepError => ({ kind: "aborted", step_id }),

	checkpoint_rejected: (step_id: string): StepError => ({ kind: "checkpoint_rejected", step_id }),

	step_failed: (step_id: string, error: StepError, trace: Trace): WorkflowError => ({
		kind: "step_failed",
		step_id,
		error,
		trace,
	}),

	invalid_workflow: (issues: string[]): WorkflowError => ({ kind: "invalid_workflow", issues }),

	config_error: (message: string): WorkflowError => ({ kind: "config_error", message }),
};
