import type { Result } from "@f0rbit/corpus";
import type { z } from "zod";
import type { AgentOutputMode, AgentStepOpts, Step, StepContext, StepError } from "./types";

export function fn<I, O>(opts: {
	id: string;
	input: z.ZodType<I>;
	output: z.ZodType<O>;
	description?: string;
	run: (input: I, ctx: StepContext) => Promise<Result<O, StepError>>;
}): Step<I, O> {
	return {
		id: opts.id,
		input: opts.input,
		output: opts.output,
		description: opts.description,
		kind: { kind: "fn", run: opts.run },
	};
}

export function shell<I, O>(opts: {
	id: string;
	input: z.ZodType<I>;
	output: z.ZodType<O>;
	description?: string;
	command: (input: I) => string;
	parse: (stdout: string, code: number) => Result<O, StepError>;
}): Step<I, O> {
	return {
		id: opts.id,
		input: opts.input,
		output: opts.output,
		description: opts.description,
		kind: { kind: "shell", command: opts.command, parse: opts.parse },
	};
}

export function agent<I, O>(opts: {
	id: string;
	input: z.ZodType<I>;
	output: z.ZodType<O>;
	description?: string;
	prompt: (input: I) => string;
	mode?: AgentOutputMode;
	agent_opts?: AgentStepOpts;
}): Step<I, O> {
	return {
		id: opts.id,
		input: opts.input,
		output: opts.output,
		description: opts.description,
		kind: {
			kind: "agent",
			prompt: opts.prompt,
			mode: opts.mode ?? "analyze",
			agent_opts: opts.agent_opts,
		},
	};
}

export function checkpoint<I, O>(opts: {
	id: string;
	input: z.ZodType<I>;
	output: z.ZodType<O>;
	description?: string;
	prompt: (input: I) => string;
}): Step<I, O> {
	return {
		id: opts.id,
		input: opts.input,
		output: opts.output,
		description: opts.description,
		kind: { kind: "checkpoint", prompt: opts.prompt },
	};
}
