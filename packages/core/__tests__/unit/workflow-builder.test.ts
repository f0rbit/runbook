import { describe, expect, test } from "bun:test";
import { ok } from "@f0rbit/corpus";
import { defineWorkflow, fn } from "@f0rbit/runbook";
import { z } from "zod";

const StringSchema = z.string();
const NumberSchema = z.number();

const upper_step = fn({
	id: "upper",
	input: StringSchema,
	output: StringSchema,
	run: async (input) => ok(input.toUpperCase()),
});

const length_step = fn({
	id: "length",
	input: StringSchema,
	output: NumberSchema,
	run: async (input) => ok(input.length),
});

const reverse_step = fn({
	id: "reverse",
	input: StringSchema,
	output: StringSchema,
	run: async (input) => ok(input.split("").reverse().join("")),
});

describe("defineWorkflow", () => {
	test("creates a workflow with correct id and input schema", () => {
		const wf = defineWorkflow(StringSchema)
			.pipe(upper_step, (_wi, prev) => prev)
			.done("test-wf", StringSchema);

		expect(wf.id).toBe("test-wf");
		expect(wf.input).toBe(StringSchema);
		expect(wf.output).toBe(StringSchema);
	});

	test("pipe chains steps and preserves type flow", () => {
		const wf = defineWorkflow(StringSchema)
			.pipe(upper_step, (_wi, prev) => prev)
			.pipe(length_step, (_wi, prev) => prev)
			.done("pipe-wf", NumberSchema);

		expect(wf.steps).toHaveLength(2);
		expect(wf.steps[0].type).toBe("sequential");
		expect(wf.steps[1].type).toBe("sequential");

		if (wf.steps[0].type === "sequential") {
			expect(wf.steps[0].step.id).toBe("upper");
		}
		if (wf.steps[1].type === "sequential") {
			expect(wf.steps[1].step.id).toBe("length");
		}
	});

	test("parallel groups steps into a parallel node", () => {
		const wf = defineWorkflow(StringSchema)
			.parallel([upper_step, (_wi, prev) => prev] as const, [reverse_step, (_wi, prev) => prev] as const)
			.done("parallel-wf", z.tuple([StringSchema, StringSchema]));

		expect(wf.steps).toHaveLength(1);
		expect(wf.steps[0].type).toBe("parallel");

		if (wf.steps[0].type === "parallel") {
			expect(wf.steps[0].branches).toHaveLength(2);
			expect(wf.steps[0].branches[0].step.id).toBe("upper");
			expect(wf.steps[0].branches[1].step.id).toBe("reverse");
		}
	});

	test("mixed pipe and parallel", () => {
		const wf = defineWorkflow(StringSchema)
			.pipe(upper_step, (_wi, prev) => prev)
			.parallel([length_step, (_wi, prev) => prev] as const, [reverse_step, (_wi, prev) => prev] as const)
			.pipe(
				fn({
					id: "join",
					input: z.tuple([NumberSchema, StringSchema]),
					output: StringSchema,
					run: async ([n, s]) => ok(`${n}-${s}`),
				}),
				(_wi, prev) => prev,
			)
			.done("mixed-wf", StringSchema);

		expect(wf.steps).toHaveLength(3);
		expect(wf.steps[0].type).toBe("sequential");
		expect(wf.steps[1].type).toBe("parallel");
		expect(wf.steps[2].type).toBe("sequential");

		if (wf.steps[0].type === "sequential") {
			expect(wf.steps[0].step.id).toBe("upper");
		}
		if (wf.steps[1].type === "parallel") {
			expect(wf.steps[1].branches).toHaveLength(2);
		}
		if (wf.steps[2].type === "sequential") {
			expect(wf.steps[2].step.id).toBe("join");
		}
	});

	test("asStep wraps workflow as a Step", () => {
		const wf = defineWorkflow(StringSchema)
			.pipe(upper_step, (_wi, prev) => prev)
			.done("sub-wf", StringSchema);

		const step = wf.asStep();

		expect(step.id).toBe("sub-wf");
		expect(step.input).toBe(StringSchema);
		expect(step.output).toBe(StringSchema);
		expect(step.kind.kind).toBe("fn");
	});

	test("done freezes the step list", () => {
		const builder = defineWorkflow(StringSchema).pipe(upper_step, (_wi, prev) => prev);

		const wf = builder.done("frozen-wf", StringSchema);
		const snapshot = [...wf.steps];

		// Further mutations on the builder should not affect the frozen workflow
		builder.pipe(length_step, (_wi, prev) => prev);

		expect(wf.steps).toEqual(snapshot);
		expect(wf.steps).toHaveLength(1);
	});
});
